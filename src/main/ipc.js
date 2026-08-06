const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, dialog, ipcMain, shell } = require('electron');
const { parseTaskInputSmart } = require('./services/aiTaskParser');
const { resolveDependencyPath } = require('./services/dependencyManager');

// ── App logger ──
let _logStream = null;
const LOG_DIR = path.join(os.homedir(), 'AntBot', 'logs');
const LOG_MAX_AGE_DAYS = 7;

function getLogFilePath() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(LOG_DIR, `app-${ts}.log`);
}

function cleanOldLogs() {
  try {
    const files = fsSync.readdirSync(LOG_DIR).filter((f) => f.startsWith('app-') && f.endsWith('.log'));
    const cutoff = Date.now() - LOG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      const filePath = path.join(LOG_DIR, file);
      try {
        const stat = fsSync.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fsSync.unlinkSync(filePath);
        }
      } catch {}
    }
  } catch {}
}

function initAppLog() {
  try {
    fsSync.mkdirSync(LOG_DIR, { recursive: true });
    cleanOldLogs();
    const logPath = getLogFilePath();
    _logStream = fsSync.createWriteStream(logPath, { flags: 'a' });
    // 记录环境信息
    appLog('info', `═══ AntBot 启动 ═══`);
    appLog('info', `版本: ${app.getVersion()} | ${os.type()} ${os.release()} ${os.arch()} | Node ${process.version} | Electron ${process.versions.electron || 'N/A'}`);
    appLog('info', `数据目录: ${path.join(os.homedir(), 'AntBot')}`);
    appLog('info', `日志文件: ${logPath}`);
  } catch {}
}

