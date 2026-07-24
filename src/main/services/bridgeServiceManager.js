const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

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

  getServerPath() {
    const fs = require('node:fs');

    // 打包后的路径（extraResources）
    if (process.resourcesPath) {
      const packagedPath = path.join(process.resourcesPath, 'publish-extension', 'local-server', 'server.js');
      if (fs.existsSync(packagedPath)) {
        return packagedPath;
      }
    }

    // 开发环境路径（项目根目录）
    const devPath = path.join(__dirname, '..', '..', '..', 'publish-extension', 'local-server', 'server.js');
    if (fs.existsSync(devPath)) {
      return devPath;
    }

    // 备用路径
    const altPath = path.join(process.cwd(), 'publish-extension', 'local-server', 'server.js');
    if (fs.existsSync(altPath)) {
      return altPath;
    }

    return devPath; // 返回默认路径，让后续错误处理
  }

  getLocalServerDir() {
    const serverPath = this.getServerPath();
    return path.dirname(serverPath);
  }

  async start() {
    if (this.process) {
      log('info', `${this.logPrefix} 服务已在运行`);
      return true;
    }

    const serverPath = this.getServerPath();
    const localServerDir = this.getLocalServerDir();
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
        const { execSync } = require('node:child_process');
        execSync('npm install --production', { cwd: localServerDir, stdio: 'inherit' });
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
      this.process = spawn('node', [serverPath], {
        cwd: localServerDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PORT: String(this.port)
        },
        detached: false
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
          const result = execSync(`lsof -ti :${this.port}`, { encoding: 'utf8' }).trim();
          if (result) {
            const pids = result.split('\n');
            for (const pid of pids) {
              try {
                process.kill(parseInt(pid), 'SIGTERM');
                log('info', `${this.logPrefix} 已发送终止信号到进程 ${pid}`);
              } catch (e) {
                // 忽略权限错误
              }
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
