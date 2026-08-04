const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');

const REMOTE_PORT = 18931;
const TOKEN_TTL = 24 * 60 * 60 * 1000; // 会话 24 小时过期
const MAX_BODY_BYTES = 1024 * 1024; // 请求体上限 1MB
const MAX_LOGIN_FAILURES = 10; // 10 次登录失败
const LOGIN_LOCK_MS = 15 * 60 * 1000; // 锁 15 分钟
let _server = null;
let _taskRunner = null;
let _store = null;
let _mainWindowRef = null;
let _appLog = null;
let _eventClients = new Set();
let _sessions = new Map(); // token -> { username, createdAt, expiresAt }
let _loginFailures = []; // 失败时间戳数组（全局限速，隧道转发后拿不到真实 IP）
let _loginLockUntil = 0;

function log(level, msg) {
  if (_appLog) _appLog(level, `[remote] ${msg}`);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(html);
}

function readBody(req, res) {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    let done = false;
    const finish = (data) => {
      if (done) return;
      done = true;
      resolve(data);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        if (res && !res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '请求体过大' }));
        }
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try { finish(JSON.parse(body)); } catch { finish({}); }
    });
    req.on('error', () => finish({}));
  });
}

function authenticate(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '');
  const session = _sessions.get(token);
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    _sessions.delete(token);
    return false;
  }
  return true;
}

// 登录限速：1 小时内失败 MAX_LOGIN_FAILURES 次 → 锁 LOGIN_LOCK_MS
function isLoginLocked() {
  if (Date.now() < _loginLockUntil) return true;
  const hourAgo = Date.now() - 60 * 60 * 1000;
  _loginFailures = _loginFailures.filter((t) => t > hourAgo);
  return false;
}

function recordLoginFailure() {
  _loginFailures.push(Date.now());
  if (_loginFailures.length >= MAX_LOGIN_FAILURES) {
    _loginLockUntil = Date.now() + LOGIN_LOCK_MS;
    _loginFailures = [];
    log('warn', `登录失败次数过多，锁定 ${LOGIN_LOCK_MS / 60000} 分钟`);
  }
}

function clearSessions() {
  _sessions.clear();
  log('info', '全部远程会话已失效（凭证变更）');
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of _eventClients) {
    try { client.write(msg); } catch { _eventClients.delete(client); }
  }
}