function appLog(level, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${message}\n`;
  try { _logStream?.write(line); } catch {}
  if (level === 'error') console.error(line.trim());
}
let _storeRef = null;
const { runStartupChecks } = require('./services/startupCheck');
const { runVoiceClone } = require('./services/voiceClone');
const { getDependencyState, repairMissingDependencies } = require('./services/dependencyManager');
const { getAppInfo } = require('./services/appInfo');

function registerIpcHandlers({ mainWindowRef, store, taskRunner, systemControl = null }) {
  _storeRef = store;
  initAppLog();

  // 初始化桥接服务日志
  const { setLogger: setBridgeLogger } = require('./services/bridgeServiceManager');
  setBridgeLogger(appLog);


  const sendWindowState = async (options = {}) => {
    const win = mainWindowRef();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('app:state', await buildInitialState({
      includeDependencies: false, includeHistory: false, ...options
    }));
  };

  const buildInitialState = async (options = {}) => {
    const includeHistory = options.includeHistory !== false;
    const includeDependencies = options.includeDependencies !== false;
    const [settings, history, dependencies] = await Promise.all([
      store.getSettings(),
      includeHistory ? store.getHistory() : Promise.resolve(undefined),
      includeDependencies ? getDependencyState() : Promise.resolve(undefined),
    ]);
    return {
      app: getAppInfo(),
      settings,
      history,
      running: taskRunner.running,
      progress: taskRunner.getSnapshot(),
      dependencies
    };
  };

  ipcMain.handle('app:get-initial-state', async () => buildInitialState());

  ipcMain.handle('settings:update', async (_event, partialSettings) => {
    const settings = await store.updateSettings(partialSettings);
    systemControl?.applySettings(settings);
    await sendWindowState();
    return settings;
  });

  ipcMain.handle('deps:get-state', async () => getDependencyState());
  ipcMain.handle('deps:repair', async () => repairMissingDependencies());

  ipcMain.handle('app:open-external', async (_event, url) => {
    const target = String(url || '').trim();
    if (!target) return false;
    if (!/^https?:\/\//i.test(target)) return false;
    await shell.openExternal(target);
    return true;
  });

  ipcMain.handle('app:reveal-in-folder', async (_event, filePath) => {
    const target = String(filePath || '').trim();
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
  });

  ipcMain.handle('startup:check', async () => {
    const [settings, loginState] = await Promise.all([
      store.getSettings(), store.getLoginState()
    ]);
    const result = await runStartupChecks(settings, loginState, () => {});
    for (const [service, state] of Object.entries(result.loginState)) {
      await store.setLoginState(service, state.loggedIn);
    }
    await sendWindowState();
    return result;
  });



  ipcMain.handle('voice:clone', async (_event, payload) => {
    const settings = await store.getSettings();
    appLog('info', `Voice clone started, samplePath=${payload?.samplePath}`);
    const pushProgress = (p) => {
      appLog('info', `Voice clone step: ${p.step} - ${p.message || ''}`);
      const win = mainWindowRef();
      if (win && !win.isDestroyed()) win.webContents.send('voice:clone-progress', { ...p, timestamp: new Date().toISOString() });
    };
    const pushLog = (message) => {
      appLog('info', `[voice] ${message}`);
      const win = mainWindowRef();
      if (win && !win.isDestroyed()) win.webContents.send('task:log', { runId: '', taskId: '', level: 'info', timestamp: new Date().toISOString(), message: `[语音克隆] ${message}` });
    };
    pushProgress({ status: 'running', step: '启动克隆', percent: 2, message: '开始执行语音克隆...' });
    try {
      const result = await runVoiceClone(payload || {}, settings, { log: pushLog, progress: pushProgress });
      const voiceClone = await store.setVoiceClone(result);
      await sendWindowState();
      appLog('info', `Voice clone completed: ${voiceClone.voiceId}`);
      pushProgress({ status: 'completed', step: '克隆完成', percent: 100, message: `语音克隆完成：${voiceClone.voiceId}` });
      return voiceClone;
    } catch (error) {
      const errMsg = String(error?.message || error);
      appLog('error', `Voice clone failed: ${errMsg}`);
      // User-friendly error for clipping
      let userMsg = errMsg;
      if (errMsg.includes('clipping') || errMsg.includes('reduce input gain')) {
        userMsg = '音频音量过大导致失真，请降低录音音量或换一个音量较小的音频文件';
      }
      pushProgress({ status: 'failed', step: '克隆失败', message: userMsg });
      throw new Error(userMsg);
    }
  });

  // 批量克隆音色（临时功能，用于预置音色）
  ipcMain.handle('voice:batch-clone', async (_event, { voices, refText }) => {
    const settings = await store.getSettings();
    const win = mainWindowRef();
    const results = [];
    for (const v of voices) {
      if (win && !win.isDestroyed()) win.webContents.send('voice:batch-progress', { name: v.name, status: 'cloning', total: voices.length, done: results.length });
      try {
        const result = await runVoiceClone({ samplePath: v.path, referenceText: refText, profileName: v.name, language: 'zh' }, settings, {
          log: () => {},
          progress: (p) => { if (win && !win.isDestroyed()) win.webContents.send('voice:batch-progress', { name: v.name, status: 'cloning', step: p.step, percent: p.percent, total: voices.length, done: results.length }); }
        });
        results.push({ name: v.name, ok: true, voiceId: result.voiceId });
      } catch (e) {
        results.push({ name: v.name, ok: false, error: e.message });
      }
    }
    if (win && !win.isDestroyed()) win.webContents.send('voice:batch-progress', { name: '', status: 'done', total: voices.length, done: results.length, results });
    return results;
  });

  // 下载预置音色
  ipcMain.handle('voice:download-preset', async (_event, { voiceId, voiceName, downloadUrl }) => {
    const { execFile } = require('node:child_process');
    const dataDir = path.join(os.homedir(), 'AntBot');
    const profilesDir = path.join(dataDir, 'voicebox-data', 'profiles');
    const profileDir = path.join(profilesDir, voiceId);
    const tmpDir = path.join(os.tmpdir(), `voice-dl-${voiceId}`);
    const zipPath = path.join(os.tmpdir(), `voice-${voiceId}.zip`);

    try {
      await fs.mkdir(profileDir, { recursive: true });
      await fs.mkdir(tmpDir, { recursive: true });

      // 下载 zip
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(zipPath, buf);

      // 解压（跨平台）
      await new Promise((resolve, reject) => {
        if (process.platform === 'win32') {
          const esc = s => String(s||'').replace(/'/g, "''");
          execFile('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${esc(zipPath)}' -DestinationPath '${esc(tmpDir)}' -Force`], { timeout: 30000 }, (err) => err ? reject(err) : resolve());
        } else {
          execFile('unzip', ['-o', '-q', zipPath, '-d', tmpDir], { timeout: 30000 }, (err) => err ? reject(err) : resolve());
        }
      });

      // 复制 WAV 到 profile 目录
      const wavFile = (await fs.readdir(tmpDir)).find(f => f.endsWith('.wav'));
      if (!wavFile) throw new Error('zip 中未找到 WAV 文件');
      await fs.copyFile(path.join(tmpDir, wavFile), path.join(profileDir, 'ref.wav'));

      // 更新 voices.json
      const voicesPath = path.join(dataDir, 'voices.json');
      let voices = [];
      try { voices = JSON.parse(await fs.readFile(voicesPath, 'utf-8')); } catch {}
      if (!voices.find(v => v.id === voiceId)) {
        voices.push({ id: voiceId, name: voiceName });
        await fs.writeFile(voicesPath, JSON.stringify(voices, null, 2));
      }

      appLog('info', `预置音色下载完成: ${voiceName} (${voiceId})`);
      return { ok: true };
    } catch (e) {
      appLog('error', `预置音色下载失败: ${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      await fs.unlink(zipPath).catch(() => {});
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  ipcMain.handle('dialog:pick-audio-file', async () => {
    const result = await dialog.showOpenDialog({ title: '选择语音样本文件', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg'] }] });
    return result.canceled || !result.filePaths?.length ? '' : result.filePaths[0];
  });

  ipcMain.handle('dialog:pick-video-file', async () => {
    const result = await dialog.showOpenDialog({ title: '选择本地视频文件', properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }] });
    return result.canceled || !result.filePaths?.length ? '' : result.filePaths[0];
  });

  ipcMain.handle('dialog:pick-file', async (_event, { title, filters } = {}) => {
    const result = await dialog.showOpenDialog({ title: title || '选择文件', properties: ['openFile'], filters: filters || [] });
    return result.canceled || !result.filePaths?.length ? '' : result.filePaths[0];
  });

  ipcMain.handle('dialog:pick-video-files', async () => {
    const result = await dialog.showOpenDialog({ title: '选择视频文件', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'flv', 'wmv', 'ts'] }] });
    return result.canceled || !result.filePaths?.length ? [] : result.filePaths;
  });

  ipcMain.handle('dialog:pick-directory', async (_event, title) => {
    const result = await dialog.showOpenDialog({ title: title || '选择文件夹', properties: ['openDirectory'] });
    return result.canceled || !result.filePaths?.length ? '' : result.filePaths[0];
  });

  ipcMain.handle('task:parse', async (_event, inputText, opts = {}) => {
    const smart = Boolean(opts?.smart);
    let apiConfig = null;
    const settings = await store.getSettings();
    if (smart) {
      const apiCfg = settings?.api || {};
      apiConfig = apiCfg.apiKey || (apiCfg.apiKeys || []).length
        ? { baseUrl: apiCfg.baseUrl, apiKey: apiCfg.apiKey, apiKeys: apiCfg.apiKeys || [apiCfg.apiKey].filter(Boolean), modelId: apiCfg.modelId }
        : null;
    }
    const taskDefaults = settings?.taskDefaults || null;
    return await parseTaskInputSmart(String(inputText || ''), { apiConfig, taskDefaults, log: (msg) => appLog('info', `[ai-parse] ${msg}`) });
  });

  ipcMain.handle('task:start', async (_event, inputText) => {
    let parsed;
    if (Array.isArray(inputText)) {
      parsed = { tasks: inputText.filter(t => t && typeof t === 'object' && typeof t.taskName === 'string'), warnings: [], source: 'provided' };
    } else {
      // 直接发送：走纯规则解析（无 AI），与旧版行为一致
      const settings = await store.getSettings();
      parsed = await parseTaskInputSmart(String(inputText || ''), { apiConfig: null, taskDefaults: settings?.taskDefaults || null, log: (msg) => appLog('info', `[rule-parse] ${msg}`) });
    }
    const tasks = parsed.tasks;
    if (!tasks.length) throw new Error(parsed.warnings?.[0] || '请输入至少一条任务。');
    const displayText = Array.isArray(inputText)
      ? tasks.map(t => t.rawLine || t.taskName || '').filter(Boolean).join('\n')
      : String(inputText || '').trim();
    const scheduled = taskRunner.enqueueTasks(tasks, {}, displayText);
    scheduled.promise.catch((error) => {
      const win = mainWindowRef();
      if (win && !win.isDestroyed()) win.webContents.send('task:log', { runId: '', taskId: '', level: 'error', timestamp: new Date().toISOString(), message: error.message });
    });
    return { started: true, queued: scheduled.queued, queuePosition: scheduled.queuePosition, taskCount: tasks.length, runId: scheduled.runId, taskIds: scheduled.taskIds, warnings: parsed.warnings || [], source: parsed.source || '' };
  });

  ipcMain.handle('history:clear', async () => {
    try {
      await store.clearHistory();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('history:remove', async (_event, recordId) => {
    try {
      const removed = await store.removeHistoryItem(String(recordId || ''));
      appLog('info', `[history] remove record=${recordId} removed=${removed}`);
      return { ok: removed };
    } catch (error) {
      appLog('error', `[history] remove record=${recordId} failed: ${error.message}`);
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('task:remove-persisted-run', async (_event, runId) => {
    await taskRunner.removePersistedTasksByRun(String(runId || ''));
    return { ok: true };
  });

  ipcMain.handle('task:stop', async () => { await taskRunner.stop({}); return { stopped: true }; });
  ipcMain.handle('task:stop-one', async (_event, taskId) => taskRunner.stopTask(taskId, {}));
  ipcMain.handle('task:resume-one', async (_event, payload) => taskRunner.resumeTask(payload?.taskId, {}, payload?.task || null));

  ipcMain.handle('task:republish', async (_event, taskId) => {
    try {
      const { publishVideo } = require('./services/publisher');
      const settings = await store.getSettings();
      const row = taskRunner.progressRows?.find(r => r.id === taskId);
      const historyItem = (await store.getHistory())?.flatMap(h => h.items || []).find(i => i.id === taskId);
      const persistedTasks = await taskRunner.loadPersistedTasks();
      const persistedItem = persistedTasks.find(t => t.id === taskId);
      const outputPath = row?.outputPath || historyItem?.outputPath || persistedItem?.outputPath;
      if (!outputPath) return { ok: false, error: '未找到视频文件路径' };

      // 检查视频文件是否存在
      let fileExists = false;
      try { const stat = fsSync.statSync(outputPath); fileExists = stat.isFile() && stat.size > 0; } catch {}
      if (!fileExists) {
        return { ok: false, error: 'FILE_DELETED', outputPath, rawLine: row?.rawLine || historyItem?.rawLine || persistedItem?.rawLine || '' };
      }

      const publishEnabled = settings?.publish?.enabled !== false;
      if (!publishEnabled) return { ok: false, error: '自动发布已关闭' };
      taskRunner.setTaskState(taskId, { status: 'running', step: '发布', progress: 95, message: '重新发布中...' });
      const task = { id: taskId, rawLine: row?.rawLine || historyItem?.rawLine || persistedItem?.rawLine || '', publishCopy: row?.publishCopy || historyItem?.publishCopy || persistedItem?.publishCopy || '', publishTopics: row?.publishTopics || historyItem?.publishTopics || persistedItem?.publishTopics || [], platforms: row?.platforms || historyItem?.platforms || persistedItem?.platforms || [], campaignName: row?.campaignName || historyItem?.campaignName || persistedItem?.campaignName || '' };
      const result = await publishVideo({ task, settings, outputPath, log: (msg) => appLog('info', `[republish] ${msg}`) });
      const publishedPlatforms = result?.platforms || [];
      const platformNames = publishedPlatforms.map(p => p === 'videoChannel' ? '视频号' : '抖音').join('、');
      taskRunner.setTaskState(taskId, { status: 'completed', progress: 100, step: '完成', message: platformNames ? `已发布到 ${platformNames}` : '发布完成' });
      await taskRunner.removePersistedTask(taskId);
      return { ok: true };
    } catch (e) {
      taskRunner.setTaskState(taskId, { status: 'warning', step: '部分完成', message: `发布失败: ${e.message}` });
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('task:get-persisted', async () => {
    return await taskRunner.loadPersistedTasks();
  });

  ipcMain.handle('task:reexecute', async (_event, rawLine) => {
    try {
      if (!rawLine) return { ok: false, error: '无任务内容' };
      const result = await taskRunner.startTasks(rawLine);
      return result;
    } catch (e) { return { ok: false, error: e.message }; }
  });


  ipcMain.handle('app:get-video-info', async (_event, videoPath) => {
    try {
      const stat = fsSync.statSync(videoPath);
      return { size: stat.size, exists: true };
    } catch {
      return { size: 0, exists: false };
    }
  });


  ipcMain.handle('app:log', async (_event, { level, message }) => {
    appLog(level || 'info', `[renderer] ${message}`);
  });

  ipcMain.handle('app:open-data-dir', async () => {
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    await fs.mkdir(dataDir, { recursive: true }).catch(() => {});
    await shell.openPath(dataDir);
    return { path: dataDir };
  });

  ipcMain.handle('deps:open-dir', async () => {
    const { getManagedBinDir } = require('./services/dependencyManager');
    const binDir = getManagedBinDir();
    await shell.openPath(binDir);
    return { path: binDir };
  });

  ipcMain.handle('deps:uninstall', async (_event, toolKey) => {
    const { resolveDependencyPath, getManagedBinDir } = require('./services/dependencyManager');
    const resolved = await resolveDependencyPath(String(toolKey || ''));
    const managedBin = getManagedBinDir();
    if (resolved && (resolved === managedBin || resolved.startsWith(managedBin + path.sep))) {
      await fs.rm(resolved, { force: true });
      return { ok: true, removed: resolved };
    }
    return { ok: false, message: '该依赖不是受管安装，无法自动删除。' };
  });

  ipcMain.handle('deps:reinstall', async (_event, toolKey) => {
    const win = mainWindowRef();
    const sendProgress = (p) => { if (win && !win.isDestroyed()) win.webContents.send('deps:progress', p); };
    try {
      sendProgress({ tool: toolKey, status: 'installing', message: `正在安装 ${toolKey}...` });
      const { ensureWindowsDependency } = require('./services/dependencyManager');
      const result = await ensureWindowsDependency(toolKey, (msg) => sendProgress({ tool: toolKey, status: 'installing', message: msg }));
      sendProgress({ tool: toolKey, status: 'completed', message: `${toolKey} 安装完成`, path: result });
      return { ok: true, path: result, state: await getDependencyState() };
    } catch (error) {
      sendProgress({ tool: toolKey, status: 'failed', message: error.message });
      return { ok: false, message: error.message };
    }
  });


  ipcMain.handle('deps:check', async (_event, tool) => {
    const { spawn } = require('node:child_process');
    const check = (cmd, args, timeoutMs = 10000) => new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '', done = false;
      const timer = setTimeout(() => { if (!done) { done = true; child.kill(); resolve({ ok: false, version: '' }); } }, timeoutMs);
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { out += d.toString(); });
      child.on('close', () => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: true, version: out.trim().split('\n')[0].slice(0, 80) }); } });
      child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, version: '' }); } });
    });
    if (tool === 'ffmpeg') return check(await resolveDependencyPath('ffmpeg') || 'ffmpeg', ['-version']);
    if (tool === 'python') return check(await resolveDependencyPath('python') || (process.platform === 'win32' ? 'python' : 'python3'), ['--version']);
    if (tool === 'whisper') {
      const pythonBin = await resolveDependencyPath('python') || (process.platform === 'win32' ? 'python' : 'python3');
      const r = await check(pythonBin, ['-c', 'import importlib; importlib.import_module("whisper"); print("ok")'], 15000);
      return { ok: r.ok, version: r.ok ? 'whisper (已安装)' : '' };
    }
    return { ok: false, version: '' };
  });

  ipcMain.handle('deps:install', async (_event, tool) => {
    const { spawn } = require('node:child_process');
    const win = mainWindowRef();
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('deps:install-progress', p); };

    if (tool === 'whisper') {
      send({ tool, status: 'installing', message: '正在安装 whisper...' });
      const pythonBin = await resolveDependencyPath('python') || 'python3';
      const pipArgs = process.platform === 'win32'
        ? [pythonBin, '-m', 'pip', 'install', 'openai-whisper']
        : [pythonBin, '-m', 'pip', 'install', '--break-system-packages', 'openai-whisper'];
      return new Promise((resolve) => {
        const child = spawn(pipArgs[0], pipArgs.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stderr = '';
        child.stdout.on('data', d => {
          const msg = d.toString().trim();
          if (msg) send({ tool, status: 'installing', message: msg.slice(0, 100) });
        });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', code => {
          if (code === 0) {
            send({ tool, status: 'completed', message: '安装完成' });
            resolve({ ok: true });
          } else {
            send({ tool, status: 'failed', message: stderr.slice(0, 200) || '安装失败' });
            resolve({ ok: false, message: stderr.slice(0, 200) });
          }
        });
        child.on('error', (e) => {
          send({ tool, status: 'failed', message: e.message });
          resolve({ ok: false, message: e.message });
        });
      });
    }
    return { ok: false, message: '不支持安装此依赖' };
  });


  const { register: registerVoicebox } = require('./ipc/voicebox');
  const { register: registerDownload } = require('./ipc/download');
  const { register: registerPublish } = require('./ipc/publish');
  const { register: registerEdit } = require('./ipc/edit');
  const { register: registerRemote } = require('./ipc/remote');
  const { register: registerUpdates } = require('./ipc/updates');
  const { register: registerModels } = require('./ipc/models');
  const { register: registerLibrary } = require('./ipc/library');

  registerVoicebox({ ipcMain, store, mainWindowRef, appLog });
  const downloadManager = registerDownload({ ipcMain, store, mainWindowRef, appLog });
  registerPublish({ ipcMain, store, mainWindowRef, appLog });
  const editScheduler = registerEdit({ ipcMain, store, mainWindowRef, appLog });
  registerRemote({ ipcMain, store, taskRunner, mainWindowRef, appLog });
  registerUpdates({ ipcMain, appLog });
  registerModels({ ipcMain, store, mainWindowRef });
  registerLibrary({ ipcMain, store, mainWindowRef, appLog });

  // 启动 HTTP API 服务
  {
    const { startApiServer } = require('./services/apiServer');
    startApiServer({ store, taskRunner, editScheduler, mainWindowRef, appLog });
  }

  return {
    cleanup: async () => {
      // 杀掉所有 spawned 子进程
      try {
        const { getManagedChildren } = require('./services/autoDubClient');
        const children = getManagedChildren();
        for (const child of children) { try { child.kill('SIGTERM'); } catch {} }
      } catch {}
      try { await editScheduler.shutdown(); } catch {}
      try { await downloadManager.cleanup(); } catch {}
    }
  };
}

module.exports = { registerIpcHandlers };
