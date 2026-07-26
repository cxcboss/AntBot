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
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>搬运蚁 - 远程控制</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#FAFAFA;--card:#FFF;--text:#0A0A0A;--muted:#78716C;--border:#E7E5E2;--primary:#0D9488;--primary-hover:#0F766E;--primary-fg:#FFF;--accent:#F0FDFA;--accent-fg:#0D9488;--destructive:#DC2626;--success:#16A34A;--warning:#D97706;--radius:8px;--radius-lg:12px;--shadow:0 1px 3px rgba(0,0,0,0.06)}
@media(prefers-color-scheme:dark){:root{--bg:#09090B;--card:#111113;--text:#FAFAFA;--muted:#A1A1AA;--border:#27272A;--primary:#5EEAD4;--primary-hover:#99F6E4;--primary-fg:#042F2E;--accent:#134E4A;--accent-fg:#5EEAD4;--shadow:0 1px 3px rgba(0,0,0,0.3)}}
body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC",sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;overflow:hidden;height:100vh;height:100dvh}

/* Layout */
.app{display:flex;flex-direction:column;height:100vh;height:100dvh}
.header{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--card);flex-shrink:0;height:48px;z-index:20}
.header-title{flex:1;font-size:16px;font-weight:700}
.header-user{font-size:12px;color:var(--muted);cursor:pointer;display:flex;align-items:center;gap:4px}
.header-user:hover{color:var(--text)}
.conn-banner{display:none;align-items:center;gap:8px;padding:6px 12px;font-size:12px;font-weight:500;flex-shrink:0}
.conn-banner.checking,.conn-banner.retry{background:#FEF3C7;color:#92400E}
.conn-banner.newurl{background:#DBEAFE;color:#1E40AF}
.conn-banner.offline{background:#FEE2E2;color:#991B1B}
.conn-banner.ok{background:#DCFCE7;color:#166534}
.conn-spinner{width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 600ms linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* Sidebar */
.sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:30}
.sidebar-overlay.show{display:block}
.sidebar{position:fixed;left:0;top:0;bottom:0;width:240px;background:var(--card);border-right:1px solid var(--border);z-index:31;transform:translateX(-100%);transition:transform 200ms;display:flex;flex-direction:column}
.sidebar.open{transform:translateX(0)}
.sidebar-header{padding:16px;border-bottom:1px solid var(--border);font-size:16px;font-weight:700}
.sidebar-nav{padding:8px;flex:1}
.nav-item{display:flex;align-items:center;gap:8px;width:100%;padding:10px 12px;border-radius:var(--radius);font-size:14px;color:var(--text);background:none;border:none;cursor:pointer;transition:background 120ms}
.nav-item:hover{background:var(--accent)}
.nav-item.active{background:var(--accent);color:var(--accent-fg);font-weight:600}
.nav-icon{width:18px;height:18px;opacity:0.7}
.nav-item.active .nav-icon{opacity:1}

/* Main content */
.content{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}

/* Chat area */
.chat{flex:1;min-height:0;overflow-y:auto;padding:12px}
.chat-stream{display:flex;flex-direction:column;gap:8px}

/* Task card */
.task{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:10px 12px;box-shadow:var(--shadow);max-width:100%}
.task-head{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.task-name{font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task-badge{font-size:10px;font-weight:500;padding:2px 8px;border-radius:999px;flex-shrink:0}
.badge-running{background:var(--accent);color:var(--accent-fg)}
.badge-completed{background:#DCFCE7;color:var(--success)}
.badge-failed{background:#FEE2E2;color:var(--destructive)}
.badge-warning{background:#FEF3C7;color:var(--warning)}
.badge-pending{background:var(--muted);color:var(--bg)}
.task-msg{font-size:11px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task-bar{height:3px;background:var(--border);border-radius:999px;margin-top:6px;overflow:hidden}
.task-bar-fill{height:100%;background:var(--primary);border-radius:999px;transition:width 300ms}
.task-bar-fill.done{background:var(--success)}
.task-bar-fill.error{background:var(--destructive)}
.task-actions{display:flex;gap:6px;margin-top:6px}
.task-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
.tag{font-size:10px;padding:1px 6px;border-radius:999px;color:var(--muted-foreground);background:var(--accent);color:var(--accent-fg)}
.tag-original{background:#DCFCE7;color:var(--success)}

/* Empty state */
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--muted);gap:8px;padding:32px}
.empty-icon{font-size:32px;opacity:0.4}

/* Input bar */
.input-bar{background:var(--card);border-top:1px solid var(--border);padding:8px 12px;flex-shrink:0}
.input-row{display:flex;gap:8px;align-items:flex-end}
.input-field{flex:1;min-height:36px;max-height:120px;padding:8px 12px;border:1px solid var(--border);border-radius:18px;background:var(--bg);color:var(--text);font-size:14px;font-family:inherit;line-height:1.4;resize:none;outline:none}
.input-field:focus{border-color:var(--border)}
.input-field::placeholder{color:var(--muted)}
.send-btn{width:36px;height:36px;border-radius:50%;background:var(--primary);color:var(--primary-fg);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 120ms}
.send-btn:hover{background:var(--primary-hover)}
.send-btn:disabled{background:var(--border);color:var(--muted);cursor:not-allowed;opacity:0.6}
.chips{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:999px;font-size:11px;background:var(--muted);color:var(--text);cursor:pointer;transition:background 120ms}
.chip:hover{background:var(--border)}
.chip.active{background:var(--accent);color:var(--accent-fg)}

/* Subtitle page */
.page{display:none;flex:1;min-height:0;overflow-y:auto;padding:12px}
.page.active{display:flex;flex-direction:column}
.form-group{margin-bottom:16px}
.form-label{font-size:12px;color:var(--muted);margin-bottom:4px;display:block}
.form-input{width:100%;height:40px;padding:0 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:14px;font-family:inherit}
.form-input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--primary) 15%,transparent)}
.form-row{display:flex;gap:12px}
.form-row .form-group{flex:1}
.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 16px;border-radius:var(--radius);font-size:14px;font-weight:500;border:none;cursor:pointer;transition:all 120ms}
.btn-primary{background:var(--primary);color:var(--primary-fg)}
.btn-primary:hover{background:var(--primary-hover)}
.btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-block{width:100%}
.color-input{width:48px;height:32px;border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;padding:2px}
.slider-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.slider-label{font-size:11px;color:var(--muted);width:28px;flex-shrink:0}
.slider-val{font-size:11px;color:var(--muted);width:36px;text-align:right;flex-shrink:0}
input[type=range]{flex:1;height:6px;-webkit-appearance:none;appearance:none;border-radius:3px;outline:none}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;background:var(--card);border:2px solid var(--border);cursor:pointer;box-shadow:var(--shadow)}
.slider-h{background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)}
.slider-s{background:linear-gradient(to right,#888,var(--primary))}
.slider-l{background:linear-gradient(to right,#000,#888,#fff)}

/* Remote page */
.section-title{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;margin-top:16px}

/* Dialog */
.dialog-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100;align-items:center;justify-content:center}
.dialog-overlay.show{display:flex}
.dialog{background:var(--card);border-radius:var(--radius-lg);padding:20px;max-width:320px;width:90%;box-shadow:var(--shadow)}
.dialog-title{font-size:16px;font-weight:600;margin-bottom:8px}
.dialog-text{font-size:13px;color:var(--muted);margin-bottom:16px}
.dialog-actions{display:flex;gap:8px;justify-content:flex-end}
</style>
</head>
<body>
<div class="app" id="app">
  <!-- Header -->
  <div class="header">
    <button class="nav-item" id="sidebar-toggle" style="width:auto;padding:6px;flex-shrink:0">
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" x2="21" y1="6" y2="6"/><line x1="3" x2="21" y1="12" y2="12"/><line x1="3" x2="21" y1="18" y2="18"/></svg>
    </button>
    <span class="header-title" id="header-title">主控</span>
    <span class="header-user" id="header-user">-</span>
  </div>

  <!-- Sidebar overlay -->
  <div class="sidebar-overlay" id="sidebar-overlay"></div>

  <!-- Sidebar -->
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">🐜 搬运蚁</div>
    <nav class="sidebar-nav">
      <button class="nav-item active" data-page="main" type="button">
        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        主控
      </button>
      <button class="nav-item" data-page="subtitle" type="button">
        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
        字幕
      </button>
      <button class="nav-item" data-page="remote" type="button">
        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        远程
      </button>
    </nav>
  </div>

  <!-- Main content -->
  <div class="content" id="content">
    <!-- Main page (chat) -->
    <div class="page active" id="page-main">
      <div class="chat" id="chat">
        <div class="chat-stream" id="chat-stream">
          <div class="empty" id="empty-state"><div class="empty-icon">📋</div><div>粘贴视频链接开始下载</div><div style="font-size:12px;color:var(--muted)">支持 YouTube、抖音、TikTok、B站</div></div>
        </div>
      </div>
      <div class="input-bar">
        <div class="input-row">
          <textarea class="input-field" id="task-input" placeholder="粘贴视频链接..." rows="1"></textarea>
          <button class="send-btn" id="send-btn" type="button">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
          </button>
        </div>
        <div class="chips" id="chips"></div>
      </div>
    </div>

    <!-- Subtitle page -->
    <div class="page" id="page-subtitle">
      <div class="form-group">
        <label class="form-label">字幕颜色</label>
        <input class="color-input" id="sub-color" type="color" value="#FFA100" />
      </div>
      <div class="form-group">
        <label class="form-label">描边颜色</label>
        <input class="color-input" id="sub-stroke" type="color" value="#000000" />
      </div>
      <div class="form-group">
        <label class="form-label">字幕位置 (0-100)</label>
        <input class="form-input" id="sub-position" type="number" min="0" max="100" value="12" />
      </div>
      <button class="btn btn-primary btn-block" id="sub-save-btn" type="button">保存设置</button>
    </div>

    <!-- Remote page -->
    <div class="page" id="page-remote">
      <div class="section-title">远程设置</div>
      <div class="form-group">
        <label class="form-label">用户名</label>
        <input class="form-input" id="remote-user" type="text" placeholder="admin" />
      </div>
      <div class="form-group">
        <label class="form-label">密码</label>
        <input class="form-input" id="remote-pass" type="password" placeholder="设置密码" />
      </div>
      <button class="btn btn-primary btn-block" id="remote-save-btn" type="button">保存并重新登录</button>
    </div>
  </div>

  <!-- Logout dialog -->
  <div class="dialog-overlay" id="logout-dialog">
    <div class="dialog">
      <div class="dialog-title">退出登录</div>
      <div class="dialog-text">确认退出当前账号？</div>
      <div class="dialog-actions">
        <button class="btn btn-ghost" id="logout-cancel" type="button">取消</button>
        <button class="btn btn-primary" id="logout-confirm" type="button">确认退出</button>
      </div>
    </div>
  </div>
</div>

<script>
const API = window.location.origin;
const HUB_URL = 'https://hub.onebugmanai.online';
let token = localStorage.getItem('antbot-token');
let tasks = [];
let sseSource = null;
let currentPage = 'main';
let currentUser = localStorage.getItem('antbot-user') || '';
let userPassword = localStorage.getItem('antbot-pass') || '';
let consecutiveErrors = 0;
let reconnectTimer = null;

// === Auth ===
async function login(username, password) {
  const res = await fetch(API + '/remote/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (data.ok) {
    token = data.token;
    currentUser = username;
    userPassword = password;
    localStorage.setItem('antbot-token', token);
    localStorage.setItem('antbot-user', username);
    localStorage.setItem('antbot-pass', password);
    initApp();
  } else {
    showToast(data.error || '登录失败');
  }
}

function logout() {
  token = null;
  currentUser = '';
  userPassword = '';
  consecutiveErrors = 0;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  localStorage.removeItem('antbot-token');
  localStorage.removeItem('antbot-user');
  localStorage.removeItem('antbot-pass');
  if (sseSource) sseSource.close();
  renderLogin();
}

// === API ===
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

// === SSE ===
function connectSSE() {
  if (sseSource) { sseSource.close(); sseSource = null; }
  sseSource = new EventSource(API + '/remote/events?token=' + token);

  sseSource.onopen = () => {
    consecutiveErrors = 0;
    hideReconnectBanner();
  };

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
  sseSource.addEventListener('settings-update', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data) {
        if (data.style) {
          if (data.style.subtitleTextColor) setColorFromHex('color', data.style.subtitleTextColor);
          if (data.style.subtitleStrokeColor) setColorFromHex('stroke', data.style.subtitleStrokeColor);
          if (data.style.subtitlePositionPercent !== undefined) {
            const el = document.getElementById('sub-position');
            if (el) el.value = data.style.subtitlePositionPercent;
          }
        }
        if (data.editDefaults || data.voiceClone || data.retry) {
          loadSettings();
        }
        showToast('设置已同步');
      }
    } catch {}
  });

  sseSource.onerror = () => {
    consecutiveErrors++;
    sseSource.close();
    sseSource = null;
    if (consecutiveErrors >= 3) {
      showReconnectBanner('checking');
      reconnectViaHub();
    } else {
      showReconnectBanner('retry');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connectSSE(), Math.min(consecutiveErrors * 2000, 10000));
    }
  };
}

// 自动重连：通过 Hub 获取最新隧道地址
async function reconnectViaHub() {
  try {
    const res = await fetch(HUB_URL + '/api/tunnel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUser, password: userPassword })
    });
    const data = await res.json();
    if (data.ok && data.tunnelUrl) {
      const newApi = data.tunnelUrl.replace(/\/$/, '');
      if (newApi !== API) {
        // 隧道地址变了，重新登录
        showReconnectBanner('newurl');
        const loginRes = await fetch(newApi + '/remote/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: currentUser, password: userPassword })
        });
        const loginData = await loginRes.json();
        if (loginData.ok) {
          token = loginData.token;
          localStorage.setItem('antbot-token', token);
          // 跳转到新地址
          window.location.href = newApi + '?auth=' + encodeURIComponent(currentUser + ':' + userPassword);
          return;
        }
      }
      // 同一地址，重试连接
      showReconnectBanner('retry');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connectSSE(), 3000);
    } else {
      // Hub 无法访问或用户不存在
      showReconnectBanner('offline');
    }
  } catch {
    showReconnectBanner('offline');
  }
}

