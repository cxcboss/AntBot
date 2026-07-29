const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { buildRuntimePath } = require('./runtimeEnv');

const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RETRIES = 2;

// ── Cookie management ──
const COOKIES_DIR = path.join(os.homedir(), 'AntBot', 'cookies');

async function ensureCookiesDir() {
  await fs.mkdir(COOKIES_DIR, { recursive: true });
}

function getCookieFile(platform) {
  return path.join(COOKIES_DIR, `${platform}.txt`);
}

// 将 fetch response 的 set-cookie 转为 Netscape cookies.txt 格式
function cookiesToNetscape(cookies, domain) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = c.expires ? Math.floor(c.expires) : '0';
    const httpOnly = c.httpOnly ? 'TRUE' : 'FALSE';
    const d = c.domain || domain;
    const domainField = d.startsWith('.') ? d : `.${d}`;
    lines.push(`${domainField}\tTRUE\t${c.path || '/'}\t${secure}\t${expiry}\t${c.name}\t${c.value}`);
  }
  return lines.join('\n');
}

// 自动获取抖音 cookies（不需要登录，只需访问页面）
// 通过 Playwright 获取抖音 cookies（真实浏览器访问）
async function fetchDouyinCookiesPlaywright() {
  try {
    await ensureCookiesDir();
    const cookieFile = getCookieFile('douyin');
    // 检查已有 cookies 是否有效（24小时内）
    try {
      const stat = await fs.stat(cookieFile);
      if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) return cookieFile;
    } catch {}

    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    const cookies = await context.cookies();
    await browser.close();

    if (cookies.length) {
      await fs.writeFile(cookieFile, cookiesToNetscape(cookies, '.douyin.com'));
      return cookieFile;
    }
    return '';
  } catch { return ''; }
}

// 检查 YouTube cookies 是否存在
async function hasCookies(platform) {
  try {
    const file = getCookieFile(platform);
    const stat = await fs.stat(file);
    return stat.size > 50; // 至少有实际内容
  } catch { return false; }
}

// ── Platform detection ──
const PLATFORM_MAP = [
  { test: /youtu\.?be|youtube\.com/i, name: 'YouTube', prefix: 'yt' },
  { test: /douyin\.com/i, name: '抖音', prefix: 'dy' },
  { test: /tiktok\.com/i, name: 'TikTok', prefix: 'tk' },
  { test: /bilibili\.com|b23\.tv/i, name: 'B站', prefix: 'b' },
];

function detectPlatform(url) {
  for (const p of PLATFORM_MAP) {
    if (p.test.test(url)) return { name: p.name, prefix: p.prefix };
  }
  return { name: '未知', prefix: 'dl' };
}

// ── URL parsing ──
const URL_RE = /https?:\/\/[^\s，,）)\]】"'<>]+/gi;

function parseUrls(text) {
  const raw = String(text || '');
  const matches = raw.match(URL_RE) || [];
  const urls = [];
  const seen = new Set();
  for (const m of matches) {
    // 清理尾部标点
    const cleaned = m.replace(/[.,;:!?]+$/, '');
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      urls.push(cleaned);
    }
  }
  return urls;
}

// ── Filename generation ──
function pad(n, len = 2) { return String(n).padStart(len, '0'); }
let _seq = 0;
function generateFilename(prefix) {
  const now = new Date();
  const md = `${now.getMonth() + 1}${now.getDate()}`;
  const ts = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ms = pad(now.getMilliseconds(), 3);
  return `${prefix}_${md}_${ts}${ms}`;
}

// ── ffmpeg resolution ──
function resolveFfmpegDir() {
  const fsSync = require('node:fs');
  const { getManagedBinDir } = require('./dependencyManager');
  const managedBin = getManagedBinDir();
  const candidates = process.platform === 'win32'
    ? [managedBin, path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin')]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const dir of candidates) {
    const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    if (fsSync.existsSync(path.join(dir, name))) return dir;
  }
  return '';
}

