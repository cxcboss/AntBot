const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const { execFile } = require('node:child_process');

// ─── 常量 ───

const GITHUB_API = 'https://api.github.com/repos/cxcboss/AntBot/releases';
const APP_VERSION_FILE = path.join(os.homedir(), 'AntBot', 'app-version.json');
const PLUGIN_DIR = path.join(os.homedir(), 'AntBot', 'browser-plugin');
const PLUGIN_VERSION_FILE = path.join(PLUGIN_DIR, 'version.json');
const CACHE_TTL = 30 * 60 * 1000;
const DOWNLOAD_CACHE_DIR = path.join(os.homedir(), 'AntBot', 'cache');

// ─── 代理检测 ───

let _proxyAgent = null;
let _proxyDetected = false;

function detectProxy() {
  if (_proxyDetected) return _proxyAgent;
  _proxyDetected = true;
  // 1. 环境变量
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (envProxy) { _proxyAgent = createProxyAgent(envProxy); return _proxyAgent; }
  // 2. macOS 系统代理
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('networksetup', ['-getwebproxy', 'Wi-Fi'], { timeout: 3000, encoding: 'utf-8' });
    const enabled = /^Enabled:\s*Yes/m.test(out);
    const hostMatch = out.match(/^Server:\s*(.+)$/m);
    const portMatch = out.match(/^Port:\s*(.+)$/m);
    if (enabled && hostMatch) {
      const proxyUrl = `http://${hostMatch[1].trim()}:${(portMatch?.[1] || '80').trim()}`;
      _proxyAgent = createProxyAgent(proxyUrl);
    }
  } catch {}
  return _proxyAgent;
}

function createProxyAgent(proxyUrl) {
  const proxy = new URL(proxyUrl);
  return {
    getAgent(isHttps) {
      if (!isHttps) {
        return new http.Agent({ host: proxy.hostname, port: parseInt(proxy.port) || 80 });
      }
      // HTTPS-over-HTTP-proxy: 用 CONNECT 隧道
      return new https.Agent({
        createConnection: (options, callback) => {
          const req = http.request({ host: proxy.hostname, port: parseInt(proxy.port) || 80, method: 'CONNECT', path: `${options.host}:${options.port}`, headers: {} });
          req.on('connect', (res, socket) => {
            if (res.statusCode === 200) {
              const tlsOptions = { ...options, socket, servername: options.host };
              const tlsSocket = require('node:tls').connect(tlsOptions, () => callback(null, tlsSocket));
              tlsSocket.on('error', callback);
            } else { callback(new Error(`代理连接失败: ${res.statusCode}`)); }
          });
          req.on('error', callback);
          req.end();
        }
      });
    }
  };
}

function getHttpOptions(urlStr, extraHeaders = {}) {
  const isHttps = urlStr.startsWith('https');
  const proxy = detectProxy();
  const opts = { timeout: 30000, headers: { 'User-Agent': 'AntBot-Updater', ...extraHeaders } };
  if (proxy) opts.agent = proxy.getAgent(isHttps);
  return opts;
}

let _log = () => {};
let _updating = false;
let _abortController = null;

function cancelDownload() {
  if (_abortController) {
    _abortController.abort();
    _abortController = null;
  }
  _updating = false;
  // 清理缓存中的未完成下载
  try {
    const entries = fsSync.readdirSync(DOWNLOAD_CACHE_DIR);
    for (const entry of entries) {
      if (entry.endsWith('.downloading')) {
        fsSync.unlinkSync(path.join(DOWNLOAD_CACHE_DIR, entry));
      }
    }
  } catch {}
}
const _cache = { app: null, plugin: null };

function setLogger(logger) { _log = logger; }

function clearCache() {
  _cache.app = null;
  _cache.plugin = null;
}

// ─── 网络层（Node.js 原生 HTTP，自动走系统代理）───

function nodeGet(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    function doRequest(reqUrl, redirectsLeft) {
      const mod = reqUrl.startsWith('https') ? https : http;
      const req = mod.get(reqUrl, getHttpOptions(reqUrl), (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('重定向次数过多'));
          return doRequest(res.headers.location, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('连接超时')); });
    }
    doRequest(url, maxRedirects);
  });
}

async function nodeGetJson(url) {
  const text = await nodeGet(url);
  return JSON.parse(text);
}

const { parseSemver, compareSemver, formatBytes } = require('./versionUtils');

