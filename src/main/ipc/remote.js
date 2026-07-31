const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { shell } = require('electron');

function register({ ipcMain, store, taskRunner, mainWindowRef, appLog }) {
  // 远程控制服务（延迟启动，按需开启）
  let remoteServerStarted = false;
  const { startRemoteServer, stopRemoteServer, getRemotePort, broadcastTaskUpdate } = require('../services/remoteServer');
  const tunnelManager = require('../services/tunnelManager');

  // 主控任务进度推送到远程 SSE
  taskRunner.onProgress = ((originalOnProgress) => (payload) => {
    if (originalOnProgress) originalOnProgress(payload);
    // 推送到远程 SSE 客户端
    if (remoteServerStarted) {
      for (const task of (payload.tasks || [])) {
        broadcastTaskUpdate(task);
      }
    }
  })(taskRunner.onProgress);

  // 远程凭证独立存储（不经过 store.getSettings 清空）
  const REMOTE_CREDS_PATH = path.join(os.homedir(), 'AntBot', 'remote-credentials.json');

  async function readRemoteCreds() {
    try {
      return JSON.parse(await fs.readFile(REMOTE_CREDS_PATH, 'utf-8'));
    } catch { return { username: '', password: '', autoStart: false }; }
  }

  async function writeRemoteCreds(creds) {
    const dir = path.dirname(REMOTE_CREDS_PATH);
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    await fs.writeFile(REMOTE_CREDS_PATH, JSON.stringify(creds, null, 2));
  }

  ipcMain.handle('remote:start', async (_event, { password, deviceName } = {}) => {
    // 保存凭证到独立文件
    if (password) {
      await writeRemoteCreds({ password, deviceName: deviceName || '', autoStart: true });
    }
    if (!remoteServerStarted) {
      startRemoteServer({ store, taskRunner, mainWindowRef, appLog });
      remoteServerStarted = true;
    }
    return { ok: true, port: getRemotePort() };
  });

  ipcMain.handle('remote:stop', async () => {
    const creds = await readRemoteCreds();
    stopRemoteServer();
    remoteServerStarted = false;
    tunnelManager.stopTunnel(creds.deviceName || creds.username);
    return { ok: true };
  });

  ipcMain.handle('remote:start-tunnel', async () => {
    try {
      // 读取凭证用于注册到 Hub
      const creds = await readRemoteCreds();
      const result = await tunnelManager.startTunnel(getRemotePort(), {
        onUrl: (url) => {
          const win = mainWindowRef();
          if (win && !win.isDestroyed()) win.webContents.send('remote:tunnel-url', url);
        },
        onStatus: (status) => {
          const win = mainWindowRef();
          if (win && !win.isDestroyed()) win.webContents.send('remote:tunnel-status', status);
        },
        log: appLog,
        deviceName: creds.deviceName || creds.username || os.hostname(),
      });
      return { ok: true, url: result.url };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('remote:stop-tunnel', async () => {
    const creds = await readRemoteCreds();
    tunnelManager.stopTunnel(creds.deviceName || creds.username);
    return { ok: true };
  });

  ipcMain.handle('remote:status', async () => {
    return {
      serverRunning: remoteServerStarted,
      tunnel: tunnelManager.getStatus(),
      port: getRemotePort(),
    };
  });

  ipcMain.handle('remote:check-cloudflared', async () => {
    const bin = tunnelManager.findCloudflared();
    return { available: !!bin, path: bin || '' };
  });

  ipcMain.handle('remote:setup-tunnel', async (_event, { cfToken }) => {
    try {
      const result = await tunnelManager.setupNamedTunnel(cfToken, getRemotePort());
      return { ok: true, ...result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('remote:get-credentials', async () => {
    const creds = await readRemoteCreds();
    if (!creds.deviceName) creds.deviceName = os.hostname();
    return creds;
  });

  ipcMain.handle('remote:update-credentials', async (_event, updates) => {
    const existing = await readRemoteCreds();
    const merged = { ...existing, ...updates };
    await writeRemoteCreds(merged);
    return { ok: true };
  });

  ipcMain.handle('remote:generate-qr', async (_event, text) => {
    try {
      const QRCode = require('qrcode');
      const dataUrl = await QRCode.toDataURL(text, { width: 160, margin: 2, color: { dark: '#000000', light: '#FFFFFF' } });
      return { ok: true, dataUrl };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('open-plugin-dir', async () => {
    const dir = path.join(os.homedir(), 'AntBot', 'browser-plugin');
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    await shell.openPath(dir);
    return { ok: true, path: dir };
  });

  ipcMain.handle('open-dir', async (_event, dirPath) => {
    await fs.mkdir(dirPath, { recursive: true }).catch(() => {});
    await shell.openPath(dirPath);
    return { ok: true };
  });

  ipcMain.handle('remote:get-local-version', async () => {
    try {
      const updater = require('../services/remoteUpdater');
      return await updater.getLocalVersion();
    } catch { return { version: '0.0.0' }; }
  });

  ipcMain.handle('remote:check-update', async () => {
    try {
      const updater = require('../services/remoteUpdater');
      updater.setLogger(appLog);
      const result = await updater.checkForUpdates();
      return { hasUpdate: result.hasUpdate, latestVersion: result.remoteVersion, currentVersion: result.localVersion, changelog: '', downloadUrl: '' };
    } catch (e) { return { hasUpdate: false, error: e.message }; }
  });

  ipcMain.handle('remote:do-update', async () => {
    try {
      const updater = require('../services/remoteUpdater');
      updater.setLogger(appLog);
      return await updater.autoUpdate();
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

module.exports = { register };
