const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let _tunnelProcess = null;
let _tunnelUrl = null;
let _onUrlChange = null;
let _onStatusChange = null;
let _log = null;

function findCloudflared() {
  const candidates = [
    path.join(os.homedir(), 'AntBot', 'tools', 'cloudflared'),
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    'cloudflared'
  ];
  for (const bin of candidates) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {}
  }
  return null;
}

function startTunnel(port, { onUrl, onStatus, log } = {}) {
  return new Promise((resolve, reject) => {
    if (_tunnelProcess) {
      return resolve({ url: _tunnelUrl, alreadyRunning: true });
    }

    _onUrlChange = onUrl || (() => {});
    _onStatusChange = onStatus || (() => {});
    _log = log || (() => {});

    const cloudflared = findCloudflared();
    if (!cloudflared) {
      return reject(new Error('cloudflared 未安装。请运行: brew install cloudflared'));
    }

    _log('info', `启动 Cloudflare Tunnel (端口 ${port})...`);
    _onStatusChange({ status: 'starting' });

    _tunnelProcess = spawn(cloudflared, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let resolved = false;

    _tunnelProcess.stderr?.on('data', (data) => {
      const text = data.toString();
      // Parse tunnel URL from stderr
      const urlMatch = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !_tunnelUrl) {
        _tunnelUrl = urlMatch[0];
        _log('info', `Tunnel URL: ${_tunnelUrl}`);
        _onUrlChange(_tunnelUrl);
        _onStatusChange({ status: 'running', url: _tunnelUrl });
        if (!resolved) {
          resolved = true;
          resolve({ url: _tunnelUrl });
        }
      }

      // Log important messages
      if (text.includes('ERR') || text.includes('error') || text.includes('failed')) {
        _log('error', `cloudflared: ${text.trim()}`);
      }
    });

    _tunnelProcess.stdout?.on('data', (data) => {
      const text = data.toString();
      const urlMatch = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !_tunnelUrl) {
        _tunnelUrl = urlMatch[0];
        _log('info', `Tunnel URL: ${_tunnelUrl}`);
        _onUrlChange(_tunnelUrl);
        _onStatusChange({ status: 'running', url: _tunnelUrl });
        if (!resolved) {
          resolved = true;
          resolve({ url: _tunnelUrl });
        }
      }
    });

    _tunnelProcess.on('close', (code) => {
      _log('info', `cloudflared 进程退出 (code=${code})`);
      _tunnelProcess = null;
      _tunnelUrl = null;
      _onStatusChange({ status: 'stopped' });
      _onUrlChange(null);
    });

    _tunnelProcess.on('error', (err) => {
      _log('error', `cloudflared 启动失败: ${err.message}`);
      _tunnelProcess = null;
      _onStatusChange({ status: 'error', error: err.message });
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    // Timeout: if no URL after 30 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Tunnel 启动超时，请检查网络连接'));
      }
    }, 30000);
  });
}

function stopTunnel() {
  if (_tunnelProcess) {
    _log('info', '停止 Cloudflare Tunnel');
    _tunnelProcess.kill('SIGTERM');
    _tunnelProcess = null;
    _tunnelUrl = null;
    _onStatusChange?.({ status: 'stopped' });
    _onUrlChange?.(null);
  }
}

function getTunnelUrl() {
  return _tunnelUrl;
}

function isRunning() {
  return _tunnelProcess !== null;
}

function getStatus() {
  return {
    running: isRunning(),
    url: _tunnelUrl,
  };
}

module.exports = {
  startTunnel,
  stopTunnel,
  getTunnelUrl,
  isRunning,
  getStatus,
  findCloudflared,
};
