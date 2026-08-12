// 主进程远程自动启动：读取凭证 → autoStart && 有密码 → 启动远程服务 + 隧道。
// 不依赖渲染端执行（headless 模式也能生效）。
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

let _started = false;

// 写入 app 日志文件（与 ipc.js 的 appLog 同一目录）
function writeAppLog(level, msg) {
  try {
    const logDir = path.join(os.homedir(), 'AntBot', 'logs');
    const files = fs.readdirSync(logDir).filter(f => f.startsWith('app-') && f.endsWith('.log'));
    if (files.length) {
      const latest = files.sort().pop();
      fs.appendFileSync(path.join(logDir, latest), `[${new Date().toISOString()}] [${level}] ${msg}\n`);
    }
  } catch {}
  if (level === 'error') console.error(`[${level}] ${msg}`);
  else console.log(`[${level}] ${msg}`);
}

const MAX_AUTOSTART_ATTEMPTS = 3;
const AUTOSTART_RETRY_DELAY_MS = 20_000; // 首次失败后每 20 秒重试

async function startRemoteAutoStart({ store, taskRunner, mainWindowRef, appLog }) {
  if (_started) return;
  _started = true;
  // appLog 负责写日志文件（index.js 传入）；不可用时回退到本地写文件
  const log = (level, msg) => {
    try {
      if (typeof appLog === 'function') appLog(level, `[remote] ${msg}`);
      else writeAppLog(level, `[remote] ${msg}`);
    } catch { writeAppLog(level, `[remote] ${msg}`); }
  };

  let creds = null;
  try {
    const { readCreds } = require('./remoteCredentials');
    creds = await readCreds();
  } catch (e) {
    log('error', `读取凭证失败: ${e.message}`);
    return;
  }
  if (!creds.autoStart || !creds.password) {
    log('info', '跳过自动启动（autoStart 未开启或无密码）');
    return;
  }

  const { startRemoteServer, isServerRunning, getRemotePort } = require('./remoteServer');
  const tunnelManager = require('./tunnelManager');
  const { getDeviceId } = require('./remoteCredentials');

  if (!isServerRunning()) {
    // remoteServer 内部日志已带 [remote] 前缀，这里直接用裸 log 避免双前缀
    startRemoteServer({ store, taskRunner, mainWindowRef, appLog: (lvl, msg) => log(lvl, msg.replace(/^\[remote\]\s*/, '')) });
    log('info', '自动启动远程控制服务');
  }

  const deviceId = await getDeviceId();
  const deviceName = creds.deviceName || os.hostname();

  // 隧道启动可能较慢（fake-ip/代理环境 cloudflared 需要更长时间建立连接），失败后重试
  for (let attempt = 1; attempt <= MAX_AUTOSTART_ATTEMPTS; attempt++) {
    try {
      const result = await tunnelManager.startTunnel(getRemotePort(), {
        onUrl: (url) => {
          const win = mainWindowRef();
          if (win && !win.isDestroyed()) win.webContents.send('remote:tunnel-url', url);
        },
        onStatus: (status) => {
          const win = mainWindowRef();
          if (win && !win.isDestroyed()) win.webContents.send('remote:tunnel-status', status);
        },
        log,
        deviceId,
        deviceName,
      });
      if (result.url) log('info', `自动启动隧道成功: ${result.url}`);
      return;
    } catch (e) {
      log('error', `自动启动隧道失败（第 ${attempt}/${MAX_AUTOSTART_ATTEMPTS} 次）: ${e.message}`);
      if (attempt < MAX_AUTOSTART_ATTEMPTS) {
        await new Promise(r => setTimeout(r, AUTOSTART_RETRY_DELAY_MS));
      }
    }
  }
}

module.exports = { startRemoteAutoStart };