// ── Progress parsing ──
const PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)/;
const MERGE_RE = /\[Merger\]|Merging formats|合并/i;

function parseProgress(line) {
  const m = line.match(PROGRESS_RE);
  if (!m) return null;
  return {
    progress: parseFloat(m[1]),
    totalSize: m[2],
    speed: m[3]
  };
}

class DownloadManager {
  constructor({ maxConcurrent = 3, outputBaseDir, onTaskUpdate, log } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.outputBaseDir = outputBaseDir || path.join(os.homedir(), 'Desktop', '视频');
    this.downloadDir = path.join(this.outputBaseDir, '视频下载');
    this.onTaskUpdate = onTaskUpdate || (() => {});
    this.log = log || (() => {});
    this.tasks = new Map();
    this.processes = new Map();
    this._stateFile = path.join(os.homedir(), 'AntBot', 'download-tasks.json');
    this._ytDlpPath = null;
    this._idCounter = 0;
  }

  async init() {
    await fs.mkdir(this.downloadDir, { recursive: true });
    await this.loadState();
    await this.cleanupTmpDirs();
    this._ytDlpPath = await this._resolveYtDlp();
  }

  // ── yt-dlp resolution ──
  async _resolveYtDlp() {
    const { resolveDependencyPath } = require('./dependencyManager');
    const resolved = await resolveDependencyPath('yt-dlp');
    if (resolved) return resolved;
    const candidates = [
      path.join(os.homedir(), 'AntBot', 'tools', 'yt-dlp'),
      path.join(os.homedir(), 'AntBot', 'tools', 'yt-dlp.exe'),
      '/opt/homebrew/bin/yt-dlp',
      '/usr/local/bin/yt-dlp',
      'yt-dlp'
    ];
    for (const bin of candidates) {
      try {
        await this._canRun(bin, ['--version']);
        return bin;
      } catch {}
    }
    return null;
  }

