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
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>搬运蚁 - 远程控制</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#FAFAFA;--card:#FFF;--text:#0A0A0A;--muted:#78716C;--border:#E7E5E2;--primary:#0D9488;--primary-hover:#0F766E;--primary-fg:#FFF;--accent:#F0FDFA;--accent-fg:#0D9488;--destructive:#DC2626;--success:#16A34A;--warning:#D97706;--radius:8px;--radius-lg:12px;--shadow:0 1px 3px rgba(0,0,0,0.06)}
@media(prefers-color-scheme:dark){:root{--bg:#09090B;--card:#111113;--text:#FAFAFA;--muted:#A1A1AA;--border:#27272A;--primary:#5EEAD4;--primary-hover:#99F6E4;--primary-fg:#042F2E;--accent:#134E4A;--accent-fg:#5EEAD4;--shadow:0 1px 3px rgba(0,0,0,0.3)}}
body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC",sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
.container{max-width:480px;margin:0 auto;padding:0 16px}

/* Login */
.login{min-height:100vh;display:flex;align-items:center;justify-content:center}
.login-box{width:100%;max-width:360px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:32px 24px;box-shadow:var(--shadow)}
.login-title{font-size:20px;font-weight:700;text-align:center;margin-bottom:4px}
.login-sub{font-size:13px;color:var(--muted);text-align:center;margin-bottom:24px}
.login-logo{text-align:center;margin-bottom:16px;font-size:32px}

/* Header */
.header{position:sticky;top:0;z-index:10;background:var(--card);border-bottom:1px solid var(--border);padding:12px 16px;display:flex;align-items:center;gap:12px}
.header-title{font-size:16px;font-weight:700;flex:1}
.status-dot{width:8px;height:8px;border-radius:50%;background:var(--success)}
.status-dot.offline{background:var(--muted)}

/* Input */
.input{width:100%;height:40px;padding:0 12px;border:1px solid var(--input,var(--border));border-radius:var(--radius);background:var(--card);color:var(--text);font-size:14px;font-family:inherit}
.input:focus{outline:none;border-color:var(--ring,var(--primary));box-shadow:0 0 0 3px color-mix(in srgb,var(--primary) 15%,transparent)}
.textarea{min-height:80px;padding:8px 12px;resize:vertical;line-height:1.5}

/* Button */
.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 16px;border-radius:var(--radius);font-size:14px;font-weight:500;border:none;cursor:pointer;transition:all 120ms}
.btn-primary{background:var(--primary);color:var(--primary-fg)}
.btn-primary:hover{background:var(--primary-hover)}
.btn-primary:active{transform:scale(0.98)}
.btn-primary:disabled{opacity:0.5;cursor:not-allowed}
.btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-ghost:hover{background:var(--accent)}
.btn-sm{height:32px;padding:0 12px;font-size:12px}
.btn-icon{width:32px;height:32px;padding:0;border-radius:var(--radius)}

/* Task cards */
.tasks{display:flex;flex-direction:column;gap:8px;padding:12px 0}
.task{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:12px 14px;box-shadow:var(--shadow)}
.task-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.task-name{font-size:13px;font-weight:600}
.task-badge{font-size:11px;font-weight:500;padding:2px 8px;border-radius:999px}
.task-badge.running{background:var(--accent);color:var(--accent-fg)}
.task-badge.completed{background:#DCFCE7;color:var(--success)}
.task-badge.failed{background:#FEE2E2;color:var(--destructive)}
.task-badge.pending{background:var(--muted);color:var(--bg)}
.task-msg{font-size:12px;color:var(--muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task-bar{height:3px;background:var(--border);border-radius:999px;margin-top:8px;overflow:hidden}
.task-bar-fill{height:100%;background:var(--primary);border-radius:999px;transition:width 300ms}
.task-bar-fill.done{background:var(--success)}
.task-bar-fill.error{background:var(--destructive)}
.task-actions{display:flex;gap:6px;margin-top:8px;justify-content:flex-end}

/* Tags */
.tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
.tag{font-size:10px;padding:2px 6px;border-radius:999px;background:var(--accent);color:var(--accent-fg)}
.tag-original{background:#DCFCE7;color:var(--success)}

/* Composer */
.composer{position:sticky;bottom:0;background:var(--card);border-top:1px solid var(--border);padding:12px 16px}
.composer-row{display:flex;gap:8px;align-items:flex-end}

/* Empty */
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 16px;color:var(--muted);gap:8px}
.empty-icon{font-size:32px;opacity:0.5}

/* Toast */
.toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:8px 16px;font-size:13px;box-shadow:var(--shadow);z-index:100;animation:fadeIn 200ms}
@keyframes fadeIn{from{opacity:0;transform:translateX(-50%) translateY(-8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
</style>
</head>
<body>
<div id="app"></div>
<script>
const API = window.location.origin;
let token = localStorage.getItem('antbot-token');
let tasks = [];
let sseSource = null;

// Auth
async function login(username, password) {
  const res = await fetch(API + '/remote/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (data.ok) {
    token = data.token;
    localStorage.setItem('antbot-token', token);
    renderApp();
    connectSSE();
  } else {
    showToast(data.error || '登录失败');
  }
}

function logout() {
  token = null;
  localStorage.removeItem('antbot-token');
  if (sseSource) sseSource.close();
  renderApp();
}

// API calls
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + '/remote' + path, opts);
  if (res.status === 401) { logout(); return null; }
  return res.json();
}

// SSE
function connectSSE() {
  if (sseSource) sseSource.close();
  sseSource = new EventSource(API + '/remote/events?token=' + token);
  sseSource.addEventListener('task-update', (e) => {
    const task = JSON.parse(e.data);
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) tasks[idx] = { ...tasks[idx], ...task };
    else tasks.push(task);
    renderTasks();
  });
  sseSource.addEventListener('status', (e) => {
    const status = JSON.parse(e.data);
    tasks = status.tasks || [];
    renderTasks();
  });
  sseSource.onerror = () => {
    document.querySelector('.status-dot')?.classList.add('offline');
  };
  sseSource.onopen = () => {
    document.querySelector('.status-dot')?.classList.remove('offline');
  };
}

// Toast
function showToast(msg, duration = 3000) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// Render
function renderApp() {
  const app = document.getElementById('app');
  if (!token) {
    app.innerHTML = renderLogin();
    document.getElementById('login-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const u = document.getElementById('login-user').value;
      const p = document.getElementById('login-pass').value;
      login(u, p);
    });
  } else {
    app.innerHTML = renderMain();
    bindMainEvents();
    api('GET', '/status').then(data => {
      if (data) { tasks = data.tasks || []; renderTasks(); }
    });
    connectSSE();
  }
}

function renderLogin() {
  return '<div class="login"><div class="login-box">' +
    '<div class="login-logo">🐜</div>' +
    '<div class="login-title">搬运蚁远程控制</div>' +
    '<div class="login-sub">输入账号密码连接到你的电脑</div>' +
    '<form id="login-form">' +
    '<div style="margin-bottom:12px"><input class="input" id="login-user" type="text" placeholder="用户名" autocomplete="username"></div>' +
    '<div style="margin-bottom:16px"><input class="input" id="login-pass" type="password" placeholder="密码" autocomplete="current-password"></div>' +
    '<button class="btn btn-primary" style="width:100%" type="submit">登录</button>' +
    '</form></div></div>';
}

function renderMain() {
  return '<div class="header">' +
    '<span style="font-size:20px">🐜</span>' +
    '<span class="header-title">搬运蚁</span>' +
    '<span class="status-dot" title="连接状态"></span>' +
    '<button class="btn btn-ghost btn-sm" onclick="logout()">退出</button>' +
    '</div>' +
    '<div class="container"><div class="tasks" id="tasks"><div class="empty"><div class="empty-icon">📋</div><div>粘贴链接开始下载</div></div></div></div>' +
    '<div class="composer"><div class="container"><div class="composer-row">' +
    '<textarea class="input textarea" id="task-input" placeholder="粘贴视频链接，多个用逗号或换行隔开" rows="1"></textarea>' +
    '<button class="btn btn-primary btn-icon" id="send-btn" type="button">↑</button>' +
    '</div></div></div>';
}

function renderTasks() {
  const el = document.getElementById('tasks');
  if (!el) return;
  if (!tasks.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">📋</div><div>粘贴链接开始下载</div></div>';
    return;
  }

  const sorted = [...tasks].sort((a, b) => {
    const ai = a.index || a.queueIndex || 0;
    const bi = b.index || b.queueIndex || 0;
    return ai - bi;
  });

  el.innerHTML = sorted.map(t => {
    const st = t.status || 'pending';
    const pg = Math.max(0, Math.min(100, Number(t.progress || 0)));
    const idx = t.index || t.queueIndex || 0;
    const name = idx ? '任务' + idx : (t.isOriginal ? '原创' : (t.taskName || '任务'));
    const badge = { pending: '等待', queued: '等待', running: '执行中', completed: '成功', warning: '部分完成', failed: '失败', stopped: '已停止' }[st] || st;
    const badgeClass = { running: 'running', completed: 'completed', warning: 'running', failed: 'failed' }[st] || 'pending';
    const barClass = st === 'completed' ? 'done' : st === 'failed' ? 'error' : '';
    const msg = t.message || '';
    const isOriginal = t.isOriginal;

    let actions = '';
    if (st === 'failed') actions += '<button class="btn btn-ghost btn-sm" data-action="retry" data-id="' + t.id + '">重试</button>';
    if (['pending', 'queued', 'running'].includes(st)) actions += '<button class="btn btn-ghost btn-sm" data-action="stop" data-id="' + t.id + '">停止</button>';

    return '<div class="task">' +
      '<div class="task-head"><span class="task-name">' + esc(name) + '</span><span class="task-badge ' + badgeClass + '">' + badge + '</span></div>' +
      (isOriginal ? '<div class="tags"><span class="tag tag-original">原创</span></div>' : '') +
      (msg ? '<div class="task-msg">' + esc(msg) + '</div>' : '') +
      '<div class="task-bar"><div class="task-bar-fill ' + barClass + '" style="width:' + pg + '%"></div></div>' +
      (actions ? '<div class="task-actions">' + actions + '</div>' : '') +
      '</div>';
  }).join('');
}

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function bindMainEvents() {
  const input = document.getElementById('task-input');
  const btn = document.getElementById('send-btn');

  if (input) {
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendTask();
      }
    });
  }
  if (btn) btn.addEventListener('click', sendTask);

  document.getElementById('tasks')?.addEventListener('click', async (e) => {
    const actionBtn = e.target.closest('[data-action]');
    if (!actionBtn) return;
    const action = actionBtn.dataset.action;
    const id = actionBtn.dataset.id;
    if (action === 'stop') {
      await api('POST', '/tasks/' + id + '/stop');
      showToast('已停止');
    } else if (action === 'retry') {
      await api('POST', '/tasks/' + id + '/retry');
      showToast('已重试');
    }
  });
}