function checkPortOpen(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const net = require('node:net');
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

async function getDiskSpace(targetPath) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-Command', `Get-PSDrive -Name $((Get-Item '${targetPath.replace(/'/g, "''")}').PSDrive.Name) | Select-Object @{n='Used';e={[math]::Round($_.Used/1GB,1)}},@{n='Free';e={[math]::Round($_.Free/1GB,1)}} | ConvertTo-Json`], { timeout: 5000, windowsHide: true }, (e, so) => e ? reject(e) : resolve({ stdout: so }));
      });
      const m = stdout.match(/\{\s*"Used"\s*:\s*([\d.]+)[\s\S]*?"Free"\s*:\s*([\d.]+)/);
      if (m) {
        const used = parseFloat(m[1]), free = parseFloat(m[2]);
        return { totalGB: used + free, usedGB: used, freeGB: free };
      }
    } else {
      const { stdout } = await new Promise((resolve, reject) => {
        execFile('df', ['-k', targetPath], { timeout: 5000 }, (e, so) => e ? reject(e) : resolve({ stdout: so }));
      });
      const lines = stdout.trim().split('\n');
      const line = lines[lines.length - 1];
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        const blocks = parseInt(parts[1], 10), used = parseInt(parts[2], 10), avail = parseInt(parts[3], 10);
        const totalGB = blocks * 512 / 1024 / 1024 / 1024;
        return { totalGB: +totalGB.toFixed(1), usedGB: +(used * 512 / 1024 / 1024 / 1024).toFixed(1), freeGB: +(avail * 512 / 1024 / 1024 / 1024).toFixed(1) };
      }
    }
  } catch {}
  return null;
}

async function getVoiceboxStatus() {
  const open = await checkPortOpen(17493);
  if (!open) return { running: false };
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:17493/api/health', { timeout: 1500 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ running: true, ...(typeof payload === 'object' && payload ? payload : {}) });
        } catch { resolve({ running: true }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ running: true }); });
    req.on('error', () => resolve({ running: true }));
  });
}

async function getServicesStatus() {
  const tunnel = (() => { try { return require('./tunnelManager').getStatus(); } catch { return { running: false }; } })();
  const [api, bridge, voicebox, remote, tunnelUp] = await Promise.all([
    checkPortOpen(18930), checkPortOpen(18321), getVoiceboxStatus(), checkPortOpen(18931), Promise.resolve(true),
  ]);
  return {
    api: { name: '本地 API', port: 18930, running: api },
    bridge: { name: '桥接服务', port: 18321, running: bridge },
    voicebox: { name: '配音引擎', port: 17493, running: voicebox.running },
    remote: { name: '远程服务', port: 18931, running: remote },
    tunnel: { name: '隧道', port: null, running: Boolean(tunnel.running && tunnelUp), url: tunnel.url || null },
  };
}

async function getApiUsage() {
  try {
    const { getUsageSummary } = require('./usageTracker');
    const settings = _store ? await _store.getSettings() : null;
    const keys = settings?.api?.apiKeys || (settings?.api?.apiKey ? [settings.api.apiKey] : []);
    if (!keys.length) return [];
    return getUsageSummary(keys);
  } catch { return []; }
}

async function getStatus() {
  const tasks = _taskRunner ? _taskRunner.progressRows || [] : [];
  const [services, disk, usage] = await Promise.all([getServicesStatus(), getDiskSpace(os.homedir()), getApiUsage()]);
  return {
    running: _taskRunner?.running || false,
    taskCount: tasks.length,
    tasks: tasks.map(t => ({
      id: t.id,
      name: t.taskName || (t.isOriginal ? '原创' : '任务'),
      status: t.status,
      progress: t.progress,
      step: t.step,
      message: t.message,
      isOriginal: t.isOriginal,
      rawLine: t.rawLine,
    })),
    services,
    disk,
    usage,
    system: { platform: process.platform, uptime: Math.floor(process.uptime()), memoryFreeGB: +(os.freemem() / 1024 / 1024 / 1024).toFixed(1) },
  };
}

async function getMobileHTML() {
  // 优先从热更新目录读取
  try {
    const updater = require('./remoteUpdater');
    const html = await updater.getLocalFile('remote-ui/index.html');
    if (html) return html;
  } catch {}
  // 回退到内置版本
  const htmlPath = path.join(__dirname, 'remote-ui', 'index.html');
  try {
    return await fs.readFile(htmlPath, 'utf-8');
  } catch (e) {
    return `<html><body><h1>Error loading UI: ${e.message}</h1></body></html>`;
  }
}

function startRemoteServer({ store, taskRunner, mainWindowRef, appLog }) {
  _store = store;
  _taskRunner = taskRunner;
  _mainWindowRef = mainWindowRef;
  _appLog = appLog;

  _server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${REMOTE_PORT}`);
    const method = req.method;
    const pathname = url.pathname;

    // CORS
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      return res.end();
    }

    try {
      // ── Public routes (no auth) ──

      // Login
      if (method === 'POST' && pathname === '/remote/login') {
        const body = await readBody(req, res);
        if (!body) return;

        // 从统一凭证模块读取（safeStorage 加密存储）
        const { readCreds } = require('./remoteCredentials');
        const creds = await readCreds();
        const remotePass = creds.password || '';

        if (!remotePass) {
          return sendJson(res, 400, { ok: false, error: '请先在 App 中设置远程访问密码' });
        }
        if (isLoginLocked()) {
          return sendJson(res, 429, { ok: false, error: '尝试次数过多，请 15 分钟后再试' });
        }
        if (body.password !== remotePass) {
          recordLoginFailure();
          return sendJson(res, 401, { ok: false, error: '密码错误' });
        }

        const token = generateToken();
        _sessions.set(token, {
          username: 'admin',
          createdAt: Date.now(),
          expiresAt: Date.now() + TOKEN_TTL,
        });
        log('info', '登录成功');
        return sendJson(res, 200, { ok: true, token, expiresIn: TOKEN_TTL });
      }

      // Mobile page
      if (method === 'GET' && (pathname === '/' || pathname === '/remote' || pathname === '/remote/')) {
        const html = await getMobileHTML();
        return sendHtml(res, html);
      }

      // SSE events (token in query param for EventSource compatibility)
      if (method === 'GET' && pathname === '/remote/events') {
        const tokenFromQuery = url.searchParams.get('token');
        const tokenFromHeader = (req.headers['authorization'] || '').replace('Bearer ', '');
        const token = tokenFromQuery || tokenFromHeader;
        if (!_sessions.has(token)) {
          res.writeHead(401);
          return res.end('Unauthorized');
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*',
        });

        // Send initial status
        const status = await getStatus();
        res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);

        _eventClients.add(res);

        // Heartbeat every 30s
        const heartbeat = setInterval(() => {
          try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
        }, 30000);

        req.on('close', () => {
          clearInterval(heartbeat);
          _eventClients.delete(res);
        });
        return;
      }

      // ── Authenticated routes ──
      if (!authenticate(req)) {
        return sendJson(res, 401, { ok: false, error: '未授权，请先登录' });
      }

      // GET /remote/status
      if (method === 'GET' && pathname === '/remote/status') {
        const status = await getStatus();
        return sendJson(res, 200, { ok: true, ...status });
      }

      // POST /remote/tasks — submit new task
      if (method === 'POST' && pathname === '/remote/tasks') {
        const body = await readBody(req, res);
        if (!body) return;
        const text = (body.text || '').trim();
        if (!text) return sendJson(res, 400, { ok: false, error: '请输入链接' });

        try {
          const { parseTaskInput } = require('./parser');
          const tasks = parseTaskInput(text);
          if (!tasks.length) return sendJson(res, 400, { ok: false, error: '未识别到有效链接' });

          const result = await _taskRunner.enqueueTasks(tasks, {}, text);
          log('info', `远程提交 ${tasks.length} 个任务`);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.message });
        }
      }

      // POST /remote/tasks/:id/stop
      const stopMatch = pathname.match(/^\/remote\/tasks\/([^/]+)\/stop$/);
      if (method === 'POST' && stopMatch) {
        await _taskRunner.stopTask(stopMatch[1], {});
        return sendJson(res, 200, { ok: true });
      }

      // POST /remote/tasks/:id/retry
      const retryMatch = pathname.match(/^\/remote\/tasks\/([^/]+)\/retry$/);
      if (method === 'POST' && retryMatch) {
        try {
          const result = await _taskRunner.resumeTask(retryMatch[1], {});
          return sendJson(res, 200, { ok: true, ...result });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.message });
        }
      }

      // GET /remote/tasks
      if (method === 'GET' && pathname === '/remote/tasks') {
        const status = await getStatus();
        return sendJson(res, 200, { ok: true, tasks: status.tasks });
      }

      // GET /remote/history — 主控历史记录
      if (method === 'GET' && pathname === '/remote/history') {
        try {
          const historyPath = path.join(os.homedir(), 'AntBot', 'antbot-store.json');
          const data = JSON.parse(await fs.readFile(historyPath, 'utf-8'));
          const history = data.users?.[0]?.history || [];
          return sendJson(res, 200, { ok: true, history });
        } catch { return sendJson(res, 200, { ok: true, history: [] }); }
      }

      // GET /remote/credentials — 读取远程凭证（统一模块，与登录同源）
      if (method === 'GET' && pathname === '/remote/credentials') {
        try {
          const { readCreds } = require('./remoteCredentials');
          const creds = await readCreds();
          return sendJson(res, 200, { ok: true, username: creds.username || '', password: creds.password || '', deviceName: creds.deviceName || '' });
        } catch { return sendJson(res, 200, { ok: true, username: '', password: '', deviceName: '' }); }
      }

      // GET /remote/settings — 读取设置（字幕/风格/音色等）
      if (method === 'GET' && pathname === '/remote/settings') {
        const settings = await _store.getSettings();
        // 读取 UI 设置（editDefaults 等）
        let uiSettings = {};
        try {
          const uiPath = path.join(os.homedir(), 'AntBot', 'ui-settings.json');
          uiSettings = JSON.parse(await fs.readFile(uiPath, 'utf-8'));
        } catch {}
        return sendJson(res, 200, { ok: true, ...settings, editDefaults: uiSettings.editDefaults || {} });
      }

      // POST /remote/settings — 更新设置
      if (method === 'POST' && pathname === '/remote/settings') {
        const body = await readBody(req, res);
        if (!body) return;

        // 拦截远程密码：写入统一凭证模块（safeStorage 加密），
        // 旧实现写 store 会被强制清空且登录不读取 → 改密码永远不生效
        if (body.remote && typeof body.remote === 'object') {
          if (typeof body.remote.password === 'string' && body.remote.password !== '') {
            const { writeCreds } = require('./remoteCredentials');
            await writeCreds({ password: body.remote.password });
            clearSessions();
            log('info', '远程密码已更新，全部会话失效');
          }
          delete body.remote;
        }

        await _store.updateSettings(body);
        // 广播设置变更到所有 SSE 客户端
        broadcast('settings-update', body);
        return sendJson(res, 200, { ok: true });
      }

      // GET /remote/voices — 读取音色列表
      if (method === 'GET' && pathname === '/remote/voices') {
        try {
          const dataDir = path.join(os.homedir(), 'AntBot');
          const raw = await fs.readFile(path.join(dataDir, 'voices.json'), 'utf-8');
          return sendJson(res, 200, { ok: true, voices: JSON.parse(raw) });
        } catch { return sendJson(res, 200, { ok: true, voices: [] }); }
      }

      // GET /remote/styles — 读取风格列表
      if (method === 'GET' && pathname === '/remote/styles') {
        try {
          const dataDir = path.join(os.homedir(), 'AntBot');
          const raw = await fs.readFile(path.join(dataDir, 'style-refs.json'), 'utf-8');
          const styles = JSON.parse(raw).filter(s => s.prompt && !s.learning);
          return sendJson(res, 200, { ok: true, styles });
        } catch { return sendJson(res, 200, { ok: true, styles: [] }); }
      }

      // POST /remote/platform-login — 检测平台登录状态
      if (method === 'POST' && pathname === '/remote/platform-login') {
        const loginBody = await readBody(req, res);
        const platform = loginBody?.platform || 'douyin';
        try {
          const { createBrowserPublishBridge } = require('./browserPublishBridge');
          const settings = await _store.getSettings();
          const config = settings.publish?.browserExtension || {};
          if (!config.enabled) return sendJson(res, 200, { ok: false, error: '浏览器插件未启用，请先在桌面端设置中启用浏览器插件发布' });
          const bridge = createBrowserPublishBridge({ baseUrl: config.baseUrl, timeoutMs: 60000 });
          const result = await bridge.checkLogin({ platform });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          const msg = /ECONNREFUSED/.test(error.message) ? '桥接服务未启动，请稍后重试（服务正在自动启动中）' : error.message;
          return sendJson(res, 200, { ok: false, error: msg });
        }
      }

      // POST /remote/select-account — 选择视频号账号
      if (method === 'POST' && pathname === '/remote/select-account') {
        const selectBody = await readBody(req, res);
        const platform = selectBody?.platform || 'weixin';
        const accountIndex = Number(selectBody?.accountIndex) || 0;
        try {
          const { createBrowserPublishBridge } = require('./browserPublishBridge');
          const settings = await _store.getSettings();
          const config = settings.publish?.browserExtension || {};
          if (!config.enabled) return sendJson(res, 200, { ok: false, error: '浏览器插件未启用' });
          const bridge = createBrowserPublishBridge({ baseUrl: config.baseUrl, timeoutMs: 30000 });
          const result = await bridge.selectAccount({ platform, accountIndex });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, 200, { ok: false, error: error.message });
        }
      }

      // 404
      sendJson(res, 404, { ok: false, error: 'Not found' });

    } catch (error) {
      log('error', `请求处理失败: ${error.message}`);
      sendJson(res, 500, { ok: false, error: '服务器错误' });
    }
  });

  _server.listen(REMOTE_PORT, '127.0.0.1', () => {
    log('info', `远程控制服务已启动: http://127.0.0.1:${REMOTE_PORT}`);
  });

  _server.on('error', (err) => {
    log('error', `远程控制服务启动失败: ${err.message}`);
  });
}

function stopRemoteServer() {
  if (_server) {
    _server.close();
    _server = null;
    log('info', '远程控制服务已停止');
  }
  _eventClients.clear();
  _sessions.clear();
  _loginFailures = [];
  _loginLockUntil = 0;
}

function isServerRunning() {
  return _server !== null;
}

function getRemotePort() {
  return REMOTE_PORT;
}

// Export for taskRunner to broadcast events
function broadcastTaskUpdate(task) {
  broadcast('task-update', task);
}

module.exports = {
  startRemoteServer,
  stopRemoteServer,
  isServerRunning,
  clearSessions,
  getRemotePort,
  broadcastTaskUpdate,
};