  async _canRun(cmd, args) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, PATH: buildRuntimePath(process.env.PATH) };
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
      let output = '';
      child.stdout?.on('data', d => { output += d.toString(); });
      child.stderr?.on('data', d => { output += d.toString(); });
      child.on('close', () => {
        if (output.includes('.') || output.includes('version')) resolve(true);
        else reject(new Error(`no version output: ${output.slice(0, 100)}`));
      });
      child.on('error', reject);
      setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 8000);
    });
  }

  isYtDlpAvailable() { return !!this._ytDlpPath; }

  async _detectBrowser() {
    // 检测有实际 cookie 数据的浏览器
    const home = os.homedir();
    const checks = [
      { name: 'chrome', db: `${home}/Library/Application Support/Google/Chrome/Default/Cookies` },
      { name: 'firefox', db: `${home}/Library/Application Support/Firefox/profiles.ini` },
      { name: 'edge', db: `${home}/Library/Application Support/Microsoft Edge/Default/Cookies` },
      { name: 'brave', db: `${home}/Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies` },
      { name: 'arc', db: `${home}/Library/Application Support/Arc/User Data/Default/Cookies` },
    ];
    for (const b of checks) {
      try {
        await fs.access(b.db);
        this.log(`[下载] 检测到 ${b.name} 浏览器 cookies`);
        return b.name;
      } catch {}
    }
    return '';
  }

  async installYtDlp() {
    const target = path.join(os.homedir(), 'AntBot', 'tools', 'yt-dlp');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载 yt-dlp 失败: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(target, buf);
    await fs.chmod(target, 0o755);
    this._ytDlpPath = target;
    return target;
  }

  // ── Task management ──
  async addTasks(inputText) {
    const urls = parseUrls(inputText);
    if (!urls.length) throw new Error('未识别到有效链接');

    const newTasks = [];
    for (const url of urls) {
      const platform = detectPlatform(url);
      const filename = generateFilename(platform.prefix);
      const task = {
        id: `dl-${Date.now()}-${++this._idCounter}`,
        url, platform: platform.name, prefix: platform.prefix, filename,
        status: 'pending', progress: 0, speed: '', size: '', downloaded: 0,
        outputPath: '', tmpDir: path.join(this.downloadDir, `.tmp_${filename}`),
        error: '', retries: 0,
        createdAt: new Date().toISOString(), completedAt: null
      };
      this.tasks.set(task.id, task);
      newTasks.push(task);
    }

    if (!newTasks.length) throw new Error('未识别到有效链接');
    await this.saveState();
    for (const t of newTasks) this.onTaskUpdate(this._serialize(t));
    this._tick();
    return { tasks: newTasks.map(t => this._serialize(t)) };
  }

  async cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    // Kill process
    const child = this.processes.get(taskId);
    if (child) { try { child.kill('SIGTERM'); } catch {} this.processes.delete(taskId); }
    task.status = 'cancelled';
    task.error = '';
    await this._cleanupTmp(task);
    this.onTaskUpdate(this._serialize(task));
    await this.saveState();
  }

  async retryTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'failed') return;
    task.status = 'pending';
    task.progress = 0;
    task.speed = '';
    task.error = '';
    task.retries = 0;
    task.tmpDir = path.join(this.downloadDir, `.tmp_${task.filename}`);
    await this.saveState();
    this.onTaskUpdate(this._serialize(task));
    this._tick();
  }

  getTasks() {
    return [...this.tasks.values()].map(t => this._serialize(t));
  }

  // ── Scheduler ──
  _tick() {
    const downloading = [...this.tasks.values()].filter(t => t.status === 'downloading' || t.status === 'merging');
    const slots = this.maxConcurrent - downloading.length;
    if (slots <= 0) return;

    const pending = [...this.tasks.values()].filter(t => t.status === 'pending');
    for (let i = 0; i < Math.min(slots, pending.length); i++) {
      this._runDownload(pending[i]);
    }
  }

  // ── Single download execution ──
  async _runDownload(task) {
    if (!this._ytDlpPath) {
      task.status = 'failed';
      task.error = 'yt-dlp 未安装';
      this.onTaskUpdate(this._serialize(task));
      await this.saveState();
      return;
    }

    task.status = 'downloading';
    task.progress = 0;
    task.error = '';
    await fs.mkdir(task.tmpDir, { recursive: true });
    // 使用固定 .mp4 扩展名，配合 --merge-output-format mp4 确保合并后文件名正确
    const outputTemplate = path.join(task.tmpDir, `${task.filename}.mp4`);

    const ffmpegDir = resolveFfmpegDir();

    // 平台 cookies 处理
    let extraArgs = [];
    const platform = detectPlatform(task.url);

    if (platform.name === '抖音') {
      this.log(`[下载] 获取抖音 cookies...`);
      const cookieFile = await fetchDouyinCookiesPlaywright();
      if (cookieFile) extraArgs.push('--cookies', cookieFile);
    } else if (platform.name === 'YouTube') {
      const cookieFile = getCookieFile('youtube');
      try { await fs.access(cookieFile); extraArgs.push('--cookies', cookieFile); } catch {}
      extraArgs.push('--remote-components', 'ejs:github');
    }

    // YouTube 优先 H.264+AAC（AV1/Opus 很多播放器不兼容），其他平台用默认最高画质
    const formatStr = platform.name === 'YouTube'
      ? 'bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=avc1]+bestaudio/bestvideo+bestaudio/best'
      : 'bestvideo+bestaudio/best';

    const args = [
      '--newline',
      '--continue',
      '-f', formatStr,
      '--merge-output-format', 'mp4',
      ...(ffmpegDir ? ['--ffmpeg-location', ffmpegDir] : []),
      ...extraArgs,
      '--retries', '6',
      '--fragment-retries', '6',
      '--extractor-retries', '6',
      '--retry-sleep', '2',
      '--socket-timeout', '30',
      '--no-warnings',
      '--no-check-certificates',
      '-o', outputTemplate,
      task.url
    ];

    this.onTaskUpdate(this._serialize(task));
    this.log(`[下载] 开始: ${task.filename} (${task.url})`);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        this.log(`[下载] 重试 ${attempt}/${MAX_RETRIES}: ${task.filename}`);
        task.retries = attempt;
      }

      try {
        await this._spawnYtDlp(task, args);
        // Success - find output file
        const outputPath = await this._findOutput(task);
        if (!outputPath) throw new Error('下载完成但未找到输出文件');

        // Verify > 0 bytes and valid mp4
        const stat = await fs.stat(outputPath);
        if (stat.size < 1024) throw new Error('输出文件过小，可能下载不完整');

        // 验证 mp4 文件头 (ftyp atom)
        if (outputPath.endsWith('.mp4')) {
          const head = Buffer.alloc(12);
          const fd = await fs.open(outputPath, 'r');
          try { await fd.read(head, 0, 12, 0); } finally { await fd.close(); }
          const hasFtyp = head.includes(Buffer.from('ftyp'));
          if (!hasFtyp) {
            this.log(`[下载] 警告: 文件头不是 mp4 格式，尝试重新查找输出`);
            // 可能是未合并的分轨文件，尝试查找其他文件
            const altPath = await this._findAnyOutput(task);
            if (altPath && altPath !== outputPath) {
              await fs.unlink(outputPath).catch(() => {});
              task.outputPath = altPath;
            } else {
              throw new Error('视频合并失败，请确认 ffmpeg 已安装');
            }
          } else {
            task.outputPath = outputPath;
          }
        } else {
          task.outputPath = outputPath;
        }
        task.status = 'completed';
        task.progress = 100;
        task.completedAt = new Date().toISOString();
        this.log(`[下载] 完成: ${task.filename} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
        await this._cleanupTmp(task);
        break;

      } catch (err) {
        const msg = String(err?.message || err);
        if (task.status === 'cancelled') return;

        if (attempt >= MAX_RETRIES) {
          task.status = 'failed';
          task.error = this._parseErrorMessage(msg);
          // YouTube 需要 cookies 的特殊提示
          if (/not a bot|Sign in|cookies/i.test(msg) && platform.name === 'YouTube') {
            task.error = '需要登录 YouTube，请在设置中导入 cookies';
          }
          this.log(`[下载] 失败: ${task.filename} - ${task.error}`);
          await this._cleanupTmp(task);
        }
      }
    }

    this.processes.delete(task.id);
    this.onTaskUpdate(this._serialize(task));
    await this.saveState();
    this._tick();
  }

  _spawnYtDlp(task, args) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, PATH: buildRuntimePath(process.env.PATH) };
      const child = spawn(this._ytDlpPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DOWNLOAD_TIMEOUT_MS,
        env,
        windowsHide: true
      });
      this.processes.set(task.id, child);

      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('下载超时')); }, DOWNLOAD_TIMEOUT_MS);

      child.stdout.on('data', d => {
        const lines = d.toString().split('\n');
        for (const line of lines) {
          const p = parseProgress(line);
          if (p) {
            task.progress = Math.min(99.9, p.progress);
            task.speed = p.speed;
            task.size = p.totalSize;
            this.onTaskUpdate(this._serialize(task));
          }
          if (MERGE_RE.test(line)) {
            task.status = 'merging';
            task.progress = 99.9;
            this.onTaskUpdate(this._serialize(task));
          }
        }
      });

      child.stderr.on('data', d => { stderr += d.toString(); });

      child.on('close', code => {
        clearTimeout(timer);
        if (task.status === 'cancelled') return reject(new Error('已取消'));
        if (code !== 0) reject(new Error(stderr || `exit ${code}`));
        else resolve();
      });

      child.on('error', err => { clearTimeout(timer); reject(err); });
    });
  }

  async _findOutput(task) {
    // Wait for final merged file to appear (ffmpeg merge may take a moment)
    const targetName = `${task.filename}.mp4`;
    for (let i = 0; i < 30; i++) {
      try {
        const entries = await fs.readdir(task.tmpDir);
        for (const e of entries) {
          // 只匹配最终合并文件，排除中间分轨文件（.f399.mp4, .f140.m4a 等）
          if (e === targetName && !e.includes('.part')) {
            const fp = path.join(task.tmpDir, e);
            const stat = await fs.stat(fp);
            if (stat.isFile() && stat.size > 0) {
              const finalPath = path.join(this.downloadDir, targetName);
              await fs.rename(fp, finalPath);
              return finalPath;
            }
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  async _findAnyOutput(task) {
    // 查找任何有效的视频文件（mp4/mkv/webm/mov）
    const videoExts = ['.mp4', '.mkv', '.webm', '.mov', '.m4v'];
    try {
      const entries = await fs.readdir(task.tmpDir);
      for (const e of entries) {
        if (videoExts.some(ext => e.endsWith(ext)) && !e.includes('.part')) {
          const fp = path.join(task.tmpDir, e);
          const stat = await fs.stat(fp);
          if (stat.isFile() && stat.size > 1024) {
            const finalPath = path.join(this.downloadDir, `${task.filename}${path.extname(e)}`);
            await fs.rename(fp, finalPath);
            return finalPath;
          }
        }
      }
    } catch {}
    return null;
  }

  async _cleanupTmp(task) {
    try {
      await fs.rm(task.tmpDir, { recursive: true, force: true });
    } catch {}
  }

  async cleanupTmpDirs() {
    try {
      const entries = await fs.readdir(this.downloadDir);
      for (const e of entries) {
        if (e.startsWith('.tmp_')) {
          const full = path.join(this.downloadDir, e);
          const active = [...this.tasks.values()].some(t =>
            t.tmpDir === full && (t.status === 'downloading' || t.status === 'merging')
          );
          if (!active) {
            await fs.rm(full, { recursive: true, force: true });
            this.log(`[清理] 删除孤立临时目录: ${e}`);
          }
        }
      }
    } catch {}
  }

  _parseErrorMessage(msg) {
    if (/Video unavailable|视频不可用|not available/i.test(msg)) return '视频不可用';
    if (/Sign in|登录|age.?restricted/i.test(msg)) return '需要登录或年龄限制';
    if (/Private|私密/i.test(msg)) return '私密视频';
    if (/geo|地区|blocked/i.test(msg)) return '地区限制';
    if (/timeout|超时/i.test(msg)) return '网络超时';
    if (/ENOTFOUND|ECONNREFUSED|网络/i.test(msg)) return '网络错误';
    return msg.slice(0, 200);
  }

  // ── State persistence ──
  async saveState() {
    const data = {};
    for (const [id, t] of this.tasks) data[id] = t;
    try {
      await fs.mkdir(path.dirname(this._stateFile), { recursive: true });
      await fs.writeFile(this._stateFile, JSON.stringify(data, null, 2));
    } catch {}
  }

  async loadState() {
    try {
      const raw = await fs.readFile(this._stateFile, 'utf-8');
      const data = JSON.parse(raw);
      for (const [id, t] of Object.entries(data)) {
        // Reset downloading/merging to failed on restart
        if (t.status === 'downloading' || t.status === 'merging') {
          t.status = 'failed';
          t.error = '应用中断';
        }
        this.tasks.set(id, t);
      }
    } catch {}
  }

  _serialize(t) { return { ...t }; }

  async cleanup() {
    for (const [id, child] of this.processes) {
      try { child.kill('SIGTERM'); } catch {}
    }
    this.processes.clear();
  }
}

module.exports = { DownloadManager, detectPlatform, parseUrls, resolveFfmpegDir };
