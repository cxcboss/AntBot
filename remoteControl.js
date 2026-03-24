const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');
const { parseTaskInput } = require('./parser');
const { runStartupChecks } = require('./startupCheck');

const REMOTE_ROOT = path.join(__dirname, '..', '..', 'remote');
const REMOTE_CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};
const TRY_CLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/ig;
const COMMON_CLOUDFLARED_PATHS = [
  '/opt/homebrew/bin/cloudflared',
  '/usr/local/bin/cloudflared',
  '/usr/bin/cloudflared'
];

function normalizeRemoteSettings(remote = {}) {
  const port = Number(remote.port || 17888);
  const publicMode = String(remote.publicMode || 'off').trim() || 'off';
  return {
    enabled: Boolean(remote.enabled),
    port: Number.isFinite(port) && port > 0 ? Math.min(65535, Math.max(1024, Math.round(port))) : 17888,
    password: String(remote.password || '').trim(),
    publicMode: publicMode === 'cloudflare-quick' ? publicMode : 'off',
    cloudflaredPath: String(remote.cloudflaredPath || '').trim()
  };
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ''), 'utf-8');
  const right = Buffer.from(String(b || ''), 'utf-8');
  if (left.length !== right.length) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function listRemoteUrls(port) {
  const urls = new Set([`http://127.0.0.1:${port}/remote/`, `http://localhost:${port}/remote/`]);
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || entry.family !== 'IPv4') {
        continue;
      }
      urls.add(`http://${entry.address}:${port}/remote/`);
    }
  }
  return Array.from(urls);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大。'));
        req.destroy();
      }
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ raw });
      }
    });
    req.on('error', reject);
  });
}

function execCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error((stderr || stdout || `${command} exit ${code}`).trim()));
      }
    });
  });
}

class RemoteControlServer {
  constructor({ store, taskRunner, onStatusChange = () => {}, onRemoteLog = () => {} }) {
    this.store = store;
    this.taskRunner = taskRunner;
    this.onStatusChange = onStatusChange;
    this.onRemoteLog = onRemoteLog;

    this.server = null;
    this.remoteSettings = normalizeRemoteSettings();
    this.status = {
      enabled: false,
      online: false,
      port: 17888,
      passwordConfigured: false,
      urls: [],
      lastError: '',
      updatedAt: new Date().toISOString(),
      public: {
        mode: 'off',
        online: false,
        url: '',
        lastError: '',
        cloudflaredPath: '',
        installing: false
      }
    };

    this.progress = taskRunner.getSnapshot();
    this.history = [];
    this.logs = [];
    this.lastStartup = null;
    this.clients = new Set();
    this.tunnelProcess = null;
    this.tunnelConfigPath = path.join(os.tmpdir(), 'antbot-cloudflared-empty.yml');
  }

  async init() {
    this.history = (await this.store.getHistory()).slice(0, 20);
    const settings = await this.store.getSettings();
    await this.reconfigure(settings.remote || {});
  }

  getPublicState() {
    return {
      server: {
        ...this.status,
        passwordConfigured: Boolean(this.remoteSettings.password)
      },
      progress: this.progress,
      history: this.history.slice(0, 10),
      logs: this.logs.slice(-20),
      startup: this.lastStartup
    };
  }

  handleProgress(payload) {
    this.progress = payload;
    this.broadcast('progress', payload);
    this.broadcast('state', this.getPublicState());
  }

  handleLog(payload) {
    this.logs.push(payload);
    this.logs = this.logs.slice(-80);
    this.broadcast('log', payload);
    this.broadcast('state', this.getPublicState());
  }

  handleHistory(history) {
    this.history = Array.isArray(history) ? history.slice(0, 20) : [];
    this.broadcast('history', this.history.slice(0, 10));
    this.broadcast('state', this.getPublicState());
  }

