const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const { buildRuntimePath } = require('./runtimeEnv');

const WINDOWS_DOWNLOADS = {
  cloudflared: {
    label: 'cloudflared',
    type: 'file',
    url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
    fileName: 'cloudflared.exe'
  },
  'yt-dlp': {
    label: 'yt-dlp',
    type: 'file',
    url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
    fileName: 'yt-dlp.exe'
  },
  node: {
    label: 'Node.js',
    type: 'zip-runtime',
    resolveUrl: async () => {
      const text = await downloadText('https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt');
      const matched = text.match(/\b(node-v[^\s]+-win-x64\.zip)\b/);
      if (!matched) {
        throw new Error('未能解析 Node.js Windows x64 下载地址。');
      }
      return `https://nodejs.org/dist/latest-v20.x/${matched[1]}`;
    },
    runtimeDirName: 'node-runtime',
    executableName: 'node.exe'
  },
  ffmpeg: {
    label: 'FFmpeg',
    type: 'zip-binaries',
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    binaryNames: ['ffmpeg.exe', 'ffprobe.exe']
  }
};

const EXTERNAL_DOWNLOAD_PAGES = {
  python: 'https://www.python.org/downloads/windows/',
  bash: 'https://git-scm.com/download/win'
};

function getElectronApp() {
  try {
    const electron = require('electron');
    return electron.app || null;
  } catch {
    return null;
  }
}

function getUserDataRoot() {
  const app = getElectronApp();
  return app
    ? app.getPath('userData')
    : path.resolve(process.cwd(), '.antbot-runtime');
}

function getManagedBinDir() {
  return path.join(getUserDataRoot(), 'bin');
}

function getBundledBinDir() {
  return path.resolve(process.resourcesPath || '', 'bin');
}

function getManagedRuntimeDir(name) {
  return path.join(getManagedBinDir(), `${name}-runtime`);
}

async function ensureManagedBinDir() {
  await fsPromises.mkdir(getManagedBinDir(), { recursive: true });
  return getManagedBinDir();
}

function unique(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item || '').trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function pathExists(targetPath) {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isWindows() {
  return process.platform === 'win32';
}

function getPathEntries() {
  return String(buildRuntimePath(process.env.PATH || ''))
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getVersionArgs(tool) {
  if (tool === 'ffmpeg' || tool === 'ffprobe') {
    return ['-version'];
  }
  if (tool === 'python') {
    return ['-V'];
  }
  return ['--version'];
}

function canRunBinary(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    // Windows 冷启动 + 杀软扫描可能明显超过 2s，放宽到 5s 避免误判已安装工具为缺失
    const timeoutMs = isWindows() ? 5000 : 2000;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // noop
      }
      resolve(false);
    }, timeoutMs);

    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function resolveExistingBinary(candidates, tool) {
  const uniqueList = unique(candidates);
  const CONCURRENCY = 8;
  const args = getVersionArgs(tool);

  for (let i = 0; i < uniqueList.length; i += CONCURRENCY) {
    const batch = uniqueList.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (candidate) => {
      const looksLikePath = candidate.includes(path.sep) || candidate.includes('/') || candidate.includes('\\');
      if (looksLikePath && !(await pathExists(candidate))) return null;
      if (await canRunBinary(candidate, args)) return candidate;
      return null;
    }));
    const found = results.find(Boolean);
    if (found) return found;
  }
  return '';
}

function getWindowsPythonCandidates() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const userProfile = process.env.USERPROFILE || os.homedir();
  const versions = ['312', '313', '311', '310'];
  const candidates = [process.env.ANTBOT_PYTHON_BIN];

  for (const suffix of versions) {
    candidates.push(
      path.join(localAppData, 'Programs', 'Python', `Python${suffix}`, 'python.exe'),
      path.join(userProfile, 'AppData', 'Local', 'Programs', 'Python', `Python${suffix}`, 'python.exe')
    );
  }

  for (const entry of getPathEntries()) {
    // 跳过 Windows Store 的 python 别名桩（App Execution Aliases 目录），避免弹商店/慢探测
    if (/[\\/]WindowsApps[\\/]?$/i.test(entry.trim())) {
      continue;
    }
    candidates.push(path.join(entry, 'python.exe'));
    candidates.push(path.join(entry, 'python3.exe'));
  }

  candidates.push('python', 'python3', 'py');
  return candidates;
}

