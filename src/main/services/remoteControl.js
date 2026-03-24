const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');
const { parseTaskInput } = require('./parser');
const { runStartupChecks, getProfileDir, getProfileScopeKey } = require('./startupCheck');
const { runVoiceClone } = require('./voiceClone');
const { ensureWindowsDependency, getManagedBinDir } = require('./dependencyManager');
const { launchPersistentChromiumContext } = require('./playwrightUtil');
const { getAppInfo } = require('./appInfo');

const REMOTE_ROOT = path.join(__dirname, '..', '..', 'remote');
const REMOTE_CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};
const TRY_CLOUDFLARE_URL_RE = /https?:\/\/[a-z0-9-]+\.trycloudflare\.com/ig;
const COMMON_CLOUDFLARED_PATHS = [
  '/opt/homebrew/bin/cloudflared',
  '/usr/local/bin/cloudflared',
  '/usr/bin/cloudflared'
];
const LOCAL_UI_MODE = ['1', 'true', 'yes', 'on'].includes(String(process.env.ANTBOT_LOCAL_UI_MODE || '').trim().toLowerCase());
const LOCAL_UI_PORT = (() => {
  const parsed = Number(process.env.ANTBOT_LOCAL_UI_PORT || 17931);
  if (!Number.isFinite(parsed)) {
    return 17931;
  }
  return Math.min(65535, Math.max(1024, Math.round(parsed)));
})();
const LOCAL_UI_HOST = '127.0.0.1';

function normalizeRemoteSettings(remote = {}) {
  const port = Number(remote.port || 17888);
  const publicMode = String(remote.publicMode || 'off').trim() || 'off';
  return {
    enabled: Boolean(remote.enabled),
    port: Number.isFinite(port) && port > 0 ? Math.min(65535, Math.max(1024, Math.round(port))) : 17888,
    password: '',
    publicMode: publicMode === 'cloudflare-quick' ? publicMode : 'off',
    cloudflaredPath: String(remote.cloudflaredPath || '').trim()
  };
}

function getElectronApp() {
  try {
    const electron = require('electron');
    return electron.app || null;
  } catch {
    return null;
  }
}

function getRuntimeRoot() {
  const app = getElectronApp();
  return app
    ? app.getPath('userData')
    : path.resolve(process.cwd(), '.antbot-runtime');
}

async function getCloudflaredLogFilePath() {
  const logDir = path.join(getRuntimeRoot(), 'logs');
  await fs.mkdir(logDir, { recursive: true });
  return path.join(logDir, 'cloudflared.log');
}

async function readRecentLogTail(logFilePath, maxLines = 12, maxBytes = 16384) {
  if (!logFilePath) {
    return '';
  }

  try {
    const stats = await fs.stat(logFilePath);
    const start = Math.max(0, stats.size - maxBytes);
    const fileHandle = await fs.open(logFilePath, 'r');
    try {
      const buffer = Buffer.alloc(stats.size - start);
      await fileHandle.read(buffer, 0, buffer.length, start);
      const lines = buffer
        .toString('utf8')
        .split(/\r?\n/g)
        .map((line) => line.trimEnd())
        .filter(Boolean);
      return lines.slice(-maxLines).join('\n');
    } finally {
      await fileHandle.close();
    }
  } catch {
    return '';
  }
}

function extractCloudflareUrl(text) {
  if (!text) {
    return '';
  }
  const matched = String(text).match(TRY_CLOUDFLARE_URL_RE);
  if (!matched || !matched.length) {
    return '';
  }
  return matched[0];
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

function listLocalUiUrls(port) {
  return [`http://${LOCAL_UI_HOST}:${port}/remote/`, `http://localhost:${port}/remote/`];
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
      if (size > 40 * 1024 * 1024) {
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

function sanitizeFilename(name, fallback = 'sample') {
  const base = path.basename(String(name || '')).trim();
  const cleaned = base.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('上传内容格式错误，请重新选择音频文件。');
  }
  return {
    mime: match[1],
    buffer: Buffer.from(match[2], 'base64')
  };
}

function resolveAudioExtension(fileName, mime) {
  const ext = path.extname(String(fileName || '')).replace('.', '').toLowerCase();
  if (ext) {
    return ext;
  }
  const map = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm',
    'audio/flac': 'flac'
  };
  return map[mime] || 'wav';
}

async function saveRemoteUpload(dataUrl, fileName) {
  const decoded = decodeDataUrl(dataUrl);
  const baseName = sanitizeFilename(fileName, 'voice-sample').replace(/\.[^.]+$/, '') || 'voice-sample';
  const ext = resolveAudioExtension(fileName, decoded.mime);
  const uploadDir = path.join(getRuntimeRoot(), 'remote-uploads');
  await fs.mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, `${baseName}-${Date.now()}.${ext}`);
  await fs.writeFile(filePath, decoded.buffer);
  return filePath;
}

async function openPlaywrightLoginContext(serviceKey, serviceConfig, userId, logger = () => {}) {
  const profileDir = getProfileDir(serviceKey, userId);
  await fs.mkdir(profileDir, { recursive: true });
  const context = await launchPersistentChromiumContext(profileDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  }, logger);

  const page = context.pages()[0] || await context.newPage();
  await page.goto(serviceConfig.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return { context, page, profileDir };
}

async function capturePageScreenshot(page) {
  const buffer = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 72 });
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