  async reconfigure(remoteSettings) {
    this.remoteSettings = normalizeRemoteSettings(remoteSettings);
    this.status = {
      enabled: this.remoteSettings.enabled,
      online: false,
      port: this.remoteSettings.port,
      passwordConfigured: Boolean(this.remoteSettings.password),
      urls: this.remoteSettings.enabled ? listRemoteUrls(this.remoteSettings.port) : [],
      lastError: '',
      updatedAt: new Date().toISOString(),
      public: {
        mode: this.remoteSettings.publicMode,
        online: false,
        url: '',
        lastError: '',
        cloudflaredPath: this.remoteSettings.cloudflaredPath || '',
        installing: false
      }
    };

    if (!this.remoteSettings.enabled) {
      await this.stop();
      this.emitStatus();
      return this.getPublicState();
    }

    if (!this.remoteSettings.password) {
      await this.stop();
      this.status.lastError = '远程控制已开启，但未设置密码。';
      this.emitStatus();
      return this.getPublicState();
    }

    await this.stop(false);
    await this.startLocalServer();
    await this.startPublicTunnelIfNeeded();
    this.emitStatus();
    return this.getPublicState();
  }

  async startLocalServer() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        sendJson(res, 500, {
          ok: false,
          message: String(error?.message || error || '服务器内部错误')
        });
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.remoteSettings.port, '0.0.0.0', () => {
        this.server.off('error', reject);
        resolve();
      });
    }).catch((error) => {
      this.status.lastError = `远程服务启动失败：${String(error?.message || error)}`;
      this.server = null;
      throw error;
    });

    this.status.online = true;
    this.status.urls = listRemoteUrls(this.remoteSettings.port);
    this.status.lastError = '';
    this.status.updatedAt = new Date().toISOString();
  }

  async stop(emit = true) {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // noop
      }
    }
    this.clients.clear();

    await this.stopTunnel();

    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(() => resolve());
      }).catch(() => {});
      this.server = null;
    }

    this.status.online = false;
    this.status.updatedAt = new Date().toISOString();
    if (emit) {
      this.emitStatus();
    }
  }

  emitStatus() {
    const payload = this.getPublicState();
    this.onStatusChange(payload);
    this.broadcast('remote', payload.server);
    this.broadcast('state', payload);
  }

  broadcast(eventName, payload) {
    if (!this.clients.size) {
      return;
    }

    const message = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of Array.from(this.clients)) {
      try {
        client.write(message);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  async resolveCloudflaredPath() {
    const configured = this.remoteSettings.cloudflaredPath;
    if (configured) {
      try {
        await fs.access(configured);
        return configured;
      } catch {
        // noop
      }
    }

    for (const candidate of COMMON_CLOUDFLARED_PATHS) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // noop
      }
    }

    try {
      const { stdout } = await execCapture('which', ['cloudflared']);
      const found = String(stdout || '').trim().split(/\r?\n/).find(Boolean);
      if (found) {
        return found;
      }
    } catch {
      // noop
    }

    if (process.platform === 'darwin') {
      try {
        this.status.public.installing = true;
        this.status.public.lastError = '正在通过 Homebrew 安装 cloudflared...';
        this.emitStatus();
        const brewPath = '/opt/homebrew/bin/brew';
        await fs.access(brewPath);
        await execCapture(brewPath, ['install', 'cloudflared']);
        await fs.access('/opt/homebrew/bin/cloudflared');
        this.status.public.installing = false;
        return '/opt/homebrew/bin/cloudflared';
      } catch (error) {
        this.status.public.installing = false;
        throw new Error(`未找到 cloudflared。请先执行 brew install cloudflared。${String(error?.message || error || '')}`.trim());
      }
    }

    throw new Error('未找到 cloudflared，请先安装后再开启公网访问。');
  }

  async startPublicTunnelIfNeeded() {
    this.status.public.mode = this.remoteSettings.publicMode;
    if (this.remoteSettings.publicMode !== 'cloudflare-quick') {
      this.status.public.online = false;
      this.status.public.url = '';
      this.status.public.lastError = '';
      this.status.public.installing = false;
      return;
    }

    try {
      const cloudflaredPath = await this.resolveCloudflaredPath();
      this.status.public.cloudflaredPath = cloudflaredPath;
      await fs.writeFile(this.tunnelConfigPath, '', 'utf-8');
      const localUrl = `http://127.0.0.1:${this.remoteSettings.port}`;

      this.tunnelProcess = spawn(cloudflaredPath, ['tunnel', '--url', localUrl, '--no-autoupdate', '--config', this.tunnelConfigPath], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const publicUrl = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, url) => {
          if (settled) {
            return;
          }
          settled = true;
          if (error) {
            reject(error);
          } else {
            resolve(url);
          }
        };

        const onData = (chunk) => {
          const text = String(chunk || '');
          const matched = text.match(TRY_CLOUDFLARE_URL_RE);
          if (matched?.length) {
            finish(null, matched[0]);
          }
        };

        this.tunnelProcess.stdout.on('data', onData);
        this.tunnelProcess.stderr.on('data', onData);
        this.tunnelProcess.once('error', (error) => finish(error));
        this.tunnelProcess.once('close', (code) => {
          if (!settled) {
            finish(new Error(`cloudflared 已退出（code=${code ?? 'null'}）。`));
          }
        });
        setTimeout(() => finish(new Error('等待 Cloudflare Quick Tunnel 地址超时。')), 20000);
      });

      this.tunnelProcess.once('close', () => {
        this.status.public.online = false;
        this.status.public.url = '';
        this.status.public.lastError = '公网隧道已断开。';
        this.emitStatus();
        this.tunnelProcess = null;
      });

      this.status.public.online = true;
      this.status.public.url = publicUrl;
      this.status.public.lastError = '';
      this.status.public.installing = false;
    } catch (error) {
      this.status.public.online = false;
      this.status.public.url = '';
      this.status.public.installing = false;
      this.status.public.lastError = String(error?.message || error);
    }
  }

  async stopTunnel() {
    if (!this.tunnelProcess) {
      this.status.public.online = false;
      this.status.public.url = '';
      this.status.public.installing = false;
      return;
    }

    const child = this.tunnelProcess;
    this.tunnelProcess = null;
    await new Promise((resolve) => {
      child.once('close', () => resolve());
      try {
        child.kill('SIGTERM');
      } catch {
        resolve();
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // noop
        }
        resolve();
      }, 3000);
    }).catch(() => {});

    this.status.public.online = false;
    this.status.public.url = '';
    this.status.public.installing = false;
  }

  async handleRequest(req, res) {
    const requestUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    if (requestUrl.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (requestUrl.pathname === '/') {
      res.writeHead(302, { Location: '/remote/' });
      res.end();
      return;
    }

    if (requestUrl.pathname === '/remote') {
      res.writeHead(302, { Location: '/remote/' });
      res.end();
      return;
    }

    if (requestUrl.pathname.startsWith('/remote/')) {
      await this.serveRemoteAsset(requestUrl.pathname, res);
      return;
    }

    if (!this.remoteSettings.enabled || !this.server) {
      sendJson(res, 503, { ok: false, message: '远程控制未启用。' });
      return;
    }

    if (requestUrl.pathname === '/api/login' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!this.isAuthorized(req, requestUrl, body)) {
        sendJson(res, 401, { ok: false, message: '密码错误。' });
        return;
      }
      sendJson(res, 200, { ok: true, state: this.getPublicState() });
      return;
    }

    if (requestUrl.pathname === '/api/events' && req.method === 'GET') {
      if (!this.isAuthorized(req, requestUrl)) {
        sendJson(res, 401, { ok: false, message: '密码错误。' });
        return;
      }
      this.attachSseClient(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/state' && req.method === 'GET') {
      if (!this.isAuthorized(req, requestUrl)) {
        sendJson(res, 401, { ok: false, message: '密码错误。' });
        return;
      }
      sendJson(res, 200, { ok: true, state: this.getPublicState() });
      return;
    }

    if (requestUrl.pathname === '/api/start' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!this.isAuthorized(req, requestUrl, body)) {
        sendJson(res, 401, { ok: false, message: '密码错误。' });
        return;
      }
      try {
        const result = await this.handleRemoteStart(body);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, /已有任务在运行/.test(String(error?.message || '')) ? 409 : 400, {
          ok: false,
          message: String(error?.message || error)
        });
      }
      return;
    }

    if (requestUrl.pathname === '/api/stop' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!this.isAuthorized(req, requestUrl, body)) {
        sendJson(res, 401, { ok: false, message: '密码错误。' });
        return;
      }
      await this.taskRunner.stop();
      sendJson(res, 200, { ok: true, stopped: true });
      return;
    }

    sendJson(res, 404, { ok: false, message: '未找到接口。' });
  }

  isAuthorized(req, requestUrl, body = {}) {
    const headerPassword = req.headers['x-antbot-password'];
    const queryPassword = requestUrl.searchParams.get('password');
    const bodyPassword = body.password;
    const candidate = String(headerPassword || bodyPassword || queryPassword || '').trim();
    if (!candidate || !this.remoteSettings.password) {
      return false;
    }
    return timingSafeEqualText(candidate, this.remoteSettings.password);
  }

  attachSseClient(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: state\ndata: ${JSON.stringify(this.getPublicState())}\n\n`);
    this.clients.add(res);

    req.on('close', () => {
      this.clients.delete(res);
    });
  }

  async handleRemoteStart(body) {
    if (this.taskRunner.running) {
      throw new Error('已有任务在运行，请先停止。');
    }

    const inputText = String(body?.inputText || '').trim();
    if (!inputText) {
      throw new Error('请输入任务内容。');
    }

    const tasks = parseTaskInput(inputText);
    if (!tasks.length) {
      throw new Error('未识别到有效任务。');
    }

    const settings = await this.store.getSettings();
    const loginState = await this.store.getLoginState();
    const startup = await runStartupChecks(settings, loginState, (msg) => {
      this.onRemoteLog({
        runId: '',
        taskId: '',
        level: 'info',
        timestamp: new Date().toISOString(),
        message: `[远程启动检查] ${msg}`
      });
    });
    this.lastStartup = startup;

    for (const [service, state] of Object.entries(startup.loginState || {})) {
      await this.store.setLoginState(service, state.loggedIn);
    }

    const videoReady = Boolean(startup.loginState?.videoChannel?.loggedIn);
    const douyinReady = Boolean(startup.loginState?.douyin?.loggedIn);
    if (!videoReady && !douyinReady) {
      throw new Error('请先在电脑端登录抖音或视频号（任一即可）。');
    }
    if (!startup.voiceCloneReady) {
      throw new Error('请先在电脑端完成语音克隆。');
    }

    this.broadcast('state', this.getPublicState());

    this.taskRunner.start(tasks).catch((error) => {
      this.onRemoteLog({
        runId: '',
        taskId: '',
        level: 'error',
        timestamp: new Date().toISOString(),
        message: String(error?.message || error)
      });
    });

    return {
      ok: true,
      started: true,
      taskCount: tasks.length,
      runId: this.taskRunner.runId || `${Date.now()}`
    };
  }

  async serveRemoteAsset(pathname, res) {
    const normalized = pathname === '/remote/' ? '/remote/index.html' : pathname;
    const relative = normalized.replace(/^\/remote\/?/, '') || 'index.html';
    const safeRelative = path.posix.normalize(`/${relative}`).replace(/^\/+/, '');
    const filePath = path.join(REMOTE_ROOT, safeRelative);

    if (!filePath.startsWith(REMOTE_ROOT)) {
      sendJson(res, 404, { ok: false, message: '远程页面不存在。' });
      return;
    }

    try {
      const content = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      sendText(res, 200, content, REMOTE_CONTENT_TYPES[ext] || 'application/octet-stream');
    } catch {
      sendJson(res, 404, { ok: false, message: '远程页面不存在。' });
    }
  }
}

module.exports = {
  RemoteControlServer,
  normalizeRemoteSettings,
  listRemoteUrls
};
