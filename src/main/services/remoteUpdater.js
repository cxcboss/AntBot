const fs = require('node:fs/promises');
const fsNative = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const { parseSemver, compareSemver, formatBytes } = require('./versionUtils');

// ─── 代理检测 ───

let _proxyAgent = null;
let _proxyDetected = false;

function detectProxy() {
  if (_proxyDetected) return _proxyAgent;
  _proxyDetected = true;
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (envProxy) { _proxyAgent = createProxyAgent(envProxy); return _proxyAgent; }
  try {
    const out = require('node:child_process').execFileSync('networksetup', ['-getwebproxy', 'Wi-Fi'], { timeout: 3000, encoding: 'utf-8' });
    const enabled = /^Enabled:\s*Yes/m.test(out);
    const hostMatch = out.match(/^Server:\s*(.+)$/m);
    const portMatch = out.match(/^Port:\s*(.+)$/m);
    if (enabled && hostMatch) {
      _proxyAgent = createProxyAgent(`http://${hostMatch[1].trim()}:${(portMatch?.[1] || '80').trim()}`);
    }
  } catch {}
  return _proxyAgent;
}

function createProxyAgent(proxyUrl) {
  const proxy = new URL(proxyUrl);
  return {
    getAgent(isHttps) {
      if (!isHttps) return new http.Agent({ host: proxy.hostname, port: parseInt(proxy.port) || 80 });
      return new https.Agent({
        createConnection: (options, callback) => {
          const req = http.request({ host: proxy.hostname, port: parseInt(proxy.port) || 80, method: 'CONNECT', path: `${options.host}:${options.port}` });
          req.on('connect', (res, socket) => {
            if (res.statusCode === 200) {
              const tlsSocket = require('node:tls').connect({ ...options, socket, servername: options.host }, () => callback(null, tlsSocket));
              tlsSocket.on('error', callback);
            } else callback(new Error(`代理连接失败: ${res.statusCode}`));
          });
          req.on('error', callback);
          req.end();
        }
      });
    }
  };
}

function getHttpOptions(urlStr) {
  const isHttps = urlStr.startsWith('https');
  const proxy = detectProxy();
  const opts = { timeout: 30000, headers: { 'User-Agent': 'AntBot-Updater' } };
  if (proxy) opts.agent = proxy.getAgent(isHttps);
  return opts;
}

const GITHUB_RAW = 'https://raw.githubusercontent.com/cxcboss/antbot-remote-ui/main';
const VERSION_URL = `${GITHUB_RAW}/version.json`;
const LOCAL_DIR = path.join(os.homedir(), 'AntBot', 'remote-ui');
const LOCAL_VERSION_FILE = path.join(LOCAL_DIR, 'version.json');
const BACKUP_DIR = path.join(LOCAL_DIR, '.backup');
const MAX_RETRY = 3;

let _log = () => {};

function setLogger(logger) { _log = logger; }

async function ensureLocalDir() {
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });
}

// ─── Node.js 原生 HTTP（直连，不走代理）───

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

function nodePost(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const options = { method: 'POST', hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 30000 };
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('连接超时')); });
    req.write(payload);
    req.end();
  });
}

// ─── SHA256 校验 ───

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

// ─── 版本管理 ───