async function sendTask() {
  const input = document.getElementById('task-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.disabled = true;
  const btn = document.getElementById('send-btn');
  if (btn) btn.disabled = true;

  try {
    const data = await api('POST', '/tasks', { text });
    if (data?.ok) {
      showToast('已添加 ' + (data.tasks?.length || 0) + ' 个任务');
      input.value = '';
      input.style.height = 'auto';
    } else {
      showToast(data?.error || '发送失败');
    }
  } catch (e) {
    showToast('网络错误');
  }

  input.disabled = false;
  if (btn) btn.disabled = false;
  input.focus();
}

// Init
renderApp();
</script>
</body>
</html>`;
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
        // 直接从文件读取密码（store.getSettings 会清空密码字段）
        let remoteUser = 'admin';
        let remotePass = '';
        try {
          const storePath = path.join(os.homedir(), 'AntBot', 'antbot-store.json');
          const data = JSON.parse(await fs.readFile(storePath, 'utf-8'));
          remoteUser = data.users?.[0]?.settings?.remote?.username || 'admin';
          remotePass = data.users?.[0]?.settings?.remote?.password || '';
        } catch {}

        if (!remotePass) {
          return sendJson(res, 400, { ok: false, error: '请先在 App 中设置远程访问密码' });
        }
        if (body.username !== remoteUser || body.password !== remotePass) {
          return sendJson(res, 401, { ok: false, error: '用户名或密码错误' });
        }

        const token = generateToken();
        _sessions.set(token, { username: body.username, createdAt: Date.now() });
        log('info', `用户 ${body.username} 登录成功`);
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
