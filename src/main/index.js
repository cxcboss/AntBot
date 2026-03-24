const fs = require('node:fs');
const path = require('node:path');

function configureBundledPlaywrightBrowsers() {
  const bundledRoot = path.resolve(process.resourcesPath || '', 'ms-playwright');
  if (!fs.existsSync(bundledRoot)) {
    return;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(bundledRoot, { withFileTypes: true });
  } catch {
    return;
  }

  const chromiumEntry = entries.find((entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith('chromium-')) {
      return false;
    }
    const executablePath = process.platform === 'win32'
      ? path.join(bundledRoot, entry.name, 'chrome-win64', 'chrome.exe')
      : process.platform === 'darwin'
        ? path.join(
            bundledRoot,
            entry.name,
            process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64',
            'Google Chrome for Testing.app',
            'Contents',
            'MacOS',
            'Google Chrome for Testing'
          )
        : path.join(bundledRoot, entry.name, 'chrome-linux64', 'chrome');
    return fs.existsSync(executablePath);
  });

  if (chromiumEntry) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundledRoot;
  }
}

configureBundledPlaywrightBrowsers();

const { app, BrowserWindow } = require('electron');

function resolveStableUserDataPath() {
  return path.join(app.getPath('appData'), 'antbot');
}

function mergeDirectoryIfNeeded(sourceDir, targetDir) {
  const normalizedSource = path.resolve(String(sourceDir || ''));
  const normalizedTarget = path.resolve(String(targetDir || ''));
  const samePath = normalizedSource
    && normalizedTarget
    && normalizedSource.localeCompare(normalizedTarget, undefined, { sensitivity: 'accent' }) === 0;

  if (!sourceDir || samePath || !fs.existsSync(sourceDir)) {
    return;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: false,
    errorOnExist: false
  });
}

function configureStableUserDataPath() {
  const stableUserDataPath = resolveStableUserDataPath();
  const currentUserDataPath = app.getPath('userData');

  for (const candidate of [
    currentUserDataPath,
    path.join(app.getPath('appData'), '搬运蚁'),
    path.join(app.getPath('appData'), 'AntBot')
  ]) {
    try {
      mergeDirectoryIfNeeded(candidate, stableUserDataPath);
    } catch (error) {
      console.warn('[app] migrate userData skipped:', candidate, error?.message || error);
    }
  }

  app.setPath('userData', stableUserDataPath);
  return stableUserDataPath;
}

configureStableUserDataPath();

const { StoreService } = require('./services/store');
const { TaskRunner } = require('./taskRunner');
const { registerIpcHandlers } = require('./ipc');
const { RemoteControlServer } = require('./services/remoteControl');
const { ensureManagedBinDir, injectManagedBinIntoProcessEnv } = require('./services/dependencyManager');
const { getAppInfo } = require('./services/appInfo');
const { SystemControlService } = require('./services/systemControl');

function parseBooleanEnv(rawValue, fallback = false) {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function shouldDisableLinuxSandbox() {
  if (parseBooleanEnv(process.env.ANTBOT_DISABLE_CHROMIUM_SANDBOX, false)) {
    return true;
  }
  if (typeof process.getuid === 'function') {
    return process.getuid() === 0;
  }
  return false;
}

function configureLinuxRuntimeFlags() {
  if (process.platform !== 'linux') {
    return;
  }

  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  if (shouldDisableLinuxSandbox()) {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-setuid-sandbox');
  }
}

configureLinuxRuntimeFlags();

const isHeadlessMode = parseBooleanEnv(process.env.ANTBOT_HEADLESS, false)
  || parseBooleanEnv(process.env.ANTBOT_NO_WINDOW, false);

let mainWindow;
let systemControl = null;

function createWindow() {
  const appInfo = getAppInfo();
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    title: appInfo.displayName,
    backgroundColor: '#eef2f7',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 20, y: 18 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (process.env.ANTBOT_DEBUG) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

async function bootstrap() {
  await ensureManagedBinDir();
  injectManagedBinIntoProcessEnv();

  const store = new StoreService();
  await store.load();
  systemControl = new SystemControlService();
  systemControl.applySettings(await store.getSettings());
  let remoteServer;

  const taskRunner = new TaskRunner({
    store,
    onProgress: (payload) => {
      systemControl?.handleProgress(payload);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('task:progress', payload);
      }
      remoteServer?.handleProgress(payload);
    },
    onLog: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('task:log', payload);
      }
      remoteServer?.handleLog(payload);
    },
    onRunDone: async () => {
      const history = await store.getHistory();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('history:changed', history);
      }
      remoteServer?.handleHistory(history);
    }
  });

  remoteServer = new RemoteControlServer({
    store,
    taskRunner,
    systemControl,
    onStatusChange: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('remote:status', payload);
      }
    },
    onRemoteLog: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('task:log', payload);
      }
      remoteServer?.handleLog(payload);
    }
  });

  remoteServer.progress = taskRunner.getSnapshot();
  systemControl.handleProgress(remoteServer.progress);
  try {
    await remoteServer.init();
  } catch (error) {
    console.error('[remote] init failed:', error);
  }

  registerIpcHandlers({
    mainWindowRef: () => mainWindow,
    store,
    taskRunner,
    remoteServer,
    systemControl
  });
}

app.whenReady().then(async () => {
  if (isHeadlessMode && process.platform === 'darwin' && app.dock?.hide) {
    app.dock.hide();
  }
  await bootstrap();
  if (!isHeadlessMode) {
    createWindow();
  }

  app.on('activate', () => {
    if (isHeadlessMode) {
      return;
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (isHeadlessMode) {
    return;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  systemControl?.dispose();
});
