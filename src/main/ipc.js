const path = require('node:path');
const { dialog, ipcMain, shell } = require('electron');
const QRCode = require('qrcode');
const { parseTaskInput, parsePublishDebugInput } = require('./services/parser');
const { runStartupChecks, getProfileDir, getProfileScopeKey } = require('./services/startupCheck');
const { runVoiceClone } = require('./services/voiceClone');
const { getDependencyState, repairMissingDependencies } = require('./services/dependencyManager');
const { launchPersistentChromiumContext } = require('./services/playwrightUtil');
const { getAppInfo } = require('./services/appInfo');

async function openPlaywrightLoginContext(serviceKey, serviceConfig, userId) {
  const profileDir = getProfileDir(serviceKey, userId);
  const context = await launchPersistentChromiumContext(profileDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  }, () => {});

  const page = context.pages()[0] || await context.newPage();
  await page.goto(serviceConfig.url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  return context;
}

function registerIpcHandlers({ mainWindowRef, store, taskRunner, remoteServer }) {
  const authContexts = new Map();

  const sendWindowState = async (options = {}) => {
    const win = mainWindowRef();
    if (!win || win.isDestroyed()) {
      return;
    }
    win.webContents.send('app:state', await buildInitialState({
      includeDependencies: false,
      includeHistory: false,
      ...options
    }));
  };

  const sendStartup = (payload) => {
    const win = mainWindowRef();
    if (win && !win.isDestroyed()) {
      win.webContents.send('startup:status', payload);
    }
  };

  const buildInitialState = async (options = {}) => {
    const includeHistory = options.includeHistory !== false;
    const includeDependencies = options.includeDependencies !== false;
    const [settings, history, dependencies, users, activeUser, geminiProfiles] = await Promise.all([
      store.getSettings(),
      includeHistory ? store.getHistory() : Promise.resolve(undefined),
      includeDependencies ? getDependencyState() : Promise.resolve(undefined),
      store.listUsers(),
      store.getActiveUserSummary(),
      store.listGeminiProfiles()
    ]);

    return {
      app: getAppInfo(),
      activeUser,
      users,
      geminiProfiles,
      settings,
      history,
      running: taskRunner.running,
      progress: taskRunner.getSnapshotForUser(activeUser?.id),
      remote: remoteServer.getPublicState(),
      dependencies
    };
  };

  ipcMain.handle('app:get-initial-state', async () => {
    return buildInitialState();
  });

  ipcMain.handle('settings:update', async (_event, partialSettings) => {
    const settings = await store.updateSettings(partialSettings);
    await remoteServer.refreshStoreState();
    if (partialSettings?.remote) {
      await remoteServer.reconfigure(settings.remote || {});
    } else {
      remoteServer.emitStatus();
    }
    await sendWindowState();
    return settings;
  });

  ipcMain.handle('gemini-profiles:list', async () => {
    return store.listGeminiProfiles();
  });

  ipcMain.handle('gemini-profiles:create', async (_event, name) => {
    const created = await store.createGeminiProfile(name);
    await sendWindowState();
    return created;
  });

  ipcMain.handle('remote:get-state', async () => {
    return remoteServer.getPublicState();
  });

  ipcMain.handle('users:create', async (_event, name) => {
    const user = await store.createUser(name);
    await remoteServer.refreshStoreState();
    remoteServer.emitStatus();
    await sendWindowState();
    return user;
  });

  ipcMain.handle('users:rename', async (_event, name) => {
    const activeUser = await store.getActiveUserSummary();
    const user = await store.renameUser(activeUser?.id, name);
    await remoteServer.refreshStoreState();
    remoteServer.emitStatus();
    await sendWindowState();
    return user;
  });

  ipcMain.handle('users:switch', async (_event, userId) => {
    await remoteServer.activateUser(userId, {
      reconfigure: true
    });
    return buildInitialState({
      includeDependencies: false
    });
  });

  ipcMain.handle('users:delete', async (_event, userId) => {
    if (taskRunner.running) {
      throw new Error('任务执行中，不能删除用户。');
    }
    const result = await store.deleteUser(userId);
    await remoteServer.refreshStoreState();
    const settings = await store.getSettings();
    await remoteServer.reconfigure(settings.remote || {});
    await sendWindowState();
    return {
      ...result,
      state: await buildInitialState()
    };
  });

  ipcMain.handle('deps:get-state', async () => {
    return getDependencyState();
  });

  ipcMain.handle('deps:repair', async () => {
    return repairMissingDependencies();
  });

  ipcMain.handle('app:open-external', async (_event, url) => {
    const target = String(url || '').trim();
    if (!target) {
      return false;
    }
    await shell.openExternal(target);
    return true;
  });

  ipcMain.handle('app:make-qr', async (_event, text) => {
    const value = String(text || '').trim();
    if (!value) {
      return '';
    }
    return QRCode.toDataURL(value, {
      margin: 1,
      width: 220
    });
  });

  ipcMain.handle('startup:check', async () => {
    const [settings, loginState] = await Promise.all([
      store.getSettings(),
      store.getLoginState()
    ]);

    const result = await runStartupChecks(settings, loginState, (msg) => {
      sendStartup({
        type: 'log',
        message: msg,
        timestamp: new Date().toISOString()
      });
    });

    for (const [service, state] of Object.entries(result.loginState)) {
      await store.setLoginState(service, state.loggedIn);
    }

    await remoteServer.refreshStoreState();
    remoteServer.emitStatus();
    await sendWindowState();

    const payload = {
      type: 'result',
      result
    };

    sendStartup(payload);
    return result;
  });

  ipcMain.handle('startup:open-login-window', async (_event, serviceKey) => {
    const settings = await store.getSettings();
    const scopeId = serviceKey === 'gemini'
      ? (settings.__geminiProfileId || settings.__userId || 'user-1')
      : (settings.__userId || 'user-1');
    const serviceConfig = settings.loginHints?.[serviceKey];

    if (!serviceConfig) {
      throw new Error(`未知服务：${serviceKey}`);
    }

    const contextKey = getProfileScopeKey(serviceKey, scopeId);
    const existing = authContexts.get(contextKey);
    if (existing) {
      const pages = existing.pages();
      if (pages.length) {
        await pages[0].bringToFront().catch(() => {});
      }
      return { opened: true, reused: true, profileDir: getProfileDir(serviceKey, scopeId) };
    }

    const context = await openPlaywrightLoginContext(serviceKey, serviceConfig, scopeId);
    authContexts.set(contextKey, context);

    context.on('close', () => {
      authContexts.delete(contextKey);
    });

    return {
      opened: true,
      reused: false,
      profileDir: getProfileDir(serviceKey, scopeId)
    };
  });

  ipcMain.handle('startup:mark-login-done', async (_event, serviceKey) => {
    const settings = await store.getSettings();
    const scopeId = serviceKey === 'gemini'
      ? (settings.__geminiProfileId || settings.__userId || 'user-1')
      : (settings.__userId || 'user-1');
    const contextKey = getProfileScopeKey(serviceKey, scopeId);
    const context = authContexts.get(contextKey);
    if (context) {
      await context.close().catch(() => {});
      authContexts.delete(contextKey);
    }

    const state = await store.setLoginState(serviceKey, true);
    await remoteServer.refreshStoreState();
    remoteServer.emitStatus();
    await sendWindowState();
    return state;
  });

  ipcMain.handle('voice:clone', async (_event, payload) => {
    const settings = await store.getSettings();
    const pushProgress = (progressPayload) => {
      const win = mainWindowRef();
      if (win && !win.isDestroyed()) {
        win.webContents.send('voice:clone-progress', {
          ...progressPayload,
          timestamp: new Date().toISOString()
        });
      }
    };

    const pushLog = (message) => {
      const win = mainWindowRef();
      if (win && !win.isDestroyed()) {
        win.webContents.send('task:log', {
          runId: '',
          taskId: '',
          level: 'info',
          timestamp: new Date().toISOString(),
          message: `[语音克隆] ${message}`
        });
      }
    };

    pushProgress({
      status: 'running',
      step: '启动克隆',
      percent: 2,
      message: '开始执行语音克隆...'
    });

    try {
      const result = await runVoiceClone(payload || {}, settings, {
        log: pushLog,
        progress: pushProgress
      });
      const voiceClone = await store.setVoiceClone(result);
      await remoteServer.refreshStoreState();
      remoteServer.emitStatus();
      await sendWindowState();

      pushProgress({
        status: 'completed',
        step: '克隆完成',
        percent: 100,
        message: `语音克隆完成：${voiceClone.voiceId}`
      });

      return voiceClone;
    } catch (error) {
      pushProgress({
        status: 'failed',
        step: '克隆失败',
        message: String(error?.message || error)
      });
      throw error;
    }
  });

  ipcMain.handle('dialog:pick-audio-file', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择语音样本文件',
      properties: ['openFile'],
      filters: [
        {
          name: 'Audio',
          extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg']
        }
      ]
    });

    if (result.canceled || !result.filePaths?.length) {
      return '';
    }

    return result.filePaths[0];
  });

  ipcMain.handle('dialog:pick-video-file', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择本地视频文件',
      properties: ['openFile'],
      filters: [
        {
          name: 'Video',
          extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv']
        }
      ]
    });

    if (result.canceled || !result.filePaths?.length) {
      return '';
    }

    return result.filePaths[0];
  });

  ipcMain.handle('task:parse', async (_event, inputText) => {
    const tasks = parseTaskInput(inputText);
    return tasks;
  });

  ipcMain.handle('task:start', async (_event, inputText) => {
    const tasks = Array.isArray(inputText) ? inputText : parseTaskInput(inputText);

    if (!tasks.length) {
      throw new Error('请输入至少一条任务。');
    }

    const activeUser = await store.getActiveUserSummary();
    const scheduled = taskRunner.enqueueTasks(tasks, activeUser, String(inputText || '').trim());
    scheduled.promise.catch((error) => {
      const win = mainWindowRef();
      if (win && !win.isDestroyed()) {
        win.webContents.send('task:log', {
          runId: '',
          taskId: '',
          level: 'error',
          timestamp: new Date().toISOString(),
          message: error.message
        });
      }
    });

    return {
      started: true,
      queued: scheduled.queued,
      queuePosition: scheduled.queuePosition,
      taskCount: tasks.length,
      runId: scheduled.runId,
      taskIds: scheduled.taskIds
    };
  });

  ipcMain.handle('task:debug-publish', async (_event, payload) => {
    const videoPath = String(payload?.videoPath || '').trim();
    if (!videoPath) {
      throw new Error('请先选择本地视频文件。');
    }

    const fallbackTaskName = path.basename(videoPath, path.extname(videoPath)) || '调试发布';
    const task = parsePublishDebugInput(payload?.inputText || '', fallbackTaskName);
    const activeUser = await store.getActiveUserSummary();

    const scheduled = taskRunner.enqueuePublishDebug({
      task,
      videoPath
    }, activeUser);

    scheduled.promise.catch((error) => {
      const win = mainWindowRef();
      if (win && !win.isDestroyed()) {
        win.webContents.send('task:log', {
          runId: '',
          taskId: '',
          level: 'error',
          timestamp: new Date().toISOString(),
          message: error.message
        });
      }
    });

    return {
      started: true,
      queued: scheduled.queued,
      queuePosition: scheduled.queuePosition,
      taskCount: 1,
      runId: scheduled.runId,
      debug: true,
      videoPath
    };
  });

  ipcMain.handle('task:stop', async () => {
    const activeUser = await store.getActiveUserSummary();
    await taskRunner.stop(activeUser);
    return { stopped: true };
  });

  ipcMain.handle('task:stop-one', async (_event, taskId) => {
    const activeUser = await store.getActiveUserSummary();
    return taskRunner.stopTask(taskId, activeUser);
  });

  ipcMain.handle('task:resume-one', async (_event, payload) => {
    const activeUser = await store.getActiveUserSummary();
    return taskRunner.resumeTask(payload?.taskId, activeUser, payload?.task || null);
  });

  ipcMain.handle('history:get', async () => {
    const history = await store.getHistory();
    return history;
  });
}

module.exports = {
  registerIpcHandlers
};