async function getLocalVersion() {
  try {
    const raw = await fs.readFile(LOCAL_VERSION_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { version: '0.0.0', files: {} };
  }
}

async function getRemoteVersion() {
  const text = await nodeGet(VERSION_URL);
  return JSON.parse(text);
}

// ─── 带重试的下载 ───

async function downloadWithRetry(relativePath, maxRetry = MAX_RETRY) {
  const url = `${GITHUB_RAW}/${encodeURI(relativePath)}`;
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      const content = await nodeGet(url);
      // SHA256 校验（如果远程提供了 hash）
      return content;
    } catch (e) {
      _log('warn', `[热更新] 下载 ${relativePath} 第${attempt}次失败: ${e.message}`);
      if (attempt === maxRetry) throw e;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

// ─── 旧版本备份 ───

async function backupCurrentVersion() {
  try {
    const local = await getLocalVersion();
    if (local.version === '0.0.0') return; // 无需备份
    const backupPath = path.join(BACKUP_DIR, `v${local.version}`);
    await fs.mkdir(backupPath, { recursive: true });
    // 备份所有已知文件
    for (const filePath of Object.keys(local.files || {})) {
      const src = path.join(LOCAL_DIR, filePath);
      const dst = path.join(backupPath, filePath);
      try {
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
      } catch { /* 文件可能不存在，跳过 */ }
    }
    // 备份 version.json
    await fs.copyFile(LOCAL_VERSION_FILE, path.join(backupPath, 'version.json')).catch(() => {});
    _log('info', `[热更新] 已备份当前版本 v${local.version}`);
  } catch (e) {
    _log('warn', `[热更新] 备份失败: ${e.message}`);
  }
}

async function getBackupVersions() {
  try {
    const entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && e.name.startsWith('v')).map(e => e.name).sort(compareSemver);
  } catch {
    return [];
  }
}

// ─── 核心更新逻辑 ───

async function checkForUpdates() {
  const local = await getLocalVersion();
  let remote;
  try {
    remote = await getRemoteVersion();
  } catch (e) {
    _log('info', `[热更新] 无法获取远程版本: ${e.message}`);
    return { hasUpdate: false, localVersion: local.version, error: e.message };
  }

  if (compareSemver(remote.version, local.version) <= 0) {
    return { hasUpdate: false, localVersion: local.version, remoteVersion: remote.version };
  }

  return {
    hasUpdate: true,
    localVersion: local.version,
    remoteVersion: remote.version,
    remote
  };
}

async function downloadUpdate(remote) {
  await ensureLocalDir();
  const files = Object.keys(remote.files || {});
  const downloaded = [];
  const failed = [];

  for (const filePath of files) {
    try {
      const content = await downloadWithRetry(filePath);
      // 写入本地
      const localPath = path.join(LOCAL_DIR, filePath);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, content, 'utf-8');

      // SHA256 校验（如果远程提供了）
      const expectedHash = remote.files[filePath]?.sha256;
      if (expectedHash) {
        const actualHash = sha256(content);
        if (actualHash !== expectedHash) {
          _log('warn', `[热更新] ${filePath} SHA256 校验失败，跳过`);
          failed.push(filePath);
          continue;
        }
      }

      downloaded.push(filePath);
      _log('info', `[热更新] 已下载: ${filePath}`);
    } catch (e) {
      _log('error', `[热更新] 下载失败 ${filePath}: ${e.message}`);
      failed.push(filePath);
    }
  }

  if (downloaded.length === files.length) {
    // 备份当前版本
    await backupCurrentVersion();
    // 更新本地版本
    await fs.writeFile(LOCAL_VERSION_FILE, JSON.stringify(remote, null, 2), 'utf-8');
    _log('info', `[热更新] 已更新到 v${remote.version}`);

    // 推送 Hub HTML 到 Cloudflare Worker
    try {
      const hubHtml = await getLocalFile('hub/index.html');
      if (hubHtml) {
        await nodePost('https://hub.onebugmanai.online/api/update-html', { html: hubHtml, version: remote.version });
        _log('info', `[热更新] Hub 页面已同步到云端`);
      }
    } catch (e) {
      _log('warn', `[热更新] Hub 页面同步失败: ${e.message}`);
    }

    return { ok: true, version: remote.version, files: downloaded };
  }

  // 部分失败，不更新版本号
  _log('warn', `[热更新] ${failed.length} 个文件下载失败，保留当前版本`);
  return { ok: false, version: null, files: downloaded, failed, error: `${failed.length} 个文件下载失败` };
}

async function autoUpdate() {
  try {
    await ensureLocalDir();
    const result = await checkForUpdates();
    if (result.hasUpdate) {
      _log('info', `[热更新] 发现新版本 v${result.remoteVersion}（当前 v${result.localVersion}）`);
      return await downloadUpdate(result.remote);
    }
    return { ok: true, version: result.localVersion, alreadyLatest: true };
  } catch (e) {
    _log('warn', `[热更新] 自动更新失败: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function getLocalFile(relativePath) {
  const localPath = path.join(LOCAL_DIR, relativePath);
  try {
    return await fs.readFile(localPath, 'utf-8');
  } catch {
    return null;
  }
}

function getLocalDir() { return LOCAL_DIR; }

module.exports = {
  setLogger,
  checkForUpdates,
  downloadUpdate,
  autoUpdate,
  getLocalVersion,
  getRemoteVersion,
  getLocalFile,
  getLocalDir,
  ensureLocalDir,
  compareSemver,
  getBackupVersions,
  sha256
};
