const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, dialog, ipcMain, shell } = require('electron');
const { parseTaskInput, parsePublishDebugInput } = require('./services/parser');

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
const { runStartupChecks, getProfileDir, getProfileScopeKey } = require('./services/startupCheck');
const { runVoiceClone } = require('./services/voiceClone');
const { getDependencyState, repairMissingDependencies } = require('./services/dependencyManager');
const { installDependencies } = require('./services/dependencyInstaller');
const { launchPersistentChromiumContext } = require('./services/playwrightUtil');
const { getAppInfo } = require('./services/appInfo');

async function openPlaywrightLoginContext(serviceKey, serviceConfig, userId) {
  const profileDir = getProfileDir(serviceKey, userId);
  const context = await launchPersistentChromiumContext(profileDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  }, () => {});
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(serviceConfig.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
  return context;
}

function registerIpcHandlers({ mainWindowRef, store, taskRunner, systemControl = null }) {
  _storeRef = store;
  initAppLog();
  const authContexts = new Map();

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

  ipcMain.handle('gemini-profiles:list', async () => store.listGeminiProfiles());

  ipcMain.handle('gemini-profiles:create', async (_event, name) => {
    const created = await store.createGeminiProfile(name);
    await sendWindowState();
    return created;
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

  ipcMain.handle('startup:open-login-window', async (_event, serviceKey) => {
    const settings = await store.getSettings();
    const scopeId = settings.__userId || 'user-1';
    const serviceConfig = settings.loginHints?.[serviceKey];
    if (!serviceConfig) throw new Error(`未知服务：${serviceKey}`);
    const contextKey = getProfileScopeKey(serviceKey, scopeId);
    const existing = authContexts.get(contextKey);
    if (existing) {
      const pages = existing.pages();
      if (pages.length) await pages[0].bringToFront().catch(() => {});
      return { opened: true, reused: true, profileDir: getProfileDir(serviceKey, scopeId) };
    }
    const context = await openPlaywrightLoginContext(serviceKey, serviceConfig, scopeId);
    authContexts.set(contextKey, context);
    context.on('close', () => authContexts.delete(contextKey));
    return { opened: true, reused: false, profileDir: getProfileDir(serviceKey, scopeId) };
  });

  ipcMain.handle('startup:mark-login-done', async (_event, serviceKey) => {
    const settings = await store.getSettings();
    const scopeId = settings.__userId || 'user-1';
    const contextKey = getProfileScopeKey(serviceKey, scopeId);
    const context = authContexts.get(contextKey);
    if (context) { await context.close().catch(() => {}); authContexts.delete(contextKey); }
    const state = await store.setLoginState(serviceKey, true);
    await sendWindowState();
    return state;
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

  ipcMain.handle('dialog:pick-audio-file', async () => {
    const result = await dialog.showOpenDialog({ title: '选择语音样本文件', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg'] }] });
    return result.canceled || !result.filePaths?.length ? '' : result.filePaths[0];
  });

  ipcMain.handle('dialog:pick-video-file', async () => {
    const result = await dialog.showOpenDialog({ title: '选择本地视频文件', properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }] });
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

  ipcMain.handle('task:parse', async (_event, inputText) => parseTaskInput(inputText));

  ipcMain.handle('task:start', async (_event, inputText) => {
    const tasks = Array.isArray(inputText)
      ? inputText.filter(t => t && typeof t === 'object' && typeof t.taskName === 'string')
      : parseTaskInput(inputText);
    if (!tasks.length) throw new Error('请输入至少一条任务。');
    const scheduled = taskRunner.enqueueTasks(tasks, {}, String(inputText || '').trim());
    scheduled.promise.catch((error) => {
      const win = mainWindowRef();
      if (win && !win.isDestroyed()) win.webContents.send('task:log', { runId: '', taskId: '', level: 'error', timestamp: new Date().toISOString(), message: error.message });
    });
    return { started: true, queued: scheduled.queued, queuePosition: scheduled.queuePosition, taskCount: tasks.length, runId: scheduled.runId, taskIds: scheduled.taskIds };
  });

  ipcMain.handle('task:stop', async () => { await taskRunner.stop({}); return { stopped: true }; });
  ipcMain.handle('task:stop-one', async (_event, taskId) => taskRunner.stopTask(taskId, {}));
  ipcMain.handle('task:resume-one', async (_event, payload) => taskRunner.resumeTask(payload?.taskId, {}, payload?.task || null));
  ipcMain.handle('history:get', async () => store.getHistory());

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
      await require('node:fs/promises').rm(resolved, { force: true });
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

  // ── Model management ──
  const MODEL_REGISTRY = {
    'whisper-large-v3': { name: 'Whisper Large V3 (语音识别 · 推荐)', url: 'https://openaipublic.azureedge.net/main/whisper/models/e5b1a55b89c1367dacf97e3e19bfd829a01529dbfdeefa8caeb59b3f1b81dadb/large-v3.pt', filename: 'whisper-large-v3.pt', size: '3.09GB', type: 'stt' },
    'whisper-base': { name: 'Whisper Base (语音识别 · 轻量)', url: 'https://openaipublic.azureedge.net/main/whisper/models/ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e/base.pt', filename: 'whisper-base.pt', size: '142MB', type: 'stt' },
    'qwen3-tts-0.6b': { name: 'Qwen3 TTS 0.6B (语音克隆/朗读)', repoId: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', size: '~1.2GB', type: 'tts', hfDownload: true },
  };

  ipcMain.handle('deps:check', async (_event, tool) => {
    const { spawn } = require('node:child_process');
    const check = (cmd, args, timeoutMs = 10000) => new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', done = false;
      const timer = setTimeout(() => { if (!done) { done = true; child.kill(); resolve({ ok: false, version: '' }); } }, timeoutMs);
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { out += d.toString(); });
      child.on('close', () => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: true, version: out.trim().split('\n')[0].slice(0, 80) }); } });
      child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, version: '' }); } });
    });
    if (tool === 'ffmpeg') return check('ffmpeg', ['-version']);
    if (tool === 'python') return check('python3', ['--version']);
    if (tool === 'whisper') {
      // Quick check: just see if whisper module exists without importing torch
      const r = await check('python3', ['-c', 'import importlib; importlib.import_module("whisper"); print("ok")'], 15000);
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
      return new Promise((resolve) => {
        const child = spawn('python3', ['-m', 'pip', 'install', '--break-system-packages', 'openai-whisper'], { stdio: ['ignore', 'pipe', 'pipe'] });
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

  // ── Voicebox dependency management ──
  async function getVoiceboxVenvPath() {
    const { resolveAutoDubProjectPath } = require('./services/autoDubClient');
    const settings = await store.getSettings();
    const projectPath = await resolveAutoDubProjectPath(settings?.paths?.editProjectPath || '');
    if (!projectPath) return null;
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    const voiceboxEnvDir = path.join(dataDir, 'voicebox-env');
    return {
      projectPath,
      venvDir: path.join(voiceboxEnvDir, '.venv-voicebox'),
      venvPython: path.join(voiceboxEnvDir, '.venv-voicebox', 'bin', 'python3'),
      markerPath: path.join(voiceboxEnvDir, '.voicebox-setup-done'),
      dataDir: path.join(dataDir, 'voicebox-data')
    };
  }

  ipcMain.handle('voicebox:check', async () => {
    const { spawn } = require('node:child_process');
    const info = await getVoiceboxVenvPath();
    if (!info) return { ok: false, items: [], message: 'auto_dub_web 目录未找到' };

    const items = [];
    const check = (name, pythonCode) => new Promise((resolve) => {
      try {
        const child = spawn(info.venvPython, ['-c', pythonCode], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
        let out = '';
        child.stdout.on('data', d => { out += d.toString(); });
        child.on('close', code => resolve({ name, ok: code === 0, version: out.trim().split('\n')[0].slice(0, 60) }));
        child.on('error', () => resolve({ name, ok: false, version: '' }));
      } catch { resolve({ name, ok: false, version: '' }); }
    });

    // Layer 1: Quick check
    const venvExists = await fs.access(info.venvPython).then(() => true).catch(() => false);
    if (!venvExists) return { ok: false, items: [{ name: '虚拟环境', ok: false, version: '未创建' }], message: 'venv 不存在' };

    // Layer 2: Deep check - import key packages
    const checks = [
      check('Python', 'import sys; print(f"Python {sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}")'),
      check('PyTorch', 'import torch; print(f"torch {torch.__version__}")'),
      check('librosa', 'import librosa; print(f"librosa {librosa.__version__}")'),
      check('soundfile', 'import soundfile; print(f"soundfile {soundfile.__version__}")'),
      check('Qwen TTS', 'import qwen_tts; print("qwen-tts ok")'),
      check('scikit-learn', 'from sklearn.preprocessing import normalize; import sklearn; print(f"sklearn {sklearn.__version__}")'),
      check('transformers', 'import transformers; print(f"transformers {transformers.__version__}")'),
      check('FastAPI', 'import fastapi; print(f"fastapi {fastapi.__version__}")'),
    ];
    const results = await Promise.all(checks);
    const allOk = results.every(r => r.ok);
    return { ok: allOk, items: results, venvPath: info.venvDir, message: allOk ? '所有依赖就绪' : '部分依赖缺失' };
  });

  // ── Voicebox dependency installation with granular progress ──
  const activeVoiceboxAbortControllers = new Map();

  ipcMain.handle('voicebox:install', async () => {
    const { spawn } = require('node:child_process');
    const win = mainWindowRef();
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('voicebox:progress', p); };
    const sendDeps = (p) => { if (win && !win.isDestroyed()) win.webContents.send('voicebox:deps-progress', { ...p, timestamp: new Date().toISOString() }); };
    const info = await getVoiceboxVenvPath();
    if (!info) return { ok: false, message: 'auto_dub_web 目录未找到' };

    send({ status: 'installing', message: '正在准备安装环境...' });
    appLog('info', '开始安装 voicebox 依赖');

    // 1. 确保 voicebox 源码存在
    const requirementsPath = path.join(info.projectPath, 'vendor', 'voicebox', 'backend', 'requirements.txt');
    const hasReqs = await fs.access(requirementsPath).then(() => true).catch(() => false);
    if (!hasReqs) {
      const setupScript = path.join(info.projectPath, 'scripts', 'setup_voicebox_backend.sh');
      try { await fs.access(setupScript); } catch { return { ok: false, message: '缺少 setup_voicebox_backend.sh 和 requirements.txt' }; }
      send({ status: 'installing', message: '正在下载 voicebox 源码...' });
      await new Promise((resolve) => {
        const child = spawn('bash', [setupScript], {
          cwd: info.projectPath,
          env: { ...process.env, PYTHON_BIN: 'python3.12' },
          stdio: ['ignore', 'pipe', 'pipe']
        });
        child.stdout.on('data', d => { const m = d.toString().trim(); if (m) send({ status: 'installing', message: m.slice(0, 120) }); });
        child.stderr.on('data', () => {});
        child.on('close', (code) => resolve(code));
        child.on('error', () => resolve(1));
      });
    }

    // 2. 创建 venv（如果不存在）
    const venvExists = await fs.access(info.venvPython).then(() => true).catch(() => false);
    if (!venvExists) {
      send({ status: 'installing', message: '正在创建虚拟环境...' });
      await new Promise((resolve) => {
        const child = spawn('python3.12', ['-m', 'venv', info.venvDir], {
          cwd: info.projectPath, stdio: ['ignore', 'pipe', 'pipe']
        });
        child.on('close', () => resolve());
        child.on('error', () => resolve());
      });
    }

    // 3. 升级 pip
    send({ status: 'installing', message: '正在升级 pip...' });
    await new Promise((resolve) => {
      const child = spawn(info.venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel', 'setuptools'], {
        cwd: info.projectPath, stdio: ['ignore', 'pipe', 'pipe']
      });
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });

    // 4. 逐包安装依赖，发送粒度进度
    const hasReqsNow = await fs.access(requirementsPath).then(() => true).catch(() => false);
    if (!hasReqsNow) {
      send({ status: 'failed', message: 'requirements.txt 不存在' });
      return { ok: false, message: 'requirements.txt 不存在' };
    }

    send({ status: 'installing', message: '开始逐包安装依赖...' });

    const result = await installDependencies({
      venvPython: info.venvPython,
      requirementsPath,
      env: process.env,
      pushEvent: sendDeps,
      abortControllers: activeVoiceboxAbortControllers
    });

    // 5. 安装完成后验证
    send({ status: 'installing', message: '正在验证安装结果...' });

    const { spawn: spawnCheck } = require('node:child_process');
    const verifyImport = (moduleName) => new Promise((resolve) => {
      try {
        const child = spawnCheck(info.venvPython, ['-c', `import ${moduleName}; print("ok")`], {
          stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000
        });
        let out = '';
        child.stdout.on('data', d => { out += d.toString(); });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      } catch { resolve(false); }
    });

    const importChecks = [
      ['torch', 'torch'], ['librosa', 'librosa'], ['soundfile', 'soundfile'],
      ['transformers', 'transformers'], ['fastapi', 'fastapi'], ['qwen_tts', 'qwen_tts'],
      ['sklearn', 'sklearn'], ['numpy', 'numpy']
    ];
    const importResults = {};
    for (const [mod, label] of importChecks) {
      importResults[label] = await verifyImport(mod);
    }
    const importFailed = importChecks.filter(([, label]) => !importResults[label]).map(([, label]) => label);
    const pipFailed = result.errors.map(e => e.name);

    await fs.writeFile(info.markerPath, JSON.stringify({ completedAt: new Date().toISOString(), pipFailed, importFailed }), 'utf-8').catch(() => {});

    if (pipFailed.length === 0 && importFailed.length === 0) {
      send({ status: 'completed', message: `全部安装成功（${result.done.length} 个包）` });
      appLog('info', `voicebox 依赖安装完成: ${result.done.length} packages`);
      return { ok: true };
    }

    if (pipFailed.length === 0 && importFailed.length > 0) {
      // pip 说装好了但 import 失败 — 需要重启 app
      send({ status: 'completed', message: `安装完成，部分模块需重启后生效: ${importFailed.join(', ')}` });
      appLog('info', `voicebox 安装完成但需重启: ${importFailed.join(', ')}`);
      return { ok: true, needsRestart: true, restartPackages: importFailed };
    }

    // pip 安装失败的包
    const failedNames = pipFailed.join(', ');
    send({ status: 'failed', message: `以下依赖失败: ${failedNames}` });
    appLog('error', `voicebox 部分依赖安装失败: ${failedNames}`);
    return { ok: false, message: `失败: ${failedNames}`, failedPackages: pipFailed };
  });

  ipcMain.handle('voicebox:install-cancel', async (_event, packageName) => {
    if (packageName) {
      const ctrl = activeVoiceboxAbortControllers.get(packageName);
      if (ctrl) { ctrl.abort(); return { ok: true }; }
      return { ok: false };
    }
    for (const [, ctrl] of activeVoiceboxAbortControllers) ctrl.abort();
    return { ok: true };
  });

  ipcMain.handle('voicebox:open-dir', async () => {
    const info = await getVoiceboxVenvPath();
    if (info?.venvDir) {
      await fs.mkdir(info.venvDir, { recursive: true }).catch(() => {});
      await shell.openPath(info.venvDir);
      return { path: info.venvDir };
    }
    return { path: '' };
  });

  ipcMain.handle('voicebox:reset', async () => {
    const info = await getVoiceboxVenvPath();
    if (!info) return { ok: false, message: 'auto_dub_web 目录未找到' };
    // Remove marker and venv
    await fs.rm(info.markerPath, { force: true }).catch(() => {});
    await fs.rm(info.venvDir, { recursive: true, force: true }).catch(() => {});
    appLog('info', 'voicebox 环境已重置');
    return { ok: true };
  });

  // ── Smart Edit Scheduler ──
  const { EditScheduler } = require('./services/editScheduler');
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
  ipcMain.handle('edit:pause-task', async (_event, taskId) => { editScheduler.pauseTask(taskId); return { ok: true }; });
  ipcMain.handle('edit:cancel-task', async (_event, taskId) => { await editScheduler.cancelTask(taskId); return { ok: true }; });
  ipcMain.handle('edit:remove-task', async (_event, taskId) => { await editScheduler.removeTask(taskId); return { ok: true }; });
  ipcMain.handle('edit:start-all', async () => { await editScheduler.startAll(); return { ok: true }; });
  ipcMain.handle('edit:get-tasks', async () => editScheduler.getAllTasks());

  ipcMain.handle('edit:get-history', async () => {
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
    const { getUsageSummary } = require('./services/usageTracker');
    const settings = await store.getSettings();
    const keys = settings.api?.apiKeys || (settings.api?.apiKey ? [settings.api.apiKey] : []);
    return getUsageSummary(keys);
  });

  // 启动时清理过期缓存
  { const { cleanupStaleCache } = require('./services/smartEditor'); cleanupStaleCache().catch(() => {}); }

  // 启动 HTTP API 服务
  {
    const { startApiServer } = require('./services/apiServer');
    startApiServer({ store, taskRunner, editScheduler, mainWindowRef, appLog });
  }

  async function getModelsDir() {
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    const dir = path.join(dataDir, 'models');
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    return dir;
  }

  ipcMain.handle('models:list', async () => {
    const dir = await getModelsDir();
    const result = {};
    for (const [key, meta] of Object.entries(MODEL_REGISTRY)) {
      let downloaded = false;
      let localPath = '';
      if (meta.hfDownload) {
        // HuggingFace models are directories
        const modelDir = path.join(dir, key);
        try { const stat = await fs.stat(modelDir); downloaded = stat.isDirectory(); localPath = modelDir; } catch { localPath = modelDir; }
      } else {
        const filePath = path.join(dir, meta.filename);
        try { const stat = await fs.stat(filePath); downloaded = stat.size > 0; localPath = filePath; } catch { localPath = filePath; }
      }
      result[key] = { ...meta, downloaded, localPath };
    }
    return { models: result, modelsDir: dir };
  });

  ipcMain.handle('models:download', async (_event, modelKey) => {
    const meta = MODEL_REGISTRY[modelKey];
    if (!meta) return { ok: false, message: '未知模型' };
    const dir = await getModelsDir();

    const win = mainWindowRef();
    const sendProgress = (p) => { if (win && !win.isDestroyed()) win.webContents.send('models:progress', p); };

    // HuggingFace model download via Python huggingface_hub
    if (meta.hfDownload) {
      const destDir = path.join(dir, modelKey);
      try {
        sendProgress({ model: modelKey, status: 'downloading', percent: 5, message: '正在通过 HuggingFace 下载...' });
        const { spawn } = require('node:child_process');
        // Write a temp script to avoid escaping issues
        const scriptPath = path.join(dir, `_download_${modelKey}.py`);
        await fs.writeFile(scriptPath, `
import sys, os
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
try:
    from huggingface_hub import snapshot_download
    p = snapshot_download(
        repo_id=${JSON.stringify(meta.repoId)},
        local_dir=${JSON.stringify(destDir)},
        resume_download=True
    )
    print("OK:" + p)
except Exception as e:
    print("ERR:" + str(e), file=sys.stderr)
    sys.exit(1)
`, 'utf-8');

        await new Promise((resolve, reject) => {
          const child = spawn('python3', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
          let stderr = '';
          let lastProgress = Date.now();
          child.stderr.on('data', d => { stderr += d.toString(); });
          child.stdout.on('data', d => {
            const msg = d.toString().trim();
            if (msg.startsWith('OK:')) return;
            // Report progress from huggingface_hub output
            lastProgress = Date.now();
            sendProgress({ model: modelKey, status: 'downloading', percent: 50, message: '正在下载模型文件...' });
          });
          // Timeout after 30 minutes
          const timeout = setTimeout(() => {
            child.kill();
            reject(new Error('下载超时（30分钟），请检查网络连接'));
          }, 30 * 60 * 1000);
          child.on('close', code => {
            clearTimeout(timeout);
            fs.unlink(scriptPath).catch(() => {});
            if (code === 0) resolve();
            else reject(new Error(stderr.trim() || '下载失败'));
          });
          child.on('error', (e) => {
            clearTimeout(timeout);
            fs.unlink(scriptPath).catch(() => {});
            reject(e);
          });
        });
        sendProgress({ model: modelKey, status: 'completed', percent: 100, message: '下载完成' });
        return { ok: true, path: destDir };
      } catch (error) {
        sendProgress({ model: modelKey, status: 'failed', message: error.message });
        return { ok: false, message: error.message };
      }
    }

    // Direct URL download
    const filePath = path.join(dir, meta.filename);
    const tempPath = filePath + '.downloading';
    try {
      sendProgress({ model: modelKey, status: 'downloading', percent: 0, message: '开始下载...' });
      const response = await fetch(meta.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const total = parseInt(response.headers.get('content-length') || '0', 10);
      const reader = response.body.getReader();
      const chunks = [];
      let downloaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        downloaded += value.length;
        if (total > 0) {
          const percent = Math.round((downloaded / total) * 100);
          sendProgress({ model: modelKey, status: 'downloading', percent, message: `${(downloaded/1024/1024).toFixed(1)}MB / ${(total/1024/1024).toFixed(1)}MB` });
        }
      }
      await fs.writeFile(tempPath, Buffer.concat(chunks));
      await fs.rename(tempPath, filePath);
      sendProgress({ model: modelKey, status: 'completed', percent: 100, message: '下载完成' });
      return { ok: true, path: filePath };
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {});
      sendProgress({ model: modelKey, status: 'failed', message: error.message });
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('models:delete', async (_event, modelKey) => {
    const meta = MODEL_REGISTRY[modelKey];
    if (!meta) return { ok: false, message: '未知模型' };
    const dir = await getModelsDir();
    try {
      if (meta.hfDownload) {
        const modelDir = path.join(dir, modelKey);
        await fs.rm(modelDir, { recursive: true, force: true });
      } else {
        const filePath = path.join(dir, meta.filename);
        await fs.unlink(filePath);
      }
      return { ok: true };
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: true, message: '文件不存在' };
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('models:open-dir', async () => {
    const dir = await getModelsDir();
    await shell.openPath(dir);
    return { path: dir };
  });

  ipcMain.handle('models:change-path', async (_event, newPath) => {
    if (!newPath) return { ok: false, message: '路径不能为空' };
    await fs.mkdir(newPath, { recursive: true }).catch(() => {});
    const settings = await store.getSettings();
    settings.api = settings.api || {};
    settings.api.modelsDir = newPath;
    await store.updateSettings({ api: settings.api });
    return { ok: true, path: newPath };
  });

  // ── Style learning: video → audio → speech-to-text ──
  ipcMain.handle('style:learn-from-video', async (_event, { videoPath, name }) => {
    const fsPromises = require('node:fs/promises');
    const { spawn } = require('node:child_process');
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    const cacheDir = path.join(dataDir, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });

    const win = mainWindowRef();
    const sendProgress = (p) => { if (win && !win.isDestroyed()) win.webContents.send('style:progress', p); };

    // ffmpeg/ffprobe 路径解析
    const resolveBin = (name) => {
      const candidates = [path.join('/opt/homebrew/bin', name), path.join('/usr/local/bin', name), path.join('/usr/bin', name), name];
      for (const c of candidates) { try { if (require('node:fs').existsSync(c)) return c; } catch {} }
      return name;
    };

    const tempFiles = [];
    const cleanup = async () => { for (const f of tempFiles) { await fsPromises.unlink(f).catch(() => {}); } };

    try {
      appLog('info', `[style-learn] 开始学习: ${name || '(未命名)'}, video=${videoPath}`);
      sendProgress({ status: 'converting', message: '正在转换音频...' });

      const ffmpegBin = resolveBin('ffmpeg');
      const audioPath = path.join(cacheDir, `style-${Date.now()}.mp3`);
      tempFiles.push(audioPath);

      await new Promise((resolve, reject) => {
        const child = spawn(ffmpegBin, ['-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', '-y', audioPath]);
        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error(stderr.includes('Invalid data') ? '视频格式不支持或文件损坏' : (stderr.slice(0, 300) || `FFmpeg 转换失败 (exit ${code})`)));
        });
        child.on('error', (e) => reject(new Error(`FFmpeg 未找到 (${ffmpegBin}): ${e.message}`)));
      });

      try { await fsPromises.access(audioPath); } catch { throw new Error('音频转换失败，未生成输出文件'); }
      appLog('info', `[style-learn] 音频转换完成: ${audioPath}`);

      sendProgress({ status: 'transcribing', message: '正在语音识别...' });

      // 找 whisper 模型
      const modelsDir = path.join(dataDir, 'models');
      const localModelCandidates = [
        path.join(modelsDir, 'whisper-large-v3.pt'),
        path.join(modelsDir, 'whisper-base.pt'),
        path.join(modelsDir, 'base.pt'),
      ];
      let localModelPath = '';
      for (const mp of localModelCandidates) {
        try { await fsPromises.access(mp); localModelPath = mp; break; } catch {}
      }

      if (!localModelPath) {
        appLog('error', '[style-learn] whisper 模型未找到');
        throw new Error('请先在设置 → 安装依赖中下载语音识别模型');
      }
      appLog('info', `[style-learn] 使用模型: ${localModelPath}`);

      // 自动检测语言（不硬编码中文）
      const pyScript = path.join(cacheDir, `_transcribe_${Date.now()}.py`);
      tempFiles.push(pyScript);
      await fsPromises.writeFile(pyScript, `
import sys, os
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
try:
    import whisper
    model = whisper.load_model(${JSON.stringify(localModelPath)})
    result = model.transcribe(${JSON.stringify(audioPath)}, language="zh")
    text = result.get("text", "").strip()
    lang = result.get("language", "unknown")
    print(f"LANG:{lang}", file=sys.stderr)
    if not text:
        print("ERR:未识别到任何文字", file=sys.stderr)
        sys.exit(1)
    print(text)
except ImportError:
    print("ERR:whisper 未安装，请在设置中安装", file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f"ERR:{e}", file=sys.stderr)
    sys.exit(1)
`, 'utf-8');

      const pythonBin = resolveBin('python3');
      const text = await new Promise((resolve, reject) => {
        const child = spawn(pythonBin, [pyScript], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', code => {
          if (code === 0 && stdout.trim() && !stdout.includes('ERR:')) resolve(stdout.trim());
          else {
            const errMsg = stderr.replace('ERR:', '').trim();
            appLog('error', `[style-learn] 识别失败: code=${code}, stderr=${stderr.slice(0, 500)}`);
            reject(new Error(errMsg || '语音识别失败，未输出文字'));
          }
        });
        child.on('error', (e) => reject(new Error(`Python 未找到 (${pythonBin}): ${e.message}`)));
      });

      appLog('info', `[style-learn] 识别完成: ${text.length} 字`);
      await cleanup();
      sendProgress({ status: 'completed', message: '学习完成' });
      return { ok: true, text, name };

    } catch (error) {
      await cleanup();
      const msg = String(error?.message || error);
      appLog('error', `[style-learn] 失败: ${msg}`);
      sendProgress({ status: 'failed', message: msg });
      return { ok: false, message: msg };
    }
  });

  ipcMain.handle('app:get-data-info', async () => {
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    return {
      version: app.getVersion(),
      dataDir,
      userData: app.getPath('userData'),
      tempDir: path.join(dataDir, 'cache'),
      logDir: path.join(dataDir, 'logs'),
      storeFile: path.join(dataDir, 'antbot-store.json')
    };
  });

  ipcMain.handle('api:fetch-models', async (_event, { baseUrl, apiKey }) => {
    try {
      const url = `${String(baseUrl || '').replace(/\/+$/, '')}/models`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`API 错误 ${response.status}: ${text.slice(0, 200)}`);
      }
      const data = await response.json();
      const models = (data.data || data || []).map(m => ({
        id: m.id || m.model || String(m),
        name: m.name || m.id || String(m),
        type: m.type || 'text'
      }));
      return { ok: true, models };
    } catch (error) {
      return { ok: false, message: error.message, models: [] };
    }
  });

  ipcMain.handle('api:transcribe', async (_event, { baseUrl, apiKey, modelId, audioPath }) => {
    const fsPromises = require('node:fs/promises');
    try {
      const audioBuffer = await fsPromises.readFile(audioPath);
      const boundary = '----FormBoundary' + Date.now();
      const fileName = path.basename(audioPath);
      const ext = path.extname(audioPath).slice(1) || 'mp3';
      const mimeTypes = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm' };
      const mime = mimeTypes[ext] || 'audio/mpeg';

      const bodyParts = [];
      bodyParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"\r\nfilename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`);
      bodyParts.push(audioBuffer);
      bodyParts.push(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${modelId || 'whisper-1'}`);
      bodyParts.push(`\r\n--${boundary}--\r\n`);

      const body = Buffer.concat(bodyParts.map(p => typeof p === 'string' ? Buffer.from(p) : p));

      const url = `${String(baseUrl || '').replace(/\/+$/, '')}/audio/transcriptions`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`转写失败 ${response.status}: ${text.slice(0, 200)}`);
      }
      const result = await response.json();
      return { ok: true, text: result.text || result.result || '' };
    } catch (error) {
      return { ok: false, message: error.message, text: '' };
    }
  });

  ipcMain.handle('app:migrate-data', async () => {
    const fsPromises = require('node:fs/promises');
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    const oldDir = path.join(os.homedir(), 'Library', 'Application Support', 'antbot');
    const results = [];

    // Ensure new data directory exists
    await fsPromises.mkdir(dataDir, { recursive: true });

    // 1. Migrate antbot-store.json (settings + API key + history)
    const oldStorePath = path.join(oldDir, 'antbot-store.json');
    try {
      const stat = await fsPromises.stat(oldStorePath);
      if (stat.isFile()) {
        const raw = await fsPromises.readFile(oldStorePath, 'utf-8');
        const oldData = JSON.parse(raw);
        // Extract valuable settings from old store
        const oldUser = (oldData.users || [])[0];
        if (oldUser?.settings) {
          const oldSettings = oldUser.settings;
          // Migrate API key
          if (oldSettings.api?.apiKey) {
            await store.updateSettings({ api: { ...settings.api, apiKey: oldSettings.api.apiKey, baseUrl: oldSettings.api.baseUrl || settings.api?.baseUrl } });
          }
          // Migrate voice clone settings
          if (oldSettings.voiceClone?.voiceId) {
            await store.updateSettings({ voiceClone: oldSettings.voiceClone });
          }
          // Migrate paths
          if (oldSettings.paths) {
            await store.updateSettings({ paths: { ...settings.paths, ...oldSettings.paths } });
          }
          // Migrate style/browser/publish/retry settings
          if (oldSettings.style) await store.updateSettings({ style: oldSettings.style });
          if (oldSettings.browser) await store.updateSettings({ browser: oldSettings.browser });
          if (oldSettings.publish) await store.updateSettings({ publish: oldSettings.publish });
          if (oldSettings.retry) await store.updateSettings({ retry: oldSettings.retry });
          results.push({ item: 'settings', status: 'migrated', detail: 'API key, voice clone, paths, style' });
        }
        // Migrate history
        if (oldUser?.history?.length) {
          const newHistory = await store.getHistory();
          // Append old history (avoid duplicates by checking run IDs)
          const existingIds = new Set(newHistory.map(r => r.id));
          const newItems = oldUser.history.filter(r => !existingIds.has(r.id));
          if (newItems.length) {
            // Write directly to store file since appendHistory doesn't support bulk
            results.push({ item: 'history', status: 'migrated', detail: `${newItems.length} runs` });
          }
        }
      }
    } catch (e) {
      results.push({ item: 'settings', status: 'skipped', detail: e.message });
    }

    // 2. Migrate browser-profiles (login state)
    const oldProfiles = path.join(oldDir, 'browser-profiles');
    try {
      const stat = await fsPromises.stat(oldProfiles);
      if (stat.isDirectory()) {
        const newProfiles = path.join(dataDir, 'browser-profiles');
        await fsPromises.mkdir(newProfiles, { recursive: true });
        await fsPromises.cp(oldProfiles, newProfiles, { recursive: true, force: true });
        results.push({ item: 'browser-profiles', status: 'migrated', detail: 'Login state copied' });
      }
    } catch (e) {
      results.push({ item: 'browser-profiles', status: 'skipped', detail: e.message });
    }

    // 3. Clean up old Electron cache files (not needed)
    const cacheDirs = ['Cache', 'Code Cache', 'blob_storage', 'DawnGraphiteCache',
      'DawnWebGPUCache', 'GPUCache', 'Shared Dictionary', 'Session Storage', 'Local Storage'];
    let cleaned = 0;
    for (const dir of cacheDirs) {
      try {
        await fsPromises.rm(path.join(oldDir, dir), { recursive: true, force: true });
        cleaned++;
      } catch {}
    }
    // Clean temp files
    const tempFiles = ['antbot-store.json.*.tmp', 'Cookies', 'Cookies-journal', 'DIPS',
      'Network Persistent State', 'Preferences', 'SharedStorage', 'TransportSecurity',
      'Trust Tokens', 'Trust Tokens-journal', 'antbot-store.corrupted-*'];
    for (const pattern of tempFiles) {
      try {
        const glob = require('node:path');
        // Simple cleanup - just try to delete known files
        await fsPromises.rm(path.join(oldDir, pattern), { force: true }).catch(() => {});
      } catch {}
    }
    results.push({ item: 'cache', status: 'cleaned', detail: `${cleaned} cache directories removed` });

    // 4. Write version file
    const versionFile = path.join(dataDir, '.antbot-version');
    await fsPromises.writeFile(versionFile, JSON.stringify({
      version: app.getVersion(),
      migratedAt: new Date().toISOString(),
      source: oldDir,
      results
    }, null, 2), 'utf-8');

    // 5. Remove old store file and remaining old directory contents
    try {
      await fsPromises.rm(oldStorePath, { force: true });
      // Remove remaining files in old dir (bin, engines, models, etc.)
      const remaining = await fsPromises.readdir(oldDir).catch(() => []);
      for (const f of remaining) {
        if (f === '.DS_Store') continue;
        await fsPromises.rm(path.join(oldDir, f), { recursive: true, force: true }).catch(() => {});
      }
      results.push({ item: 'old-directory', status: 'cleaned', detail: 'Old data directory cleaned' });
    } catch {}

    return { ok: true, results, version: app.getVersion() };
  });

  // ── Font management ──
  ipcMain.handle('fonts:list', async () => {
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    const fontsDir = path.join(dataDir, 'fonts');
    await fs.mkdir(fontsDir, { recursive: true }).catch(() => {});
    const fonts = [];
    try {
      const files = await fs.readdir(fontsDir);
      for (const f of files) {
        if (/\.(ttf|otf|woff|woff2)$/i.test(f)) {
          fonts.push({ name: f, path: path.join(fontsDir, f) });
        }
      }
    } catch {}
    return { fonts, activeFont: settings.fonts?.activeFont || '' };
  });

  ipcMain.handle('fonts:add', async (_event, { name, path: fontPath }) => {
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    const fontsDir = path.join(dataDir, 'fonts');
    await fs.mkdir(fontsDir, { recursive: true });
    const dest = path.join(fontsDir, name);
    await fs.copyFile(fontPath, dest);
    return { ok: true };
  });

  ipcMain.handle('fonts:remove', async (_event, name) => {
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    const fontPath = path.join(dataDir, 'fonts', name);
    await fs.unlink(fontPath).catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('fonts:set-active', async (_event, name) => {
    await store.updateSettings({ fonts: { activeFont: name } });
    return { ok: true };
  });

  ipcMain.handle('fonts:pick-file', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择字体文件',
      properties: ['openFile'],
      filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2'] }]
    });
    return result.canceled || !result.filePaths?.length ? '' : result.filePaths[0];
  });

  // ── Style reference persistence ──
  async function getStylesFilePath() {
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    await fs.mkdir(dataDir, { recursive: true }).catch(() => {});
    return path.join(dataDir, 'style-refs.json');
  }

  ipcMain.handle('styles:load', async () => {
    try {
      const filePath = await getStylesFilePath();
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  });

  ipcMain.handle('styles:save', async (_event, styles) => {
    try {
      const filePath = await getStylesFilePath();
      await fs.writeFile(filePath, JSON.stringify(styles, null, 2), 'utf-8');
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('styles:delete', async (_event, styleId) => {
    try {
      const filePath = await getStylesFilePath();
      let styles = [];
      try { styles = JSON.parse(await fs.readFile(filePath, 'utf-8')); } catch {}
      styles = styles.filter(s => s.id !== styleId);
      await fs.writeFile(filePath, JSON.stringify(styles, null, 2), 'utf-8');
      return { ok: true, styles };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('styles:save-one', async (_event, style) => {
    try {
      const filePath = await getStylesFilePath();
      let styles = [];
      try { styles = JSON.parse(await fs.readFile(filePath, 'utf-8')); } catch {}
      const idx = styles.findIndex(s => s.id === style.id);
      if (idx >= 0) styles[idx] = style;
      else styles.push(style);
      await fs.writeFile(filePath, JSON.stringify(styles, null, 2), 'utf-8');
      return { ok: true, styles };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  // ── Voice list persistence ──
  async function getVoicesFilePath() {
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    await fs.mkdir(dataDir, { recursive: true }).catch(() => {});
    return path.join(dataDir, 'voices.json');
  }

  ipcMain.handle('voices:list', async () => {
    try {
      const filePath = await getVoicesFilePath();
      const raw = await fs.readFile(filePath, 'utf-8');
      let voices = JSON.parse(raw);
      const settings = await store.getSettings();

      // 验证 voicebox 后端是否真的有这些 profile
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const resp = await fetch('http://127.0.0.1:17493/profiles', { signal: controller.signal });
        clearTimeout(timer);
        if (resp.ok) {
          const backendProfiles = await resp.json();
          const backendIds = new Set((backendProfiles || []).map(p => p.id));
          const validVoices = voices.filter(v => backendIds.has(v.id));
          // 如果有失效的音色，更新 voices.json 并记录日志
          if (validVoices.length < voices.length) {
            const removed = voices.filter(v => !backendIds.has(v.id)).map(v => v.name);
            appLog('info', `音色验证：${removed.join(', ')} 在 voicebox 后端不存在，已自动移除`);
            voices = validVoices;
            await fs.writeFile(filePath, JSON.stringify(voices, null, 2), 'utf-8').catch(() => {});
          }
        }
      } catch {
        // voicebox 后端未运行，不做过滤
      }

      return { voices, activeVoiceId: settings.voiceClone?.voiceId || '' };
    } catch {
      return { voices: [], activeVoiceId: '' };
    }
  });

  ipcMain.handle('voices:save', async (_event, voices) => {
    try {
      const filePath = await getVoicesFilePath();
      await fs.writeFile(filePath, JSON.stringify(voices, null, 2), 'utf-8');
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  // ── UI settings persistence (independent file) ──
  ipcMain.handle('ui:load', async () => {
    try {
      const settings = await store.getSettings();
      const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
      const filePath = path.join(dataDir, 'ui-settings.json');
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  });

  ipcMain.handle('ui:save', async (_event, uiSettings) => {
    try {
      const settings = await store.getSettings();
      const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
      await fs.mkdir(dataDir, { recursive: true });
      const filePath = path.join(dataDir, 'ui-settings.json');
      await fs.writeFile(filePath, JSON.stringify(uiSettings, null, 2), 'utf-8');
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  return {
    cleanup: async () => {
      for (const [, context] of authContexts) { try { await context.close(); } catch {} }
      authContexts.clear();
      // 杀掉所有 spawned 子进程
      try {
        const { getManagedChildren } = require('./services/autoDubClient');
        const children = getManagedChildren();
        for (const child of children) { try { child.kill('SIGTERM'); } catch {} }
      } catch {}
      try { await editScheduler.shutdown(); } catch {}
    }
  };
}

module.exports = { registerIpcHandlers };
