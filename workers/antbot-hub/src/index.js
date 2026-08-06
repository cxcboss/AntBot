/**
 * AntBot Hub — 设备注册中心 (Cloudflare Worker)
 *
 * API 端点：
 *   POST /api/register    设备注册/心跳
 *   GET  /api/devices     获取在线设备列表
 *   POST /api/unregister  设备下线注销
 *   POST /api/verify      代理密码验证
 *
 * 页面：
 *   GET /                 设备列表页面
 *
 * KV 绑定：DEVICES
 */

const ONLINE_TTL = 300;
const ONLINE_THRESHOLD = 120;

// 与 App 端共享的 API 密钥（wrangler secret put HUB_SECRET=xxx 可覆盖）
const DEFAULT_HUB_SECRET = 'antbot-hub-2026-default-secret';

// verify 限速：每设备 10 分钟内最多 5 次失败（内存态，单实例有效）
const VERIFY_LIMIT = 5;
const VERIFY_WINDOW_MS = 10 * 60 * 1000;
const _rateLimit = new Map(); // deviceId -> { count, resetAt }

function checkSecret(request, env) {
  const secret = env.HUB_SECRET || DEFAULT_HUB_SECRET;
  return request.headers.get('x-hub-secret') === secret;
}

function isRateLimited(deviceId) {
  const now = Date.now();
  const entry = _rateLimit.get(deviceId);
  if (!entry || entry.resetAt < now) {
    _rateLimit.set(deviceId, { count: 0, resetAt: now + VERIFY_WINDOW_MS });
    return false;
  }
  if (entry.count >= VERIFY_LIMIT) return true;
  return false;
}

function recordFailure(deviceId) {
  const now = Date.now();
  const entry = _rateLimit.get(deviceId);
  if (!entry || entry.resetAt < now) {
    _rateLimit.set(deviceId, { count: 1, resetAt: now + VERIFY_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function clearRateLimit(deviceId) {
  _rateLimit.delete(deviceId);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const NO_CACHE = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...NO_CACHE },
  });
}

function options() {
  return new Response(null, { status: 204, headers: CORS });
}

// ─── 设备列表页面 ───
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>搬运蚁 — 远程控制中心</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg:#0a0a0b;--card:#141416;--fg:#fafafa;--muted:#a1a1aa;
    --border:#26262a;--primary:#fafafa;--primary-hover:#d4d4d8;--primary-fg:#0a0a0b;
    --accent:#26262a;--success:#22c55e;--destructive:#ef4444;
    --radius:8px;--radius-lg:12px;--radius-xl:16px;
    --font:-apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC","Inter",sans-serif;
  }
  body{font-family:var(--font);background:var(--bg);color:var(--fg);min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 16px}
  .container{width:100%;max-width:480px}
  .header{text-align:center;margin-bottom:32px}
  .header h1{font-size:20px;font-weight:600;margin-bottom:4px}
  .header p{font-size:13px;color:var(--muted)}
  .device-list{display:flex;flex-direction:column;gap:8px}
  .device-card{
    display:flex;align-items:center;gap:12px;padding:14px 16px;
    background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);
    cursor:pointer;transition:border-color 120ms ease;text-decoration:none;color:var(--fg);
  }
  .device-card:hover{border-color:var(--muted)}
  .device-card.offline{opacity:.5;cursor:default}
  .device-card.offline:hover{border-color:var(--border)}
  .device-icon{width:40px;height:40px;border-radius:var(--radius);background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
  .device-info{flex:1;min-width:0}
  .device-name{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .device-status{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);margin-top:2px}
  .status-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
  .status-dot.online{background:var(--success)}
  .status-dot.offline{background:var(--muted)}
  .device-arrow{color:var(--muted);font-size:16px;flex-shrink:0}
  .empty{text-align:center;padding:48px 16px;color:var(--muted);font-size:13px}
  .empty-icon{font-size:32px;margin-bottom:8px;opacity:.5}
  .footer{margin-top:32px;text-align:center;font-size:11px;color:var(--muted)}
  .loading{text-align:center;padding:32px;color:var(--muted);font-size:13px}
  .spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--muted);border-radius:50%;animation:spin .6s linear infinite;margin-right:6px;vertical-align:middle}
  @keyframes spin{to{transform:rotate(360deg)}}
  .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:100}
  .modal{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-xl);padding:24px;width:90%;max-width:360px;box-shadow:0 20px 25px -5px rgba(0,0,0,.3)}
  .modal h3{font-size:15px;font-weight:600;margin-bottom:4px}
  .modal p{font-size:12px;color:var(--muted);margin-bottom:16px}
  .modal input{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--fg);font-size:13px;outline:none;transition:border-color 120ms}
  .modal input:focus{border-color:var(--muted)}
  .modal-error{font-size:11px;color:var(--destructive);margin-top:6px;min-height:16px}
  .modal-actions{display:flex;gap:8px;margin-top:16px;justify-content:flex-end}
  .modal-actions button{padding:8px 16px;border-radius:var(--radius);font-size:13px;font-weight:500;cursor:pointer;border:1px solid var(--border);background:var(--card);color:var(--fg);transition:border-color 120ms}
  .modal-actions button:hover{border-color:var(--muted)}
  .modal-actions .btn-primary{background:var(--primary);color:var(--primary-fg);border-color:var(--primary)}
  .modal-actions .btn-primary:hover{background:var(--primary-hover)}
  .modal-actions .btn-primary:disabled{opacity:.5;cursor:not-allowed}
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>搬运蚁 远程控制中心</h1>
      <p>选择一台电脑，输入密码即可远程操控</p>
    </div>
    <div class="device-list" id="device-list">
      <div class="loading"><span class="spinner"></span>正在搜索设备...</div>
    </div>
    <div class="footer">设备离线？请确认电脑上的搬运蚁 App 已开启远程访问</div>
  </div>
  <div id="modal-root"></div>

