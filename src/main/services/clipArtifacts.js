const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const CLIP_CACHE_DIR_NAME = 'clip-cache';
const LEGACY_SMART_EDIT_PREFIX = 'antbot-smart-edit-';
const DEFAULT_DATA_DIR = path.join(os.homedir(), 'AntBot');
const TERMINAL_STATUSES = new Set(['failed', 'cancelled', 'completed']);
const INTERRUPTED_STATUSES = new Set(['preparing', 'composing']);

function resolveDir(dirPath, fallback) {
  return path.resolve(String(dirPath || fallback));
}

function safeTaskId(taskId) {
  const raw = String(taskId || '').trim() || `task-${Date.now()}`;
  const slug = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'task';
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10);
  return `${slug}-${hash}`;
}

function isInside(parentDir, childPath) {
  const parent = path.resolve(parentDir);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function removePath(targetPath, removed, log) {
  if (!targetPath) return false;
  try {
    const before = await fs.stat(targetPath).catch(() => null);
    if (!before) return false;
    await fs.rm(targetPath, { recursive: true, force: true });
    removed.push(targetPath);
    return true;
  } catch (error) {
    log(`清理缓存失败: ${targetPath} (${error?.message || error})`);
    return false;
  }
}

function createClipArtifactManager(options = {}) {
  const dataDir = resolveDir(options.dataDir, DEFAULT_DATA_DIR);
  const tempDir = resolveDir(options.tempDir, os.tmpdir());
  const log = typeof options.log === 'function' ? options.log : () => {};
  const cacheRoot = path.join(dataDir, CLIP_CACHE_DIR_NAME);

  const getTaskCacheDir = (taskId) => path.join(cacheRoot, safeTaskId(taskId));

  const isManagedClipPath = (targetPath) => {
    if (!targetPath) return false;
    const resolved = path.resolve(targetPath);
    if (isInside(cacheRoot, resolved)) return true;
    return path.dirname(resolved) === tempDir && path.basename(resolved).startsWith(LEGACY_SMART_EDIT_PREFIX);
  };

  const cleanupTaskCache = async (taskOrId) => {
    const task = typeof taskOrId === 'object' && taskOrId ? taskOrId : { id: taskOrId };
    const removed = [];
    const candidates = new Set();
    if (task.id) candidates.add(getTaskCacheDir(task.id));
    if (task.tmpDir && isManagedClipPath(task.tmpDir)) candidates.add(path.resolve(task.tmpDir));
    if (task.srtPath) {
      const srtDir = path.dirname(path.resolve(task.srtPath));
      if (isManagedClipPath(srtDir)) candidates.add(srtDir);
    }
    for (const candidate of candidates) {
      await removePath(candidate, removed, log);
    }
    return { removed };
  };

  const ensureTaskCache = async (taskId, manifest = {}) => {
    const taskDir = getTaskCacheDir(taskId);
    await fs.mkdir(taskDir, { recursive: true });
    await writeTaskManifest(taskId, manifest);
    return taskDir;
  };

  const writeTaskManifest = async (taskId, manifest = {}) => {
    const taskDir = getTaskCacheDir(taskId);
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(
      path.join(taskDir, 'manifest.json'),
      JSON.stringify({ taskId, updatedAt: new Date().toISOString(), ...manifest }, null, 2),
      'utf-8',
    );
  };

  const cleanupLegacySmartEditCaches = async (maxAgeMs = 0) => {
    const removed = [];
    const now = Date.now();
    for (const entry of await fs.readdir(tempDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !entry.name.startsWith(LEGACY_SMART_EDIT_PREFIX)) continue;
      const targetPath = path.join(tempDir, entry.name);
      if (maxAgeMs > 0) {
        const stat = await fs.stat(targetPath).catch(() => null);
        if (stat && now - stat.mtimeMs < maxAgeMs) continue;
      }
      await removePath(targetPath, removed, log);
    }
    return { removed };
  };

  const cleanupOrphanTaskCaches = async (ownedTaskIds) => {
    const keepDirs = new Set([...ownedTaskIds].map((id) => getTaskCacheDir(id)));
    const removed = [];
    await fs.mkdir(cacheRoot, { recursive: true });
    for (const entry of await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const targetPath = path.join(cacheRoot, entry.name);
      if (!keepDirs.has(targetPath)) {
        await removePath(targetPath, removed, log);
      }
    }
    return { removed };
  };

  const cleanupAbandonedStoreTemps = async () => {
    const removed = [];
    for (const entry of await fs.readdir(dataDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile()) continue;
      if (!/^antbot-store\.json\.\d+\.\d+\.tmp$/.test(entry.name)) continue;
      const targetPath = path.join(dataDir, entry.name);
      const stat = await fs.stat(targetPath).catch(() => null);
      if (stat && stat.size === 0) {
        await removePath(targetPath, removed, log);
      }
    }
    return { removed };
  };

  return {
    cacheRoot,
    dataDir,
    tempDir,
    getTaskCacheDir,
    ensureTaskCache,
    writeTaskManifest,
    cleanupTaskCache,
    cleanupLegacySmartEditCaches,
    cleanupOrphanTaskCaches,
    cleanupAbandonedStoreTemps,
    isManagedClipPath,
  };
}

function resetTaskToPending(task) {
  return {
    ...task,
    status: 'pending',
    progress: 0,
    step: '',
    message: '',
    error: '',
    srtContent: '',
    srtPath: '',
    tmpDir: '',
  };
}

async function reconcileEditTaskCaches(tasks, options = {}) {
  const manager = createClipArtifactManager(options);
  const resultTasks = [];
  const resumableReadyIds = new Set();
  const removed = [];
  let changed = false;

  for (const sourceTask of Array.isArray(tasks) ? tasks : []) {
    let task = { ...sourceTask };

    if (TERMINAL_STATUSES.has(task.status)) {
      const cleanup = await manager.cleanupTaskCache(task);
      removed.push(...cleanup.removed);
      if (task.tmpDir || task.srtPath || task.srtContent) {
        task = { ...task, tmpDir: '', srtPath: '', srtContent: '' };
        changed = true;
      }
    } else if (INTERRUPTED_STATUSES.has(task.status)) {
      const cleanup = await manager.cleanupTaskCache(task);
      removed.push(...cleanup.removed);
      task = resetTaskToPending(task);
      changed = true;
    } else if (task.status === 'ready') {
      const hasSubtitle = Boolean(task.srtPath) && await exists(task.srtPath);
      const srtIsManaged = hasSubtitle && manager.isManagedClipPath(path.dirname(task.srtPath));
      if (hasSubtitle && srtIsManaged) {
        resumableReadyIds.add(task.id);
      } else {
        const cleanup = await manager.cleanupTaskCache(task);
        removed.push(...cleanup.removed);
        task = resetTaskToPending(task);
        changed = true;
      }
    } else if (task.status === 'paused') {
      const cleanup = await manager.cleanupTaskCache(task);
      removed.push(...cleanup.removed);
      task = resetTaskToPending(task);
      changed = true;
    }

    resultTasks.push(task);
  }

  const orphans = await manager.cleanupOrphanTaskCaches(resumableReadyIds);
  removed.push(...orphans.removed);
  const legacy = await manager.cleanupLegacySmartEditCaches(0);
  removed.push(...legacy.removed);
  const storeTemps = await manager.cleanupAbandonedStoreTemps();
  removed.push(...storeTemps.removed);

  return { tasks: resultTasks, removed, changed: changed || removed.length > 0 };
}

module.exports = {
  CLIP_CACHE_DIR_NAME,
  DEFAULT_DATA_DIR,
  LEGACY_SMART_EDIT_PREFIX,
  createClipArtifactManager,
  reconcileEditTaskCaches,
  safeTaskId,
};
