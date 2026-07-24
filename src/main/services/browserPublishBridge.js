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

function createBrowserPublishBridge({ baseUrl = 'http://127.0.0.1:18321', pollIntervalMs = 700, timeoutMs = 30 * 60 * 1000 } = {}) {
  const normalizedBaseUrl = String(baseUrl).replace(/\/$/, '');

  const call = (method, pathname, body, requestTimeout = 15000) => requestJson(normalizedBaseUrl, method, pathname, body, requestTimeout);

  const getStatus = () => call('GET', '/api/bridge/status');
  const getCapabilities = () => call('GET', '/api/bridge/capabilities');
  const invoke = (action, payload = {}, options = {}) => call('POST', '/api/bridge/commands', {
    id: options.id,
    action,
    payload
  });

  const publish = async ({ videos, settings, videoPath, platform, requestId, onProgress = () => {} }) => {
    const accepted = await invoke('publish.start', {
      videos,
      settings,
      videoPath,
      platform
    }, { id: requestId });
    const id = accepted.command?.id || requestId;
    const startedAt = Date.now();
    let cursor = 0;

    while (Date.now() - startedAt < timeoutMs) {
      const result = await call('GET', `/api/bridge/commands/${encodeURIComponent(id)}`);
      for (const event of result.events || []) {
        if (event.sequence > cursor) {
          cursor = event.sequence;
          onProgress(event);
        }
      }
      if (result.command?.status === 'completed' || result.command?.status === 'failed' || result.command?.status === 'cancelled') {
        const finalResult = result.command.result || {};
        if (finalResult.success === false || result.command.status !== 'completed') {
          throw new Error(finalResult.error || `浏览器插件发布${result.command.status}`);
        }
        return finalResult;
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    await call('POST', `/api/bridge/commands/${encodeURIComponent(id)}/cancel`, { reason: 'AntBot 等待插件结果超时' }).catch(() => {});
    throw new Error('浏览器插件发布超时');
  };

  return { call, getStatus, getCapabilities, invoke, publish };
}

module.exports = { createBrowserPublishBridge, requestJson };
