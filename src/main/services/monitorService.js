const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const MONITORS_FILE = path.join(os.homedir(), 'AntBot', 'monitors.json');
const DEFAULT_CHECK_INTERVAL = 60; // 分钟

let _monitors = [];
let _timers = new Map(); // id -> interval
let _taskRunner = null;
let _store = null;
let _appLog = null;
let _mainWindowRef = null;
let _monitorBroadcast = null;
let _checking = new Set();
let _saveChain = Promise.resolve();
let _readyPromise = Promise.resolve();

function normalizeInterval(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(5, Math.round(parsed)) : DEFAULT_CHECK_INTERVAL;
}

function normalizeCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

const SOURCE_TYPES = new Set(['youtube', 'tiktok']);
const PROCESS_MODES = new Set(['download', 'edit', 'publish']);

function inferSourceType(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  } catch {}
  return 'youtube';
}

function normalizeProcessMode(value, isLegacy = false) {
  const mode = String(value || '').trim().toLowerCase();
  if (PROCESS_MODES.has(mode)) return mode;
  return isLegacy ? 'publish' : 'download';
}

function validateSourceUrl(value, sourceType = inferSourceType(value)) {
  const sourceUrl = String(value || '').trim();
  if (!sourceUrl) throw new Error('请填写博主主页链接');
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new Error('链接格式不正确');
  }
  const type = SOURCE_TYPES.has(sourceType) ? sourceType : inferSourceType(sourceUrl);
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('链接格式不正确');
  }
  const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';
  if (type === 'tiktok') {
    if (!(host === 'tiktok.com' || host.endsWith('.tiktok.com')) || !/^\/@[^/]+$/.test(pathname)) {
      throw new Error('请填写 TikTok 公开账号主页链接，例如 https://www.tiktok.com/@username');
    }
    return url.toString();
  }
  const youtubePath = /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(?:\/videos)?$/i;
  if (!(host === 'youtube.com' || host.endsWith('.youtube.com')) || !youtubePath.test(pathname)) {
    throw new Error('请填写 YouTube 频道或用户主页链接');
  }
  return url.toString();
}

function sourceVideoKey(sourceType, videoId) {
  const type = SOURCE_TYPES.has(sourceType) ? sourceType : 'youtube';
  return `${type}:${String(videoId || '').trim()}`;
}

function normalizeSourceVideo(entry, sourceType) {
  const type = SOURCE_TYPES.has(sourceType) ? sourceType : 'youtube';
  const id = String(entry?.id || entry?.display_id || '').trim();
  const rawUrl = String(entry?.webpage_url || entry?.webpageUrl || entry?.url || '').trim();
  const fallbackUrl = type === 'tiktok'
    ? `https://www.tiktok.com/video/${id}`
    : `https://www.youtube.com/watch?v=${id}`;
  const videoUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : fallbackUrl;
  return {
    id,
    title: String(entry?.title || entry?.fulltitle || id),
    url: videoUrl,
    webpageUrl: videoUrl,
    uploadDate: String(entry?.upload_date || entry?.uploadDate || ''),
    timestamp: Number(entry?.timestamp || 0) || 0,
    duration: Number(entry?.duration || 0) || 0,
    sourceType: type,
    key: sourceVideoKey(type, id),
  };
}

function processStages(value) {
  const mode = normalizeProcessMode(value, false);
  if (mode === 'publish') return ['download', 'edit', 'publish'];
  if (mode === 'edit') return ['download', 'edit'];
  return ['download'];
}

function log(level, msg) {
  if (_appLog) _appLog(level, `[monitor] ${msg}`);
  else console.log(`[monitor] ${msg}`);
}

function setContext({ taskRunner, store, appLog, mainWindowRef, monitorBroadcast = null }) {
  _taskRunner = taskRunner;
  _store = store;
  _appLog = appLog;
  _mainWindowRef = mainWindowRef;
  _monitorBroadcast = typeof monitorBroadcast === 'function' ? monitorBroadcast : null;
}

