const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function register({ ipcMain, store, mainWindowRef, appLog }) {
  const PUBLISH_TASKS_FILE = path.join(os.homedir(), 'AntBot', 'publish-tasks.json');

  ipcMain.handle('publish:tasks-load', async () => {
    try {
      return JSON.parse(await fs.readFile(PUBLISH_TASKS_FILE, 'utf-8'));
    } catch { return []; }
  });

  ipcMain.handle('publish:tasks-save', async (_event, tasks) => {
    try {
      await fs.mkdir(path.dirname(PUBLISH_TASKS_FILE), { recursive: true });
      await fs.writeFile(PUBLISH_TASKS_FILE, JSON.stringify(Array.isArray(tasks) ? tasks : [], null, 2), 'utf-8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('publish:bridge-status', async () => {
    const { resolveBridgeBaseUrl, createBrowserPublishBridge } = require('../services/browserPublishBridge');
    const settings = await store.getSettings();
    const config = settings.publish?.browserExtension || {};
    const preferred = config.baseUrl || 'http://127.0.0.1:18321';
    try {
      const baseUrl = await resolveBridgeBaseUrl(preferred);
      const result = await createBrowserPublishBridge({ baseUrl }).getStatus();
      return { ...result, baseUrl };
    }
    catch (error) {
      appLog('error', `[publish] 状态检测失败: ${error.message}`);
      return { ok: false, status: 'offline', message: error.message };
    }
  });

  ipcMain.handle('publish:bridge-open-browser', async (_event, platform) => {
    const { openBrowserForPlatform } = require('../services/browserLauncher');
    const p = platform === 'douyin' ? 'douyin' : 'weixin';
    const r = await openBrowserForPlatform(p, { allowSpawn: true });
    return r;
  });

  ipcMain.handle('publish:bridge-start', async () => {
    appLog('info', '[publish] 启动桥接服务');
    const { bridgeServiceManager } = require('../services/bridgeServiceManager');
    try {
      const started = await bridgeServiceManager.start();
      appLog('info', `[publish] 桥接服务启动结果: ${started}`);
      return { ok: started, status: bridgeServiceManager.getStatus(), error: started ? '' : '服务启动超时，请检查日志' };
    } catch (e) {
      appLog('error', `[publish] 桥接服务启动异常: ${e.message}`);
      return { ok: false, status: null, error: e.message };
    }
  });

  ipcMain.handle('publish:bridge-stop', async () => {
    appLog('info', '[publish] 停止桥接服务');
    const { bridgeServiceManager } = require('../services/bridgeServiceManager');
    bridgeServiceManager.stop();
    return { ok: true, status: bridgeServiceManager.getStatus() };
  });

  ipcMain.handle('publish:start', async (_event, payload) => {
    appLog('info', '[publish] 开始发布视频');
    const { resolveBridgeBaseUrl, createBrowserPublishBridge } = require('../services/browserPublishBridge');
    const settings = await store.getSettings();
    const config = settings.publish?.browserExtension || {};
    const videos = Array.isArray(payload?.videos) ? payload.videos : [];
    if (!videos.length) {
      appLog('error', '[publish] 错误: 请先选择视频');
      throw new Error('请先选择视频');
    }
    const platform = String(payload.platform || settings.publish?.platform || 'videoChannel');
    // 每视频定时过期降级：时间已过 → 取消定时立即发布（发布页 5 天窗口可能轮到时已过期）
    const notices = [];
    const normalizedVideos = videos.map(v => {
      const vs = v.settings || {};
      let scheduled = vs.scheduledPublish !== false;
      if (scheduled && vs.scheduleTime) {
        const t = new Date(vs.scheduleTime);
        if (!isNaN(t.getTime()) && t.getTime() <= Date.now()) {
          scheduled = false;
          notices.push(`${v.name || ''}: 定时时间已过，改为立即发布`);
        }
      }
      return { ...v, settings: { ...vs, scheduledPublish: scheduled, exactTime: true } };
    });
    if (notices.length) appLog('info', `[publish] 定时降级: ${notices.join('; ')}`);
    const baseUrl = await resolveBridgeBaseUrl(config.baseUrl || 'http://127.0.0.1:18321');
    appLog('info', `[publish] 视频数量: ${videos.length}, 平台: ${platform}, baseUrl: ${baseUrl}`);
    try {
      const result = await createBrowserPublishBridge({ baseUrl, timeoutMs: config.timeoutMs }).publish({
        videos: normalizedVideos,
        settings: payload.settings || {},
        videoPath: payload.videoPath || path.dirname(videos[0].path || ''),
        platform: platform === 'videoChannel' ? 'weixin' : platform,
        requestId: payload.requestId,
        onProgress: event => {
          appLog('info', `[publish] 进度: ${event.type || 'unknown'} - ${event.message || ''}`);
          const win = mainWindowRef();
          if (win && !win.isDestroyed()) win.webContents.send('publish:progress', event);
        }
      });
      if (notices.length) result.notices = (result.notices || []).concat(notices);
      appLog('info', '[publish] 发布完成');
      return result;
    } catch (error) {
      appLog('error', `[publish] 发布失败: ${error.message}`);
      throw error;
    }
  });

  // 发布记录持久化
  const PUBLISH_RECORDS_FILE = path.join(os.homedir(), 'AntBot', 'publish-records.json');

  const loadPublishRecords = async () => {
    try {
      if (fsSync.existsSync(PUBLISH_RECORDS_FILE)) {
        const data = await fs.readFile(PUBLISH_RECORDS_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (e) {
      appLog('error', `[publish] 加载发布记录失败: ${e.message}`);
    }
    return [];
  };

  const savePublishRecordsToFile = async (records) => {
    try {
      await fs.writeFile(PUBLISH_RECORDS_FILE, JSON.stringify(records, null, 2), 'utf8');
    } catch (e) {
      appLog('error', `[publish] 保存发布记录失败: ${e.message}`);
    }
  };

  ipcMain.handle('publish:save-record', async (_event, record) => {
    appLog('info', `[publish] 保存发布记录: ${record.name}`);
    let records = await loadPublishRecords();
    records.unshift({ ...record, id: record.id || Date.now(), publishTime: record.publishTime || new Date().toISOString() });
    records = records.slice(0, 200);
    await savePublishRecordsToFile(records);
    return { ok: true };
  });

  ipcMain.handle('publish:get-records', async () => {
    return await loadPublishRecords();
  });

  ipcMain.handle('publish:delete-record', async (_event, recordId) => {
    appLog('info', `[publish] 删除发布记录: ${recordId}`);
    let records = await loadPublishRecords();
    records = records.filter(r => r.id !== recordId);
    await savePublishRecordsToFile(records);
    return { ok: true };
  });
}

module.exports = { register };
