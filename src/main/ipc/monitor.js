function register({ ipcMain, store, taskRunner, mainWindowRef, appLog }) {
  const monitorService = require('../services/monitorService');

  // 初始化上下文（taskRunner/store 已在 index.js bootstrap 后可用，这里再确保）
  try { monitorService.setContext({ taskRunner, store, mainWindowRef, appLog }); } catch {}

  ipcMain.handle('monitor:list', async () => {
    return monitorService.getMonitors();
  });

  ipcMain.handle('monitor:add', async (_e, data) => {
    const result = await monitorService.addMonitor(data);
    return { ok: true, monitor: result };
  });

  ipcMain.handle('monitor:update', async (_e, { id, patch }) => {
    const result = await monitorService.updateMonitor(id, patch);
    return { ok: true, monitor: result };
  });

  ipcMain.handle('monitor:remove', async (_e, id) => {
    await monitorService.removeMonitor(id);
    return { ok: true };
  });

  ipcMain.handle('monitor:check-now', async (_e, id) => {
    const result = await monitorService.checkMonitorNow(id);
    return { ok: true, result };
  });

  ipcMain.handle('monitor:toggle', async (_e, { id, enabled }) => {
    const result = await monitorService.updateMonitor(id, { enabled });
    return { ok: true, monitor: result };
  });

  return monitorService;
}

module.exports = { register };