function showReconnectBanner(state) {
  const banner = document.getElementById('conn-banner');
  const text = document.getElementById('conn-text');
  if (!banner) return;
  banner.style.display = 'flex';
  banner.className = 'conn-banner ' + state;
  const msgs = {
    checking: '连接中断，正在检查服务器...',
    retry: '连接中断，正在重连...',
    newurl: '服务器地址已更新，正在跳转...',
    offline: '电脑可能已离线',
    ok: '已重新连接'
  };
  text.textContent = msgs[state] || '正在连接...';
}

function hideReconnectBanner() {
  const banner = document.getElementById('conn-banner');
  if (!banner) return;
  banner.className = 'conn-banner ok';
  document.getElementById('conn-text').textContent = '已重新连接';
  setTimeout(() => { banner.style.display = 'none'; }, 2000);
}

// === Toast ===
function showToast(msg, duration = 3000) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  el.style.cssText = 'position:fixed;top:56px;left:50%;transform:translateX(-50%);background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:8px 16px;font-size:13px;box-shadow:var(--shadow);z-index:200;animation:fadeIn 200ms';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// === Render ===
function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function renderLogin() {
  document.getElementById('app').innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;padding:24px">' +
    '<div style="width:100%;max-width:360px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:32px 24px;box-shadow:var(--shadow)">' +
    '<div style="text-align:center;font-size:32px;margin-bottom:16px">🐜</div>' +
    '<div style="text-align:center;font-size:18px;font-weight:700;margin-bottom:4px">搬运蚁远程控制</div>' +
    '<div style="text-align:center;font-size:13px;color:var(--muted);margin-bottom:24px">输入账号密码连接到你的电脑</div>' +
    '<form id="login-form">' +
    '<div style="margin-bottom:12px"><input class="form-input" id="login-user" type="text" placeholder="用户名" autocomplete="username" style="width:100%"></div>' +
    '<div style="margin-bottom:16px"><input class="form-input" id="login-pass" type="password" placeholder="密码" autocomplete="current-password" style="width:100%"></div>' +
    '<button class="btn btn-primary btn-block" type="submit">登录</button>' +
    '</form></div></div>';
  document.getElementById('login-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    login(document.getElementById('login-user').value, document.getElementById('login-pass').value);
  });
}

