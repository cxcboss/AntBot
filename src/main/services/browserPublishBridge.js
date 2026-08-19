const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_PORT = 18321;
const PORT_RANGE = 11; // 18321-18331
const PORT_FILE = path.join(os.homedir(), 'AntBot', 'bridge-port.json');

function readStoredPort() {
  try {
    if (!fs.existsSync(PORT_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'));
    const p = Number(data.port);
    if (p >= 1024 && p <= 65535) return p;
  } catch {}
  return null;
}

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
    req.on('timeout', () => {
      req.destroy(new Error('桥接服务请求超时'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function probePort(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/bridge/status`, { timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const data = raw ? JSON.parse(raw) : {};
          if (data && data.ok === true) resolve({ port, ok: true, data });
          else resolve({ port, ok: false });
        } catch { resolve({ port, ok: false }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ port, ok: false }); });
    req.on('error', () => resolve({ port, ok: false }));
  });
}

async function findActiveBridgeBaseUrl(timeoutMs = 1200) {
  const stored = readStoredPort();
  const ports = [];
  if (stored) ports.push(stored);
  for (let i = 0; i < PORT_RANGE; i++) {
    const p = DEFAULT_PORT + i;
    if (!ports.includes(p)) ports.push(p);
  }
  for (const port of ports) {
    const result = await probePort(port, timeoutMs);
    if (result.ok) return `http://127.0.0.1:${port}`;
  }
  return null;
}

async function resolveBridgeBaseUrl(preferredBaseUrl) {
  // 优先使用传入的 baseUrl（用户配置），若健康则直接用
  if (preferredBaseUrl) {
    const normalized = String(preferredBaseUrl).replace(/\/$/, '');
    try {
      const url = new URL('/api/bridge/status', normalized);
      const port = Number(url.port) || 80;
      if (port >= 1024) {
        const r = await probePort(port, 1000);
        if (r.ok) return normalized;
      } else {
        // 无端口的 URL（如 http://localhost:18321），直接试
        await requestJson(normalized, 'GET', '/api/bridge/status', undefined, 1200);
        return normalized;
      }
    } catch {}
  }
  // 扫描可用端口
  const found = await findActiveBridgeBaseUrl(1200);
  if (found) return found;
  // 兜底返回传入值或默认
  return preferredBaseUrl ? String(preferredBaseUrl).replace(/\/$/, '') : `http://127.0.0.1:${DEFAULT_PORT}`;
}

// 插件可返回的终态（终态之外的任何状态都视为"仍在执行"）
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'login-required']);

function calcInactivityTimeout(videos) {
  try {
    const totalSize = (Array.isArray(videos) ? videos : []).reduce((s, v) => s + Number(v.size || 0), 0);
    // 基础 90s，大文件增加：每 50MB +30s，上限 300s
    const extra = Math.floor(totalSize / (50 * 1024 * 1024)) * 30000;
    return Math.min(300000, Math.max(90000, 90000 + extra));
  } catch { return 180000; }
}

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
    const INACTIVITY_TIMEOUT = calcInactivityTimeout(videos); // 动态：90s-300s
    const HARD_TIMEOUT = Math.max(60_000, timeoutMs || 10 * 60_000); // M1: 用调用方配置的超时上限（下限 1 分钟）

    let pollDelay = pollIntervalMs;
    while (Date.now() - startedAt < HARD_TIMEOUT) {
      let result;
      try {
        result = await call('GET', `/api/bridge/commands/${encodeURIComponent(id)}`);
      } catch (e) {
        // 网络抖动重试：等待后继续，不立即失败
        if (Date.now() - lastActivityAt > INACTIVITY_TIMEOUT) {
          await call('POST', `/api/bridge/commands/${encodeURIComponent(id)}/cancel`, { reason: 'AntBot 等待插件结果超时' }).catch(() => {});
          throw new Error('浏览器插件发布超时（无响应）');
        }
        await new Promise(resolve => setTimeout(resolve, pollDelay));
        pollDelay = Math.min(1500, pollDelay + 100);
        continue;
      }
      pollDelay = pollIntervalMs;
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

      await new Promise(resolve => setTimeout(resolve, pollDelay));
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

  return { call, getStatus, getCapabilities, invoke, publish, checkLogin, selectAccount, baseUrl: normalizedBaseUrl };
}

async function createResolvedBridge({ baseUrl, pollIntervalMs, timeoutMs } = {}) {
  const resolvedBaseUrl = await resolveBridgeBaseUrl(baseUrl);
  return createBrowserPublishBridge({ baseUrl: resolvedBaseUrl, pollIntervalMs, timeoutMs });
}

module.exports = {
  createBrowserPublishBridge,
  createResolvedBridge,
  resolveBridgeBaseUrl,
  findActiveBridgeBaseUrl,
  requestJson,
  probePort,
  TERMINAL_STATUSES,
};
