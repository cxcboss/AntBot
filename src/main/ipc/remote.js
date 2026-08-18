const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { shell } = require('electron');

function register({ ipcMain, store, taskRunner, mainWindowRef, appLog }) {
  // 远程控制服务（延迟启动，按需开启）
  const { startRemoteServer, stopRemoteServer, isServerRunning, getRemotePort, configureRemotePort, broadcastTaskUpdate, clearSessions } = require('../services/remoteServer');
  const tunnelManager = require('../services/tunnelManager');
  const { readCreds, writeCreds, getDeviceId } = require('../services/remoteCredentials');

  // 同步配置端口（settings.remote.port），使隧道指向正确端口
  store.getSettings().then(s => { if (s?.remote?.port) configureRemotePort(s.remote.port); }).catch(() => {});

  // 主控任务进度推送到远程 SSE
  taskRunner.onProgress = ((originalOnProgress) => (payload) => {
    if (originalOnProgress) originalOnProgress(payload);
    // 推送到远程 SSE 客户端
    if (isServerRunning()) {
      for (const task of (payload.tasks || [])) {
        broadcastTaskUpdate(task);
      }
    }
  })(taskRunner.onProgress);

  ipcMain.handle('remote:start', async (_event, { password, deviceName } = {}) => {
    // 保存凭证到独立文件（safeStorage 加密）；
    // autoStart 保持用户设置，不因"保存并启用"被强制覆盖
    if (password || deviceName) {
      const existing = await readCreds();
      await writeCreds({
        password: password !== undefined ? password : existing.password,
        deviceName: deviceName !== undefined ? deviceName : existing.deviceName,
        autoStart: existing.autoStart,
      });
      if (password !== undefined && password !== existing.password) clearSessions();
    }
    if (!isServerRunning()) {
      startRemoteServer({ store, taskRunner, mainWindowRef, appLog });
    }
    return { ok: true, port: getRemotePort() };
  });

  ipcMain.handle('remote:stop', async () => {
    stopRemoteServer();
    tunnelManager.stopTunnel();
    return { ok: true };
  });

  ipcMain.handle('remote:start-tunnel', async () => {
    try {
      const creds = await readCreds();
      const deviceId = await getDeviceId();
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
        deviceId,
        deviceName: creds.deviceName || os.hostname(),
      });
      return { ok: true, url: result.url };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('remote:stop-tunnel', async () => {
    tunnelManager.stopTunnel();
    return { ok: true };
  });

  ipcMain.handle('remote:status', async () => {
    return {
      serverRunning: isServerRunning(),
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
    const creds = await readCreds();
    if (!creds.deviceName) creds.deviceName = os.hostname();
    return creds;
  });

  ipcMain.handle('remote:update-credentials', async (_event, updates) => {
    const existing = await readCreds();
    const merged = { ...existing, ...updates };
    await writeCreds(merged);
    // 桌面端改密码 → 远程会话全部失效
    if (typeof updates.password === 'string' && updates.password !== existing.password) {
      clearSessions();
    }
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
      return { hasUpdate: result.hasUpdate, latestVersion: result.remoteVersion, currentVersion: result.localVersion, changelog: '', downloadUrl: '', error: result.error || '' };
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
