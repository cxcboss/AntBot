const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

const REMOTE_PORT = 18931;
const TOKEN_TTL = 24 * 60 * 60 * 1000; // 会话 24 小时过期
const MAX_BODY_BYTES = 1024 * 1024; // 请求体上限 1MB
const MAX_LOGIN_FAILURES = 10; // 10 次登录失败
const LOGIN_LOCK_MS = 15 * 60 * 1000; // 锁 15 分钟
let _server = null;
let _startPromise = null;
let _remotePort = REMOTE_PORT;
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
  let bridgePort = 18321;
  try {
    const { readStoredPort } = require('./bridgeServiceManager');
    bridgePort = readStoredPort() || 18321;
  } catch {}
  const [api, bridge, voicebox, remote] = await Promise.all([
    checkPortOpen(18930), checkPortOpen(bridgePort), getVoiceboxStatus(), checkPortOpen(_remotePort),
  ]);
  return {
    api: { name: '本地 API', port: 18930, running: api },
    bridge: { name: '桥接服务', port: bridgePort, running: bridge },
    voicebox: { name: '配音引擎', port: 17493, running: voicebox.running },
    remote: { name: '远程服务', port: _remotePort, running: remote },
    tunnel: { name: '隧道', port: null, running: Boolean(tunnel.running), url: tunnel.url || null },
  };
}

async function getApiUsage() {
  try {
    const { getUsageSummary } = require('./usageTracker');
    const { normalizeApiKeys } = require('./apiClient');
    const settings = _store ? await _store.getSettings() : null;
    const keys = normalizeApiKeys(settings?.api).map(k => k.key);
    if (!keys.length) return [];
    return getUsageSummary(keys);
  } catch { return []; }
}