function notifyMonitor(monitor, extra = {}) {
  try {
    const win = typeof _mainWindowRef === 'function' ? _mainWindowRef() : null;
    if (win && !win.isDestroyed()) {
      win.webContents.send('monitor:updated', {
        ...extra,
        monitor: monitor ? { ...monitor } : null,
      });
    }
  } catch {}
  try {
    if (_monitorBroadcast) _monitorBroadcast({
      ...extra,
      monitor: monitor ? { ...monitor } : null,
    });
  } catch {}
}

async function ensureFile() {
  try {
    await fs.mkdir(path.dirname(MONITORS_FILE), { recursive: true });
    if (!fsSync.existsSync(MONITORS_FILE)) {
      await fs.writeFile(MONITORS_FILE, JSON.stringify([], null, 2), 'utf8');
    }
  } catch {}
}

async function loadMonitors() {
  await ensureFile();
  try {
    const raw = await fs.readFile(MONITORS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) _monitors = arr;
    else _monitors = [];
  } catch {
    _monitors = [];
  }
  // 兼容迁移：确保字段完整
  _monitors = _monitors.map(migrateMonitor);
  return _monitors;
}

async function saveMonitors() {
  await ensureFile();
  const snapshot = JSON.stringify(_monitors, null, 2);
  // 多个监控可能同时完成检查，串行写入避免同一文件的并发覆盖/交错。
  _saveChain = _saveChain.catch(() => {}).then(() => fs.writeFile(MONITORS_FILE, snapshot, 'utf8'));
  await _saveChain;
}

function migrateMonitor(m) {
  m = m && typeof m === 'object' ? m : {};
  const now = new Date().toISOString();
  const sourceUrl = String(m.sourceUrl || m.url || '');
  const hasProcessMode = Object.prototype.hasOwnProperty.call(m, 'processMode');
  const sourceType = SOURCE_TYPES.has(m.sourceType) ? m.sourceType : inferSourceType(sourceUrl);
  return {
    id: String(m.id || `mon-${Date.now()}-${Math.random().toString(36).slice(2,6)}`),
    enabled: m.enabled !== false,
    name: String(m.name || sourceUrl || '未命名监控'),
    sourceType,
    sourceUrl,
    platformHint: m.platformHint || sourceType,
    processMode: normalizeProcessMode(m.processMode, !hasProcessMode),
    checkIntervalMinutes: normalizeInterval(m.checkIntervalMinutes || m.intervalMinutes || DEFAULT_CHECK_INTERVAL),
    lastCheckAt: m.lastCheckAt || '',
    lastVideoId: m.lastVideoId || '',
    seenIds: Array.isArray(m.seenIds) ? m.seenIds.slice(0, 100) : [],
    overrides: {
      publishPlatforms: Array.isArray(m.overrides?.publishPlatforms) ? m.overrides.publishPlatforms : (Array.isArray(m.platforms) ? m.platforms : null),
      topics: Array.isArray(m.overrides?.topics) ? m.overrides.topics : null,
      styleName: m.overrides?.styleName || m.styleName || '',
      voiceId: m.overrides?.voiceId || m.voiceId || '',
      voiceProfileName: m.overrides?.voiceProfileName || m.profileName || '',
      isOriginal: typeof m.overrides?.isOriginal === 'boolean' ? m.overrides.isOriginal : (typeof m.isOriginal === 'boolean' ? m.isOriginal : null),
      campaignName: m.overrides?.campaignName || m.campaignName || '',
      intervalMinutes: m.overrides?.intervalMinutes || null,
    },
    stats: {
      totalFetched: normalizeCount(m.stats?.totalFetched),
      // 旧字段 totalPublished 实际统计的是入队数量，保留兼容迁移但改用准确命名。
      totalQueued: normalizeCount(m.stats?.totalQueued ?? m.stats?.totalPublished),
      lastError: String(m.stats?.lastError || ''),
      lastSuccessAt: m.stats?.lastSuccessAt || '',
    },
    createdAt: m.createdAt || now,
    updatedAt: now,
  };
}

async function waitForReady() {
  await _readyPromise;
}

async function getMonitors() {
  await waitForReady();
  return _monitors.map(m => ({ ...m }));
}