function pickRemoteSettings(settings = {}) {
  return {
    paths: {
      tempDir: settings.paths?.tempDir || '',
      outputBaseDir: settings.paths?.outputBaseDir || '',
      youtubeProjectPath: settings.paths?.youtubeProjectPath || '',
      editProjectPath: settings.paths?.editProjectPath || '',
      publishProjectPath: settings.paths?.publishProjectPath || ''
    },
    commands: {
      download: settings.commands?.download || '',
      gemini: settings.commands?.gemini || '',
      edit: settings.commands?.edit || '',
      publish: settings.commands?.publish || '',
      voiceClone: settings.commands?.voiceClone || ''
    },
    retry: {
      failedTaskRetries: settings.retry?.failedTaskRetries ?? 0
    },
    subtitle: {
      geminiUrl: settings.subtitle?.geminiUrl || ''
    },
    publish: {
      enabled: settings.publish?.enabled !== false
    },
    browser: {
      pauseBetweenTasksMs: settings.browser?.pauseBetweenTasksMs ?? 2500,
      actionDelayMs: settings.browser?.actionDelayMs ?? 1500,
      showAutomationWindow: Boolean(settings.browser?.showAutomationWindow)
    },
    style: {
      voiceSpeed: settings.style?.voiceSpeed ?? 1.1,
      voiceoverEnabled: settings.style?.voiceoverEnabled !== false,
      subtitleEnabled: settings.style?.subtitleEnabled !== false,
      subtitleTextColor: settings.style?.subtitleTextColor || '#FFA100',
      subtitleStrokeColor: settings.style?.subtitleStrokeColor || '#000000',
      subtitlePositionPercent: settings.style?.subtitlePositionPercent ?? 12
    },
    voiceClone: {
      voiceId: settings.voiceClone?.voiceId || '',
      modelPath: settings.voiceClone?.modelPath || '',
      samplePath: settings.voiceClone?.samplePath || '',
      referenceText: settings.voiceClone?.referenceText || '',
      profileName: settings.voiceClone?.profileName || '',
      language: settings.voiceClone?.language || 'zh',
      lastUpdatedAt: settings.voiceClone?.lastUpdatedAt || ''
    },
    remote: {
      enabled: Boolean(settings.remote?.enabled),
      port: settings.remote?.port ?? 17888,
      publicMode: settings.remote?.publicMode === 'cloudflare-quick' ? 'cloudflare-quick' : 'off'
    },
    system: {
      preventSleepOnTasks: settings.system?.preventSleepOnTasks !== false,
      launchAtLogin: settings.system?.launchAtLogin !== false
    }
  };
}