// 持久化下载缓存（跨重启保留）
const _downloadCache = {};

function getCachedPath(url) {
  if (_downloadCache[url]) {
    try { fsSync.accessSync(_downloadCache[url]); return _downloadCache[url]; }
    catch { delete _downloadCache[url]; }
  }
  const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
  const diskPath = path.join(DOWNLOAD_CACHE_DIR, hash + '.zip');
  try { fsSync.accessSync(diskPath); _downloadCache[url] = diskPath; return diskPath; }
  catch { return null; }
}

// 原生 HTTP 下载（走系统代理，支持重定向和取消）
function nodeDownload(url, destPath, onProgress, maxRedirects = 5, signal = null) {
  return new Promise((resolve, reject) => {
    const cached = getCachedPath(url);
    if (cached) {
      if (onProgress) onProgress({ percent: 100, speedText: '缓存', downloadedText: '已缓存' });
      return resolve(cached);
    }

    const tmpPath = destPath + '.downloading';
    const file = fsSync.createWriteStream(tmpPath);
    let totalBytes = 0;
    let downloaded = 0;
    let lastSize = 0;
    let lastTime = Date.now();

    const progressTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.max(0.1, (now - lastTime) / 1000);
      const speed = (downloaded - lastSize) / elapsed;
      const pct = totalBytes > 0 ? (downloaded / totalBytes * 100) : 0;
      if (onProgress) {
        onProgress({
          percent: Math.min(99, pct || 0),
          downloaded,
          total: totalBytes,
          speed,
          speedText: formatBytes(speed) + '/s',
          downloadedText: formatBytes(downloaded),
          totalText: totalBytes > 0 ? formatBytes(totalBytes) : '',
        });
      }
      lastSize = downloaded;
      lastTime = now;
    }, 300);

    let activeReq = null;

    const cleanup = (err) => {
      clearInterval(progressTimer);
      if (activeReq) activeReq.destroy();
      file.close(() => fsSync.unlink(tmpPath, () => {}));
      reject(err);
    };

    // 取消信号
    if (signal) {
      signal.addEventListener('abort', () => cleanup(new Error('下载已取消')), { once: true });
    }

    function doRequest(reqUrl, redirectsLeft) {
      const mod = reqUrl.startsWith('https') ? https : http;
      const req = mod.get(reqUrl, getHttpOptions(reqUrl), (res) => {
        activeReq = req;
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return cleanup(new Error('重定向次数过多'));
          return doRequest(res.headers.location, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) { res.resume(); return cleanup(new Error(`HTTP ${res.statusCode}`)); }

        totalBytes = parseInt(res.headers['content-length'], 10) || 0;

        res.on('data', (chunk) => { downloaded += chunk.length; file.write(chunk); });

        res.on('end', () => {
          clearInterval(progressTimer);
          file.end(() => {
            try {
              const stats = fsSync.statSync(tmpPath);
              if (stats.size < 1000) { fsSync.unlinkSync(tmpPath); return reject(new Error('下载的文件太小')); }
              fsSync.renameSync(tmpPath, destPath);
              _downloadCache[url] = destPath;
              if (onProgress) onProgress({ percent: 100, downloaded: stats.size, total: stats.size, speed: 0, speedText: '完成', downloadedText: formatBytes(stats.size), totalText: formatBytes(stats.size) });
              resolve(destPath);
            } catch (e) { fsSync.unlink(tmpPath, () => {}); reject(e); }
          });
        });

        res.on('error', cleanup);
      });

      req.on('error', cleanup);
      req.on('timeout', () => { req.destroy(); cleanup(new Error('连接超时')); });
    }

    doRequest(url, maxRedirects);
  });
}

// ─── GitHub API ───

async function getLatestRelease() {
  const now = Date.now();
  if (_cache.app && now - _cache.app.ts < CACHE_TTL) {
    return _cache.app.data;
  }
  // 获取所有 release，过滤出 app release（tag 以 v 开头，排除 plugin-）
  const releases = await nodeGetJson(`${GITHUB_API}`);
  const appReleases = (Array.isArray(releases) ? releases : [])
    .filter(r => r.tag_name && r.tag_name.startsWith('v') && !r.tag_name.startsWith('plugin-'))
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  const data = appReleases[0] || {};
  const result = { tag_name: data.tag_name || '', body: data.body || '', assets: data.assets || [] };
  _cache.app = { ts: now, data: result };
  return result;
}

