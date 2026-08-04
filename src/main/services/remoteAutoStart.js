// 主进程远程自动启动：读取凭证 → autoStart && 有密码 → 启动远程服务 + 隧道。
// 不依赖渲染端执行（headless 模式也能生效）。
const os = require('node:os');

let _started = false;

async function startRemoteAutoStart({ store, taskRunner, mainWindowRef, appLog }) {
  if (_started) return;
  _started = true;
  try {
    const { readCreds, getDeviceId } = require('./remoteCredentials');
    const creds = await readCreds();
    if (!creds.autoStart || !creds.password) return;

    const { startRemoteServer, isServerRunning, getRemotePort } = require('./remoteServer');
    const tunnelManager = require('./tunnelManager');
    const log = (level, msg) => {
      if (typeof appLog === 'function') appLog(level, `[remote] ${msg}`);
      else console.log(`[remote] ${msg}`);
    };

    if (!isServerRunning()) {
      startRemoteServer({ store, taskRunner, mainWindowRef, appLog: log });
      log('info', '自动启动远程控制服务');
    }

    const deviceId = await getDeviceId();
    const deviceName = creds.deviceName || os.hostname();
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
  } catch (e) {
    console.log(`[remote] 自动启动失败: ${e.message}`);
  }
}

module.exports = { startRemoteAutoStart };