async function getStatus() {
  const tasks = _taskRunner ? _taskRunner.progressRows || [] : [];
  const queueTasks = _taskRunner?.getQueuedTaskRows ? _taskRunner.getQueuedTaskRows() : [];
  const taskRows = [...tasks, ...queueTasks];
  const [services, usage] = await Promise.all([getServicesStatus(), getApiUsage()]);
  return {
    running: _taskRunner?.running || false,
    taskCount: taskRows.length,
    tasks: taskRows.map(t => ({
      id: t.id,
      logicalTaskId: t.logicalTaskId || t.taskSnapshot?.logicalTaskId || '',
      name: t.taskName || (t.isOriginal ? '原创' : '任务'),
      status: t.status,
      progress: t.progress,
      step: t.step,
      message: t.message,
      isOriginal: t.isOriginal,
      rawLine: t.rawLine,
      platforms: Array.isArray(t.platforms) ? t.platforms.slice() : [],
      sourceType: t.sourceType || '',
      processMode: t.processMode || 'publish',
      monitorId: t.monitorId || '',
      monitorName: t.monitorName || '',
      taskSnapshot: t.taskSnapshot || null,
      campaignName: t.campaignName || '',
      publishAt: t.publishAt || '',
      batchRunId: t.batchRunId || '',
      enqueuedAt: t.enqueuedAt || '',
      outputPath: t.outputPath || '',
      duration: t.duration || 0,
      retryCount: t.retryCount || 0,
      _exec: t._exec || null,
    })),
    services,
    usage,
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

  // 监控更新复用远程 SSE，远程页面无需轮询即可同步启停、检查和统计状态。
  try {
    const monitorService = require('./monitorService');
    monitorService.setContext({ taskRunner, store, mainWindowRef, appLog, monitorBroadcast: (payload) => broadcast('monitor-update', payload) });
  } catch (error) {
    log('warn', `监控远程广播初始化失败: ${error.message}`);
  }

  // 支持通过 settings.remote.port / ANTBOT_REMOTE_PORT 配置端口（默认 18931）
  const envPort = Number(process.env.ANTBOT_REMOTE_PORT) || null;
  if (envPort) _remotePort = envPort;

  if (_server) return _startPromise || Promise.resolve();
  // 防重复启动：并发调用共享同一个启动 Promise，避免 EADDRINUSE 产生孤儿 server
  if (_startPromise) return _startPromise;

  _startPromise = new Promise((resolveStart) => {
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

        // 从统一凭证模块读取（hash 验证优先，safeStorage 解密失败也能工作）
        const { readCreds, verifyPassword } = require('./remoteCredentials');
        const creds = await readCreds();

        if (!creds.passwordHash && !creds.password) {
          return sendJson(res, 400, { ok: false, error: '请先在 App 中设置远程访问密码' });
        }
        if (isLoginLocked()) {
          return sendJson(res, 429, { ok: false, error: '尝试次数过多，请 15 分钟后再试' });
        }
        if (!verifyPassword(body.password, creds)) {
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

      // POST /remote/parse — 规则识别 / AI 优化解析（主控输入预览）
      if (method === 'POST' && pathname === '/remote/parse') {
        const body = await readBody(req, res);
        if (!body) return;
        const text = String(body.text || '').trim();
        if (!text) return sendJson(res, 400, { ok: false, error: '请输入任务' });
        const smart = Boolean(body.smart);
        try {
          const { parseTaskInputSmart } = require('./aiTaskParser');
          let apiConfig = null;
          let taskDefaults = null;
          if (_store) {
            const settings = await _store.getSettings();
            taskDefaults = settings?.taskDefaults || null;
            const { hasApiConfig } = require('./apiClient');
            if (smart && hasApiConfig(settings?.api)) {
              apiConfig = settings.api;
            }
          }
          const parsed = await parseTaskInputSmart(text, { apiConfig, taskDefaults, log: (m) => log('info', `[parse${smart ? '-ai' : ''}] ${m}`) });
          return sendJson(res, 200, { ok: true, tasks: parsed.tasks, warnings: parsed.warnings || [], source: parsed.source || '', defaults: parsed.defaults || null });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.message });
        }
      }

      // POST /remote/tasks — submit new task
      if (method === 'POST' && pathname === '/remote/tasks') {
        const body = await readBody(req, res);
        if (!body) return;
        const text = (body.text || '').trim();
        const tasksBody = Array.isArray(body.tasks) ? body.tasks : null;

        try {
          let tasks;
          if (tasksBody) {
            tasks = tasksBody.filter(t => t && typeof t === 'object' && typeof t.taskName === 'string')
              .map(t => ({ ...t, publishAt: t.publishAt ? new Date(t.publishAt) : null }));
            if (!tasks.length) return sendJson(res, 400, { ok: false, error: '任务列表为空' });
          } else {
            if (!text) return sendJson(res, 400, { ok: false, error: '请输入链接' });
            // 直接发送：纯规则解析（无 AI），与桌面端行为一致
            const { parseTaskInputSmart } = require('./aiTaskParser');
            const settings = _store ? await _store.getSettings() : null;
            const parsed = await parseTaskInputSmart(text, { apiConfig: null, taskDefaults: settings?.taskDefaults || null });
            tasks = parsed.tasks;
            if (!tasks.length) return sendJson(res, 400, { ok: false, error: parsed.warnings?.[0] || '未识别到有效链接' });
          }

          const result = await _taskRunner.enqueueTasks(tasks, {}, text);
          log('info', `远程提交 ${tasks.length} 个任务`);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.message });
        }
      }

      // POST /remote/tasks/stop-all — 停止当前用户可见的全部任务
      if (method === 'POST' && pathname === '/remote/tasks/stop-all') {
        const rows = [
          ...(_taskRunner?.progressRows || []),
          ...(_taskRunner?.getQueuedTaskRows ? _taskRunner.getQueuedTaskRows() : [])
        ];
        for (const row of rows) await _taskRunner.stopTask(row.id, {}).catch(() => {});
        broadcast('status', await getStatus());
        return sendJson(res, 200, { ok: true, stopped: rows.length });
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
          const taskId = retryMatch[1];
          let taskPayload = null;
          try {
            const historyPath = path.join(os.homedir(), 'AntBot', 'antbot-store.json');
            const data = JSON.parse(await fs.readFile(historyPath, 'utf-8'));
            const item = (data.users?.[0]?.history || []).flatMap(h => h.items || []).find(i => i.taskId === taskId || i.id === taskId);
            taskPayload = item?.taskSnapshot || null;
          } catch {}
          if (!taskPayload) {
            try { taskPayload = (await _taskRunner.loadPersistedTasks()).find(t => t.id === taskId)?.taskSnapshot || null; } catch {}
          }
          const result = await _taskRunner.resumeTask(taskId, {}, taskPayload);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.message });
        }
      }

      // POST /remote/tasks/:id/republish — 重新发布已完成的视频（与 App 端 task:republish 同逻辑）
      const republishMatch = pathname.match(/^\/remote\/tasks\/([^/]+)\/republish$/);
      if (method === 'POST' && republishMatch) {
        const taskId = republishMatch[1];
        try {
          const result = await _taskRunner.republishTask(taskId);
          if (_store) broadcastHistoryUpdate(await _store.getHistory());
          broadcast('status', await getStatus());
          return sendJson(res, 200, result);
        } catch (e) {
          if (_store) broadcastHistoryUpdate(await _store.getHistory().catch(() => []));
          broadcast('status', await getStatus());
          return sendJson(res, 200, { ok: false, error: e.message, outputPath: e.outputPath || '', rawLine: e.rawLine || '' });
        }
      }

      // GET /remote/tasks
      if (method === 'GET' && pathname === '/remote/tasks') {
        const status = await getStatus();
        return sendJson(res, 200, { ok: true, tasks: status.tasks });
      }

      // ── 监控：桌面端与远程端共用同一份监控配置 ──
      if (method === 'GET' && pathname === '/remote/monitors') {
        const monitorService = require('./monitorService');
        return sendJson(res, 200, { ok: true, monitors: await monitorService.getMonitors() });
      }

      if (method === 'POST' && pathname === '/remote/monitors') {
        const body = await readBody(req, res);
        if (!body) return;
        try {
          const monitorService = require('./monitorService');
          const monitor = await monitorService.addMonitor(body);
          return sendJson(res, 200, { ok: true, monitor });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
      }

      const monitorActionMatch = pathname.match(/^\/remote\/monitors\/([^/]+)\/(update|toggle|check|remove)$/);
      if (method === 'POST' && monitorActionMatch) {
        const monitorId = decodeURIComponent(monitorActionMatch[1]);
        const action = monitorActionMatch[2];
        const body = await readBody(req, res);
        if (!body) return;
        try {
          const monitorService = require('./monitorService');
          if (action === 'update') {
            const monitor = await monitorService.updateMonitor(monitorId, body);
            return sendJson(res, 200, { ok: true, monitor });
          }
          if (action === 'toggle') {
            const monitor = await monitorService.updateMonitor(monitorId, { enabled: body.enabled !== false });
            return sendJson(res, 200, { ok: true, monitor });
          }
          if (action === 'check') {
            const result = await monitorService.checkMonitorNow(monitorId);
            return sendJson(res, 200, { ok: true, result });
          }
          await monitorService.removeMonitor(monitorId);
          return sendJson(res, 200, { ok: true });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
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

        // 拦截 editDefaults（风格/音色）：与 App 端写入路径保持一致，否则任务执行读不到。
        //  - style   → ui-settings.json（App saveUI() 同路径，taskRunner 从这里读风格）
        //  - voice   → store.voiceClone（App 选音色同路径，editor/taskRunner 从这里读音色）
        if (body.editDefaults && typeof body.editDefaults === 'object') {
          const uiPath = path.join(os.homedir(), 'AntBot', 'ui-settings.json');
          let uiSettings = {};
          try { uiSettings = JSON.parse(await fs.readFile(uiPath, 'utf-8')); } catch {}
          const mergedDefaults = { ...(uiSettings.editDefaults || {}), ...body.editDefaults };
          if (typeof mergedDefaults.voice === 'string' && mergedDefaults.voice === '') {
            delete mergedDefaults.voice;
          }
          uiSettings.editDefaults = mergedDefaults;
          await fs.mkdir(path.dirname(uiPath), { recursive: true }).catch(() => {});
          await fs.writeFile(uiPath, JSON.stringify(uiSettings, null, 2), 'utf-8');
          log('info', `远程更新 editDefaults: style=${mergedDefaults.style || '-'}, voice=${mergedDefaults.voice || '-'}`);

          // 音色同步到 voiceClone（任务实际读音色档案）：按名称在 voices.json 反查 id
          if (typeof mergedDefaults.voice === 'string' && mergedDefaults.voice) {
            try {
              const voices = JSON.parse(await fs.readFile(path.join(os.homedir(), 'AntBot', 'voices.json'), 'utf-8'));
              const matched = voices.find(v => v.name === mergedDefaults.voice);
              const current = await _store.getSettings();
              await _store.updateSettings({
                voiceClone: {
                  ...(current.voiceClone || {}),
                  voiceId: matched?.id || current.voiceClone?.voiceId || '',
                  profileName: mergedDefaults.voice,
                }
              });
              log('info', `远程音色已同步到 voiceClone: ${mergedDefaults.voice}${matched ? ' (id=' + matched.id.slice(0, 8) + ')' : ' (未匹配到 id)'}`);
            } catch (e) {
              log('error', `音色同步失败: ${e.message}`);
            }
          }
          delete body.editDefaults;
        }

        await _store.updateSettings(body);
        // 广播设置变更到所有 SSE 客户端
        broadcast('settings-update', body);
        return sendJson(res, 200, { ok: true });
      }

      // GET /remote/voices — 读取音色列表
      if (method === 'GET' && pathname === '/remote/voices') {
        try {
          const settings = _store ? await _store.getSettings() : null;
          const dataDir = settings?.dataDir || path.join(os.homedir(), 'AntBot');
          let cloneVoices = [];
          try {
            const raw = await fs.readFile(path.join(dataDir, 'voices.json'), 'utf-8');
            const parsed = JSON.parse(raw);
            cloneVoices = Array.isArray(parsed) ? parsed : [];
          } catch {}

          // 与 App 端一致：voicebox 在线时只展示后端真实存在的克隆档案。
          let profileTimer = null;
          try {
            const controller = new AbortController();
            profileTimer = setTimeout(() => controller.abort(), 3000);
            const response = await fetch('http://127.0.0.1:17493/profiles', { signal: controller.signal });
            clearTimeout(profileTimer);
            profileTimer = null;
            if (response.ok) {
              const profiles = await response.json();
              const ids = new Set((Array.isArray(profiles) ? profiles : []).map(profile => profile.id));
              cloneVoices = cloneVoices.filter(voice => ids.has(voice.id));
            }
          } catch {
            if (profileTimer) clearTimeout(profileTimer);
          }

          // App 的 voices:list 会合并内置 Azure 音色；远程页也必须使用同一份完整列表。
          const { getAzureVoices } = require('./azureTts');
          const voices = [
            ...getAzureVoices(),
            ...cloneVoices
              .filter(v => v && v.id && v.name)
              .map(v => ({ id: v.id, name: v.name, source: 'clone' }))
          ];
          return sendJson(res, 200, { ok: true, voices });
        } catch {
          try {
            const { getAzureVoices } = require('./azureTts');
            return sendJson(res, 200, { ok: true, voices: getAzureVoices() });
          } catch {
            return sendJson(res, 200, { ok: true, voices: [] });
          }
        }
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

      // POST /remote/platform-logout — 退出平台登录（清 cookies + 通知插件）
      if (method === 'POST' && pathname === '/remote/platform-logout') {
        const body = await readBody(req, res);
        const platform = body?.platform || 'weixin';
        try {
          // 清理本地 cookies 文件（YouTube/Douyin）
          const targetPlatform = platform === 'weixin' ? 'videoChannel' : platform;
          try {
            const cookiesDir = path.join(os.homedir(), 'AntBot', 'cookies');
            const files = await fs.readdir(cookiesDir).catch(() => []);
            for (const f of files) {
              if ((targetPlatform === 'douyin' && f.includes('douyin')) || (platform === 'youtube' && f.includes('youtube')) || f.includes(platform)) {
                await fs.unlink(path.join(cookiesDir, f)).catch(() => {});
              }
            }
            // 兼容旧路径
            const legacy = path.join(os.homedir(), 'AntBot', 'cookies', `${platform}.txt`);
            await fs.unlink(legacy).catch(() => {});
          } catch {}
          // 尝试通过桥接让浏览器清除 cookies（若插件在线）
          try {
            const { createBrowserPublishBridge } = require('./browserPublishBridge');
            const settings = await _store.getSettings();
            const config = settings.publish?.browserExtension || {};
            if (config.enabled) {
              const bridge = createBrowserPublishBridge({ baseUrl: config.baseUrl, timeoutMs: 15000 });
              // 发送 logout 指令，插件侧会用 chrome.cookies 清理
              await bridge.invoke('platform.logout', { platform }).catch(() => {});
            }
          } catch {}
          return sendJson(res, 200, { ok: true });
        } catch (error) {
          return sendJson(res, 200, { ok: false, error: error.message });
        }
      }

      // 404
      sendJson(res, 404, { ok: false, error: '接口不存在' });

    } catch (error) {
      log('error', `请求处理失败: ${error.message}`);
      sendJson(res, 500, { ok: false, error: '服务器错误' });
    }
  });

  _server.listen(_remotePort, '127.0.0.1', () => {
    log('info', `远程控制服务已启动: http://127.0.0.1:${_remotePort}`);
    resolveStart();
  });

  _server.on('error', (err) => {
    log('error', `远程控制服务启动失败: ${err.message}`);
    if (err.code === 'EADDRINUSE') _server = null;
    resolveStart();
  });
  }).finally(() => { _startPromise = null; });

  return _startPromise;
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
  return _remotePort;
}

// 从设置读取配置的端口（设置可能在服务启动前已加载，用于隧道指向正确端口）
function configureRemotePort(port) {
  const parsed = Number(port);
  if (parsed && parsed >= 1024 && parsed <= 65535) _remotePort = parsed;
  return _remotePort;
}

// Export for taskRunner to broadcast events
function broadcastTaskUpdate(task) {
  broadcast('task-update', task);
}

function broadcastHistoryUpdate(history) {
  broadcast('history-update', Array.isArray(history) ? history : []);
}

module.exports = {
  startRemoteServer,
  stopRemoteServer,
  isServerRunning,
  clearSessions,
  getRemotePort,
  configureRemotePort,
  broadcastTaskUpdate,
  broadcastHistoryUpdate,
};
