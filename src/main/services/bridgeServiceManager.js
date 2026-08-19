const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const http = require('node:http');
const fs = require('node:fs');

let _appLog = null;

function setLogger(logger) {
  _appLog = logger;
}

function log(level, message) {
  if (_appLog) {
    _appLog(level, message);
  } else {
    console.log(`[BridgeService] ${message}`);
  }
}

const DEFAULT_PORT = 18321;
const PORT_RANGE = 11; // 18321-18331
const PORT_FILE = path.join(os.homedir(), 'AntBot', 'bridge-port.json');
const HEALTH_TIMEOUT_MS = 2000;
const START_TIMEOUT_MS = 30000;
const WATCHDOG_INTERVAL_MS = 10000;

function getPortFilePath() {
  return PORT_FILE;
}

function readStoredPort() {
  try {
    if (!fs.existsSync(PORT_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'));
    const p = Number(data.port);
    if (p >= 1024 && p <= 65535) return p;
  } catch {}
  return null;
}

function writeStoredPort(port) {
  try {
    const dir = path.dirname(PORT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PORT_FILE, JSON.stringify({ port, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch (e) {
    log('error', `[BridgeService] 写入端口文件失败: ${e.message}`);
  }
}

function clearStoredPort() {
  try {
    if (fs.existsSync(PORT_FILE)) fs.unlinkSync(PORT_FILE);
  } catch {}
}

// HTTP 健康探测（比 TCP 更准）
function healthCheck(port, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const data = raw ? JSON.parse(raw) : {};
          // 只要返回 2xx 且 status===ok 即算桥接服务存活
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
          else resolve(false);
        } catch {
          resolve(res.statusCode >= 200 && res.statusCode < 300);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function isBridgeService(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/bridge/status`, { timeout: HEALTH_TIMEOUT_MS }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const data = raw ? JSON.parse(raw) : {};
          if (data && data.ok === true && (data.name === '搬运蚁发布助手' || typeof data.protocolVersion === 'number')) {
            resolve(true);
          } else {
            // 即使没有 name，只要能返回 pending/ready 也视为桥接（兼容旧版）
            resolve(Boolean(data && data.ok && typeof data.status === 'string'));
          }
        } catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function isTcpPortFree(port) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    client.setTimeout(1000);
    client.once('connect', () => { client.destroy(); resolve(false); });
    client.once('error', () => { client.destroy(); resolve(true); });
    client.once('timeout', () => { client.destroy(); resolve(true); });
    client.connect(port, '127.0.0.1');
  });
}

async function findAvailablePort() {
  // 优先已存储端口（App 重启复用）
  const stored = readStoredPort();
  if (stored) {
    const isBridge = await isBridgeService(stored);
    if (isBridge) return stored; // 已有桥接服务，直接复用
    const free = await isTcpPortFree(stored);
    if (free) return stored; // 空闲可用
    // 被非桥接占用，继续扫描
  }
  for (let i = 0; i < PORT_RANGE; i++) {
    const port = DEFAULT_PORT + i;
    if (port === stored) continue;
    const isBridge = await isBridgeService(port);
    if (isBridge) return port;
    const free = await isTcpPortFree(port);
    if (free) return port;
  }
  // 兜底：让系统分配 0 端口（极少见），调用方需处理
  return DEFAULT_PORT;
}

async function waitForBridgeReady(port, timeoutMs = START_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await healthCheck(port, 1500);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function hashFile(filePath) {
  const crypto = require('node:crypto');
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch {
    return '';
  }
}

class BridgeServiceManager {
  constructor() {
    this.process = null;
    this.port = readStoredPort() || DEFAULT_PORT;
    this.maxRetries = 3;
    this.retryDelay = 1000;
    this.logPrefix = '[BridgeService]';
    this._starting = null;
    this._watchdogTimer = null;
    this._intentionalStop = false;
    this._startAttempts = 0;
  }

  getBundledServerDir() {
    if (process.resourcesPath) {
      const packagedPath = path.join(process.resourcesPath, 'publish-extension', 'local-server', 'server.js');
      if (fs.existsSync(packagedPath)) {
        return path.join(process.resourcesPath, 'publish-extension', 'local-server');
      }
    }
    const devPath = path.join(__dirname, '..', '..', '..', 'publish-extension', 'local-server');
    if (fs.existsSync(path.join(devPath, 'server.js'))) {
      return devPath;
    }
    return null;
  }

  getWritableServerDir() {
    return path.join(os.homedir(), 'AntBot', 'local-server');
  }

  getPort() {
    return this.port;
  }

  getBaseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  async ensureWritableServerDir() {
    const crypto = require('node:crypto');
    const writableDir = this.getWritableServerDir();

    const bundledDir = this.getBundledServerDir();
    if (!bundledDir) {
      log('error', `${this.logPrefix} 找不到打包的服务文件`);
      return null;
    }

    const filesToCheck = ['server.js', 'bridgeQueue.js', 'package.json'];
    const needsRefresh = await (async () => {
      try {
        for (const name of filesToCheck) {
          const bundledFile = path.join(bundledDir, name);
          const writableFile = path.join(writableDir, name);
          if (!fs.existsSync(bundledFile)) continue;
          if (!fs.existsSync(writableFile)) return true;
          if (hashFile(bundledFile) !== hashFile(writableFile)) return true;
        }
        // package.json 依赖变化也需刷新
        return false;
      } catch {
        return true;
      }
    })();

    if (needsRefresh) {
      log('info', `${this.logPrefix} 检测到服务文件更新，重新复制到可写目录...`);
      try {
        // Windows 下如果进程正在运行，cp 可能 EBUSY，先确保停止
        await fs.promises.rm(writableDir, { recursive: true, force: true }).catch(() => {});
        await fs.promises.mkdir(writableDir, { recursive: true });
        await fs.promises.cp(bundledDir, writableDir, { recursive: true });
      } catch (e) {
        log('error', `${this.logPrefix} 复制服务文件失败: ${e.message}`);
        // 尝试继续，已有目录可能仍可用
        if (!fs.existsSync(path.join(writableDir, 'server.js'))) return null;
      }
    }

    return writableDir;
  }

  _isProcessAlive() {
    if (!this.process || !this.process.pid) return false;
    if (this.process.killed) return false;
    if (this.process.exitCode !== null) return false;
    try {
      // 0 信号仅检测存在性，不杀进程
      process.kill(this.process.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async _isBridgeHealthy() {
    return healthCheck(this.port, 1500);
  }

  // 启动看门狗：每 10s 检查一次，崩溃自动拉起
  startWatchdog() {
    if (this._watchdogTimer) return;
    this._watchdogTimer = setInterval(async () => {
      if (this._intentionalStop) return;
      if (this._starting) return; // 正在启动中
      const alive = this._isProcessAlive();
      const healthy = await this._isBridgeHealthy().catch(() => false);
      if (!alive || !healthy) {
        // 如果是外部桥接（用户手动启动），alive===false 但 healthy===true 则不拉起
        if (!alive && healthy) {
          // 外部服务正常，无需处理
          return;
        }
        if (this.process && !alive) {
          log('info', `${this.logPrefix} 检测到进程已退出，尝试自动恢复...`);
          this.process = null;
        } else if (!healthy && alive) {
          log('info', `${this.logPrefix} 健康检查失败，尝试重启...`);
          this.stop();
          await new Promise((r) => setTimeout(r, 1000));
        } else if (!healthy && !alive) {
          log('info', `${this.logPrefix} 服务离线，尝试自动恢复...`);
          this.process = null;
        } else {
          return;
        }
        // 延迟重启，避免频繁抖动
        if (this._startAttempts < 5) {
          this._startAttempts += 1;
          this.start().catch(() => {});
          setTimeout(() => { this._startAttempts = Math.max(0, this._startAttempts - 1); }, 60000);
        }
      }
    }, WATCHDOG_INTERVAL_MS);
    // 不阻止进程退出
    if (this._watchdogTimer.unref) this._watchdogTimer.unref();
  }

  stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  async start() {
    // 并发启动合并
    if (this._starting) return this._starting;
    this._starting = (async () => {
      this._intentionalStop = false;
      // 若已有进程且健康，直接返回
      if (this._isProcessAlive()) {
        const healthy = await this._isBridgeHealthy();
        if (healthy) {
          log('info', `${this.logPrefix} 服务已在运行 (pid=${this.process.pid}, port=${this.port})`);
          return true;
        }
        // 进程活但不健康，重启
        log('info', `${this.logPrefix} 进程存活但健康检查失败，重启...`);
        this.stop();
        await new Promise((r) => setTimeout(r, 800));
      } else if (this.process) {
        // 僵尸引用清理
        this.process = null;
      }

      // 若已有外部桥接在运行，直接复用端口
      // 尝试读取存储端口或扫描
      let chosenPort = this.port;
      // 先检查当前端口是否有健康桥接
      const currentHealthy = await healthCheck(chosenPort, 1200);
      const currentIsBridge = currentHealthy ? true : await isBridgeService(chosenPort);
      if (currentHealthy || currentIsBridge) {
        log('info', `${this.logPrefix} 检测到外部桥接服务在端口 ${chosenPort} 运行，直接复用`);
        writeStoredPort(chosenPort);
        this.startWatchdog();
        return true;
      }
      // 否则寻找可用端口
      chosenPort = await findAvailablePort();
      this.port = chosenPort;
      writeStoredPort(chosenPort);
      log('info', `${this.logPrefix} 选中端口 ${chosenPort}`);

      const localServerDir = await this.ensureWritableServerDir();
      if (!localServerDir) {
        log('error', `${this.logPrefix} 无法准备服务目录`);
        return false;
      }
      const serverPath = path.join(localServerDir, 'server.js');

      if (!fs.existsSync(serverPath)) {
        log('error', `${this.logPrefix} 服务文件不存在: ${serverPath}`);
        return false;
      }

      // 检查并安装依赖（更稳健：检查 node_modules/xxx 完整性）
      const nodeModulesPath = path.join(localServerDir, 'node_modules');
      const needInstall = (() => {
        if (!fs.existsSync(nodeModulesPath)) return true;
        // 检查关键依赖是否存在
        const required = ['express', 'cors'];
        for (const dep of required) {
          if (!fs.existsSync(path.join(nodeModulesPath, dep))) return true;
        }
        return false;
      })();

      if (needInstall) {
        log('info', `${this.logPrefix} 正在安装依赖...`);
        try {
          const { buildNpmInvocation } = require('./dependencyManager');
          const invocation = await buildNpmInvocation();
          if (!invocation) {
            throw new Error('未找到可用的 npm，无法安装桥接服务依赖');
          }
          await new Promise((resolve, reject) => {
            const child = spawn(invocation.command, [...invocation.args, 'install', '--production'], {
              cwd: localServerDir,
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
              shell: invocation.shell === true,
            });
            let stderrBuf = '';
            child.stderr?.on('data', (d) => {
              const s = d.toString().trim();
              if (s) {
                stderrBuf += s + '\n';
                log('info', `${this.logPrefix} ${s}`);
              }
            });
            child.stdout?.on('data', (d) => {
              const s = d.toString().trim();
              if (s) log('info', `${this.logPrefix} ${s}`);
            });
            const timer = setTimeout(() => {
              try { child.kill('SIGKILL'); } catch {}
              reject(new Error('依赖安装超时（60s）'));
            }, 60000);
            child.once('close', (code) => {
              clearTimeout(timer);
              if (code === 0) resolve();
              else reject(new Error(`依赖安装失败（退出码 ${code}）${stderrBuf.slice(0, 500)}`));
            });
            child.once('error', (e) => { clearTimeout(timer); reject(e); });
          });
          log('info', `${this.logPrefix} 依赖安装完成`);
        } catch (error) {
          log('error', `${this.logPrefix} 依赖安装失败:`, error.message);
          return false;
        }
      }

      // 指数退避重试启动
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { resolveDependencyPath } = require('./dependencyManager');
          const nodeBin = (await resolveDependencyPath('node')) || 'node';
          // 若端口在重试期间被抢，重新选口
          if (attempt > 0) {
            const freshPort = await findAvailablePort();
            if (freshPort !== this.port) {
              this.port = freshPort;
              writeStoredPort(freshPort);
              log('info', `${this.logPrefix} 重试选用新端口 ${freshPort}`);
            }
          }

          this.process = spawn(nodeBin, [serverPath], {
            cwd: localServerDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              PORT: String(this.port),
            },
            detached: false,
            windowsHide: true,
          });

          this.process.stdout?.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) log('info', `${this.logPrefix} ${msg}`);
          });

          this.process.stderr?.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) log('error', `${this.logPrefix} ${msg}`);
          });

          this.process.on('error', (error) => {
            log('error', `${this.logPrefix} 启动失败:`, error.message);
            this.process = null;
          });

          this.process.on('exit', (code, signal) => {
            log('info', `${this.logPrefix} 进程退出 (code=${code}, signal=${signal})`);
            // 只有非主动停止才清空，主动 stop 已置 null
            if (this.process && this.process.exitCode !== null) {
              this.process = null;
            }
          });

          const started = await waitForBridgeReady(this.port, START_TIMEOUT_MS);
          if (started) {
            log('info', `${this.logPrefix} 服务启动成功，端口: ${this.port}, pid: ${this.process?.pid}`);
            this.startWatchdog();
            return true;
          }
          log('error', `${this.logPrefix} 服务启动超时 (尝试 ${attempt + 1}/3)`);
          try { this.process?.kill('SIGTERM'); } catch {}
          await new Promise((r) => setTimeout(r, 1500));
          try { if (this.process && !this.process.killed) this.process.kill('SIGKILL'); } catch {}
          this.process = null;
          // 退避
          if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        } catch (error) {
          log('error', `${this.logPrefix} 启动异常 (尝试 ${attempt + 1}/3):`, error.message);
          this.process = null;
          if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
      return false;
    })();
    try {
      return await this._starting;
    } finally {
      this._starting = null;
    }
  }

  stop() {
    this._intentionalStop = true;
    this.stopWatchdog();
    if (!this.process) {
      // 即使无内部进程，也尝试清理健康但非内部的外部桥接？不再误杀，仅清理端口文件由下次启动复用
      // 不主动 kill 外部占用端口的进程，避免误杀用户其他服务
      log('info', `${this.logPrefix} 无内部进程，标记为已停止`);
      return;
    }
    log('info', `${this.logPrefix} 正在停止服务 (pid=${this.process.pid}, port=${this.port})...`);
    try {
      const proc = this.process;
      this.process = null;
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try {
          if (proc && !proc.killed && proc.exitCode === null) {
            proc.kill('SIGKILL');
          }
        } catch {}
      }, 3000);
    } catch (error) {
      log('error', `${this.logPrefix} 停止失败:`, error.message);
      this.process = null;
    }
  }

  isRunning() {
    if (this._isProcessAlive()) return true;
    // 外部桥接也算运行（健康即运行）
    // 同步探活太慢，这里仅看进程；健康由 getStatus 异步判断
    return false;
  }

  // 同步状态（供 UI 快速显示），异步健康由调用方 healthCheck 决定
  getStatus() {
    return {
      running: this._isProcessAlive(),
      port: this.port,
      pid: this.process?.pid || null,
      baseUrl: this.getBaseUrl(),
    };
  }

  // 异步精准状态：检查健康
  async getDetailedStatus() {
    const alive = this._isProcessAlive();
    const healthy = await healthCheck(this.port, 1200);
    const isBridge = healthy ? true : await isBridgeService(this.port);
    return {
      running: alive || healthy || isBridge,
      port: this.port,
      pid: this.process?.pid || null,
      baseUrl: this.getBaseUrl(),
      healthy,
      isBridge,
    };
  }

  async ensureRunning() {
    const healthy = await healthCheck(this.port, 1500);
    if (healthy) return true;
    return this.start();
  }
}

const bridgeServiceManager = new BridgeServiceManager();

module.exports = {
  bridgeServiceManager,
  BridgeServiceManager,
  setLogger,
  getPortFilePath,
  readStoredPort,
  writeStoredPort,
  healthCheck,
  isBridgeService,
  findAvailablePort,
  DEFAULT_PORT,
  PORT_RANGE,
};