function parseBooleanInput(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseIntegerInput(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function parseFloatInput(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function trimInput(value, fallback = '') {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value).trim();
}

function buildRemoteSettingsPatch(source = {}, current = {}) {
  const currentPicked = pickRemoteSettings(current);
  const nextVoiceoverEnabled = parseBooleanInput(source.style?.voiceoverEnabled, currentPicked.style.voiceoverEnabled);

  return {
    paths: {
      tempDir: trimInput(source.paths?.tempDir, currentPicked.paths.tempDir),
      outputBaseDir: trimInput(source.paths?.outputBaseDir, currentPicked.paths.outputBaseDir),
      youtubeProjectPath: trimInput(source.paths?.youtubeProjectPath, currentPicked.paths.youtubeProjectPath),
      editProjectPath: trimInput(source.paths?.editProjectPath, currentPicked.paths.editProjectPath),
      publishProjectPath: trimInput(source.paths?.publishProjectPath, currentPicked.paths.publishProjectPath)
    },
    commands: {
      download: trimInput(source.commands?.download, currentPicked.commands.download),
      gemini: trimInput(source.commands?.gemini, currentPicked.commands.gemini),
      edit: trimInput(source.commands?.edit, currentPicked.commands.edit),
      publish: trimInput(source.commands?.publish, currentPicked.commands.publish),
      voiceClone: trimInput(source.commands?.voiceClone, currentPicked.commands.voiceClone)
    },
    subtitle: {
      geminiUrl: trimInput(source.subtitle?.geminiUrl, currentPicked.subtitle.geminiUrl)
    },
    publish: {
      enabled: parseBooleanInput(source.publish?.enabled, currentPicked.publish.enabled)
    },
    retry: {
      failedTaskRetries: parseIntegerInput(
        source.retry?.failedTaskRetries,
        currentPicked.retry.failedTaskRetries,
        0,
        20
      )
    },
    browser: {
      pauseBetweenTasksMs: parseIntegerInput(
        source.browser?.pauseBetweenTasksMs,
        currentPicked.browser.pauseBetweenTasksMs,
        0,
        300000
      ),
      actionDelayMs: parseIntegerInput(
        source.browser?.actionDelayMs,
        currentPicked.browser.actionDelayMs,
        500,
        60000
      ),
      showAutomationWindow: parseBooleanInput(
        source.browser?.showAutomationWindow,
        currentPicked.browser.showAutomationWindow
      )
    },
    style: {
      voiceSpeed: parseFloatInput(source.style?.voiceSpeed, currentPicked.style.voiceSpeed, 0.5, 2),
      voiceoverEnabled: nextVoiceoverEnabled,
      subtitleEnabled: nextVoiceoverEnabled && parseBooleanInput(
        source.style?.subtitleEnabled,
        currentPicked.style.subtitleEnabled
      ),
      subtitleTextColor: trimInput(source.style?.subtitleTextColor, currentPicked.style.subtitleTextColor) || '#FFA100',
      subtitleStrokeColor: trimInput(source.style?.subtitleStrokeColor, currentPicked.style.subtitleStrokeColor) || '#000000',
      subtitlePositionPercent: parseIntegerInput(
        source.style?.subtitlePositionPercent,
        currentPicked.style.subtitlePositionPercent,
        0,
        100
      )
    },
    voiceClone: {
      voiceId: trimInput(source.voiceClone?.voiceId, currentPicked.voiceClone.voiceId),
      modelPath: trimInput(source.voiceClone?.modelPath, currentPicked.voiceClone.modelPath)
    },
    remote: {
      enabled: parseBooleanInput(source.remote?.enabled, currentPicked.remote.enabled),
      port: parseIntegerInput(source.remote?.port, currentPicked.remote.port, 1024, 65535),
      publicMode: trimInput(source.remote?.publicMode, currentPicked.remote.publicMode) === 'cloudflare-quick'
        ? 'cloudflare-quick'
        : 'off'
    },
    system: {
      preventSleepOnTasks: parseBooleanInput(
        source.system?.preventSleepOnTasks,
        currentPicked.system.preventSleepOnTasks
      ),
      launchAtLogin: parseBooleanInput(
        source.system?.launchAtLogin,
        currentPicked.system.launchAtLogin
      )
    }
  };
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

async function ensureWindowsFirewallRule(port, logger = () => {}) {
  if (process.platform !== 'win32') {
    return true;
  }

  const ruleName = `搬运蚁 Remote ${port}`;
  try {
    await execCapture('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${ruleName}`]);
    return true;
  } catch {
    // rule missing, continue to add
  }

  try {
    await execCapture('netsh', [
      'advfirewall',
      'firewall',
      'add',
      'rule',
      `name=${ruleName}`,
      'dir=in',
      'action=allow',
      'protocol=TCP',
      `localport=${port}`,
      'profile=any'
    ]);
    logger(`已自动添加 Windows 防火墙入站规则：${ruleName}`);
    return true;
  } catch (error) {
    logger(`自动添加 Windows 防火墙规则失败，请手动放行端口 ${port}。${String(error?.message || error)}`);
    return false;
  }
}

class RemoteControlServer {
  constructor({ store, taskRunner, onStatusChange = () => {}, onRemoteLog = () => {}, systemControl = null }) {
    this.store = store;
    this.taskRunner = taskRunner;
    this.onStatusChange = onStatusChange;
    this.onRemoteLog = onRemoteLog;
    this.systemControl = systemControl;

    this.server = null;
    this.remoteAccessServer = null;
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
    this.loginState = {};
    this.users = [];
    this.activeUser = null;
    this.loginContexts = new Map();
    this.voiceClone = {
      status: 'idle',
      step: '等待开始',
      percent: 0,
      message: '',
      running: false,
      updatedAt: ''
    };
    this.voiceCloneRunning = false;
    this.lastStartup = null;
    this.clients = new Set();
    this.tunnelProcess = null;
    this.tunnelConfigPath = path.join(os.tmpdir(), 'antbot-cloudflared-empty.yml');
    this.reconfigureQueue = Promise.resolve();
    this.localUiMode = LOCAL_UI_MODE;
    this.localUiPort = LOCAL_UI_PORT;
  }

  async init() {
    await this.refreshStoreState();
    const settings = await this.store.getSettings();
    if (this.localUiMode) {
      await this.startLocalUiServer();
    }
    this.systemControl?.applySettings(settings);
    await this.reconfigure(settings.remote || {});
  }

  async refreshStoreState() {
    const [history, loginState, users, activeUser] = await Promise.all([
      this.store.getHistory(),
      this.store.getLoginState(),
      this.store.listUsers(),
      this.store.getActiveUserSummary()
    ]);

    this.history = history.slice(0, 20);
    this.loginState = loginState;
    this.users = this.decorateUsersWithProgress(users);
    this.activeUser = this.decorateUserSummary(activeUser);
  }

  buildTaskCountMap(progress = this.taskRunner.getSnapshot()) {
    const counts = new Map();
    const items = [
      ...(Array.isArray(progress?.tasks) ? progress.tasks : []),
      ...(Array.isArray(progress?.queueTasks) ? progress.queueTasks : [])
    ];

    for (const item of items) {
      const userId = String(item?.userId || '').trim();
      if (!userId) {
        continue;
      }
      const status = String(item?.status || '').trim();
      if (!counts.has(userId)) {
        counts.set(userId, {
          liveTaskCount: 0,
          waitingTaskCount: 0,
          runningTaskCount: 0
        });
      }
      const bucket = counts.get(userId);
      if (!['completed', 'failed', 'partial_failed', 'stopped'].includes(status)) {
        bucket.liveTaskCount += 1;
      }
      if (['queued', 'pending'].includes(status)) {
        bucket.waitingTaskCount += 1;
      }
      if (status === 'running') {
        bucket.runningTaskCount += 1;
      }
    }

    return counts;
  }

  decorateUserSummary(user) {
    if (!user || typeof user !== 'object') {
      return user;
    }
    const counts = this.buildTaskCountMap(this.progress).get(String(user.id || '').trim()) || {};
    return {
      ...user,
      liveTaskCount: Number(counts.liveTaskCount || 0),
      waitingTaskCount: Number(counts.waitingTaskCount || 0),
      runningTaskCount: Number(counts.runningTaskCount || 0)
    };
  }

  decorateUsersWithProgress(users = []) {
    return (Array.isArray(users) ? users : []).map((user) => this.decorateUserSummary(user));
  }

  async activateUser(userId, options = {}) {
    const targetUserId = String(userId || '').trim();
    if (!targetUserId) {
      throw new Error('缺少用户。');
    }

    await this.store.switchUser(targetUserId);
    await this.refreshStoreState();
    const settings = await this.store.getSettings();
    this.systemControl?.applySettings(settings);

    if (options.reconfigure) {
      await this.reconfigure(settings.remote || {});
    } else if (options.emit !== false) {
      this.emitStatus();
    }

    return {
      activeUser: this.activeUser,
      users: this.users,
      state: this.getPublicState()
    };
  }

  async resolveUserAuth(userId) {
    const targetUserId = String(userId || '').trim();
    const fallbackUserId = targetUserId || this.activeUser?.id || '';
    if (!fallbackUserId) {
      return { ok: false, message: '请选择用户。' };
    }

    const state = await this.store.getState();
    const user = Array.isArray(state.users)
      ? state.users.find((item) => item.id === fallbackUserId)
      : null;

    if (!user) {
      return { ok: false, message: '用户不存在。' };
    }

    return { ok: true, user };
  }

  async authorizeRequest(req, requestUrl, body = {}) {
    const userId = String(
      req.headers['x-antbot-user']
      || body.userId
      || requestUrl.searchParams.get('userId')
      || this.activeUser?.id
      || ''
    ).trim();
    const auth = await this.resolveUserAuth(userId);
    if (!auth.ok) {
      return auth;
    }

    return {
      ok: true,
      userId: auth.user.id,
      user: auth.user
    };
  }

  getPublicState() {
    return {
      app: getAppInfo(),
      activeUser: this.activeUser,
      users: this.users,
      server: this.status,
      progress: this.progress,
      history: this.history.slice(0, 10),
      logs: this.logs.slice(-20),
      startup: this.lastStartup,
      loginState: this.loginState,
      voiceClone: this.voiceClone
    };
  }

  async buildUserScopedState(userId) {
    const [activeUser, users, history, loginState] = await Promise.all([
      this.store.getUserSummary(userId),
      this.store.listUsers(),
      this.store.getHistoryForUser(userId),
      this.store.getLoginStateForUser(userId)
    ]);

    return {
      app: getAppInfo(),
      activeUser,
      users,
      server: this.status,
      progress: this.taskRunner.getSnapshotForUser(userId),
      history: history.slice(0, 10),
      logs: this.logs.slice(-20),
      startup: this.lastStartup,
      loginState,
      voiceClone: this.voiceClone
    };
  }

  handleProgress(payload) {
    this.progress = payload;
    this.users = this.decorateUsersWithProgress(this.users);
    this.activeUser = this.decorateUserSummary(this.activeUser);
    this.systemControl?.handleProgress(payload);
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

  pushRemoteLog(message, level = 'info') {
    if (!message) {
      return;
    }
    this.onRemoteLog({
      runId: '',
      taskId: '',
      level,
      timestamp: new Date().toISOString(),
      message
    });
  }

  updateVoiceCloneProgress(payload = {}) {
    const next = { ...this.voiceClone };
    if (typeof payload.status === 'string') {
      next.status = payload.status;
    }
    if (typeof payload.step === 'string' && payload.step.trim()) {
      next.step = payload.step.trim();
    }
    const shouldLog = payload.log !== false;
    if (typeof payload.message === 'string' && payload.message.trim()) {
      next.message = payload.message.trim();
      if (shouldLog) {
        this.pushRemoteLog(`[语音克隆] ${next.message}`);
      }
    }
    if (typeof payload.running === 'boolean') {
      next.running = payload.running;
    }
    if (typeof payload.percent === 'number' && Number.isFinite(payload.percent)) {
      next.percent = Math.max(0, Math.min(100, Math.round(payload.percent)));
    }
    next.updatedAt = new Date().toISOString();
    this.voiceClone = next;
    this.broadcast('voiceClone', this.voiceClone);
    this.broadcast('state', this.getPublicState());
  }

  async handleRemoteSettingsGet(userId) {
    const [settings, globalSettings] = await Promise.all([
      this.store.getSettingsForUser(userId),
      this.store.getGlobalSettingsForUser(userId)
    ]);
    return {
      ...pickRemoteSettings(settings),
      __userId: settings.__userId || '',
      __geminiProfileId: settings.__geminiProfileId || '',
      __geminiProfileName: settings.__geminiProfileName || '',
      __globalSettings: pickRemoteSettings(globalSettings),
      __profileSettingsEnabled: Boolean(settings.__profileSettingsEnabled),
      __profileSettingsOverrides: settings.__profileSettingsOverrides || {}
    };
  }

  async handleRemoteSettingsUpdate(body, userId) {
    const current = await this.store.getSettingsForUser(userId);
    const source = body?.settings && typeof body.settings === 'object' ? body.settings : body;
    const hasExplicitScope = typeof body?.scope === 'string';
    const scope = body?.scope === 'user-profile' ? 'user-profile' : 'global';
    const partial = hasExplicitScope
      ? source
      : buildRemoteSettingsPatch(source, current);
    const settings = await this.store.updateSettingsForUser(userId, partial, {
      scope,
      profileSettingsEnabled: typeof body?.profileSettingsEnabled === 'boolean'
        ? body.profileSettingsEnabled
        : null
    });
    this.systemControl?.applySettings(settings);
    await this.refreshStoreState();
    const globalSettings = await this.store.getGlobalSettingsForUser(userId);
    return {
      fullSettings: settings,
      settings: {
        ...pickRemoteSettings(settings),
        __userId: settings.__userId || '',
        __geminiProfileId: settings.__geminiProfileId || '',
        __geminiProfileName: settings.__geminiProfileName || '',
        __globalSettings: pickRemoteSettings(globalSettings),
        __profileSettingsEnabled: Boolean(settings.__profileSettingsEnabled),
        __profileSettingsOverrides: settings.__profileSettingsOverrides || {}
      },
      remoteChanged: Boolean(source?.remote)
    };
  }

  async handleRemoteLoginStart(body, userId) {
    const serviceKey = String(body?.service || '').trim();
    if (!serviceKey) {
      throw new Error('请选择登录平台。');
    }

    const settings = await this.store.getSettingsForUser(userId);
    const resolvedUserId = settings.__userId || userId || 'user-1';
    const serviceConfig = settings.loginHints?.[serviceKey];
    if (!serviceConfig) {
      throw new Error(`未知登录平台：${serviceKey}`);
    }

    const contextKey = getProfileScopeKey(serviceKey, resolvedUserId);
    let entry = this.loginContexts.get(contextKey);
    if (!entry || !entry.context) {
      const created = await openPlaywrightLoginContext(serviceKey, serviceConfig, resolvedUserId, (msg) => {
        this.pushRemoteLog(`[登录] ${msg}`);
      });
      entry = { context: created.context, page: created.page, profileDir: created.profileDir };
      this.loginContexts.set(contextKey, entry);
      created.context.on('close', () => {
        this.loginContexts.delete(contextKey);
      });
    } else if (entry.page) {
      await entry.page.bringToFront().catch(() => {});
    }

    const page = entry.page || entry.context.pages()[0] || await entry.context.newPage();
    entry.page = page;

    await page.goto(serviceConfig.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);
    const screenshot = await capturePageScreenshot(page);
    const title = await page.title().catch(() => '');

    return {
      ok: true,
      service: serviceKey,
      screenshot,
      title,
      url: page.url()
    };
  }

  async handleRemoteLoginConfirm(body, userId) {
    const serviceKey = String(body?.service || '').trim();
    if (!serviceKey) {
      throw new Error('缺少登录平台。');
    }
    const settings = await this.store.getSettingsForUser(userId);
    const scopeId = settings.__userId || userId;
    const contextKey = getProfileScopeKey(serviceKey, scopeId);
    const entry = this.loginContexts.get(contextKey);
    if (entry?.context) {
      await entry.context.close().catch(() => {});
    }
    this.loginContexts.delete(contextKey);
    const loginState = await this.store.setLoginStateForUser(userId, serviceKey, true);
    await this.refreshStoreState();
    this.broadcast('state', this.getPublicState());
    return {
      ok: true,
      loginState
    };
  }

  async handleRemoteLoginCancel(body, userId) {
    const serviceKey = String(body?.service || '').trim();
    if (!serviceKey) {
      throw new Error('缺少登录平台。');
    }
    const settings = await this.store.getSettingsForUser(userId);
    const scopeId = settings.__userId || userId;
    const contextKey = getProfileScopeKey(serviceKey, scopeId);
    const entry = this.loginContexts.get(contextKey);
    if (entry?.context) {
      await entry.context.close().catch(() => {});
    }
    this.loginContexts.delete(contextKey);
    return { ok: true, cancelled: true };
  }

  async handleRemoteVoiceClone(body, userId) {
    if (this.voiceCloneRunning) {
      throw new Error('语音克隆正在进行中，请稍候。');
    }

    const sampleData = String(body?.sampleData || '').trim();
    const sampleName = String(body?.sampleName || 'voice-sample').trim();
    const referenceText = String(body?.referenceText || '').trim();
    const profileName = String(body?.profileName || '').trim();
    const language = String(body?.language || '').trim() || 'zh';

    if (!sampleData) {
      throw new Error('请先选择语音样本文件。');
    }
    if (!referenceText) {
      throw new Error('请填写语音样本对应的文本。');
    }

    this.voiceCloneRunning = true;
    this.updateVoiceCloneProgress({
      status: 'running',
      running: true,
      step: '接收样本',
      percent: 6,
      message: '正在接收远程音频...'
    });

    try {
      const samplePath = await saveRemoteUpload(sampleData, sampleName);
      const settings = await this.store.updateSettingsForUser(userId, {
        voiceClone: {
          samplePath,
          referenceText,
          profileName,
          language
        }
      });

      this.updateVoiceCloneProgress({
        status: 'running',
        running: true,
        step: '开始克隆',
        percent: 12,
        message: '准备执行语音克隆...'
      });

      runVoiceClone({
        samplePath,
        referenceText,
        profileName,
        language
      }, settings, {
        log: (message) => this.pushRemoteLog(`[语音克隆] ${message}`),
        progress: (progressPayload) => this.updateVoiceCloneProgress({ ...progressPayload, running: true, log: false })
      }).then(async (result) => {
        const saved = await this.store.setVoiceClone(result);
        this.voiceCloneRunning = false;
        await this.refreshStoreState();
        this.updateVoiceCloneProgress({
          status: 'completed',
          running: false,
          step: '克隆完成',
          percent: 100,
          message: `语音克隆完成：${saved.voiceId}`
        });
      }).catch((error) => {
        this.voiceCloneRunning = false;
        this.updateVoiceCloneProgress({
          status: 'failed',
          running: false,
          step: '克隆失败',
          message: String(error?.message || error)
        });
      });

      return { ok: true, started: true };
    } catch (error) {
      this.voiceCloneRunning = false;
      this.updateVoiceCloneProgress({
        status: 'failed',
        running: false,
        step: '克隆失败',
        message: String(error?.message || error)
      });
      throw error;
    }
  }

  async reconfigure(remoteSettings) {
    this.reconfigureQueue = this.reconfigureQueue.then(() => this.applyConfiguration(remoteSettings));
    return this.reconfigureQueue;
  }

  async startLocalUiServer() {
    if (!this.localUiMode || this.server) {
      return;
    }

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
      this.server.listen(this.localUiPort, LOCAL_UI_HOST, () => {
        this.server.off('error', reject);
        resolve();
      });
    }).catch((error) => {
      this.server = null;
      throw error;
    });
  }

  async applyConfiguration(remoteSettings) {
    const configuredSettings = normalizeRemoteSettings(remoteSettings);
    const nextSettings = configuredSettings;
    const previousSettings = this.remoteSettings;
    const previousPublic = this.status.public;
    const accessServer = this.localUiMode ? this.remoteAccessServer : this.server;
    const unchanged = accessServer
      && this.status.online
      && previousSettings.enabled
      && previousSettings.port === nextSettings.port
      && previousSettings.publicMode === nextSettings.publicMode
      && previousSettings.cloudflaredPath === nextSettings.cloudflaredPath;

    this.remoteSettings = nextSettings;
    this.status = {
      enabled: this.remoteSettings.enabled,
      online: false,
      port: this.remoteSettings.port,
      passwordConfigured: false,
      urls: this.remoteSettings.enabled
        ? listRemoteUrls(this.remoteSettings.port)
        : [],
      lastError: '',
      updatedAt: new Date().toISOString(),
      internalMode: this.localUiMode,
      public: {
        mode: this.remoteSettings.publicMode,
        online: false,
        url: '',
        lastError: '',
        cloudflaredPath: this.remoteSettings.cloudflaredPath || '',
        installing: false
      }
    };

    if (unchanged) {
      this.status.online = true;
      this.status.urls = listRemoteUrls(this.remoteSettings.port);
      this.status.passwordConfigured = false;
      if (previousPublic) {
        this.status.public = {
          ...this.status.public,
          ...previousPublic,
          mode: this.remoteSettings.publicMode
        };
      }
      if (this.remoteSettings.publicMode === 'cloudflare-quick' && !this.status.public.online) {
        await this.startPublicTunnelIfNeeded();
      }
      this.status.updatedAt = new Date().toISOString();
      this.emitStatus();
      return this.getPublicState();
    }

    if (!this.remoteSettings.enabled) {
      await this.stop();
      this.emitStatus();
      return this.getPublicState();
    }

    await this.stop(false);
    try {
      await this.startConfiguredServer();
    } catch (error) {
      const message = String(error?.message || error || '远程服务启动失败');
      this.status.online = false;
      this.status.lastError = message;
      this.status.updatedAt = new Date().toISOString();
      this.emitStatus();
      return this.getPublicState();
    }

    await this.startPublicTunnelIfNeeded();
    this.emitStatus();
    return this.getPublicState();
  }

  async startConfiguredServer() {
    const serverRef = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        sendJson(res, 500, {
          ok: false,
          message: String(error?.message || error || '服务器内部错误')
        });
      });
    });
    const serverKey = this.localUiMode ? 'remoteAccessServer' : 'server';
    this[serverKey] = serverRef;

    await new Promise((resolve, reject) => {
      serverRef.once('error', reject);
      serverRef.listen(this.remoteSettings.port, '0.0.0.0', () => {
        serverRef.off('error', reject);
        resolve();
      });
    }).catch((error) => {
      if (error?.code === 'EADDRINUSE') {
        this.status.lastError = `端口 ${this.remoteSettings.port} 已被占用，请关闭占用进程或更换端口。`;
      } else {
        this.status.lastError = `远程服务启动失败：${String(error?.message || error)}`;
      }
      this[serverKey] = null;
      throw error;
    });

    this.status.online = true;
    this.status.urls = listRemoteUrls(this.remoteSettings.port);
    this.status.lastError = '';
    this.status.updatedAt = new Date().toISOString();

    await ensureWindowsFirewallRule(this.remoteSettings.port, (message) => {
      this.onRemoteLog({
        runId: '',
        taskId: '',
        level: 'info',
        timestamp: new Date().toISOString(),
        message: `[远程服务] ${message}`
      });
      this.status.lastError = message;
      this.status.updatedAt = new Date().toISOString();
    });
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

    for (const entry of this.loginContexts.values()) {
      try {
        await entry.context?.close();
      } catch {
        // noop
      }
    }
    this.loginContexts.clear();

    await this.stopTunnel();

    const serverKey = this.localUiMode ? 'remoteAccessServer' : 'server';
    if (this[serverKey]) {
      await new Promise((resolve) => {
        this[serverKey].close(() => resolve());
      }).catch(() => {});
      this[serverKey] = null;
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

    if (process.platform === 'win32') {
      try {
        this.status.public.installing = true;
        this.status.public.lastError = '正在自动下载 cloudflared...';
        this.emitStatus();
        const resolved = await ensureWindowsDependency('cloudflared', (message) => {
          this.status.public.lastError = message;
          this.emitStatus();
        });
        this.status.public.installing = false;
        return resolved;
      } catch (error) {
        this.status.public.installing = false;
        throw new Error(
          `未找到 cloudflared，自动下载失败。可在“运行依赖”面板点击“下载缺失依赖”。${String(error?.message || error || '')}`.trim()
        );
      }
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

    throw new Error(`未找到 cloudflared，请先安装后再开启公网访问。受管目录：${getManagedBinDir()}`);
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
      if (this.tunnelProcess) {
        await this.stopTunnel();
      }
      this.status.public.online = false;
      this.status.public.url = '';
      this.status.public.lastError = '正在建立公网地址...';
      this.status.public.installing = false;
      this.emitStatus();

      const cloudflaredPath = await this.resolveCloudflaredPath();
      this.status.public.cloudflaredPath = cloudflaredPath;
      await fs.writeFile(this.tunnelConfigPath, '', 'utf-8');
      const localUrl = `http://127.0.0.1:${this.remoteSettings.port}`;
      const logFilePath = await getCloudflaredLogFilePath();
      await fs.appendFile(
        logFilePath,
        `\n[${new Date().toISOString()}] [cloudflared] starting: ${cloudflaredPath} tunnel --url ${localUrl}\n`,
        'utf8'
      );

      this.tunnelProcess = spawn(
        cloudflaredPath,
        [
          'tunnel',
          '--url',
          localUrl,
          '--no-autoupdate',
          '--config',
          this.tunnelConfigPath,
          '--loglevel',
          'info',
          '--logfile',
          logFilePath
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );

      const publicUrl = await new Promise((resolve, reject) => {
        let settled = false;
        let pollTimer = null;
        let timeoutTimer = null;
        const finish = (error, url) => {
          if (settled) {
            return;
          }
          settled = true;
          if (pollTimer) {
            clearInterval(pollTimer);
          }
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
          }
          if (error) {
            reject(error);
          } else {
            resolve(url);
          }
        };

        const onData = (chunk) => {
          const text = String(chunk || '');
          const url = extractCloudflareUrl(text);
          if (url) {
            finish(null, url);
          }
        };

        const checkLog = async () => {
          const tail = await readRecentLogTail(logFilePath, 16, 32768);
          const url = extractCloudflareUrl(tail);
          if (url) {
            finish(null, url);
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
        pollTimer = setInterval(() => {
          checkLog().catch(() => {});
        }, 1000);
        checkLog().catch(() => {});
        timeoutTimer = setTimeout(() => {
          readRecentLogTail(logFilePath, 16, 32768)
            .then((tail) => {
              const detail = tail
                ? `等待 Cloudflare Quick Tunnel 地址超时。\n${tail}`
                : '等待 Cloudflare Quick Tunnel 地址超时。';
              finish(new Error(detail));
            })
            .catch(() => {
              finish(new Error('等待 Cloudflare Quick Tunnel 地址超时。'));
            });
        }, 60000);
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
      this.emitStatus();
    } catch (error) {
      this.status.public.online = false;
      this.status.public.url = '';
      this.status.public.installing = false;
      this.status.public.lastError = String(error?.message || error);
      this.emitStatus();
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

    if (requestUrl.pathname === '/api/users' && req.method === 'GET') {
      await this.refreshStoreState();
      sendJson(res, 200, {
        ok: true,
        users: this.users,
        activeUser: this.activeUser
      });
      return;
    }

    if (requestUrl.pathname === '/api/login' && req.method === 'POST') {
      const body = await parseBody(req);
      const auth = await this.resolveUserAuth(body?.userId);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      const state = await this.buildUserScopedState(auth.user.id);
      sendJson(res, 200, {
        ok: true,
        activeUser: state.activeUser,
        users: state.users,
        state
      });
      return;
    }

    if (requestUrl.pathname === '/api/events' && req.method === 'GET') {
      const auth = await this.authorizeRequest(req, requestUrl);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      this.attachSseClient(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/state' && req.method === 'GET') {
      const auth = await this.authorizeRequest(req, requestUrl);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      sendJson(res, 200, { ok: true, state: await this.buildUserScopedState(auth.user.id) });
      return;
    }

    if (requestUrl.pathname === '/api/settings' && req.method === 'GET') {
      const auth = await this.authorizeRequest(req, requestUrl);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      const settings = await this.handleRemoteSettingsGet(auth.user.id);
      sendJson(res, 200, { ok: true, settings });
      return;
    }

    if (requestUrl.pathname === '/api/settings' && req.method === 'POST') {
      const body = await parseBody(req);
      const auth = await this.authorizeRequest(req, requestUrl, body);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      try {
        const result = await this.handleRemoteSettingsUpdate(body, auth.user.id);
        sendJson(res, 200, { ok: true, settings: result.settings });
        if (result.remoteChanged && this.activeUser?.id === auth.user.id) {
          setTimeout(() => {
            this.reconfigure(result.fullSettings?.remote || {}).catch((error) => {
              this.pushRemoteLog(`[远程设置] 重载远程服务失败：${String(error?.message || error)}`, 'error');
            });
          }, 20);
        }
      } catch (error) {
        sendJson(res, 400, { ok: false, message: String(error?.message || error) });
      }
      return;
    }

    if (requestUrl.pathname === '/api/remote-login/start' && req.method === 'POST') {
      const body = await parseBody(req);
      const auth = await this.authorizeRequest(req, requestUrl, body);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      try {
        const result = await this.handleRemoteLoginStart(body, auth.user.id);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 400, { ok: false, message: String(error?.message || error) });
      }
      return;
    }

    if (requestUrl.pathname === '/api/remote-login/confirm' && req.method === 'POST') {
      const body = await parseBody(req);
      const auth = await this.authorizeRequest(req, requestUrl, body);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      try {
        const result = await this.handleRemoteLoginConfirm(body, auth.user.id);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 400, { ok: false, message: String(error?.message || error) });
      }
      return;
    }

    if (requestUrl.pathname === '/api/remote-login/cancel' && req.method === 'POST') {
      const body = await parseBody(req);
      const auth = await this.authorizeRequest(req, requestUrl, body);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      try {
        const result = await this.handleRemoteLoginCancel(body, auth.user.id);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 400, { ok: false, message: String(error?.message || error) });
      }
      return;
    }

    if (requestUrl.pathname === '/api/voice-clone/start' && req.method === 'POST') {
      const body = await parseBody(req);
      const auth = await this.authorizeRequest(req, requestUrl, body);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      try {
        const result = await this.handleRemoteVoiceClone(body, auth.user.id);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 400, { ok: false, message: String(error?.message || error) });
      }
      return;
    }

    if (requestUrl.pathname === '/api/start' && req.method === 'POST') {
      const body = await parseBody(req);
      const auth = await this.authorizeRequest(req, requestUrl, body);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      try {
        const result = await this.handleRemoteStart(body, auth.user);
        sendJson(res, 200, {
          ok: true,
          ...result
        });
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
      const auth = await this.authorizeRequest(req, requestUrl, body);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      try {
        await this.taskRunner.stop(auth.user || { id: auth.userId });
        sendJson(res, 200, { ok: true, stopped: true });
      } catch (error) {
        sendJson(res, 409, { ok: false, message: String(error?.message || error) });
      }
      return;
    }

    if (requestUrl.pathname === '/api/task/stop-one' && req.method === 'POST') {
      const body = await parseBody(req);
      const auth = await this.authorizeRequest(req, requestUrl, body);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      try {
        const result = await this.taskRunner.stopTask(body?.taskId, auth.user || { id: auth.userId });
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 409, { ok: false, message: String(error?.message || error) });
      }
      return;
    }

    if (requestUrl.pathname === '/api/users/create' && req.method === 'POST') {
      const body = await parseBody(req);
      const auth = await this.authorizeRequest(req, requestUrl, body);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      try {
        const user = await this.store.createUserFromUser(auth.user.id, body?.name);
        await this.refreshStoreState();
        this.emitStatus();
        sendJson(res, 200, {
          ok: true,
          user,
          users: this.users,
          activeUser: await this.store.getUserSummary(auth.user.id)
        });
      } catch (error) {
        sendJson(res, 400, { ok: false, message: String(error?.message || error) });
      }
      return;
    }

    if (requestUrl.pathname === '/api/users/switch' && req.method === 'POST') {
      const body = await parseBody(req);
      const auth = await this.authorizeRequest(req, requestUrl, body);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      try {
        await this.activateUser(body?.userId || auth.user.id, {
          reconfigure: true
        });
        sendJson(res, 200, {
          ok: true,
          activeUser: this.activeUser,
          users: this.users
        });
      } catch (error) {
        sendJson(res, 400, { ok: false, message: String(error?.message || error) });
      }
      return;
    }

    if (requestUrl.pathname === '/api/users/rename' && req.method === 'POST') {
      const body = await parseBody(req);
      const auth = await this.authorizeRequest(req, requestUrl, body);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      try {
        const user = await this.store.renameUser(auth.user.id, body?.name);
        await this.refreshStoreState();
        this.emitStatus();
        sendJson(res, 200, {
          ok: true,
          user,
          users: this.users,
          activeUser: user
        });
      } catch (error) {
        sendJson(res, 400, { ok: false, message: String(error?.message || error) });
      }
      return;
    }

    if (requestUrl.pathname === '/api/users/delete' && req.method === 'POST') {
      const body = await parseBody(req);
      const auth = await this.authorizeRequest(req, requestUrl, body);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, message: auth.message || '无法确认用户。' });
        return;
      }
      if (this.taskRunner.running) {
        sendJson(res, 409, { ok: false, message: '任务执行中，不能删除用户。' });
        return;
      }
      try {
        const result = await this.store.deleteUser(body?.userId);
        await this.refreshStoreState();
        const settings = await this.store.getSettings();
        await this.reconfigure(settings.remote || {});
        sendJson(res, 200, {
          ok: true,
          ...result,
          users: this.users,
          activeUser: this.activeUser
        });
      } catch (error) {
        sendJson(res, 400, { ok: false, message: String(error?.message || error) });
      }
      return;
    }

    sendJson(res, 404, { ok: false, message: '未找到接口。' });
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

  async handleRemoteStart(body, user) {
    const inputText = String(body?.inputText || '').trim();
    if (!inputText) {
      throw new Error('请输入任务内容。');
    }

    const tasks = parseTaskInput(inputText);
    if (!tasks.length) {
      throw new Error('未识别到有效任务。');
    }

    const userId = user?.id || this.activeUser?.id || 'user-1';
    const settings = await this.store.getSettingsForUser(userId);
    const loginState = await this.store.getLoginStateForUser(userId);
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
      await this.store.setLoginStateForUser(userId, service, state.loggedIn);
    }
    this.loginState = await this.store.getLoginStateForUser(userId);

    const videoReady = Boolean(startup.loginState?.videoChannel?.loggedIn);
    const douyinReady = Boolean(startup.loginState?.douyin?.loggedIn);
    if (!videoReady && !douyinReady) {
      throw new Error('请先在电脑端登录抖音或视频号（任一即可）。');
    }
    if (!startup.voiceCloneReady) {
      throw new Error('请先在电脑端完成语音克隆。');
    }

    this.broadcast('state', this.getPublicState());

    const scheduled = this.taskRunner.enqueueTasks(tasks, user, inputText);
    scheduled.promise.catch((error) => {
      this.onRemoteLog({
        runId: '',
        taskId: '',
        level: 'error',
        timestamp: new Date().toISOString(),
        message: String(error?.message || error)
      });
    });

    return {
      started: true,
      queued: scheduled.queued,
      queuePosition: scheduled.queuePosition,
      taskCount: tasks.length,
      runId: scheduled.runId,
      taskIds: scheduled.taskIds
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
      if (ext === '.html') {
        const appInfo = getAppInfo();
        const text = content
          .toString('utf-8')
          .replaceAll('__APP_NAME__', appInfo.name)
          .replaceAll('__APP_VERSION__', appInfo.version)
          .replaceAll('__APP_DISPLAY__', appInfo.displayName);
        sendText(res, 200, text, REMOTE_CONTENT_TYPES[ext] || 'text/html; charset=utf-8');
        return;
      }
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
