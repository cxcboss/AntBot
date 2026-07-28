const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

const REMOTE_PORT = 18931;
let _server = null;
let _taskRunner = null;
let _store = null;
let _mainWindowRef = null;
let _appLog = null;
let _eventClients = new Set();
let _sessions = new Map(); // token -> { username, createdAt }

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

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function authenticate(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '');
  return _sessions.has(token);
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of _eventClients) {
    try { client.write(msg); } catch { _eventClients.delete(client); }
  }
}

async function getStatus() {
  const tasks = _taskRunner ? _taskRunner.progressRows || [] : [];
  return {
    running: _taskRunner?.running || false,
    taskCount: tasks.length,
    tasks: tasks.map(t => ({
      id: t.id,
      name: t.taskName || t.isOriginal ? '原创' : '任务',
      status: t.status,
      progress: t.progress,
      step: t.step,
      message: t.message,
      isOriginal: t.isOriginal,
      rawLine: t.rawLine,
    })),
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
        const body = await readBody(req);
        // 从独立凭证文件读取
        let remotePass = '';
        try {
          const credsPath = path.join(os.homedir(), 'AntBot', 'remote-credentials.json');
          const creds = JSON.parse(await fs.readFile(credsPath, 'utf-8'));
          remotePass = creds.password || '';
        } catch {}

        if (!remotePass) {
          return sendJson(res, 400, { ok: false, error: '请先在 App 中设置远程访问密码' });
        }
        if (body.password !== remotePass) {
          return sendJson(res, 401, { ok: false, error: '密码错误' });
        }

        const token = generateToken();
        _sessions.set(token, { username: 'admin', createdAt: Date.now() });
        log('info', '登录成功');
        return sendJson(res, 200, { ok: true, token });
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
        const body = await readBody(req);
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

      // GET /remote/credentials — 读取用户名密码（不经过 getSettings 清空）
      if (method === 'GET' && pathname === '/remote/credentials') {
        try {
          const storePath = path.join(os.homedir(), 'AntBot', 'antbot-store.json');
          const data = JSON.parse(await fs.readFile(storePath, 'utf-8'));
          const remote = data.users?.[0]?.settings?.remote || {};
          return sendJson(res, 200, { ok: true, username: remote.username || '', password: remote.password || '' });
        } catch { return sendJson(res, 200, { ok: true, username: '', password: '' }); }
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
        const body = await readBody(req);
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
        const loginBody = await readBody(req);
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
        const selectBody = await readBody(req);
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
  getRemotePort,
  broadcastTaskUpdate,
};
