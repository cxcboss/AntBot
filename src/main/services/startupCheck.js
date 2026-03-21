const fs = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');
const { launchPersistentChromiumContext } = require('./playwrightUtil');

function normalizeProfileSegment(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function isSharedProfileService(serviceKey) {
  return normalizeProfileSegment(serviceKey, 'service') === 'gemini';
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

function looksLikeLoginPage(url, bodyText, loginKeywords = []) {
  const urlMatched = /login|signin|passport|accounts\.google\.com/i.test(url || '');
  const keywordMatched = loginKeywords.some((keyword) => bodyText.includes(keyword));
  return urlMatched || keywordMatched;
}

function compactErrorMessage(error, maxLength = 180) {
  const raw = String(error?.message || error || '未知错误');
  return raw.replace(/\s+/g, ' ').slice(0, maxLength);
}

async function detectServiceLogin(serviceKey, serviceConfig, fallbackState, logger = () => {}, userId = 'user-1') {
  const fallback = fallbackState?.[serviceKey] || { loggedIn: false, checkedAt: '' };

  try {
    const profileDir = getProfileDir(serviceKey, userId);
    await fs.mkdir(profileDir, { recursive: true });

    const context = await launchPersistentChromiumContext(profileDir, {
      headless: true,
      args: ['--disable-blink-features=AutomationControlled']
    }, logger);

    const page = await context.newPage();
    await page.goto(serviceConfig.url, {
      waitUntil: 'domcontentloaded',
      timeout: 40000
    });

    await page.waitForTimeout(1200);

    const currentUrl = page.url();
    const bodyText = await page.evaluate(() => {
      return (document.body?.innerText || '').slice(0, 2000);
    });

    await context.close();

    const loggedIn = !looksLikeLoginPage(currentUrl, bodyText, serviceConfig.loginKeywords);
    return {
      loggedIn,
      checkedAt: new Date().toISOString(),
      source: 'runtime-check'
    };
  } catch (error) {
    logger(`登录检测失败（${serviceKey}）：${compactErrorMessage(error)}`);
    return {
      ...fallback,
      checkedAt: new Date().toISOString(),
      source: 'fallback-cache'
    };
  }
}

async function runStartupChecks(settings, persistedLoginState, logger = () => {}) {
  const loginResult = {};
  const loginHints = settings.loginHints || {};
  const userId = settings?.__userId || 'user-1';

  for (const [serviceKey, config] of Object.entries(loginHints)) {
    // Gemini 登录状态在部分场景会被误判，这里统一跳过启动检查。
    if (serviceKey === 'gemini' || config?.skipStartupCheck) {
      loginResult[serviceKey] = {
        loggedIn: true,
        checkedAt: new Date().toISOString(),
        source: 'skipped'
      };
      continue;
    }
    loginResult[serviceKey] = await detectServiceLogin(serviceKey, config, persistedLoginState, logger, userId);
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