function getWindowsBashCandidates() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    process.env.ANTBOT_BASH_BIN,
    path.join(programFiles, 'Git', 'bin', 'bash.exe'),
    path.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    path.join(programFilesX86, 'Git', 'usr', 'bin', 'bash.exe'),
    ...getPathEntries().map((entry) => path.join(entry, 'bash.exe')),
    'bash'
  ];
}

function getToolCandidates(tool) {
  const managedBin = getManagedBinDir();
  const bundledBin = getBundledBinDir();
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const pathEntries = getPathEntries();

  if (tool === 'node') {
    return [
      process.env.ANTBOT_NODE_BIN,
      path.join(getManagedRuntimeDir('node'), 'node.exe'),
      path.join(managedBin, 'node.exe'),
      path.join(bundledBin, 'node.exe'),
      path.join(programFiles, 'nodejs', 'node.exe'),
      path.join(programFilesX86, 'nodejs', 'node.exe'),
      path.join(localAppData, 'Programs', 'nodejs', 'node.exe'),
      ...pathEntries.map((entry) => path.join(entry, 'node.exe')),
      ...pathEntries.map((entry) => path.join(entry, 'node')),
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node',
      path.join(bundledBin, 'node'),
      'node'
    ];
  }

  if (tool === 'cloudflared') {
    return [
      process.env.ANTBOT_CLOUDFLARED_BIN,
      path.join(managedBin, 'cloudflared.exe'),
      path.join(bundledBin, 'cloudflared.exe'),
      ...pathEntries.map((entry) => path.join(entry, 'cloudflared.exe')),
      ...pathEntries.map((entry) => path.join(entry, 'cloudflared')),
      '/opt/homebrew/bin/cloudflared',
      '/usr/local/bin/cloudflared',
      '/usr/bin/cloudflared',
      'cloudflared'
    ];
  }

  if (tool === 'npm') {
    // npm 优先用托管 node-runtime 里的 npm（跨平台可靠）：
    // 优先返回 node-runtime 的 npm-cli.js（用 node 执行，避免 .cmd shell 问题）
    const nodeRuntimeDir = getManagedRuntimeDir('node');
    const npmCli = path.join(nodeRuntimeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return [
      process.env.ANTBOT_NPM_BIN,
      npmCli,
      path.join(nodeRuntimeDir, 'npm.cmd'),
      path.join(nodeRuntimeDir, 'npm'),
      path.join(managedBin, 'npm.cmd'),
      path.join(bundledBin, 'npm.cmd'),
      path.join(programFiles, 'nodejs', 'npm.cmd'),
      path.join(programFilesX86, 'nodejs', 'npm.cmd'),
      path.join(localAppData, 'Programs', 'nodejs', 'npm.cmd'),
      ...pathEntries.map((entry) => path.join(entry, 'npm.cmd')),
      ...pathEntries.map((entry) => path.join(entry, 'npm')),
      '/opt/homebrew/bin/npm',
      '/usr/local/bin/npm',
      '/usr/bin/npm',
      'npm.cmd',
      'npm'
    ];
  }

  if (tool === 'yt-dlp') {
    return [
      process.env.ANTBOT_YTDLP_BIN,
      path.join(managedBin, 'yt-dlp.exe'),
      path.join(bundledBin, 'yt-dlp.exe'),
      ...pathEntries.map((entry) => path.join(entry, 'yt-dlp.exe')),
      ...pathEntries.map((entry) => path.join(entry, 'yt-dlp')),
      path.join(bundledBin, 'yt-dlp'),
      '/opt/homebrew/bin/yt-dlp',
      '/usr/local/bin/yt-dlp',
      '/usr/bin/yt-dlp',
      'yt-dlp'
    ];
  }

  if (tool === 'ffmpeg' || tool === 'ffprobe') {
    const fileName = isWindows() ? `${tool}.exe` : tool;
    return [
      process.env[`ANTBOT_${tool.toUpperCase()}_BIN`],
      path.join(managedBin, fileName),
      path.join(bundledBin, fileName),
      ...pathEntries.map((entry) => path.join(entry, fileName)),
      path.join(bundledBin, tool),
      '/opt/homebrew/bin/' + tool,
      '/usr/local/bin/' + tool,
      '/usr/bin/' + tool,
      tool
    ];
  }

  if (tool === 'python') {
    if (isWindows()) {
      return getWindowsPythonCandidates();
    }
    return [
      process.env.ANTBOT_PYTHON_BIN,
      '/opt/homebrew/bin/python3.12',
      '/opt/homebrew/bin/python3.11',
      '/opt/homebrew/bin/python3.10',
      '/usr/local/bin/python3.12',
      '/usr/local/bin/python3.11',
      '/usr/local/bin/python3.10',
      '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12',
      '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11',
      '/Library/Frameworks/Python.framework/Versions/3.10/bin/python3.10',
      ...pathEntries.map((entry) => path.join(entry, 'python3.12')),
      ...pathEntries.map((entry) => path.join(entry, 'python3.11')),
      ...pathEntries.map((entry) => path.join(entry, 'python3.10')),
      ...pathEntries.map((entry) => path.join(entry, 'python3')),
      ...pathEntries.map((entry) => path.join(entry, 'python')),
      'python3',
      'python'
    ];
  }

  if (tool === 'bash') {
    if (isWindows()) {
      return getWindowsBashCandidates();
    }
    return [
      process.env.ANTBOT_BASH_BIN,
      '/bin/bash',
      '/usr/bin/bash',
      ...pathEntries.map((entry) => path.join(entry, 'bash')),
      'bash'
    ];
  }

  return [];
}

async function resolveDependencyPath(tool) {
  return resolveExistingBinary(getToolCandidates(tool), tool);
}

async function downloadText(url) {
  const { proxyFetch } = require('./proxyFetch');
  const response = await proxyFetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）：${url}`);
  }
  return await response.text();
}

async function downloadFile(url, targetPath, logger = () => {}) {
  const { proxyFetch } = require('./proxyFetch');
  const response = await proxyFetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`下载失败（HTTP ${response.status}）：${url}`);
  }

  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.download`;
  const writeStream = fs.createWriteStream(tempPath);
  logger(`正在下载：${url}`);
  await pipeline(Readable.fromWeb(response.body), writeStream);
  await fsPromises.rename(tempPath, targetPath);
  logger(`下载完成：${path.basename(targetPath)}`);
  return targetPath;
}

function escapePowerShellLiteral(value) {
  return String(value || '').replace(/'/g, "''");
}

async function expandZipArchive(zipPath, outputDir) {
  await fsPromises.rm(outputDir, { recursive: true, force: true });
  await fsPromises.mkdir(outputDir, { recursive: true });

  if (process.platform === 'win32') {
    const script = `Expand-Archive -LiteralPath '${escapePowerShellLiteral(zipPath)}' -DestinationPath '${escapePowerShellLiteral(outputDir)}' -Force`;
    await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return;
  }

  await runCommand('unzip', ['-o', zipPath, '-d', outputDir]);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error((stderr || stdout || `${command} exit ${code}`).trim()));
      }
    });
  });
}