<script>
const REFRESH_INTERVAL = 10000;
let refreshTimer = null;

function formatTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return new Date(ts).toLocaleDateString('zh-CN');
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderDevices(devices) {
  const el = document.getElementById('device-list');
  if (!devices.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">💻</div>暂无在线设备<br><span style="font-size:11px">请确认电脑上的 App 已开启远程访问</span></div>';
    return;
  }
  el.innerHTML = devices.map(d => {
    const online = d.online;
    const cls = online ? '' : ' offline';
    return '<div class="device-card'+cls+'" data-id="'+escapeHtml(d.deviceId)+'" data-url="'+escapeHtml(d.tunnelUrl)+'" data-name="'+escapeHtml(d.deviceName)+'" data-online="'+online+'">'
      + '<div class="device-icon">💻</div>'
      + '<div class="device-info">'
      + '<div class="device-name">'+escapeHtml(d.deviceName)+'</div>'
      + '<div class="device-status">'
      + '<span class="status-dot '+(online?'online':'offline')+'"></span>'
      + (online ? '在线' : '离线') + ' · ' + formatTime(d.lastSeen)
      + '</div></div>'
      + (online ? '<div class="device-arrow">→</div>' : '')
      + '</div>';
  }).join('');
  el.querySelectorAll('.device-card[data-online="true"]').forEach(card => {
    card.addEventListener('click', () => showPasswordModal(card.dataset.name, card.dataset.url, card.dataset.id));
  });
}

function showPasswordModal(deviceName, tunnelUrl, deviceId) {
  const root = document.getElementById('modal-root');
  root.innerHTML = '<div class="modal-overlay" id="pw-modal">'
    + '<div class="modal">'
    + '<h3>连接到 ' + escapeHtml(deviceName) + '</h3>'
    + '<p>请输入该设备的访问密码</p>'
    + '<input type="password" id="pw-input" placeholder="密码" autocomplete="off" />'
    + '<div class="modal-error" id="pw-error"></div>'
    + '<div class="modal-actions">'
    + '<button id="pw-cancel">取消</button>'
    + '<button id="pw-confirm" class="btn-primary">确认</button>'
    + '</div></div></div>';
  const input = document.getElementById('pw-input');
  const error = document.getElementById('pw-error');
  const confirm = document.getElementById('pw-confirm');
  input.focus();
  document.getElementById('pw-cancel').addEventListener('click', closePasswordModal);
  document.getElementById('pw-modal').addEventListener('click', e => { if (e.target.id === 'pw-modal') closePasswordModal(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doVerify(); });
  confirm.addEventListener('click', doVerify);

  async function doVerify() {
    const password = input.value.trim();
    if (!password) { error.textContent = '请输入密码'; return; }
    confirm.disabled = true;
    confirm.textContent = '验证中...';
    error.textContent = '';
    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, password })
      });
      const data = await res.json();
      if (data.ok) {
        const sep = tunnelUrl.includes('?') ? '&' : '?';
        window.location.href = tunnelUrl + sep + 'hub_token=' + data.token + '&device_id=' + encodeURIComponent(deviceId) + '&device_name=' + encodeURIComponent(deviceName);
      } else {
        error.textContent = data.error || '密码错误';
        confirm.disabled = false;
        confirm.textContent = '确认';
        input.select();
      }
    } catch (e) {
      error.textContent = '网络错误，请重试';
      confirm.disabled = false;
      confirm.textContent = '确认';
    }
  }
}

function closePasswordModal() {
  document.getElementById('modal-root').innerHTML = '';
}

async function fetchDevices() {
  try {
    const res = await fetch('/api/devices');
    const data = await res.json();
    if (data.ok) renderDevices(data.devices);
  } catch (e) {
    document.getElementById('device-list').innerHTML = '<div class="empty" style="color:#ef4444">加载失败: ' + (e.message || '网络错误') + '<br><button onclick="fetchDevices()" style="margin-top:8px;padding:4px 12px;border-radius:6px;border:1px solid #27272a;background:#111113;color:#fafafa;cursor:pointer">重试</button></div>';
  }
}

