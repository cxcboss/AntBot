function register({ ipcMain, appLog }) {
  // ── Update system ──
  const updater = require('../services/appUpdater');
  updater.setLogger(appLog);

  ipcMain.handle('update:check-all', async (_event, options) => {
    try { return await updater.checkAllUpdates(options || {}); } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('update:download-app', async (_event, downloadUrl) => {
    try {
      const win = _event.sender;
      return await updater.downloadAppUpdate(downloadUrl, (progress) => {
        if (!win.isDestroyed()) win.send('update:progress', { key: 'app', ...progress });
      });
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('update:download-win', async (_event, downloadUrl) => {
    try {
      const win = _event.sender;
      return await updater.downloadWinUpdate(downloadUrl, (progress) => {
        if (!win.isDestroyed()) win.send('update:progress', { key: 'app', ...progress });
      });
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('update:install-app', async (_event, zipPath, newVersion) => {
    try { return await updater.installAppUpdate(zipPath, newVersion); } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('update:cancel', async () => {
    try { updater.cancelDownload(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('update:download-plugin', async (_event, downloadUrl) => {
    try {
      const win = _event.sender;
      return await updater.downloadPluginUpdate(downloadUrl, (progress) => {
        if (!win.isDestroyed()) win.send('update:progress', { key: 'plugin', ...progress });
      });
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('update:install-plugin', async (_event, zipPath, newVersion) => {
    try { return await updater.installPluginUpdate(zipPath, newVersion); } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('update:get-app-version', async () => {
    try { return await updater.getAppVersion(); } catch { return '0.0.0'; }
  });

  ipcMain.handle('update:get-plugin-version', async () => {
    try { return await updater.getPluginVersion(); } catch { return '0.0.0'; }
  });
}

module.exports = { register };