function initApp() {
  document.getElementById('app').innerHTML = renderAppShell();
  bindEvents();
  loadSettings();
  loadTasks();
  connectSSE();
}

function renderAppShell() {
  return '<div class="header">' +
    '<button class="nav-item" id="sidebar-toggle" style="width:auto;padding:6px;flex-shrink:0">' +
    '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" x2="21" y1="6" y2="6"/><line x1="3" x2="21" y1="12" y2="12"/><line x1="3" x2="21" y1="18" y2="18"/></svg>' +
    '</button>' +
    '<span class="header-title" id="header-title">主控</span>' +
    '<span class="header-user" id="header-user">' + esc(currentUser) + '</span>' +
    '</div>' +
    '<div class="conn-banner" id="conn-banner"><span class="conn-spinner"></span><span id="conn-text"></span></div>' +
    '<div class="sidebar-overlay" id="sidebar-overlay"></div>' +
    '<div class="sidebar" id="sidebar">' +
    '<div class="sidebar-header">🐜 搬运蚁</div>' +
    '<nav class="sidebar-nav">' +
    '<button class="nav-item active" data-page="main"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>主控</button>' +
    '<button class="nav-item" data-page="subtitle"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>字幕</button>' +
    '<button class="nav-item" data-page="remote"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>远程</button>' +
    '</nav></div>' +
    '<div class="content" id="content">' +
    '<div class="page active" id="page-main">' +
    '<div class="chat" id="chat"><div class="chat-stream" id="chat-stream"><div class="empty" id="empty-state"><div class="empty-icon">📋</div><div>粘贴视频链接开始下载</div></div></div></div>' +
    '</div>' +
    '<div class="page" id="page-subtitle">' +
    '<div class="form-group"><label class="form-label">字幕颜色</label>' +
    '<div class="color-picker" id="color-picker">' +
    '<div class="color-preview" id="color-preview" style="width:100%;height:28px;border-radius:var(--radius);border:1px solid var(--border);margin-bottom:8px"></div>' +
    '<div class="slider-row"><span class="slider-label">色相</span><input type="range" id="color-h" min="0" max="360" value="30" class="slider-h"><span class="slider-val" id="color-h-val">30°</span></div>' +
    '<div class="slider-row"><span class="slider-label">饱和</span><input type="range" id="color-s" min="0" max="100" value="100" class="slider-s"><span class="slider-val" id="color-s-val">100%</span></div>' +
    '<div class="slider-row"><span class="slider-label">亮度</span><input type="range" id="color-l" min="0" max="100" value="50" class="slider-l"><span class="slider-val" id="color-l-val">50%</span></div>' +
    '</div></div>' +
    '<div class="form-group"><label class="form-label">描边颜色</label>' +
    '<div class="color-picker" id="stroke-picker">' +
    '<div class="color-preview" id="stroke-preview" style="width:100%;height:28px;border-radius:var(--radius);border:1px solid var(--border);margin-bottom:8px"></div>' +
    '<div class="slider-row"><span class="slider-label">色相</span><input type="range" id="stroke-h" min="0" max="360" value="0" class="slider-h"><span class="slider-val" id="stroke-h-val">0°</span></div>' +
    '<div class="slider-row"><span class="slider-label">饱和</span><input type="range" id="stroke-s" min="0" max="100" value="0" class="slider-s"><span class="slider-val" id="stroke-s-val">0%</span></div>' +
    '<div class="slider-row"><span class="slider-label">亮度</span><input type="range" id="stroke-l" min="0" max="100" value="0" class="slider-l"><span class="slider-val" id="stroke-l-val">0%</span></div>' +
    '</div></div>' +
    '<div class="form-group"><label class="form-label">字幕位置 (0-100)</label><input class="form-input" id="sub-position" type="number" min="0" max="100" value="12" /></div>' +
    '<button class="btn btn-primary btn-block" id="sub-save-btn" type="button">保存设置</button>' +
    '</div>' +
    '<div class="page" id="page-remote">' +
    '<div class="section-title">远程设置</div>' +
    '<div class="form-group"><label class="form-label">用户名</label><input class="form-input" id="remote-user" type="text" /></div>' +
    '<div class="form-group"><label class="form-label">密码</label><input class="form-input" id="remote-pass" type="password" /></div>' +
    '<button class="btn btn-primary btn-block" id="remote-save-btn" type="button">保存并重新登录</button>' +
    '</div>' +
    '</div>' +
    '<div class="input-bar" id="input-bar"><div class="input-row">' +
    '<textarea class="input-field" id="task-input" placeholder="粘贴视频链接..." rows="1"></textarea>' +
    '<button class="send-btn" id="send-btn" type="button"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></button>' +
    '</div><div class="chips" id="chips"></div></div>' +
    '<div class="dialog-overlay" id="logout-dialog"><div class="dialog"><div class="dialog-title">退出登录</div><div class="dialog-text">确认退出当前账号？</div><div class="dialog-actions"><button class="btn btn-ghost" id="logout-cancel">取消</button><button class="btn btn-primary" id="logout-confirm">确认退出</button></div></div></div>';
}