async function getLatestPluginRelease() {
  const now = Date.now();
  if (_cache.plugin && now - _cache.plugin.ts < CACHE_TTL) {
    return _cache.plugin.data;
  }
  const releases = await nodeGetJson(GITHUB_API);
  const pluginReleases = (Array.isArray(releases) ? releases : [])
    .filter((r) => String(r.tag_name || '').startsWith('plugin-'))
    .sort((a, b) => {
      const va = a.tag_name.replace(/^plugin-/, '');
      const vb = b.tag_name.replace(/^plugin-/, '');
      return compareSemver(vb, va);
    });
  const release = pluginReleases[0] || null;
  const result = release ? { tag_name: release.tag_name, body: release.body, assets: release.assets || [] } : null;
  _cache.plugin = { ts: now, data: result };
  return result;
}

// ─── 更新检查 ───

async function checkAppUpdate() {
  try {
    const versionData = await getAppVersion();
    const currentVersion = versionData.version || '0.0.0';

    const release = await getLatestRelease();
    const latestVersion = release.tag_name.replace(/^v/, '');

    if (compareSemver(latestVersion, currentVersion) <= 0) {
      return { hasUpdate: false, currentVersion, latestVersion };
    }

    const macAsset = release.assets.find((a) =>
      String(a.name || '').endsWith('.zip') && String(a.name || '').includes('mac')
    ) || release.assets.find((a) => String(a.name || '').endsWith('.zip')) || null;

    return {
      hasUpdate: true,
      currentVersion,
      latestVersion,
      changelog: release.body || '',
      downloadUrl: macAsset ? macAsset.browser_download_url : '',
      fileSize: macAsset ? macAsset.size : 0,
      assetName: macAsset ? macAsset.name : ''
    };
  } catch (e) {
    _log('warn', `[更新] 检查 App 更新失败: ${e.message}`);
    return { hasUpdate: false, error: e.message };
  }
}

async function checkPluginUpdate() {
  try {
    const versionData = await getPluginVersion();
    const currentVersion = versionData.version || '0.0.0';

    const release = await getLatestPluginRelease();
    if (!release) {
      return { hasUpdate: false, currentVersion, latestVersion: '0.0.0' };
    }

    const latestVersion = release.tag_name.replace(/^plugin-/, '');

    if (compareSemver(latestVersion, currentVersion) <= 0) {
      return { hasUpdate: false, currentVersion, latestVersion };
    }

    const zipAsset = release.assets.find((a) => String(a.name || '').endsWith('.zip')) || null;

    return {
      hasUpdate: true,
      currentVersion,
      latestVersion,
      changelog: release.body || '',
      downloadUrl: zipAsset ? zipAsset.browser_download_url : '',
      fileSize: zipAsset ? zipAsset.size : 0,
      assetName: zipAsset ? zipAsset.name : ''
    };
  } catch (e) {
    _log('warn', `[更新] 检查插件更新失败: ${e.message}`);
    return { hasUpdate: false, error: e.message };
  }
}

async function checkAllUpdates() {
  const [app, plugin] = await Promise.all([checkAppUpdate(), checkPluginUpdate()]);
  return { app, plugin };
}

// ─── App 更新流程 ───

async function downloadAppUpdate(assetUrl, onProgress) {
  if (!assetUrl) return { ok: false, error: '下载地址为空' };

  _abortController = new AbortController();
  await fs.mkdir(DOWNLOAD_CACHE_DIR, { recursive: true });
  const zipPath = path.join(DOWNLOAD_CACHE_DIR, `app-update.zip`);

  _log('info', `[更新] 开始下载 App 更新...`);
  await nodeDownload(assetUrl, zipPath, onProgress, 5, _abortController.signal);
  _log('info', `[更新] 下载完成: ${zipPath}`);

  return { ok: true, zipPath };
}

