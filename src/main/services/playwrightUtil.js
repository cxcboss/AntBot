const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

let chromiumInstallPromise = null;

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

function shouldDisableLinuxSandbox() {
  if (process.platform !== 'linux') {
    return false;
  }
  if (parseBooleanEnv(process.env.ANTBOT_DISABLE_CHROMIUM_SANDBOX, false)) {
    return true;
  }
  if (typeof process.getuid === 'function') {
    return process.getuid() === 0;
  }
  return false;
}

function mergeChromiumArgs(currentArgs = []) {
  const merged = Array.isArray(currentArgs) ? currentArgs.slice() : [];
  const ensuredArgs = [];

  if (process.platform === 'linux') {
    ensuredArgs.push('--disable-dev-shm-usage');
    if (shouldDisableLinuxSandbox()) {
      ensuredArgs.push('--no-sandbox', '--disable-setuid-sandbox');
    }
  }

  for (const arg of ensuredArgs) {
    if (!merged.includes(arg)) {
      merged.push(arg);
    }
  }
  return merged;
}

function withContainerSafeLaunchOptions(options = {}) {
  return {
    ...options,
    args: mergeChromiumArgs(options.args)
  };
}

function isMissingChromiumExecutableError(error) {
  const text = String(error?.message || error || '');
  return text.includes("Executable doesn't exist")
    || text.includes('download new browsers')
    || text.includes('playwright install');
}

function isChromiumClosedError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('target page, context or browser has been closed')
    || text.includes('browser has been closed')
    || text.includes('sigtrap')
    || text.includes('crash')
    || text.includes('killed: 9')
    || text.includes('abort trap');
}

function isDamagedChromiumError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('code signature invalid')
    || text.includes('is damaged and can')
    || text.includes('cannot be opened because')
    || text.includes('bad cpu type');
}

function isProfileInUseError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('processsingleton')
    || text.includes('profile is already in use')
    || text.includes('singletonlock')
    || text.includes('failed to create a processsingleton');
}

function cleanupProfileSingleton(userDataDir, logger = () => {}) {
  if (!userDataDir) {
    return;
  }
  const candidates = [
    'SingletonLock',
    'SingletonSocket',
    'SingletonCookie'
  ];
  for (const name of candidates) {
    const target = path.join(userDataDir, name);
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
        logger(`已清理浏览器配置锁文件：${name}`);
      }
    } catch {
      // noop
    }
  }
}

function getPlaywrightRegistryModulePath() {
  const packageJsonPath = require.resolve('playwright-core/package.json');
  return path.join(path.dirname(packageJsonPath), 'lib', 'server', 'registry', 'index.js');
}

function getExpectedChromiumRevision() {
  try {
    const browsersJson = require('playwright-core/browsers.json');
    const entry = browsersJson?.browsers?.find((browser) => browser.name === 'chromium');
    return String(entry?.revision || '');
  } catch {
    return '';
  }
}

function getDefaultPlaywrightBrowsersRoot() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
}

function getChromiumExecutableSegments() {
  if (process.platform === 'win32') {
    return ['chrome-win64', 'chrome.exe'];
  }
  if (process.platform === 'darwin') {
    return [
      process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing'
    ];
  }
  return ['chrome-linux64', 'chrome'];
}

function getCandidateBrowserRoots() {
  const roots = [
    process.resourcesPath ? path.resolve(process.resourcesPath, 'ms-playwright') : '',
    path.resolve(process.cwd(), 'ms-playwright'),
    path.resolve(process.cwd(), 'vendors', 'ms-playwright'),
    process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0'
      ? process.env.PLAYWRIGHT_BROWSERS_PATH
      : '',
    getDefaultPlaywrightBrowsersRoot(),
    process.platform === 'linux' ? '/ms-playwright' : '',
    process.platform === 'linux' ? '/root/.cache/ms-playwright' : ''
  ];

  return [...new Set(roots.filter(Boolean))];
}

function extractChromiumRevision(dirName) {
  const matched = String(dirName || '').match(/^chromium-(\d+)$/);
  return matched ? matched[1] : '';
}

function listChromiumExecutableCandidatesInRoot(rootDir, rootIndex = 0) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }

  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const executableSegments = getChromiumExecutableSegments();
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium-'))
    .map((entry) => ({
      executablePath: path.join(rootDir, entry.name, ...executableSegments),
      revision: extractChromiumRevision(entry.name),
      rootIndex
    }))
    .filter((candidate) => fs.existsSync(candidate.executablePath));
}

function resolveChromiumExecutablePath() {
  const expectedRevision = getExpectedChromiumRevision();
  const candidates = [];

  for (const [rootIndex, rootDir] of getCandidateBrowserRoots().entries()) {
    candidates.push(...listChromiumExecutableCandidatesInRoot(rootDir, rootIndex));
  }

  candidates.sort((left, right) => {
    const leftIsExpected = expectedRevision && left.revision === expectedRevision ? 1 : 0;
    const rightIsExpected = expectedRevision && right.revision === expectedRevision ? 1 : 0;
    if (leftIsExpected !== rightIsExpected) {
      return rightIsExpected - leftIsExpected;
    }

    const leftRevision = Number.parseInt(left.revision || '0', 10);
    const rightRevision = Number.parseInt(right.revision || '0', 10);
    if (leftRevision !== rightRevision) {
      return rightRevision - leftRevision;
    }

    return left.rootIndex - right.rootIndex;
  });

  return candidates[0]?.executablePath || '';
}

function getSystemChromeCandidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      path.join(os.homedir(), 'Applications', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
    ];
  }
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
}

function resolveSystemChromePath() {
  for (const candidate of getSystemChromeCandidates()) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // noop
    }
  }
  return '';
}

function shouldPreferSystemChrome() {
  if (process.platform !== 'darwin') {
    return false;
  }
  return parseBooleanEnv(process.env.ANTBOT_PREFER_SYSTEM_CHROME, false);
}

function shouldAllowSystemChromeFallback() {
  if (process.platform === 'darwin') {
    return parseBooleanEnv(process.env.ANTBOT_ALLOW_SYSTEM_CHROME_FALLBACK, false);
  }
  return true;
}

function withResolvedChromiumExecutable(options = {}) {
  if (options.executablePath) {
    return options;
  }

  const executablePath = resolveChromiumExecutablePath();
  if (!executablePath) {
    return options;
  }

  return {
    ...options,
    executablePath
  };
}

async function installChromium(logger = () => {}, options = {}) {
  const force = Boolean(options.force);
  if (!chromiumInstallPromise) {
    chromiumInstallPromise = (async () => {
      logger(force ? '开始强制修复 Playwright Chromium...' : '开始安装 Playwright Chromium...');
      const registryModulePath = getPlaywrightRegistryModulePath();
      const registryModule = require(registryModulePath);
      if (force) {
        const executables = [registryModule.registry.findExecutable('chromium')];
        if (process.platform === 'win32') {
          executables.unshift(registryModule.registry.findExecutable('winldd'));
        }
        await registryModule.registry.install(executables, { force: true });
      } else {
        await registryModule.installBrowsersForNpmInstall(['chromium']);
      }
      logger(force ? 'Playwright Chromium 修复完成。' : 'Playwright Chromium 安装完成。');
    })().finally(() => {
      chromiumInstallPromise = null;
    });
  }

  return chromiumInstallPromise;
}

function buildChromiumLaunchOptions(options = {}, logger = () => {}) {
  let launchOptions = withContainerSafeLaunchOptions(withResolvedChromiumExecutable(options));
  if (shouldPreferSystemChrome() && !launchOptions.executablePath && !launchOptions.channel) {
    const systemChromePath = resolveSystemChromePath();
    if (systemChromePath) {
      launchOptions = { ...launchOptions, executablePath: systemChromePath };
      logger('检测到系统 Chrome，按配置优先使用系统浏览器启动。');
    }
  }
  return launchOptions;
}

async function launchWithSystemChromeFallback(userDataDir, options = {}, logger = () => {}) {
  if (!shouldAllowSystemChromeFallback()) {
    return null;
  }

  logger('Playwright Chromium 启动异常，尝试使用系统 Chrome 重新打开...');
  const fallbackOptions = withContainerSafeLaunchOptions({ ...options });
  delete fallbackOptions.executablePath;

  if (!fallbackOptions.channel) {
    fallbackOptions.channel = 'chrome';
  }

  try {
    return await chromium.launchPersistentContext(userDataDir, fallbackOptions);
  } catch (fallbackError) {
    const chromePath = resolveSystemChromePath();
    if (chromePath) {
      const pathOptions = withContainerSafeLaunchOptions({ ...options, executablePath: chromePath });
      return chromium.launchPersistentContext(userDataDir, pathOptions);
    }
    throw fallbackError;
  }
}

async function launchPersistentChromiumContext(userDataDir, options = {}, logger = () => {}) {
  let launchOptions = buildChromiumLaunchOptions(options, logger);
  try {
    return await chromium.launchPersistentContext(userDataDir, launchOptions);
  } catch (error) {
    if (isProfileInUseError(error)) {
      logger('检测到浏览器配置目录被占用，正在清理锁文件后重试...');
      cleanupProfileSingleton(userDataDir, logger);
      return chromium.launchPersistentContext(userDataDir, launchOptions);
    }

    if (isMissingChromiumExecutableError(error)) {
      logger('检测到 Playwright Chromium 未安装，正在自动安装...');
      await installChromium(logger);
      logger('Playwright Chromium 安装完成，正在重试打开浏览器...');
      return chromium.launchPersistentContext(
        userDataDir,
        buildChromiumLaunchOptions(options, logger)
      );
    }

    if (isChromiumClosedError(error) || isDamagedChromiumError(error)) {
      logger('检测到 Playwright Chromium 可能已损坏、被外部覆盖，或与当前 Playwright revision 不匹配，正在修复后重试...');
      await installChromium(logger, { force: true });
      launchOptions = buildChromiumLaunchOptions(options, logger);
      try {
        return await chromium.launchPersistentContext(userDataDir, launchOptions);
      } catch (repairedError) {
        if (isProfileInUseError(repairedError)) {
          logger('修复后检测到浏览器配置目录被占用，正在清理锁文件后重试...');
          cleanupProfileSingleton(userDataDir, logger);
          return chromium.launchPersistentContext(userDataDir, launchOptions);
        }
        const fallbackContext = await launchWithSystemChromeFallback(userDataDir, options, logger);
        if (fallbackContext) {
          return fallbackContext;
        }
        throw repairedError;
      }
    }

    throw error;
  }
}

module.exports = {
  installChromium,
  launchPersistentChromiumContext,
  isMissingChromiumExecutableError,
  resolveChromiumExecutablePath
};
