const http = require('node:http');

function requestJson(baseUrl, method, pathname, body, timeoutMs = 15000) {
  const target = new URL(pathname, baseUrl);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(target, {
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : undefined,
      timeout: timeoutMs
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { reject(new Error(`桥接服务返回无效 JSON（${res.statusCode}）`)); return; }
        if (res.statusCode < 200 || res.statusCode >= 300 || data.ok === false) {
          reject(new Error(data.message || data.error || `桥接服务请求失败（${res.statusCode}）`));
          return;
        }
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('桥接服务请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 插件可返回的终态（终态之外的任何状态都视为"仍在执行"）
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'login-required']);

function createBrowserPublishBridge({ baseUrl = 'http://127.0.0.1:18321', pollIntervalMs = 700, timeoutMs = 30 * 60 * 1000 } = {}) {
  const normalizedBaseUrl = String(baseUrl).replace(/\/$/, '');
  const requestTimeoutMs = 15000; // 单次 HTTP 请求超时

  const call = (method, pathname, body) => requestJson(normalizedBaseUrl, method, pathname, body, requestTimeoutMs);

  const getStatus = () => call('GET', '/api/bridge/status');
  const getCapabilities = () => call('GET', '/api/bridge/capabilities');
  const invoke = (action, payload = {}, options = {}) => call('POST', '/api/bridge/commands', {
    id: options.id,
    action,
    payload
  });

  const publish = async ({ videos, settings, videoPath, platform, requestId, onProgress = () => {} }) => {
    // M2: 命令 ID 冲突时（复用已存在的 ID）自动换新 ID 重试一次
    let id = null;
    for (const attemptId of [requestId, requestId ? `${requestId}-${Date.now()}` : null]) {
      if (attemptId == null) break;
      try {
        const accepted = await invoke('publish.start', {
          videos,
          settings,
          videoPath,
          platform
        }, { id: attemptId });
        id = accepted.command?.id || attemptId;
        break;
      } catch (error) {
        if (!/命令 ID 已存在/.test(error.message) || !attemptId) throw error;
      }
    }
    if (!id) {
      const accepted = await invoke('publish.start', {
        videos,
        settings,
        videoPath,
        platform
      });
      id = accepted.command?.id;
    }
    const startedAt = Date.now();
    let cursor = 0;
    let lastActivityAt = Date.now();
    const INACTIVITY_TIMEOUT = 90_000;      // 90 秒无事件 → 超时
    const HARD_TIMEOUT = Math.max(60_000, timeoutMs || 10 * 60_000); // M1: 用调用方配置的超时上限（下限 1 分钟）

    while (Date.now() - startedAt < HARD_TIMEOUT) {
      const result = await call('GET', `/api/bridge/commands/${encodeURIComponent(id)}`);
      let gotNewEvent = false;
      for (const event of result.events || []) {
        if (event.sequence > cursor) {
          cursor = event.sequence;
          gotNewEvent = true;
          onProgress(event);
        }
      }
      if (gotNewEvent) lastActivityAt = Date.now();

      if (TERMINAL_STATUSES.has(result.command?.status)) {
        const finalResult = result.command.result || {};
        // S2: login-required 是插件给出的"未登录"终态，透传插件错误
        if (result.command.status === 'login-required') {
          throw new Error(finalResult.error || '平台未登录，请先扫码登录');
        }
        if (finalResult.success === false) {
          // H3: 部分成功（有成功记录也有失败记录）不抛错，返回结果由上层标记部分完成
          if (finalResult.partialSuccess) {
            return finalResult;
          }
          const records = Array.isArray(finalResult.records) ? finalResult.records : [];
          const failedNames = records.filter(r => r && r.status !== 'success').map(r => r.videoName).join('、');
          throw new Error(finalResult.error || `浏览器插件发布${result.command.status}${failedNames ? `：${failedNames}` : ''}`);
        }
        return finalResult;
      }

      // 无事件活动超时
      if (Date.now() - lastActivityAt > INACTIVITY_TIMEOUT) {
        await call('POST', `/api/bridge/commands/${encodeURIComponent(id)}/cancel`, { reason: 'AntBot 等待插件结果超时' }).catch(() => {});
        throw new Error('浏览器插件发布超时（无响应）');
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    await call('POST', `/api/bridge/commands/${encodeURIComponent(id)}/cancel`, { reason: 'AntBot 等待插件结果超时' }).catch(() => {});
    throw new Error('浏览器插件发布超时');
  };

  const checkLogin = async ({ platform = 'douyin', onProgress = () => {} } = {}) => {
    const accepted = await invoke('platform.loginCheck', { platform });
    const id = accepted.command?.id;
    const startedAt = Date.now();
    let cursor = 0;
    let qrDataUrl = null;
    let accounts = null;
    const TIMEOUT = 60_000;

    while (Date.now() - startedAt < TIMEOUT) {
      const result = await call('GET', `/api/bridge/commands/${encodeURIComponent(id)}`);
      for (const event of result.events || []) {
        if (event.sequence > cursor) {
          cursor = event.sequence;
          if (event.type === 'login-qr' && event.qrDataUrl) {
            qrDataUrl = event.qrDataUrl;
            onProgress({ type: 'login-qr', qrDataUrl });
          }
          if (event.type === 'account-selection' && event.accounts) {
            accounts = event.accounts;
            onProgress({ type: 'account-selection', accounts });
          }
        }
      }
      if (TERMINAL_STATUSES.has(result.command?.status)) {
        const finalResult = result.command.result || {};
        return {
          loggedIn: Boolean(finalResult.loggedIn),
          platform: finalResult.platform || platform,
          qrDataUrl: finalResult.qrDataUrl || qrDataUrl,
          accountSelection: Boolean(finalResult.accountSelection || accounts),
          accounts: finalResult.accounts || accounts
        };
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error('登录检测超时');
  };

  const selectAccount = async ({ platform = 'weixin', accountIndex = 0 } = {}) => {
    const accepted = await invoke('platform.selectAccount', { platform, accountIndex });
    const id = accepted.command?.id;
    const startedAt = Date.now();
    const TIMEOUT = 30_000;

    while (Date.now() - startedAt < TIMEOUT) {
      const result = await call('GET', `/api/bridge/commands/${encodeURIComponent(id)}`);
      if (TERMINAL_STATUSES.has(result.command?.status)) {
        const finalResult = result.command.result || {};
        if (finalResult.success === false) throw new Error(finalResult.error || '选择失败');
        return finalResult;
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error('选择账号超时');
  };

  return { call, getStatus, getCapabilities, invoke, publish, checkLogin, selectAccount };
}

module.exports = { createBrowserPublishBridge, requestJson };
