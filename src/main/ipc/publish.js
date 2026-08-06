const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function register({ ipcMain, store, mainWindowRef, appLog }) {
  ipcMain.handle('publish:bridge-status', async () => {
    const { createBrowserPublishBridge } = require('../services/browserPublishBridge');
    const settings = await store.getSettings();
    const config = settings.publish?.browserExtension || {};
    const baseUrl = config.baseUrl || 'http://127.0.0.1:18321';
    try {
      const result = await createBrowserPublishBridge({ baseUrl }).getStatus();
      return result;
    }
    catch (error) {
      appLog('error', `[publish] 状态检测失败: ${error.message}`);
      return { ok: false, status: 'offline', message: error.message };
    }
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

  ipcMain.handle('publish:bridge-service-status', async () => {
    const { bridgeServiceManager } = require('../services/bridgeServiceManager');
    return bridgeServiceManager.getStatus();
  });

  ipcMain.handle('publish:bridge-capabilities', async () => {
    const { createBrowserPublishBridge } = require('../services/browserPublishBridge');
    const settings = await store.getSettings();
    const config = settings.publish?.browserExtension || {};
    try { return await createBrowserPublishBridge({ baseUrl: config.baseUrl }).getCapabilities(); }
    catch (error) { return { ok: false, capabilities: [], message: error.message }; }
  });

  ipcMain.handle('bridge:check-platform-login', async (_event, platform) => {
    const { createBrowserPublishBridge } = require('../services/browserPublishBridge');
    const settings = await store.getSettings();
    const config = settings.publish?.browserExtension || {};
    if (!config.enabled) return { ok: false, error: '浏览器插件未启用' };
    try {
      const bridge = createBrowserPublishBridge({ baseUrl: config.baseUrl, timeoutMs: 60000 });
      const result = await bridge.checkLogin({ platform: platform || 'douyin' });
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('bridge:select-account', async (_event, platform, accountIndex) => {
    const { createBrowserPublishBridge } = require('../services/browserPublishBridge');
    const settings = await store.getSettings();
    const config = settings.publish?.browserExtension || {};
    if (!config.enabled) return { ok: false, error: '浏览器插件未启用' };
    try {
      const bridge = createBrowserPublishBridge({ baseUrl: config.baseUrl, timeoutMs: 30000 });
      const result = await bridge.selectAccount({ platform: platform || 'weixin', accountIndex });
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('publish:start', async (_event, payload) => {
    appLog('info', '[publish] 开始发布视频');
    const { createBrowserPublishBridge } = require('../services/browserPublishBridge');
    const settings = await store.getSettings();
    const config = settings.publish?.browserExtension || {};
    const videos = Array.isArray(payload?.videos) ? payload.videos : [];
    if (!videos.length) {
      appLog('error', '[publish] 错误: 请先选择视频');
      throw new Error('请先选择视频');
    }
    const platform = String(payload.platform || settings.publish?.platform || 'videoChannel');
    appLog('info', `[publish] 视频数量: ${videos.length}, 平台: ${platform}, baseUrl: ${config.baseUrl}`);
    try {
      const result = await createBrowserPublishBridge({ baseUrl: config.baseUrl, timeoutMs: config.timeoutMs }).publish({
        videos,
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
      appLog('info', '[publish] 发布完成');
      return result;
    } catch (error) {
      appLog('error', `[publish] 发布失败: ${error.message}`);
      throw error;
    }
  });

  ipcMain.handle('publish:stop', async (_event, requestId) => {
    appLog('info', `[publish] 停止发布: ${requestId || '(未指定)'}`);
    const { createBrowserPublishBridge } = require('../services/browserPublishBridge');
    const settings = await store.getSettings();
    const config = settings.publish?.browserExtension || {};
    try {
      // M2: 不传 id 时由服务端生成，避免重复 stop / 复用旧 id 触发"命令 ID 已存在"
      return await createBrowserPublishBridge({ baseUrl: config.baseUrl }).invoke('publish.stop', {}, requestId ? { id: requestId } : {});
    } catch (error) {
      if (/ECONNREFUSED|ECONNRESET/.test(error.message)) {
        throw new Error('桥接服务未运行，无法停止发布');
      }
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
