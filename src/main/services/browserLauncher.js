const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let _appLog = null;

function setLogger(logger) {
  _appLog = logger;
}

function log(level, message) {
  if (_appLog) _appLog(level, message);
  else console.log(`[BrowserLauncher] ${message}`);
}

const PLATFORM_URLS = {
  weixin: 'https://channels.weixin.qq.com/platform/post/create',
  douyin: 'https://creator.douyin.com/creator-micro/content/publish',
};

function getDefaultPlatformUrl(platform) {
  if (platform === 'douyin' || platform === 'weixin') return PLATFORM_URLS[platform];
  return PLATFORM_URLS.weixin;
}

// ── 获取常见 Chrome/Edge 路径（Win/Mac）──
function getCandidateBrowserPaths() {
  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      path.join(os.homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium');
  }
  return candidates.filter(Boolean);
}

function findExistingBrowser() {
  for (const p of getCandidateBrowserPaths()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

async function openWithShell(url) {
  try {
    const { shell } = require('electron');
    await shell.openExternal(url);
    log('info', `已通过系统默认浏览器打开: ${url}`);
    return true;
  } catch (e) {
    log('error', `shell.openExternal 失败: ${e.message}`);
    return false;
  }
}

async function openWithSpawn(url) {
  const browserPath = findExistingBrowser();
  if (!browserPath) {
    log('info', '未找到本地 Chrome/Edge，将使用系统默认浏览器');
    return false;
  }
  try {
    const child = spawn(browserPath, [url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    log('info', `已通过 ${path.basename(browserPath)} 打开: ${url}`);
    return true;
  } catch (e) {
    log('error', `spawn 浏览器失败: ${e.message}`);
    return false;
  }
}

/**
 * 打开浏览器到指定平台发布页（允许弹新窗口/新标签）
 * 优先 shell.openExternal（新标签，不抢焦点由系统决定），失败则 spawn
 * @param {string} platform 'weixin' | 'douyin'
 * @param {{ allowSpawn?: boolean }} opts
 */
async function openBrowserForPlatform(platform = 'weixin', opts = {}) {
  const url = getDefaultPlatformUrl(platform);
  // 优先用系统默认浏览器新标签打开（最稳，Win/Mac 都可用，不抢焦点取决于系统）
  const shellOk = await openWithShell(url);
  if (shellOk) return { ok: true, method: 'shell', url };
  // 兜底：直接启动 Chrome/Edge 新窗口
  if (opts.allowSpawn !== false) {
    const spawnOk = await openWithSpawn(url);
    if (spawnOk) return { ok: true, method: 'spawn', url };
  }
  return { ok: false, error: '无法打开浏览器，请手动打开 Chrome 并访问 ' + url, url };
}

module.exports = {
  setLogger,
  openBrowserForPlatform,
  getDefaultPlatformUrl,
  findExistingBrowser,
};
