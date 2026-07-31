const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveDependencyPath } = require('../services/dependencyManager');
const { EditScheduler } = require('../services/editScheduler');

function register({ ipcMain, store, mainWindowRef, appLog }) {
  // ── Smart Edit Scheduler ──
  const editScheduler = new EditScheduler({
    onTaskUpdate: (t) => {
      const win = mainWindowRef();
      if (win && !win.isDestroyed()) win.webContents.send('edit:task-update', t);
    },
    onProgress: (p) => {
      const win = mainWindowRef();
      if (win && !win.isDestroyed()) win.webContents.send('edit:smart-progress', { ...p, timestamp: new Date().toISOString() });
    },
    log: (msg) => appLog('info', `[smart-edit] ${msg}`)
  });
  editScheduler.setSettingsGetter(() => store.getSettings());
  editScheduler.loadState().then(() => {
    // 恢复后如有 ready/composing 任务，自动继续调度
    const hasActive = [...editScheduler.tasks.values()].some(t => ['pending', 'ready', 'preparing', 'composing'].includes(t.status));
    if (hasActive) editScheduler._tick();
  });

  ipcMain.handle('edit:add-tasks', async (_event, tasks) => {
    const settings = await store.getSettings();
    const results = [];
    for (const taskData of tasks) {
      const t = editScheduler.addTask({
        ...taskData,
        voiceProfileId: taskData.voiceProfileId || settings.voiceClone?.voiceId || '',
        voiceProfileName: taskData.voiceProfileName || settings.voiceClone?.profileName || '',
        voiceSpeed: taskData.voiceSpeed || settings.style?.voiceSpeed || 1.1,
        apiConfig: taskData.apiConfig || {},
        outputDir: taskData.outputDir || settings.paths?.outputBaseDir || '',
        language: taskData.language || 'zh',
        frameRate: settings.edit?.frameRate || 1,
      });
      results.push(t);
    }
    return results;
  });

  ipcMain.handle('edit:start-task', async (_event, taskId) => { await editScheduler.startTask(taskId); return { ok: true }; });
  ipcMain.handle('edit:retry-task', async (_event, taskId) => { await editScheduler.retryTask(taskId); return { ok: true }; });
  ipcMain.handle('edit:update-task', async (_event, taskId, updates) => { await editScheduler.updateTask(taskId, updates); return { ok: true }; });
  ipcMain.handle('edit:pause-task', async (_event, taskId) => { editScheduler.pauseTask(taskId); return { ok: true }; });
  ipcMain.handle('edit:cancel-task', async (_event, taskId) => { await editScheduler.cancelTask(taskId); return { ok: true }; });
  ipcMain.handle('edit:remove-task', async (_event, taskId) => { await editScheduler.removeTask(taskId); return { ok: true }; });
  ipcMain.handle('edit:start-all', async () => { await editScheduler.startAll(); return { ok: true }; });
  ipcMain.handle('edit:get-tasks', async () => editScheduler.getAllTasks());

  ipcMain.handle('edit:extract-thumbnail', async (_event, videoPath) => {
    try {
      const thumbnailDir = path.join(os.homedir(), 'AntBot', 'thumbnails');
      await fs.mkdir(thumbnailDir, { recursive: true });

      // Generate unique filename based on video path
      const crypto = require('node:crypto');
      const hash = crypto.createHash('md5').update(videoPath).digest('hex').slice(0, 10);
      const thumbnailPath = path.join(thumbnailDir, `${hash}.jpg`);

      // Check if thumbnail already exists, if not extract it
      const exists = await fs.access(thumbnailPath).then(() => true).catch(() => false);
      if (!exists) {
        const ffmpegBin = await resolveDependencyPath('ffmpeg') || 'ffmpeg';

        // Extract frame at 1 second using ffmpeg
        const { spawn } = require('node:child_process');
        await new Promise((resolve, reject) => {
          const child = spawn(ffmpegBin, [
            '-i', videoPath,
            '-ss', '00:00:01',
            '-vframes', '1',
            '-vf', 'scale=120:-1',
            '-q:v', '5',
            '-y',
            thumbnailPath
          ], { windowsHide: true });
          child.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg failed')));
          child.on('error', reject);
        });
      }

      // Read file and convert to base64 data URL for reliable display
      const imageBuffer = await fs.readFile(thumbnailPath);
      const base64 = imageBuffer.toString('base64');
      const dataUrl = `data:image/jpeg;base64,${base64}`;

      return { ok: true, path: thumbnailPath, dataUrl };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('edit:get-history', async () => {
    try {
      const filePath = path.join(os.homedir(), 'AntBot', 'edit-history.json');
      return JSON.parse(await fs.readFile(filePath, 'utf-8').catch(() => '[]'));
    } catch { return []; }
  });

  ipcMain.handle('history:get', async () => {
    try {
      const filePath = path.join(os.homedir(), 'AntBot', 'edit-history.json');
      return JSON.parse(await fs.readFile(filePath, 'utf-8').catch(() => '[]'));
    } catch { return []; }
  });

  ipcMain.handle('edit:save-history', async (_event, record) => {
    try {
      const filePath = path.join(os.homedir(), 'AntBot', 'edit-history.json');
      let history = [];
      try { history = JSON.parse(await fs.readFile(filePath, 'utf-8')); } catch {}
      history.unshift(record);
      history = history.slice(0, 100);
      await fs.writeFile(filePath, JSON.stringify(history, null, 2), 'utf-8');
      return { ok: true, history };
    } catch (error) { return { ok: false, message: error.message }; }
  });

  ipcMain.handle('edit:delete-history', async (_event, { id, deleteFile }) => {
    try {
      const filePath = path.join(os.homedir(), 'AntBot', 'edit-history.json');
      let history = [];
      try { history = JSON.parse(await fs.readFile(filePath, 'utf-8')); } catch {}
      const target = history.find(h => h.id === id);
      if (target?.outputPath && deleteFile) await fs.unlink(target.outputPath).catch(() => {});
      history = history.filter(h => h.id !== id);
      await fs.writeFile(filePath, JSON.stringify(history, null, 2), 'utf-8');
      return { ok: true, history };
    } catch (error) { return { ok: false, message: error.message }; }
  });

  ipcMain.handle('api:usage', async () => {
    const { getUsageSummary } = require('../services/usageTracker');
    const settings = await store.getSettings();
    const keys = settings.api?.apiKeys || (settings.api?.apiKey ? [settings.api.apiKey] : []);
    return getUsageSummary(keys);
  });

  // 启动时清理过期缓存
  { const { cleanupStaleCache } = require('../services/smartEditor'); cleanupStaleCache().catch(() => {}); }

  return editScheduler;
}

module.exports = { register };