fetchDevices();
refreshTimer = setInterval(fetchDevices, REFRESH_INTERVAL);
</script>
</body>
</html>`;

// ─── API 处理 ───

async function handleRegister(request, env) {
  const { deviceId, deviceName, tunnelUrl } = await request.json();
  if (!deviceId || !deviceName || !tunnelUrl) {
    return json({ ok: false, error: '缺少 deviceId / deviceName / tunnelUrl' }, 400);
  }
  const key = `device:${deviceId}`;
  const now = Date.now();
  const value = JSON.stringify({ deviceId, deviceName, tunnelUrl, lastSeen: now });
  await env.DEVICES.put(key, value, { expirationTtl: ONLINE_TTL });
  return json({ ok: true, deviceId, deviceName });
}

async function handleDevices(request, env) {
  const list = await env.DEVICES.list({ prefix: 'device:' });
  const now = Date.now();
  const devices = [];

  for (const item of list.keys) {
    const raw = await env.DEVICES.get(item.name);
    if (!raw) continue;
    try {
      const d = JSON.parse(raw);
      // 跳过旧版格式记录（无 deviceId，等待 TTL 自动过期）
      if (!d.deviceId) continue;
      devices.push({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        tunnelUrl: d.tunnelUrl,
        online: (now - d.lastSeen) < ONLINE_THRESHOLD * 1000,
        lastSeen: d.lastSeen,
      });
    } catch { /* skip */ }
  }

  devices.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return b.lastSeen - a.lastSeen;
  });

  return json({ ok: true, devices });
}

async function handleUnregister(request, env) {
  const { deviceId } = await request.json();
  if (!deviceId) return json({ ok: false, error: '缺少 deviceId' }, 400);
  await env.DEVICES.delete(`device:${deviceId}`);
  clearRateLimit(deviceId);
  return json({ ok: true });
}

async function handleVerify(request, env) {
  const { deviceId, password } = await request.json();
  if (!deviceId || !password) {
    return json({ ok: false, error: '缺少参数' }, 400);
  }

  if (isRateLimited(deviceId)) {
    return json({ ok: false, error: '尝试次数过多，请稍后再试' }, 429);
  }

  const raw = await env.DEVICES.get(`device:${deviceId}`);
  if (!raw) return json({ ok: false, error: '设备不存在或已离线' }, 404);

  let device;
  try { device = JSON.parse(raw); } catch {
    return json({ ok: false, error: '设备数据异常' }, 500);
  }

  // 代理验证：将密码发送到设备的 /remote/login
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(device.tunnelUrl + '/remote/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json();
    if (data.ok && data.token) {
      clearRateLimit(deviceId);
      return json({ ok: true, token: data.token });
    }
    recordFailure(deviceId);
    return json({ ok: false, error: data.error || '密码错误' }, 401);
  } catch (e) {
    if (e.name === 'AbortError') {
      return json({ ok: false, error: '设备响应超时' }, 504);
    }
    return json({ ok: false, error: '无法连接到设备' }, 502);
  }
}

// ─── 路由 ───

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return options();

    // 设备注册/注销/验证需要共享密钥鉴权（防止设备列表污染与钓鱼）
    if (path === '/api/register' && method === 'POST') {
      if (!checkSecret(request, env)) return json({ ok: false, error: '未授权' }, 401);
      return handleRegister(request, env);
    }
    if (path === '/api/devices' && method === 'GET') return handleDevices(request, env);
    if (path === '/api/unregister' && method === 'POST') {
      if (!checkSecret(request, env)) return json({ ok: false, error: '未授权' }, 401);
      return handleUnregister(request, env);
    }
    if (path === '/api/verify' && method === 'POST') return handleVerify(request, env);

    // 更新 Hub HTML（由 App 端调用，需共享密钥）
    if (path === '/api/update-html' && method === 'POST') {
      if (!checkSecret(request, env)) return json({ ok: false, error: '未授权' }, 401);
      const { html, version } = await request.json();
      if (!html) return json({ ok: false, error: '缺少 html' }, 400);
      await env.DEVICES.put('hub-html-cache', JSON.stringify({ html, version }), { expirationTtl: 86400 * 7 });
      return json({ ok: true, version });
    }

    // 查询 Hub HTML 版本
    if (path === '/api/html-version' && method === 'GET') {
      const cached = await env.DEVICES.get('hub-html-cache', { type: 'json' });
      return json({ ok: true, version: cached?.version || 'built-in' });
    }

    if (path === '/' || path === '') {
      // 优先使用 KV 缓存的 HTML
      let html = HTML;
      try {
        const cached = await env.DEVICES.get('hub-html-cache', { type: 'json' });
        if (cached?.html) html = cached.html;
      } catch {}
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_CACHE },
      });
    }

    return json({ ok: false, error: 'Not found' }, 404);
  },
};
