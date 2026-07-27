const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

// ─── 常量 ───

const GITHUB_API = 'https://api.github.com/repos/cxcboss/AntBot/releases';
const APP_VERSION_FILE = path.join(os.homedir(), 'AntBot', 'app-version.json');
const PLUGIN_DIR = path.join(os.homedir(), 'AntBot', 'browser-plugin');
const PLUGIN_VERSION_FILE = path.join(PLUGIN_DIR, 'version.json');
const CACHE_TTL = 30 * 60 * 1000;
const DOWNLOAD_CACHE_DIR = path.join(os.homedir(), 'AntBot', 'cache');

let _log = () => {};
let _updating = false;
const _cache = { app: null, plugin: null };

function setLogger(logger) { _log = logger; }

function clearCache() {
  _cache.app = null;
  _cache.plugin = null;
}

// ─── 网络层（curl via child_process.execFile，支持系统代理）───

function curlGet(url) {
  const tmpFile = path.join(os.tmpdir(), `antbot-update-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
  return new Promise((resolve, reject) => {
    execFile('curl', ['-sL', '-o', tmpFile, '--connect-timeout', '15', '-m', '60', url], { timeout: 70000 }, async (err) => {
      try {
        if (err) { reject(new Error(`curl 失败: ${err.message}`)); return; }
        const content = await fs.readFile(tmpFile, 'utf-8');
        resolve(content);
      } catch (e) {
        reject(e);
      } finally {
        fs.unlink(tmpFile).catch(() => {});
      }
    });
  });
}

const { parseSemver, compareSemver, formatBytes } = require('./versionUtils');

// 持久化下载缓存（跨重启保留）
const _downloadCache = {};

function getCachedPath(url) {
  if (_downloadCache[url]) {
    try { require('node:fs').accessSync(_downloadCache[url]); return _downloadCache[url]; }
    catch { delete _downloadCache[url]; }
  }
  // 检查磁盘缓存目录
  const hash = require('node:crypto').createHash('md5').update(url).digest('hex').slice(0, 12);
  const diskPath = path.join(DOWNLOAD_CACHE_DIR, hash + '.zip');
  try { require('node:fs').accessSync(diskPath); _downloadCache[url] = diskPath; return diskPath; }
  catch { return null; }
}

function curlDownload(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    // 检查缓存
    const cached = getCachedPath(url);
    if (cached) {
      if (onProgress) onProgress({ percent: 100, speedText: '缓存', downloadedText: '已缓存' });
      return resolve(cached);
    }

    let totalBytes = 0;
    const args = ['-L', '-o', destPath, '--connect-timeout', '30', '--max-time', '1800', '--retry', '5', '--retry-delay', '5', '--retry-max-time', '300', '--retry-all-errors', url];
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    // 从 stderr 解析 Content-Length
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!totalBytes) {
        const clMatch = text.match(/content-length:\s*(\d+)/i);
        if (clMatch) totalBytes = parseInt(clMatch[1], 10);
      }
    });

    // 每 300ms 轮询文件大小
    let lastSize = 0;
    let lastTime = Date.now();
    const fsSync = require('node:fs');
    const progressTimer = setInterval(() => {
      try {
        const stats = fsSync.statSync(destPath);
        const now = Date.now();
        const elapsed = Math.max(0.1, (now - lastTime) / 1000);
        const speed = (stats.size - lastSize) / elapsed;
        const pct = totalBytes > 0 ? (stats.size / totalBytes * 100) : 0;
        if (onProgress) {
          onProgress({
            percent: Math.min(99, pct || 0),
            downloaded: stats.size,
            total: totalBytes,
            speed,
            speedText: formatBytes(speed) + '/s',
            downloadedText: formatBytes(stats.size),
            totalText: totalBytes > 0 ? formatBytes(totalBytes) : '',
          });
        }
        lastSize = stats.size;
        lastTime = now;
      } catch {}
    }, 300);

    child.on('close', (code) => {
      clearInterval(progressTimer);
      if (code !== 0) return reject(new Error(`下载失败 (code ${code})`));
      try {
        const stats = fsSync.statSync(destPath);
        if (stats.size < 1000) return reject(new Error('下载的文件太小，可能不是有效的更新包'));
        _downloadCache[url] = destPath;
        if (onProgress) onProgress({ percent: 100, downloaded: stats.size, total: stats.size, speed: 0, speedText: '完成', downloadedText: formatBytes(stats.size), totalText: formatBytes(stats.size) });
      } catch {}
      resolve(destPath);
    });

    child.on('error', (err) => {
      clearInterval(progressTimer);
      reject(new Error(`curl 启动失败: ${err.message}`));
    });
  });
}

async function curlGetJson(url) {
  const text = await curlGet(url);
  return JSON.parse(text);
}

// ─── GitHub API ───

async function getLatestRelease() {
  const now = Date.now();
  if (_cache.app && now - _cache.app.ts < CACHE_TTL) {
    return _cache.app.data;
  }
  // 获取所有 release，过滤出 app release（tag 以 v 开头，排除 plugin-）
  const releases = await curlGetJson(`${GITHUB_API}`);
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
  const releases = await curlGetJson(GITHUB_API);
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

  await fs.mkdir(DOWNLOAD_CACHE_DIR, { recursive: true });
  const zipPath = path.join(DOWNLOAD_CACHE_DIR, `app-update.zip`);

  _log('info', `[更新] 开始下载 App 更新...`);
  await curlDownload(assetUrl, zipPath, onProgress);
  _log('info', `[更新] 下载完成: ${zipPath}`);

  return { ok: true, zipPath };
}

async function installAppUpdate(zipPath) {
  if (_updating) return { ok: false, error: '更新进行中' };
  _updating = true;

  try {
    const tmpDir = path.join(os.tmpdir(), `antbot-install-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    _log('info', `[更新] 解压更新包...`);
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
        if (entry.isDirectory() && entry.name.endsWith('.app')) {
          return path.join(dir, entry.name);
        }
        if (entry.isDirectory()) {
          const found = await findApp(path.join(dir, entry.name));
          if (found) return found;
        }
      }
      return null;
    }

    const newAppPath = await findApp(tmpDir);
    if (!newAppPath) {
      throw new Error('更新包中未找到 .app 文件');
    }

    // 生成替换脚本
    const scriptPath = path.join(tmpDir, 'update.sh');
    const scriptLines = [
      '#!/bin/bash',
      'NEW_APP="$1"',
      'OLD_PID="$2"',
      '',
      '# 等待旧进程退出',
      'WAITED=0',
      'while kill -0 "$OLD_PID" 2>/dev/null && [ "$WAITED" -lt 60 ]; do',
      '  sleep 0.5',
      '  WAITED=$((WAITED + 1))',
      'done',
      'sleep 1',
      '',
      'OLD_APP="/Applications/搬运蚁.app"',
      'OLD_APP_BACKUP="/Applications/搬运蚁.app.old"',
      '',
      '# 移除旧备份',
      'rm -rf "$OLD_APP_BACKUP" 2>/dev/null',
      '',
      '# 移动旧版本',
      'if [ -d "$OLD_APP" ]; then',
      '  mv "$OLD_APP" "$OLD_APP_BACKUP"',
      'fi',
      '',
      '# 移动新版本',
      'mv "$NEW_APP" "$OLD_APP"',
      '',
      '# 清除隔离属性',
      'xattr -cr "$OLD_APP" 2>/dev/null',
      '',
      '# 启动新版本',
      'open "$OLD_APP"',
      '',
      '# 清理',
      'rm -rf "$OLD_APP_BACKUP" 2>/dev/null',
      'rm -f "$0"'
    ];
    await fs.writeFile(scriptPath, scriptLines.join('\n'), { mode: 0o755 });

    _log('info', `[更新] 安装脚本已生成: ${scriptPath}`);
    return { ok: true, scriptPath, appPath: newAppPath };
  } catch (e) {
    _log('error', `[更新] 安装失败: ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    _updating = false;
  }
}

function executeUpdate(scriptPath, newAppPath) {
  if (_updating) return { ok: false, error: '更新进行中' };

  const child = spawn('bash', [scriptPath, newAppPath, process.pid.toString()], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  _log('info', `[更新] 已启动更新脚本 (PID: ${child.pid})，应用将退出`);
  return { ok: true, pid: child.pid };
}

// ─── 插件更新流程 ───

async function downloadPluginUpdate(assetUrl, onProgress) {
  if (!assetUrl) return { ok: false, error: '下载地址为空' };

  await fs.mkdir(DOWNLOAD_CACHE_DIR, { recursive: true });
  const zipPath = path.join(DOWNLOAD_CACHE_DIR, `plugin-update.zip`);

  _log('info', `[更新] 开始下载插件更新...`);
  await curlDownload(assetUrl, zipPath, onProgress);
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
    await new Promise((resolve, reject) => {
      execFile('unzip', ['-o', '-q', zipPath, '-d', PLUGIN_DIR], { timeout: 60000 }, (err) => {
        if (err) return reject(new Error(`解压失败: ${err.message}`));
        resolve();
      });
    });

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

// ─── 导出 ───

module.exports = {
  setLogger,
  checkAppUpdate,
  checkPluginUpdate,
  checkAllUpdates,
  downloadAppUpdate,
  installAppUpdate,
  executeUpdate,
  downloadPluginUpdate,
  installPluginUpdate,
  getAppVersion,
  getPluginVersion,
  clearCache
};