function bindEvents() {
  // Sidebar toggle
  document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('open');
    document.getElementById('sidebar-overlay')?.classList.toggle('show');
  });
  document.getElementById('sidebar-overlay')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.remove('show');
  });

  // Navigation
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });

  // Username click -> logout dialog
  document.getElementById('header-user')?.addEventListener('click', () => {
    document.getElementById('logout-dialog')?.classList.add('show');
  });
  document.getElementById('logout-cancel')?.addEventListener('click', () => {
    document.getElementById('logout-dialog')?.classList.remove('show');
  });
  document.getElementById('logout-confirm')?.addEventListener('click', () => {
    document.getElementById('logout-dialog')?.classList.remove('show');
    logout();
  });

  // Task input
  const input = document.getElementById('task-input');
  const sendBtn = document.getElementById('send-btn');
  if (input) {
    // 初始状态：空内容时禁用发送按钮
    if (sendBtn) sendBtn.disabled = !input.value.trim();
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      if (sendBtn) sendBtn.disabled = !input.value.trim();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTask(); }
    });
  }
  document.getElementById('send-btn')?.addEventListener('click', sendTask);

  // Task actions (event delegation)
  document.getElementById('chat-stream')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    if (action === 'stop') api('POST', '/tasks/' + id + '/stop').then(() => showToast('已停止'));
    if (action === 'retry') api('POST', '/tasks/' + id + '/retry').then(() => showToast('已重试'));
  });

  // 颜色滑块交互
  setupColorPicker('color', '#FFA100');
  setupColorPicker('stroke', '#000000');

  // Subtitle save（自动同步）
  document.getElementById('sub-save-btn')?.addEventListener('click', async () => {
    const color = getColorHex('color');
    const stroke = getColorHex('stroke');
    const position = document.getElementById('sub-position')?.value;
    await api('POST', '/remote/settings', {
      style: { subtitleTextColor: color, subtitleStrokeColor: stroke, subtitlePositionPercent: parseInt(position) || 12 }
    });
    showToast('字幕设置已保存并同步');
  });

  // Remote save
  document.getElementById('remote-save-btn')?.addEventListener('click', async () => {
    const user = document.getElementById('remote-user')?.value?.trim();
    const pass = document.getElementById('remote-pass')?.value?.trim();
    if (!pass) { showToast('请设置密码'); return; }
    await api('POST', '/remote/settings', { remote: { username: user, password: pass } });
    showToast('已保存，需要重新登录');
    setTimeout(() => logout(), 1000);
  });
}

