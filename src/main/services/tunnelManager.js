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

const HUB_URL = 'https://hub.onebugmanai.online';
const CF_API = 'https://api.cloudflare.com/client/v4';
const DOMAIN = 'onebugmanai.online';

async function registerWithHub(username, password, tunnelUrl) {
  try {
    const res = await fetch(`${HUB_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, tunnelUrl })
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 自动创建命名隧道 + DNS + 配置
async function setupNamedTunnel(cfToken, port) {
  const log = _log || (() => {});
  const cloudflared = findCloudflared();
  if (!cloudflared) throw new Error('cloudflared 未安装');

  // 1. 获取账户 ID
  log('info', '获取 Cloudflare 账户信息...');
  const accountsRes = await fetch(`${CF_API}/accounts`, {
    headers: { 'Authorization': `Bearer ${cfToken}` }
  });
  const accounts = await accountsRes.json();
  if (!accounts.success || !accounts.result?.length) throw new Error('无法获取账户信息，请检查 API Token');
  const accountId = accounts.result[0].id;

  // 2. 获取域名区域 ID
  log('info', '获取域名区域...');
  const zonesRes = await fetch(`${CF_API}/zones?name=${DOMAIN}`, {
    headers: { 'Authorization': `Bearer ${cfToken}` }
  });
  const zones = await zonesRes.json();
  if (!zones.success || !zones.result?.length) throw new Error('无法获取域名区域');
  const zoneId = zones.result[0].id;

  // 3. 生成唯一子域名
  const hostname = os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'pc';
  const subdomain = `${hostname}-${Date.now().toString(36).slice(-4)}`;
  const fqdn = `${subdomain}.${DOMAIN}`;

  // 4. 创建命名隧道
  log('info', `创建隧道 ${subdomain}...`);
  const tunnelRes = await fetch(`${CF_API}/accounts/${accountId}/cfd_tunnel`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `antbot-${subdomain}` })
  });
  const tunnel = await tunnelRes.json();
  if (!tunnel.success) throw new Error('创建隧道失败: ' + JSON.stringify(tunnel.errors));
  const tunnelId = tunnel.result.id;
  const tunnelToken = tunnel.result.token;

  // 5. 创建 DNS CNAME 记录
  log('info', `创建 DNS 记录 ${fqdn}...`);
  await fetch(`${CF_API}/zones/${zoneId}/dns_records`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'CNAME',
      name: subdomain,
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true
    })
  });

  // 6. 配置隧道路由
  log('info', '配置隧道路由...');
  await fetch(`${CF_API}/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: {
        ingress: [
          { hostname: fqdn, service: `http://localhost:${port}` },
          { service: 'http_status:404' }
        ]
      }
    })
  });

  // 7. 保存凭证和配置到本地
  const credsPath = path.join(os.homedir(), '.cloudflared', `${tunnelId}.json`);
  const configPath = path.join(os.homedir(), '.cloudflared', 'config.yml');
  await fs.mkdir(path.dirname(credsPath), { recursive: true });
  await fs.writeFile(credsPath, JSON.stringify({ TunnelID: tunnelId, TunnelSecret: tunnelToken }));
  await fs.writeFile(configPath, [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credsPath}`,
    '',
    'ingress:',
    `  - hostname: ${fqdn}`,
    `    service: http://localhost:${port}`,
    '    originRequest:',
    '      noTLSVerify: true',
    '  - service: http_status:404'
  ].join('\n'));

  log('info', `隧道创建成功: https://${fqdn}`);
  return { tunnelId, fqdn: `https://${fqdn}`, configPath };
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

module.exports = { startTunnel, stopTunnel, getTunnelUrl, isRunning, getStatus, findCloudflared, setupNamedTunnel };