function findMonitor(id) {
  return _monitors.find(m => m.id === id);
}

async function addMonitor(data) {
  await waitForReady();
  const m = migrateMonitor({
    id: `mon-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    ...data,
    processMode: data?.processMode || 'download',
    createdAt: new Date().toISOString(),
  });
  m.sourceUrl = validateSourceUrl(m.sourceUrl, m.sourceType);
  _monitors.unshift(m);
  await saveMonitors();
  scheduleMonitor(m);
  notifyMonitor(m);
  log('info', `已添加监控: ${m.name} (${m.sourceUrl}) 间隔 ${m.checkIntervalMinutes} 分钟`);
  return m;
}

async function updateMonitor(id, patch = {}) {
  await waitForReady();
  const idx = _monitors.findIndex(m => m.id === id);
  if (idx < 0) throw new Error('监控不存在');
  const safePatch = patch && typeof patch === 'object' ? patch : {};
  const cur = _monitors[idx];
  const next = migrateMonitor({ ...cur, ...safePatch, id: cur.id, overrides: { ...cur.overrides, ...(safePatch.overrides||{}) } });
  next.sourceUrl = validateSourceUrl(next.sourceUrl, next.sourceType);
  // 保留 seenIds / stats / lastCheck
  if (!safePatch.seenIds) next.seenIds = cur.seenIds;
  if (!safePatch.stats) next.stats = cur.stats;
  if (!safePatch.lastCheckAt) next.lastCheckAt = cur.lastCheckAt;
  _monitors[idx] = next;
  await saveMonitors();
  // 重调度
  unscheduleMonitor(id);
  if (next.enabled) scheduleMonitor(next);
  notifyMonitor(next);
  log('info', `已更新监控: ${next.name}`);
  return next;
}

async function removeMonitor(id) {
  await waitForReady();
  const idx = _monitors.findIndex(m => m.id === id);
  if (idx < 0) throw new Error('监控不存在');
  unscheduleMonitor(id);
  const removed = _monitors.splice(idx, 1)[0];
  await saveMonitors();
  notifyMonitor(null, { id, removed: true });
  log('info', `已删除监控: ${removed.name}`);
  return removed;
}

function unscheduleMonitor(id) {
  const timer = _timers.get(id);
  if (timer) {
    clearInterval(timer);
    _timers.delete(id);
  }
}

function scheduleMonitor(monitor) {
  unscheduleMonitor(monitor.id);
  if (!monitor.enabled) return;
  const intervalMs = Math.max(5, Number(monitor.checkIntervalMinutes)) * 60 * 1000;
  const timer = setInterval(() => {
    checkMonitor(monitor.id).catch(e => log('error', `定时检查失败 ${monitor.name}: ${e.message}`));
  }, intervalMs);
  if (timer.unref) timer.unref();
  _timers.set(monitor.id, timer);
  log('info', `已调度监控 ${monitor.name} 每 ${monitor.checkIntervalMinutes} 分钟`);
}

function scheduleAll() {
  for (const m of _monitors) {
    if (m.enabled) scheduleMonitor(m);
  }
}

function unscheduleAll() {
  for (const id of [..._timers.keys()]) unscheduleMonitor(id);
}

// ── yt-dlp 拉取频道最新视频 ──
async function getYtDlpPath() {
  const { resolveDependencyPath, ensureWindowsDependency } = require('./dependencyManager');
  let p = await resolveDependencyPath('yt-dlp');
  if (!p && process.platform === 'win32') {
    try { p = await ensureWindowsDependency('yt-dlp', () => {}); } catch {}
  }
  return p;
}

async function runYtDlp(args, timeoutMs = 40000) {
  const ytdlp = await getYtDlpPath();
  let cmd;
  let cmdArgs;
  if (ytdlp && !ytdlp.endsWith('.py')) {
    cmd = ytdlp;
    cmdArgs = args;
  } else {
    // 回退 python -m yt_dlp
    const { resolveDependencyPath } = require('./dependencyManager');
    const py = await resolveDependencyPath('python') || 'python3';
    cmd = py;
    cmdArgs = ['-m', 'yt_dlp', ...args];
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, cmdArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(new Error('yt-dlp 超时'));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (code === 0) finish(null, { stdout, stderr });
      else finish(new Error(stderr.slice(0, 500) || `yt-dlp 退出码 ${code}`));
    });
  });
}

async function fetchSourceVideos(sourceType, sourceUrl, limit = 10) {
  // 使用 --flat-playlist 快速列举，不下载
  const args = [
    '--flat-playlist',
    '-J',
    '--playlist-end', String(limit),
    '--skip-download',
    '--no-warnings',
    '--no-check-certificates',
    sourceUrl,
  ];
  // 公开页面不强制登录；存在平台 cookies 时附加，兼容受限账号页面。
  try {
    const cookieName = sourceType === 'tiktok' ? 'tiktok.txt' : 'youtube.txt';
    const cookiesPath = path.join(os.homedir(), 'AntBot', 'cookies', cookieName);
    if (fsSync.existsSync(cookiesPath)) {
      args.push('--cookies', cookiesPath);
    }
  } catch {}
  const { stdout } = await runYtDlp(args, 35000);
  let data;
  try { data = JSON.parse(stdout); } catch { throw new Error('解析频道数据失败'); }
  const entries = Array.isArray(data.entries) ? data.entries : (Array.isArray(data) ? data : []);
  const videos = entries
    .filter(e => e && e.id)
    .map(e => normalizeSourceVideo(e, sourceType));
  return videos;
}

async function checkMonitor(monitorId) {
  await waitForReady();
  if (_checking.has(monitorId)) {
    log('info', `监控 ${monitorId} 正在检查中，跳过`);
    return { skipped: true };
  }
  const monitor = findMonitor(monitorId);
  if (!monitor) throw new Error('监控不存在');
  if (!monitor.enabled) return { skipped: true, reason: '已禁用' };
  _checking.add(monitorId);
  try {
    log('info', `检查监控: ${monitor.name} (${monitor.sourceType}) ${monitor.sourceUrl}`);
    const videos = await fetchSourceVideos(monitor.sourceType, monitor.sourceUrl, 10);
    if (findMonitor(monitorId) !== monitor || !monitor.enabled) {
      return { skipped: true, reason: !monitor.enabled ? '已禁用' : '监控已删除' };
    }
    if (!videos.length) {
      monitor.lastCheckAt = new Date().toISOString();
      monitor.stats.lastError = '未获取到视频列表';
      await saveMonitors();
      notifyMonitor(monitor);
      return { newVideos: [] };
    }
    // 去重：找出未见过的 id
    const seenSet = new Set(monitor.seenIds || []);
    const newVideos = [];
    for (const v of videos) {
      if (!seenSet.has(v.key) && !seenSet.has(v.id)) newVideos.push(v);
    }
    // 若是首次运行（seenIds 为空），仅记录不自动下载，避免历史视频批量下载
    const isFirstRun = !monitor.seenIds || monitor.seenIds.length === 0;
    if (isFirstRun) {
      monitor.seenIds = videos.map(v => v.key).slice(0, 50);
      monitor.lastCheckAt = new Date().toISOString();
      monitor.stats.totalFetched = videos.length;
      monitor.stats.lastError = '';
      await saveMonitors();
      notifyMonitor(monitor);
      log('info', `首次监控 ${monitor.name}，记录 ${videos.length} 个已有视频，下次发现新视频时自动下载`);
      return { newVideos: [], firstRun: true, videos };
    }
    if (!newVideos.length) {
      monitor.lastCheckAt = new Date().toISOString();
      monitor.stats.lastError = '';
      await saveMonitors();
      notifyMonitor(monitor);
      log('info', `监控 ${monitor.name} 暂无新视频`);
      return { newVideos: [] };
    }
    // 发现新视频，按监控独立配置构造任务并入队
    log('info', `监控 ${monitor.name} 发现 ${newVideos.length} 个新视频: ${newVideos.map(v=>v.title).join('、')}`);
    const tasks = [];
    const overrides = monitor.overrides || {};
    // 读取全局默认以回退
    let globalSettings = null;
    try { globalSettings = _store ? await _store.getSettings() : null; } catch {}
    const defaultPlatforms = overrides.publishPlatforms || globalSettings?.taskDefaults?.platforms || ['videoChannel'];
    const defaultTopics = overrides.topics || globalSettings?.taskDefaults?.topics || [];
    const defaultStyle = overrides.styleName || '';
    const defaultIsOriginal = overrides.isOriginal !== null && overrides.isOriginal !== undefined ? overrides.isOriginal : (globalSettings?.taskDefaults?.isOriginal || false);
    for (const v of newVideos) {
      const videoUrl = v.webpageUrl && v.webpageUrl.includes('http') ? v.webpageUrl : `https://www.youtube.com/watch?v=${v.id}`;
      tasks.push({
        id: `task-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        rawLine: videoUrl,
        taskName: v.title.slice(0, 80),
        videoUrl,
        timeRange: '',
        platforms: Array.isArray(defaultPlatforms) && defaultPlatforms.length ? defaultPlatforms : ['videoChannel'],
        publishCopy: v.title,
        publishTopics: Array.isArray(defaultTopics) ? defaultTopics.slice(0, 5) : [],
        campaignName: overrides.campaignName || '',
        publishAt: null,
        isOriginal: !!defaultIsOriginal,
        _styleName: defaultStyle,
        _voiceId: overrides.voiceId || '',
        _voiceProfileName: overrides.voiceProfileName || '',
        sourceType: v.sourceType,
        processMode: monitor.processMode,
        _monitorId: monitor.id,
        _monitorName: monitor.name,
      });
    }
    // 入队到主控流水线
    if (!_taskRunner || !tasks.length) {
      throw new Error('任务队列未就绪，视频暂未处理');
    }
    try {
      const inputText = `监控:${monitor.name} ${newVideos.length} 个新视频`;
      await _taskRunner.enqueueTasks(tasks, { id: 'monitor', name: `监控:${monitor.name}` }, inputText);
      monitor.stats.totalQueued += tasks.length;
      monitor.stats.lastSuccessAt = new Date().toISOString();
      monitor.stats.lastError = '';
      log('info', `监控 ${monitor.name} 已入队 ${tasks.length} 个任务`);
    } catch (e) {
      monitor.stats.lastError = e.message;
      throw e;
    }

    // 入队成功后再记录 seenIds，入队失败时下次检查仍会重试，避免漏处理。
    const newIds = newVideos.map(v => v.key);
    monitor.seenIds = [...newIds, ...monitor.seenIds].slice(0, 100);
    monitor.lastCheckAt = new Date().toISOString();
    monitor.stats.totalFetched += newVideos.length;
    await saveMonitors();
    notifyMonitor(monitor);
    return { newVideos, tasks };
  } catch (e) {
    const m = findMonitor(monitorId);
    if (m) {
      m.lastCheckAt = new Date().toISOString();
      m.stats.lastError = e.message;
      await saveMonitors().catch(()=>{});
      notifyMonitor(m);
    }
    throw e;
  } finally {
    _checking.delete(monitorId);
  }
}

async function checkMonitorNow(id) {
  return checkMonitor(id);
}

async function init() {
  _readyPromise = (async () => {
    await loadMonitors();
    scheduleAll();
    log('info', `监控服务已启动，共 ${ _monitors.length } 个监控，${_timers.size} 个定时器`);
  })();
  await _readyPromise;
}

function dispose() {
  unscheduleAll();
}

module.exports = {
  inferSourceType,
  normalizeProcessMode,
  validateSourceUrl,
  sourceVideoKey,
  normalizeSourceVideo,
  processStages,
  migrateMonitor,
  setContext,
  waitForReady,
  loadMonitors,
  saveMonitors,
  getMonitors,
  addMonitor,
  updateMonitor,
  removeMonitor,
  checkMonitor,
  checkMonitorNow,
  scheduleMonitor,
  unscheduleMonitor,
  scheduleAll,
  unscheduleAll,
  init,
  dispose,
  MONITORS_FILE,
};
