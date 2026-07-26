const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let _tunnelProcess = null;
let _tunnelUrl = null;
let _onUrlChange = null;
let _onStatusChange = null;
let _log = null;

const TUNNEL_ID = '843f2a80-cd75-4724-a9ce-2f6964227d2b';
const TUNNEL_DOMAIN = 'remote.onebugmanai.online';
const CONFIG_PATH = path.join(os.homedir(), '.cloudflared', 'config.yml');

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

const HUB_URL = 'https://remote.onebugmanai.online';

async function registerWithHub(username, password, tunnelUrl) {
  try {
    const res = await fetch(`${HUB_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, tunnelUrl })
    });
    const data = await res.json();
    return data;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function startTunnel(port, { onUrl, onStatus, log, username, password } = {}) {
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

    // 检查是否有命名隧道配置
    const hasConfig = fs.existsSync(CONFIG_PATH);
    const useNamed = hasConfig && fs.readFileSync(CONFIG_PATH, 'utf-8').includes(TUNNEL_ID);

    _log('info', `启动 Cloudflare Tunnel (端口 ${port})...`);
    _onStatusChange({ status: 'starting' });

    let args;
    if (useNamed) {
      // 使用命名隧道（稳定域名）
      args = ['tunnel', '--config', CONFIG_PATH, 'run', TUNNEL_ID];
      _tunnelUrl = `https://${TUNNEL_DOMAIN}`;
      _log('info', `使用命名隧道: ${_tunnelUrl}`);
    } else {
      // 回退到 Quick Tunnel
      args = ['tunnel', '--url', `http://127.0.0.1:${port}`];
    }

    _tunnelProcess = spawn(cloudflared, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let resolved = false;

    const parseOutput = (data) => {
      const text = data.toString();
      // Quick Tunnel URL 解析
      const urlMatch = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !_tunnelUrl) {
        _tunnelUrl = urlMatch[0];
      }
      if (text.includes('ERR') || text.includes('error') || text.includes('failed')) {
        _log('error', `cloudflared: ${text.trim()}`);
      }
      // 命名隧道连接成功
      if (text.includes('Connection established') || text.includes('Registered tunnel connection')) {
        if (!resolved) {
          resolved = true;
          _onUrlChange(_tunnelUrl);
          _onStatusChange({ status: 'running', url: _tunnelUrl });
          resolve({ url: _tunnelUrl });
        }
      }
    };

    _tunnelProcess.stderr?.on('data', parseOutput);
    _tunnelProcess.stdout?.on('data', parseOutput);

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
      if (!resolved) { resolved = true; reject(err); }
    });

    // 命名隧道立即解析并注册到 Hub
    if (useNamed) {
      setTimeout(async () => {
        if (!resolved) {
          resolved = true;
          _onUrlChange(_tunnelUrl);
          _onStatusChange({ status: 'running', url: _tunnelUrl });
          // 注册到 Hub 中心
          if (username && password) {
            const regResult = await registerWithHub(username, password, _tunnelUrl);
            if (regResult.ok) _log('info', '已注册到远程控制中心');
            else _log('error', '注册到 Hub 失败: ' + (regResult.error || '未知错误'));
          }
          resolve({ url: _tunnelUrl });
        }
      }, 3000);
    }

    // Quick Tunnel 超时
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Tunnel 启动超时'));
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

function getTunnelUrl() { return _tunnelUrl || `https://${TUNNEL_DOMAIN}`; }
function isRunning() { return _tunnelProcess !== null; }
function getStatus() { return { running: isRunning(), url: getTunnelUrl() }; }

module.exports = { startTunnel, stopTunnel, getTunnelUrl, isRunning, getStatus, findCloudflared };