async function collectNamedFiles(rootDir, fileNames) {
  const wanted = new Set(fileNames.map((item) => item.toLowerCase()));
  const found = new Map();
  const queue = [rootDir];

  while (queue.length) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      const lowered = entry.name.toLowerCase();
      if (wanted.has(lowered) && !found.has(lowered)) {
        found.set(lowered, fullPath);
      }
    }
  }

  return found;
}

async function ensureWindowsDependency(tool, logger = () => {}) {
  if (!isWindows()) {
    return resolveDependencyPath(tool);
  }

  const existing = await resolveDependencyPath(tool);
  if (existing) {
    return existing;
  }

  const config = WINDOWS_DOWNLOADS[tool];
  if (!config) {
    throw new Error(`当前不支持自动下载 ${tool}。`);
  }

  await ensureManagedBinDir();

  if (config.type === 'file') {
    const targetPath = path.join(getManagedBinDir(), config.fileName);
    await downloadFile(config.url, targetPath, logger);
    return targetPath;
  }

  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), `antbot-${tool}-`));
  try {
    const sourceUrl = typeof config.resolveUrl === 'function' ? await config.resolveUrl() : config.url;
    const zipPath = path.join(tempRoot, `${tool}.zip`);
    const extractDir = path.join(tempRoot, 'extracted');

    await downloadFile(sourceUrl, zipPath, logger);
    await expandZipArchive(zipPath, extractDir);

    if (config.type === 'zip-runtime') {
      const named = await collectNamedFiles(extractDir, [config.executableName]);
      const executablePath = named.get(config.executableName.toLowerCase());
      if (!executablePath) {
        throw new Error(`${config.label} 压缩包中未找到 ${config.executableName}`);
      }
      const runtimeSourceDir = path.dirname(executablePath);
      const runtimeTargetDir = getManagedRuntimeDir('node');
      await fsPromises.rm(runtimeTargetDir, { recursive: true, force: true });
      await fsPromises.mkdir(path.dirname(runtimeTargetDir), { recursive: true });
      await fsPromises.cp(runtimeSourceDir, runtimeTargetDir, { recursive: true, force: true });
      return path.join(runtimeTargetDir, config.executableName);
    }

    if (config.type === 'zip-binaries') {
      const named = await collectNamedFiles(extractDir, config.binaryNames);
      for (const binaryName of config.binaryNames) {
        const source = named.get(binaryName.toLowerCase());
        if (!source) {
          throw new Error(`${config.label} 压缩包中未找到 ${binaryName}`);
        }
        const target = path.join(getManagedBinDir(), binaryName);
        await fsPromises.copyFile(source, target);
      }
      return path.join(getManagedBinDir(), config.binaryNames[0]);
    }

    throw new Error(`未知依赖下载类型：${config.type}`);
  } finally {
    await fsPromises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function getDependencyState() {
  const checks = [
    ['node', 'Node.js', true, true],
    ['yt-dlp', 'yt-dlp', true, true],
    ['ffmpeg', 'FFmpeg', true, true],
    ['ffprobe', 'FFprobe', true, true],
    ['cloudflared', 'cloudflared', false, true],
    ['python', 'Python 3.10~3.13', false, false],
    ['bash', 'Git Bash/bash', false, false]
  ];

  const items = {};
  const results = await Promise.all(checks.map(async ([key, label, required, autoInstallSupported]) => {
    const resolved = await resolveDependencyPath(key);
    return { key, label, required, autoInstallSupported, resolved };
  }));
  for (const { key, label, required, autoInstallSupported, resolved } of results) {
    items[key] = {
      key,
      label,
      required,
      autoInstallSupported,
      found: Boolean(resolved),
      path: resolved,
      managed: Boolean(resolved && resolved.startsWith(getManagedBinDir()))
    };
  }

  return {
    platform: process.platform,
    managedBinDir: getManagedBinDir(),
    items,
    downloads: EXTERNAL_DOWNLOAD_PAGES
  };
}

async function repairMissingDependencies(logger = () => {}) {
  if (!isWindows()) {
    return getDependencyState();
  }

  for (const key of ['node', 'yt-dlp', 'ffmpeg', 'cloudflared']) {
    const resolved = await resolveDependencyPath(key);
    if (!resolved) {
      await ensureWindowsDependency(key, logger);
    }
  }

  return getDependencyState();
}

// 构建可靠的 npm 调用方式：
// 1. 优先：托管 node-runtime 的 npm-cli.js（用 node 执行，跨平台无 .cmd shell 问题）
// 2. 回退：系统 npm / npm.cmd（Windows 需 shell）
async function buildNpmInvocation() {
  const npmCli = path.join(getManagedRuntimeDir('node'), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const nodeBin = await resolveDependencyPath('node');
  if (nodeBin && await pathExists(npmCli)) {
    return { command: nodeBin, args: [npmCli], shell: false };
  }
  if (isWindows()) {
    return { command: 'npm.cmd', args: [], shell: true };
  }
  return { command: 'npm', args: [], shell: false };
}

function injectManagedBinIntoProcessEnv() {
  const managedBinDir = getManagedBinDir();
  process.env.ANTBOT_MANAGED_BIN = managedBinDir;
  process.env.PATH = buildRuntimePath(managedBinDir, process.env.PATH || '');
  return managedBinDir;
}

module.exports = {
  EXTERNAL_DOWNLOAD_PAGES,
  getManagedBinDir,
  ensureManagedBinDir,
  resolveDependencyPath,
  ensureWindowsDependency,
  repairMissingDependencies,
  getDependencyState,
  buildNpmInvocation,
  injectManagedBinIntoProcessEnv
};
