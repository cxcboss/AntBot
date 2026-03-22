import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DATA_ROOT = process.env.ANTBOT_PROXY_DATA_ROOT || '/data';
const CONFIG_PATH = path.join(DATA_ROOT, 'proxy-config.json');
const STATIC_ROOT = path.join(__dirname, 'remote');
const ENV_TARGET_URL = normalizeTargetUrl(process.env.ANTBOT_DESKTOP_BASE_URL || '');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function normalizeTargetUrl(input) {
  const value = String(input || '').trim();
  if (!value) {
    return '';
  }
  const normalized = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  const url = new URL(normalized);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('桌面端地址仅支持 http 或 https。');
  }
  return url.origin;
}

async function ensureDataRoot() {
  await fs.mkdir(DATA_ROOT, { recursive: true });
}

async function readSavedConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      targetUrl: normalizeTargetUrl(parsed.targetUrl || ''),
      updatedAt: parsed.updatedAt || ''
    };
  } catch {
    return { targetUrl: '', updatedAt: '' };
  }
}

async function writeSavedConfig(targetUrl) {
  await ensureDataRoot();
  const payload = {
    targetUrl,
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  return payload;
}

async function resolveProxyState() {
  if (ENV_TARGET_URL) {
    return {
      configured: true,
      targetUrl: ENV_TARGET_URL,
      updatedAt: '',
      source: 'env'
    };
  }
  const saved = await readSavedConfig();
  return {
    configured: Boolean(saved.targetUrl),
    targetUrl: saved.targetUrl,
    updatedAt: saved.updatedAt,
    source: saved.targetUrl ? 'file' : 'unset'
  };
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  const payload = Buffer.from(String(body || ''), 'utf-8');
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': payload.length,
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function buildSetupPage(proxyState, message = '') {
  const targetUrl = proxyState.targetUrl || '';
  const messageHtml = message
    ? `<p class="message">${escapeHtml(message)}</p>`
    : '<p class="message muted">首次使用时填写桌面端在局域网中的地址，例如 http://192.168.31.8:17888 。</p>';
  const sourceText = proxyState.source === 'env'
    ? '当前地址由环境变量锁定。'
    : (proxyState.updatedAt ? `上次保存：${escapeHtml(proxyState.updatedAt)}` : '尚未保存桌面端地址。');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>搬运蚁远程中转设置</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      font-family: "PingFang SC", "Noto Sans SC", sans-serif;
      background: #eef3f8;
      color: #111827;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #0f141a; color: #f4f7fb; }
      .card { background: #181e26; border-color: #2f3946; }
      input { background: #121821; color: #f4f7fb; border-color: #2f3946; }
      .muted { color: #aab6c6; }
    }
    .wrap { max-width: 680px; margin: 0 auto; padding: 20px 14px 28px; }
    .card {
      background: rgba(255, 255, 255, 0.94);
      border: 1px solid #d6dfea;
      border-radius: 24px;
      padding: 18px;
      box-shadow: 0 16px 32px rgba(15, 23, 42, 0.08);
    }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0; line-height: 1.65; }
    .muted { color: #6b7280; }
    .message { margin-top: 12px; }
    label { display: block; margin-top: 18px; font-size: 12px; color: #6b7280; }
    input {
      width: 100%;
      margin-top: 8px;
      box-sizing: border-box;
      border-radius: 14px;
      border: 1px solid #d6dfea;
      padding: 12px 14px;
      font: inherit;
    }
    .actions { display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
    button, a {
      border-radius: 999px;
      min-height: 42px;
      padding: 0 16px;
      border: 1px solid transparent;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font: inherit;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
    }
    button { background: #2978ff; color: #fff; }
    a { background: transparent; border-color: #d6dfea; color: inherit; }
    .tip {
      margin-top: 16px;
      padding: 12px 14px;
      border-radius: 16px;
      background: rgba(41, 120, 255, 0.08);
      font-size: 13px;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <h1>搬运蚁远程中转</h1>
      <p class="muted">手机访问飞牛 NAS 后，这个服务会把请求转发到同局域网内的搬运蚁桌面端。</p>
      ${messageHtml}
      <label for="target-url">桌面端地址</label>
      <input id="target-url" type="text" placeholder="http://192.168.31.8:17888" value="${escapeHtml(targetUrl)}" ${proxyState.source === 'env' ? 'disabled' : ''} />
      <div class="actions">
        <button id="save-btn" type="button" ${proxyState.source === 'env' ? 'disabled' : ''}>保存并进入控制台</button>
        <a href="/">打开控制台</a>
      </div>
      <div class="tip">${escapeHtml(sourceText)}</div>
    </section>
  </main>
  <script>
    const saveBtn = document.getElementById('save-btn');
    saveBtn?.addEventListener('click', async () => {
      const targetUrl = document.getElementById('target-url').value.trim();
      const response = await fetch('/api/proxy-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        alert(payload.message || '保存失败');
        return;
      }
      window.location.href = '/';
    });
  </script>
</body>
</html>`;
}

function escapeHtml(input = '') {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === '/') {
    pathname = '/index.html';
  }
  const relativePath = pathname.replace(/^\/+/, '');
  const targetPath = path.join(STATIC_ROOT, relativePath);
  if (!targetPath.startsWith(STATIC_ROOT)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) {
      sendText(res, 404, 'Not Found');
      return;
    }
    const data = await fs.readFile(targetPath);
    const ext = path.extname(targetPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300'
    });
    res.end(data);
  } catch {
    sendText(res, 404, 'Not Found');
  }
}

async function proxyApi(req, res, targetUrl) {
  const requestUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const target = new URL(requestUrl.pathname + requestUrl.search, targetUrl);
  const body = await readBody(req);
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) {
      continue;
    }
    const lowerKey = key.toLowerCase();
    if (['host', 'connection', 'content-length'].includes(lowerKey)) {
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(key, item));
    } else {
      headers.set(key, value);
    }
  }

  let response;
  try {
    response = await fetch(target, {
      method: req.method,
      headers,
      body: body.length && !['GET', 'HEAD'].includes(req.method || 'GET') ? body : undefined
    });
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      message: `无法连接桌面端：${error.message}`
    });
    return;
  }

  const responseBuffer = Buffer.from(await response.arrayBuffer());
  const nextHeaders = {};
  response.headers.forEach((value, key) => {
    if (['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
      return;
    }
    nextHeaders[key] = value;
  });
  nextHeaders['Cache-Control'] = 'no-store';
  nextHeaders['Content-Length'] = responseBuffer.length;
  res.writeHead(response.status, nextHeaders);
  res.end(responseBuffer);
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const proxyState = await resolveProxyState();

  if (requestUrl.pathname === '/healthz') {
    sendJson(res, 200, { ok: true, configured: proxyState.configured });
    return;
  }

  if (requestUrl.pathname === '/api/proxy-meta' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      configured: proxyState.configured,
      targetUrl: proxyState.targetUrl,
      source: proxyState.source,
      updatedAt: proxyState.updatedAt,
      setupUrl: '/setup/'
    });
    return;
  }

  if (requestUrl.pathname === '/api/proxy-config' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      configured: proxyState.configured,
      targetUrl: proxyState.targetUrl,
      source: proxyState.source,
      updatedAt: proxyState.updatedAt
    });
    return;
  }

  if (requestUrl.pathname === '/api/proxy-config' && req.method === 'POST') {
    if (proxyState.source === 'env') {
      sendJson(res, 400, {
        ok: false,
        message: '当前地址由环境变量控制，不能在页面中修改。'
      });
      return;
    }
    const body = await readBody(req);
    let payload = {};
    try {
      payload = JSON.parse(body.toString('utf-8') || '{}');
    } catch {
      sendJson(res, 400, { ok: false, message: '请求体必须为 JSON。' });
      return;
    }
    let targetUrl = '';
    try {
      targetUrl = normalizeTargetUrl(payload.targetUrl || '');
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error.message });
      return;
    }
    if (!targetUrl) {
      sendJson(res, 400, { ok: false, message: '请填写桌面端地址。' });
      return;
    }
    const saved = await writeSavedConfig(targetUrl);
    sendJson(res, 200, { ok: true, targetUrl: saved.targetUrl, updatedAt: saved.updatedAt });
    return;
  }

  if (requestUrl.pathname === '/setup' || requestUrl.pathname === '/setup/') {
    sendText(res, 200, buildSetupPage(proxyState), 'text/html; charset=utf-8');
    return;
  }

  if (requestUrl.pathname.startsWith('/api/')) {
    if (!proxyState.configured || !proxyState.targetUrl) {
      sendJson(res, 503, {
        ok: false,
        message: '飞牛中转尚未配置桌面端地址。请先打开 /setup/ 完成一次配置。'
      });
      return;
    }
    await proxyApi(req, res, proxyState.targetUrl);
    return;
  }

  if (requestUrl.pathname === '/' && (!proxyState.configured || !proxyState.targetUrl)) {
    res.writeHead(302, { Location: '/setup/' });
    res.end();
    return;
  }

  await serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[antbot-relay] listening on :${PORT}`);
});