async function installAppUpdate(zipPath) {
  if (_updating) return { ok: false, error: '更新进行中' };
  _updating = true;

  try {
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    const tmpDir = path.join(downloadsDir, `antbot-update-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    _log('info', `[更新] 解压更新包到下载目录...`);
    await new Promise((resolve, reject) => {
      execFile('unzip', ['-o', '-q', zipPath, '-d', tmpDir], { timeout: 60000 }, (err) => {
        if (err) return reject(new Error(`解压失败: ${err.message}`));
        resolve();
      });
    });

    // 查找 .app 目录
    async function findApp(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.endsWith('.app')) return path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = await findApp(path.join(dir, entry.name));
          if (found) return found;
        }
      }
      return null;
    }

    const appPath = await findApp(tmpDir);
    if (!appPath) throw new Error('更新包中未找到 .app 文件');

    _log('info', `[更新] 已解压到: ${appPath}`);
    return { ok: true, appPath, appDir: tmpDir };
  } catch (e) {
    _log('error', `[更新] 安装失败: ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    _updating = false;
  }
}

// ─── 插件更新流程 ───

async function downloadPluginUpdate(assetUrl, onProgress) {
  if (!assetUrl) return { ok: false, error: '下载地址为空' };

  await fs.mkdir(DOWNLOAD_CACHE_DIR, { recursive: true });
  const zipPath = path.join(DOWNLOAD_CACHE_DIR, `plugin-update.zip`);

  _log('info', `[更新] 开始下载插件更新...`);
  await nodeDownload(assetUrl, zipPath, onProgress);
  _log('info', `[更新] 插件下载完成: ${zipPath}`);

  return { ok: true, zipPath };
}

async function installPluginUpdate(zipPath, newVersion) {
  if (_updating) return { ok: false, error: '更新进行中' };
  _updating = true;

  try {
    // 清理旧插件目录
    await fs.rm(PLUGIN_DIR, { recursive: true, force: true });
    await fs.mkdir(PLUGIN_DIR, { recursive: true });

    _log('info', `[更新] 解压插件...`);
    // 先解压到临时目录，处理可能的嵌套目录
    const tmpExtract = path.join(DOWNLOAD_CACHE_DIR, 'plugin-extract');
    await fs.rm(tmpExtract, { recursive: true, force: true });
    await fs.mkdir(tmpExtract, { recursive: true });

    await new Promise((resolve, reject) => {
      execFile('unzip', ['-o', '-q', zipPath, '-d', tmpExtract], { timeout: 60000 }, (err) => {
        if (err) return reject(new Error(`解压失败: ${err.message}`));
        resolve();
      });
    });

    // 检测嵌套目录（zip 内有单一根目录时剥离）
    const extractEntries = await fs.readdir(tmpExtract);
    const srcDir = extractEntries.length === 1
      ? (await fs.stat(path.join(tmpExtract, extractEntries[0]))).isDirectory()
        ? path.join(tmpExtract, extractEntries[0])
        : tmpExtract
      : tmpExtract;

    // 移动到目标目录
    const srcEntries = await fs.readdir(srcDir);
    for (const entry of srcEntries) {
      await fs.rename(path.join(srcDir, entry), path.join(PLUGIN_DIR, entry));
    }
    await fs.rm(tmpExtract, { recursive: true, force: true });

    // 写入新版本号
    await fs.writeFile(PLUGIN_VERSION_FILE, JSON.stringify({
      version: newVersion || '1.0.0',
      updatedAt: new Date().toISOString()
    }, null, 2));

    _log('info', `[更新] 插件安装完成`);
    return { ok: true, version: newVersion };
  } catch (e) {
    _log('error', `[更新] 插件安装失败: ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    _updating = false;
  }
}

// ─── 版本读取 ───

async function getAppVersion() {
  try {
    const raw = await fs.readFile(APP_VERSION_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { version: '0.0.0', updatedAt: '' };
  }
}

async function getPluginVersion() {
  try {
    const raw = await fs.readFile(PLUGIN_VERSION_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { version: '0.0.0', updatedAt: '' };
  }
}

// ─── 清理 ───

async function cleanupPartialDownloads() {
  try {
    const entries = await fs.readdir(DOWNLOAD_CACHE_DIR);
    for (const entry of entries) {
      if (entry.endsWith('.downloading')) {
        await fs.unlink(path.join(DOWNLOAD_CACHE_DIR, entry)).catch(() => {});
      }
    }
  } catch {}
}

// ─── 导出 ───

module.exports = {
  setLogger,
  checkAppUpdate,
  checkPluginUpdate,
  checkAllUpdates,
  downloadAppUpdate,
  installAppUpdate,
  downloadPluginUpdate,
  installPluginUpdate,
  getAppVersion,
  getPluginVersion,
  clearCache,
  cleanupPartialDownloads,
  cancelDownload
};