function switchPage(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + page)?.classList.add('active');
  document.querySelectorAll('.nav-item[data-page]').forEach(n => n.classList.toggle('active', n.dataset.page === page));
  document.getElementById('header-title').textContent = { main: '主控', subtitle: '字幕', remote: '远程' }[page] || '主控';
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('show');
  // 输入栏只在主控页显示
  const inputBar = document.getElementById('input-bar');
  if (inputBar) inputBar.style.display = page === 'main' ? '' : 'none';
  if (page === 'subtitle') loadSubtitleSettings();
  if (page === 'remote') loadRemoteSettings();
}

async function loadSettings() {
  const data = await api('GET', '/remote/settings');
  if (!data) return;
  renderChips(data);
}

function renderChips(settings) {
  const chips = document.getElementById('chips');
  if (!chips) return;
  const style = settings?.editDefaults?.style || '未设置';
  const voice = settings?.voiceClone?.profileName || '未设置';
  const retry = settings?.retry?.failedTaskRetries ?? 0;
  chips.innerHTML =
    '<span class="chip" title="风格">' + esc(style) + '</span>' +
    '<span class="chip" title="音色">' + esc(voice) + '</span>' +
    '<span class="chip" title="重试次数">重试' + retry + '次</span>';
}

async function loadSubtitleSettings() {
  const data = await api('GET', '/remote/settings');
  if (!data) return;
  const s = data?.style || {};
  setColorFromHex('color', s.subtitleTextColor || '#FFA100');
  setColorFromHex('stroke', s.subtitleStrokeColor || '#000000');
  const posEl = document.getElementById('sub-position');
  if (posEl) posEl.value = s.subtitlePositionPercent ?? 12;
}

