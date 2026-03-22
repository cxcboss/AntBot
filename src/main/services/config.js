const os = require('node:os');
const path = require('node:path');

function formatCnDateFolder(date = new Date()) {
  const year = String(date.getFullYear()).slice(-2);
  return `${date.getMonth() + 1}月${date.getDate()}日${year}年`;
}

function parseBooleanEnv(rawValue, fallback = false) {
  const normalized = String(rawValue || '').trim().toLowerCase();
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

function parseNumberEnv(rawValue, fallback, min, max) {
  const normalized = String(rawValue || '').trim();
  if (!normalized) {
    return fallback;
  }
  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function resolvePathEnv(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) {
    return '';
  }
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') {
    return target;
  }

  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      target[key] = value.slice();
      continue;
    }
    if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      deepMerge(target[key], value);
      continue;
    }
    target[key] = value;
  }

  return target;
}

const BASE_DEFAULT_SETTINGS = {
  paths: {
    tempDir: path.join(os.homedir(), 'Desktop', '视频', '_临时'),
    outputBaseDir: path.join(os.homedir(), 'Desktop', '视频'),
    youtubeProjectPath: '',
    editProjectPath: path.resolve(process.cwd(), 'vendors', 'auto_dub_web'),
    publishProjectPath: ''
  },
  browser: {
    showAutomationWindow: true,
    actionDelayMs: 1500,
    pauseBetweenTasksMs: 2500
  },
  publish: {
    platform: '视频号',
    enabled: true
  },
  subtitle: {
    geminiUrl: ''
  },
  retry: {
    failedTaskRetries: 0
  },
  remote: {
    enabled: true,
    port: 17888,
    password: '',
    publicMode: 'cloudflare-quick',
    cloudflaredPath: ''
  },
  system: {
    preventSleepOnTasks: true,
    launchAtLogin: true
  },
  style: {
    subtitleTextColor: '#FFA100',
    subtitleStrokeColor: '#000000',
    subtitlePositionPercent: 12,
    voiceSpeed: 1.1,
    subtitleEnabled: true,
    voiceoverEnabled: true
  },
  commands: {
    download: '',
    gemini: '',
    edit: '',
    publish: '',
    voiceClone: ''
  },
  voiceClone: {
    voiceId: '',
    modelPath: '',
    samplePath: '',
    referenceText: '',
    profileName: '',
    language: 'zh',
    lastUpdatedAt: ''
  },
  loginHints: {
    videoChannel: {
      url: 'https://channels.weixin.qq.com',
      loginKeywords: ['登录', '扫码', '微信']
    },
    douyin: {
      url: 'https://creator.douyin.com',
      loginKeywords: ['登录', '抖音号登录', '扫码']
    },
    gemini: {
      url: 'https://gemini.google.com',
      loginKeywords: ['Sign in', '登录', 'Google'],
      skipStartupCheck: true
    }
  }
};

function getSettingsOverridesFromEnv() {
  const overrides = {};
  const pathOverrides = {};

  const dataRoot = resolvePathEnv(process.env.ANTBOT_DATA_ROOT);
  const tempDir = resolvePathEnv(process.env.ANTBOT_TEMP_DIR) || (dataRoot ? path.join(dataRoot, 'temp') : '');
  const outputBaseDir = resolvePathEnv(process.env.ANTBOT_OUTPUT_BASE_DIR) || (dataRoot ? path.join(dataRoot, 'output') : '');
  const editProjectPath = resolvePathEnv(process.env.ANTBOT_EDIT_PROJECT_PATH) || (dataRoot ? path.join(dataRoot, 'engines', 'auto_dub_web') : '');
  const youtubeProjectPath = resolvePathEnv(process.env.ANTBOT_YOUTUBE_PROJECT_PATH);
  const publishProjectPath = resolvePathEnv(process.env.ANTBOT_PUBLISH_PROJECT_PATH);

  if (tempDir) {
    pathOverrides.tempDir = tempDir;
  }
  if (outputBaseDir) {
    pathOverrides.outputBaseDir = outputBaseDir;
  }
  if (editProjectPath) {
    pathOverrides.editProjectPath = editProjectPath;
  }
  if (youtubeProjectPath) {
    pathOverrides.youtubeProjectPath = youtubeProjectPath;
  }
  if (publishProjectPath) {
    pathOverrides.publishProjectPath = publishProjectPath;
  }

  if (Object.keys(pathOverrides).length > 0) {
    overrides.paths = pathOverrides;
  }

  const remoteOverrides = {};
  const remoteEnabledRaw = String(process.env.ANTBOT_REMOTE_ENABLED || '').trim();
  const remotePassword = String(process.env.ANTBOT_REMOTE_PASSWORD || '').trim();
  const remotePortRaw = String(process.env.ANTBOT_REMOTE_PORT || '').trim();
  const remotePublicMode = String(process.env.ANTBOT_REMOTE_PUBLIC_MODE || '').trim();
  const cloudflaredPath = resolvePathEnv(process.env.ANTBOT_CLOUDFLARED_PATH);

  if (remoteEnabledRaw) {
    remoteOverrides.enabled = parseBooleanEnv(remoteEnabledRaw, false);
  } else if (remotePassword) {
    remoteOverrides.enabled = true;
  }

  if (remotePassword) {
    remoteOverrides.password = remotePassword;
  }

  if (remotePortRaw) {
    remoteOverrides.port = parseNumberEnv(remotePortRaw, 17888, 1024, 65535);
  }

  if (remotePublicMode === 'cloudflare-quick' || remotePublicMode === 'off') {
    remoteOverrides.publicMode = remotePublicMode;
  }

  if (cloudflaredPath) {
    remoteOverrides.cloudflaredPath = cloudflaredPath;
  }

  if (Object.keys(remoteOverrides).length > 0) {
    overrides.remote = remoteOverrides;
  }

  const failedTaskRetriesRaw = String(process.env.ANTBOT_FAILED_TASK_RETRIES || '').trim();
  if (failedTaskRetriesRaw) {
    overrides.retry = {
      failedTaskRetries: parseNumberEnv(failedTaskRetriesRaw, 0, 0, 20)
    };
  }

  const geminiUrl = String(process.env.ANTBOT_GEMINI_URL || '').trim();
  if (geminiUrl) {
    overrides.subtitle = {
      geminiUrl
    };
  }

  return overrides;
}

function buildDefaultSettings() {
  return deepMerge(structuredClone(BASE_DEFAULT_SETTINGS), getSettingsOverridesFromEnv());
}

const DEFAULT_SETTINGS = buildDefaultSettings();

const STEP_NAMES = {
  download: '视频下载',
  subtitle: '字幕生成',
  edit: '视频剪辑',
  publish: '视频发布'
};

module.exports = {
  DEFAULT_SETTINGS,
  buildDefaultSettings,
  getSettingsOverridesFromEnv,
  STEP_NAMES,
  formatCnDateFolder
};
