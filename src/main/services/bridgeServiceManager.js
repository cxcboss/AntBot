const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');

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

class BridgeServiceManager {
  constructor() {
    this.process = null;
    this.port = 18321;
    this.maxRetries = 3;
    this.retryDelay = 1000;
    this.logPrefix = '[BridgeService]';
  }

  async isPortAvailable(port) {
    return new Promise((resolve) => {
      const client = new net.Socket();
      client.setTimeout(1000);
      client.once('connect', () => {
        client.destroy();
        resolve(false); // 端口被占用
      });
      client.once('error', (err) => {
        client.destroy();
        resolve(true); // 端口可用
      });
      client.once('timeout', () => {
        client.destroy();
        resolve(true); // 端口可用（超时通常意味着没有服务监听）
      });
      client.connect(port, '127.0.0.1');
    });
  }

  async waitForPortReady(port, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const available = await this.isPortAvailable(port);
      if (!available) {
        // 端口被占用，说明服务已启动
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return false;
  }

  getBundledServerDir() {
    const fs = require('node:fs');
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

  async ensureWritableServerDir() {
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    const writableDir = this.getWritableServerDir();
    const serverJs = path.join(writableDir, 'server.js');

    const bundledDir = this.getBundledServerDir();
    if (!bundledDir) {
      log('error', `${this.logPrefix} 找不到打包的服务文件`);
      return null;
    }

    // 比较 bundled 与可写目录 server.js 的 hash：
    // 若 bundled 更新（App 升级后服务代码变更），则重新复制，避免旧副本带旧 bug/旧安全配置
    const bundledServerJs = path.join(bundledDir, 'server.js');
    const needsRefresh = await (async () => {
      try {
        if (!fs.existsSync(serverJs)) return true;
        const hash = (p) => {
          const data = fs.readFileSync(p);
          return crypto.createHash('sha256').update(data).digest('hex');
        };
        return hash(bundledServerJs) !== hash(serverJs);
      } catch {
        return true;
      }
    })();

    if (needsRefresh) {
      log('info', `${this.logPrefix} 检测到服务文件更新，重新复制到可写目录...`);
      await fs.promises.rm(writableDir, { recursive: true, force: true }).catch(() => {});
      await fs.promises.mkdir(writableDir, { recursive: true });
      await fs.promises.cp(bundledDir, writableDir, { recursive: true });
    }

    return writableDir;
  }

  async start() {
    // 清理已退出的进程引用
    if (this.process && this.process.pid && this.process.killed) {
      this.process = null;
    }
    if (this.process) {
      // 验证进程是否真的在运行
      if (this.process.isExternal) {
        const stillRunning = !(await this.isPortAvailable(this.port));
        if (!stillRunning) {
          this.process = null;
        }
      }
    }
    if (this.process) {
      log('info', `${this.logPrefix} 服务已在运行`);
      return true;
    }

    const localServerDir = await this.ensureWritableServerDir();
    if (!localServerDir) {
      log('error', `${this.logPrefix} 无法准备服务目录`);
      return false;
    }
    const serverPath = path.join(localServerDir, 'server.js');
    const fs = require('node:fs');

    if (!fs.existsSync(serverPath)) {
      log('error', `${this.logPrefix} 服务文件不存在: ${serverPath}`);
      return false;
    }

    // 检查并安装依赖
    const nodeModulesPath = path.join(localServerDir, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
      log('info', `${this.logPrefix} 正在安装依赖...`);
      try {
        const { resolveDependencyPath } = require('./dependencyManager');
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
            shell: invocation.shell === true
          });
          child.stderr?.on('data', d => { if (d.toString().trim()) log('info', `${this.logPrefix} ${d.toString().trim()}`); });
          child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`依赖安装失败（退出码 ${code}）`)));
          child.once('error', reject);
        });
        log('info', `${this.logPrefix} 依赖安装完成`);
      } catch (error) {
        log('error', `${this.logPrefix} 依赖安装失败:`, error.message);
        return false;
      }
    }

    const isAvailable = await this.isPortAvailable(this.port);
    if (!isAvailable) {
      log('info', `${this.logPrefix} 端口 ${this.port} 已被占用，可能服务已在运行`);
      // 设置一个虚拟的进程对象，表示服务在运行
      this.process = { killed: false, pid: null, isExternal: true };
      return true;
    }

    try {
      const { resolveDependencyPath } = require('./dependencyManager');
      const nodeBin = await resolveDependencyPath('node') || 'node';
      this.process = spawn(nodeBin, [serverPath], {
        cwd: localServerDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PORT: String(this.port)
        },
        detached: false,
        windowsHide: true
      });

      this.process.stdout?.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
          log('info', `${this.logPrefix} ${msg}`);
        }
      });

      this.process.stderr?.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
          log('error', `${this.logPrefix} ${msg}`);
        }
      });

      this.process.on('error', (error) => {
        log('error', `${this.logPrefix} 启动失败:`, error.message);
        this.process = null;
      });

      this.process.on('exit', (code, signal) => {
        log('info', `${this.logPrefix} 进程退出 (code=${code}, signal=${signal})`);
        this.process = null;
      });

      const started = await this.waitForPortReady(this.port, 5000);
      if (started) {
        log('info', `${this.logPrefix} 服务启动成功，端口: ${this.port}`);
        return true;
      } else {
        log('error', `${this.logPrefix} 服务启动超时`);
        this.stop();
        return false;
      }
    } catch (error) {
      log('error', `${this.logPrefix} 启动异常:`, error.message);
      this.process = null;
      return false;
    }
  }

  stop() {
    if (this.process) {
      log('info', `${this.logPrefix} 正在停止服务...`);

      // 如果是外部进程（端口被占用时设置的虚拟对象），尝试杀死占用端口的进程
      if (this.process.isExternal) {
        log('info', `${this.logPrefix} 检测到外部进程占用端口，尝试停止...`);
        try {
          const { execSync } = require('node:child_process');
          let pids = [];
          if (process.platform === 'win32') {
            const result = execSync(`netstat -ano -p tcp | findstr :${this.port}`, { encoding: 'utf8', shell: 'cmd.exe', windowsHide: true }).trim();
            for (const line of result.split('\n')) {
              const parts = line.trim().split(/\s+/);
              const pid = parts[parts.length - 1];
              if (pid && pid !== '0') pids.push(pid);
            }
          } else {
            const result = execSync(`lsof -ti :${this.port}`, { encoding: 'utf8' }).trim();
            if (result) pids = result.split('\n');
          }
          for (const pid of pids) {
            try {
              process.kill(parseInt(pid), 'SIGTERM');
              log('info', `${this.logPrefix} 已发送终止信号到进程 ${pid}`);
            } catch (e) {
              // 忽略权限错误
            }
          }
        } catch (e) {
          log('error', `${this.logPrefix} 停止外部进程失败:`, e.message);
        }
        this.process = null;
        return;
      }

      // 如果是内部启动的进程
      try {
        const proc = this.process;
        this.process = null;
        proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (proc && !proc.killed) {
              proc.kill('SIGKILL');
            }
          } catch (e) {
            // 忽略
          }
        }, 3000);
      } catch (error) {
        log('error', `${this.logPrefix} 停止失败:`, error.message);
        this.process = null;
      }
    }
  }

  isRunning() {
    return this.process !== null && !this.process.killed;
  }

  getStatus() {
    return {
      running: this.isRunning(),
      port: this.port,
      pid: this.process?.pid || null
    };
  }
}

const bridgeServiceManager = new BridgeServiceManager();

module.exports = { bridgeServiceManager, BridgeServiceManager, setLogger };