// ── 颜色工具函数 ──
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1); return Math.round(255 * color).toString(16).padStart(2, '0'); };
  return '#' + f(0) + f(8) + f(4);
}

function hexToHsl(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function getColorHex(prefix) {
  const h = parseInt(document.getElementById(prefix + '-h')?.value || 0);
  const s = parseInt(document.getElementById(prefix + '-s')?.value || 0);
  const l = parseInt(document.getElementById(prefix + '-l')?.value || 50);
  return hslToHex(h, s, l);
}

function setColorFromHex(prefix, hex) {
  const hsl = hexToHsl(hex);
  const hEl = document.getElementById(prefix + '-h');
  const sEl = document.getElementById(prefix + '-s');
  const lEl = document.getElementById(prefix + '-l');
  if (hEl) { hEl.value = hsl.h; document.getElementById(prefix + '-h-val').textContent = hsl.h + '°'; }
  if (sEl) { sEl.value = hsl.s; document.getElementById(prefix + '-s-val').textContent = hsl.s + '%'; }
  if (lEl) { lEl.value = hsl.l; document.getElementById(prefix + '-l-val').textContent = hsl.l + '%'; }
  updateColorPreview(prefix);
}

function updateColorPreview(prefix) {
  const hex = getColorHex(prefix);
  const preview = document.getElementById(prefix + '-preview');
  if (preview) preview.style.background = hex;
}

function setupColorPicker(prefix, defaultHex) {
  setColorFromHex(prefix, defaultHex);
  ['h', 's', 'l'].forEach(type => {
    const el = document.getElementById(prefix + '-' + type);
    if (!el) return;
    el.addEventListener('input', () => {
      document.getElementById(prefix + '-' + type + '-val').textContent =
        el.value + (type === 'h' ? '°' : '%');
      updateColorPreview(prefix);
    });
  });
}

async function loadRemoteSettings() {
  const creds = await api('GET', '/remote/credentials');
  if (!creds) return;
  if (document.getElementById('remote-user')) document.getElementById('remote-user').value = creds.username || '';
  if (document.getElementById('remote-pass')) document.getElementById('remote-pass').value = creds.password || '';
}

async function loadTasks() {
  // 加载当前运行任务
  const data = await api('GET', '/remote/tasks');
  if (data?.tasks) { tasks = data.tasks; }
  // 加载历史记录
  try {
    const hist = await api('GET', '/remote/history');
    if (hist?.history) {
      // 从历史中提取任务项，合并到 tasks
      for (const run of hist.history) {
        if (run.items) {
          for (const item of run.items) {
            if (!tasks.find(t => t.id === item.id)) {
              tasks.push({ ...item, _fromHistory: true });
            }
          }
        }
      }
    }
  } catch {}
  renderTasks();
}

async function sendTask() {
  const input = document.getElementById('task-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.disabled = true;
  document.getElementById('send-btn').disabled = true;
  try {
    const data = await api('POST', '/tasks', { text });
    if (data?.ok) {
      showToast('已添加 ' + (data.tasks?.length || 0) + ' 个任务');
      input.value = '';
      input.style.height = 'auto';
    } else {
      showToast(data?.error || '发送失败');
    }
  } catch { showToast('网络错误'); }
  input.disabled = false;
  document.getElementById('send-btn').disabled = false;
  input.focus();
}

function renderTasks() {
  const stream = document.getElementById('chat-stream');
  const empty = document.getElementById('empty-state');
  if (!stream) return;
  if (!tasks.length) {
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  const sorted = [...tasks].sort((a, b) => (a.index || a.queueIndex || 0) - (b.index || b.queueIndex || 0));

  stream.innerHTML = sorted.map(t => {
    const st = t.status || 'pending';
    const pg = Math.max(0, Math.min(100, Number(t.progress || 0)));
    const idx = t.index || t.queueIndex || 0;
    const name = idx ? '任务' + idx : (t.isOriginal ? '原创' : (t.taskName || '任务'));
    const badgeClass = { running: 'badge-running', completed: 'badge-completed', warning: 'badge-warning', failed: 'badge-failed' }[st] || 'badge-pending';
    const badgeText = { pending: '等待', queued: '等待', running: '执行中', completed: '成功', warning: '部分完成', failed: '失败', stopped: '已停止' }[st] || st;
    const barClass = st === 'completed' ? 'done' : st === 'failed' ? 'error' : '';
    const msg = t.message || '';
    const isOriginal = t.isOriginal;

    let actions = '';
    if (st === 'failed') actions += '<button class="btn btn-ghost" style="height:28px;padding:0 10px;font-size:11px" data-action="retry" data-id="' + t.id + '">重试</button>';
    if (['pending', 'queued', 'running'].includes(st)) actions += '<button class="btn btn-ghost" style="height:28px;padding:0 10px;font-size:11px" data-action="stop" data-id="' + t.id + '">停止</button>';

    return '<div class="task">' +
      '<div class="task-head"><span class="task-name">' + esc(name) + '</span><span class="task-badge ' + badgeClass + '">' + badgeText + '</span></div>' +
      (isOriginal ? '<div class="tasks"><span class="tag tag-original">原创</span></div>' : '') +
      (msg ? '<div class="task-msg">' + esc(msg) + '</div>' : '') +
      '<div class="task-bar"><div class="task-bar-fill ' + barClass + '" style="width:' + pg + '%"></div></div>' +
      (actions ? '<div class="task-actions">' + actions + '</div>' : '') +
      '</div>';
  }).join('');

  // Auto scroll to bottom
  const chat = document.getElementById('chat');
  if (chat) chat.scrollTop = chat.scrollHeight;
}

// === Init ===
if (token) {
  initApp();
} else {
  renderLogin();
}
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
        // 从独立凭证文件读取
        let remoteUser = 'admin';
        let remotePass = '';
        try {
          const credsPath = path.join(os.homedir(), 'AntBot', 'remote-credentials.json');
          const creds = JSON.parse(await fs.readFile(credsPath, 'utf-8'));
          remoteUser = creds.username || 'admin';
          remotePass = creds.password || '';
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
