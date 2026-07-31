const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { shell } = require('electron');
const { resolveDependencyPath } = require('../services/dependencyManager');

/**
 * Register download:* IPC handlers
 * @param {{ ipcMain: typeof import('electron').ipcMain, store: import('../services/store').StoreService, mainWindowRef: () => import('electron').BrowserWindow|null, appLog: (level: string, msg: string) => void }} deps
 */
function register({ ipcMain, store, mainWindowRef, appLog }) {
  // ── Download Manager ──
  const { DownloadManager } = require('../services/downloadManager');
  const downloadManager = new DownloadManager({
    maxConcurrent: 3,
    onTaskUpdate: (t) => { const w = mainWindowRef(); if (w && !w.isDestroyed()) w.webContents.send('download:task-update', t); },
    log: (msg) => appLog('info', msg)
  });
  downloadManager.init().catch(e => appLog('error', `DownloadManager init failed: ${e.message}`));

  ipcMain.handle('download:add', async (_event, text) => {
    try {
      const settings = await store.getSettings();
      downloadManager.outputBaseDir = settings.paths?.outputBaseDir || path.join(os.homedir(), 'Desktop', '视频');
      downloadManager.downloadDir = path.join(downloadManager.outputBaseDir, '视频下载');
      const result = await downloadManager.addTasks(text);
      return { ok: true, ...result };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('download:cancel', async (_event, taskId) => { await downloadManager.cancelTask(taskId); return { ok: true }; });
  ipcMain.handle('download:retry', async (_event, taskId) => { await downloadManager.retryTask(taskId); return { ok: true }; });
  ipcMain.handle('download:list', async () => downloadManager.getTasks());
  ipcMain.handle('download:check-ytdlp', async () => ({ available: downloadManager.isYtDlpAvailable() }));
  ipcMain.handle('download:install-ytdlp', async () => {
    try { await downloadManager.installYtDlp(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('download:check-ffmpeg', async () => {
    const resolved = await resolveDependencyPath('ffmpeg');
    return { available: !!resolved, path: resolved ? require('node:path').dirname(resolved) : '' };
  });
  ipcMain.handle('download:open-folder', async () => {
    const dir = downloadManager.downloadDir;
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    shell.openPath(dir);
  });

  ipcMain.handle('download:delete-file', async (_event, taskId) => {
    const task = downloadManager.tasks.get(taskId);
    if (task?.outputPath) {
      await fs.unlink(task.outputPath).catch(() => {});
    }
    downloadManager.tasks.delete(taskId);
    await downloadManager.saveState();
    return { ok: true };
  });

  ipcMain.handle('download:clean-task', async (_event, taskId) => {
    downloadManager.tasks.delete(taskId);
    await downloadManager.saveState();
    return { ok: true };
  });

  ipcMain.handle('download:check-youtube-cookies', async () => {
    try {
      const cookieFile = path.join(os.homedir(), 'AntBot', 'cookies', 'youtube.txt');
      const stat = await fs.stat(cookieFile);
      return stat.size > 50;
    } catch { return false; }
  });

  ipcMain.handle('download:login-youtube', async () => {
    const { BrowserWindow } = require('electron');
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 800, height: 700,
        title: '登录 YouTube — 登录后关闭此窗口',
        webPreferences: { session: require('electron').session.defaultSession }
      });
      win.loadURL('https://accounts.google.com/signin/v2/identifier?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F');
      win.on('closed', async () => {
        // 提取 YouTube 相关 cookies
        try {
          const cookies = await require('electron').session.defaultSession.cookies.get({ domain: '.youtube.com' });
          if (cookies.length) {
            const lines = ['# Netscape HTTP Cookie File'];
            for (const c of cookies) {
              const secure = c.secure ? 'TRUE' : 'FALSE';
              const expiry = c.expirationDate ? Math.floor(c.expirationDate) : '0';
              const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
              lines.push(`${domain}\tTRUE\t${c.path}\t${secure}\t${expiry}\t${c.name}\t${c.value}`);
            }
            const cookieDir = path.join(os.homedir(), 'AntBot', 'cookies');
            await fs.mkdir(cookieDir, { recursive: true });
            await fs.writeFile(path.join(cookieDir, 'youtube.txt'), lines.join('\n'));
            resolve({ ok: true, count: cookies.length });
          } else {
            resolve({ ok: false, error: '未获取到 YouTube cookies' });
          }
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    });
  });

  return downloadManager;
}

module.exports = { register };
