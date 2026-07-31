const fs = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');

function normalizeProfileSegment(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function isSharedProfileService(serviceKey) {
  return false;
}

function getProfileScopeKey(serviceKey, userId = 'user-1') {
  const safeServiceKey = normalizeProfileSegment(serviceKey, 'service');
  if (isSharedProfileService(safeServiceKey)) {
    return `shared:${safeServiceKey}`;
  }
  const safeUserId = normalizeProfileSegment(userId, 'user-1');
  return `${safeUserId}:${safeServiceKey}`;
}

function getProfileDir(serviceKey, userId = 'user-1') {
  const safeServiceKey = normalizeProfileSegment(serviceKey, 'service');
  if (isSharedProfileService(safeServiceKey)) {
    return path.join(app.getPath('userData'), 'browser-profiles', 'shared', safeServiceKey);
  }
  const safeUserId = normalizeProfileSegment(userId, 'user-1');
  return path.join(app.getPath('userData'), 'browser-profiles', safeUserId, safeServiceKey);
}

async function hasVoiceClone(settings) {
  const voice = settings.voiceClone || {};
  if (voice.voiceId) {
    return true;
  }

  if (voice.profileName && voice.samplePath && voice.referenceText) {
    try {
      await fs.access(voice.samplePath);
      return true;
    } catch {
      // noop
    }
  }

  if (!voice.modelPath) {
    return false;
  }

  try {
    await fs.access(voice.modelPath);
    return true;
  } catch {
    return false;
  }
}

async function runStartupChecks(settings, persistedLoginState, logger = () => {}) {
  // 登录检测已废弃，所有登录在用户浏览器中进行
  const loginResult = {};
  const loginHints = settings.loginHints || {};
  for (const serviceKey of Object.keys(loginHints)) {
    loginResult[serviceKey] = {
      loggedIn: true,
      checkedAt: new Date().toISOString(),
      source: 'skipped'
    };
  }
  const voiceCloneReady = await hasVoiceClone(settings);
  return {
    loginState: loginResult,
    voiceCloneReady,
    checkedAt: new Date().toISOString()
  };
}

module.exports = {
  runStartupChecks,
  hasVoiceClone,
  getProfileDir,
  getProfileScopeKey,
  isSharedProfileService
};
