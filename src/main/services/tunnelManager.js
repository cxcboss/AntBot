const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 检测系统代理（cloudflared 需要走代理才能绕过 fake-ip DNS 的 UDP 超时）
function getSystemProxy() {
  // 1. 环境变量优先
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (envProxy) return envProxy;
  try {
    if (process.platform === 'darwin') {
      // macOS: scutil --proxy
      const out = execFileSync('scutil', ['--proxy'], { timeout: 3000 }).toString();
      if (/HTTPEnable\s*:\s*1/.test(out)) {
        const portMatch = out.match(/HTTPPort\s*:\s*(\d+)/);
        const hostMatch = out.match(/HTTPProxy\s*:\s*([^\s]+)/);
        if (portMatch) return `http://${hostMatch ? hostMatch[1] : '127.0.0.1'}:${portMatch[1]}`;
      }
    } else if (process.platform === 'win32') {
      // Windows: 注册表 Internet Settings
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const enable = execFileSync('reg', ['query', key, '/v', 'ProxyEnable'], { timeout: 3000 }).toString();
      if (/0x1\s*$/.test(enable.trim())) {
        const server = execFileSync('reg', ['query', key, '/v', 'ProxyServer'], { timeout: 3000 }).toString();
        const m = server.match(/ProxyServer\s+REG_SZ\s+([^\s]+)/);
        if (m) return `http://${m[1]}`;
      }
    }
  } catch {}
  return null;
}

let _tunnelProcess = null;
let _tunnelUrl = null;
let _onUrlChange = null;
let _onStatusChange = null;
let _log = null;
let _stopped = false;
let _deviceId = null;
let _deviceName = null;

const TUNNEL_ID = '843f2a80-cd75-4724-a9ce-2f6964227d2b';
const TUNNEL_DOMAIN = 'remote.onebugmanai.online';
const CONFIG_PATH = path.join(os.homedir(), '.cloudflared', 'config.yml');

// 自动重启策略：最多 5 次、指数退避（5s → 10s → 20s → 40s → 80s）
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_RESET_MS = 5 * 60 * 1000; // 稳定运行 5 分钟后重置计数

function findCloudflared() {
  const { getManagedBinDir } = require('./dependencyManager');
  const managedBin = getManagedBinDir();
  const candidates = process.platform === 'win32'
    ? [
        path.join(managedBin, 'cloudflared.exe'),
        path.join(os.homedir(), 'AntBot', 'bin', 'cloudflared.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
        'cloudflared.exe'
      ]
    : [
        path.join(managedBin, 'cloudflared'),
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

const { HUB_URL, HUB_SECRET, HUB_SECRET_HEADER } = require('./hubConfig');
const CF_API = 'https://api.cloudflare.com/client/v4';
const DOMAIN = 'onebugmanai.online';
const HEARTBEAT_INTERVAL = 60_000; // 60 秒心跳

let _heartbeatTimer = null;

function hubHeaders() {
  return { 'Content-Type': 'application/json', [HUB_SECRET_HEADER]: HUB_SECRET };
}

async function registerWithHub(deviceId, deviceName, tunnelUrl) {
  try {
    const res = await fetch(`${HUB_URL}/api/register`, {
      method: 'POST',
      headers: hubHeaders(),
      body: JSON.stringify({ deviceId, deviceName, tunnelUrl })
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function unregisterFromHub(deviceId) {
  if (!deviceId) return;
  try {
    await fetch(`${HUB_URL}/api/unregister`, {
      method: 'POST',
      headers: hubHeaders(),
      body: JSON.stringify({ deviceId })
    });
  } catch { /* best effort */ }
}

function startHeartbeat() {
  stopHeartbeat();
  _heartbeatTimer = setInterval(() => {
    if (_tunnelUrl && _deviceId) registerWithHub(_deviceId, _deviceName || '', _tunnelUrl);
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
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

let _autoRestart = true;
let _restartAttempts = 0;
let _stableSince = 0;

function startTunnel(port, { onUrl, onStatus, log, deviceId, deviceName } = {}) {
  return new Promise((resolve, reject) => {
    if (_tunnelProcess) {
      return resolve({ url: _tunnelUrl, alreadyRunning: true });
    }
    _stopped = false;

    if (deviceId) _deviceId = deviceId;
    if (deviceName) _deviceName = deviceName;
    _onUrlChange = onUrl || (() => {});
    _onStatusChange = onStatus || (() => {});
    _log = log || (() => {});

    const cloudflared = findCloudflared();
    if (!cloudflared) {
      return reject(new Error('cloudflared 未安装。请在设置页面安装依赖。'));
    }

    // 检查是否有命名隧道配置
    const hasConfig = fs.existsSync(CONFIG_PATH);
    let useNamed = false;
    if (hasConfig) {
      try { useNamed = fs.readFileSync(CONFIG_PATH, 'utf-8').includes(TUNNEL_ID); } catch {}
    }

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
      _tunnelUrl = null;
    }

    // 检测系统代理：有代理时强制 http2 协议走代理（QUIC 不支持代理，且 fake-ip DNS 会导致 UDP 查询超时）
    const proxy = getSystemProxy();
    if (proxy) {
      _log('info', `检测到系统代理，隧道将通过代理连接: ${proxy}`);
      args = [args[0], '--protocol', 'http2', ...args.slice(1)];
    }

    _tunnelProcess = spawn(cloudflared, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : {})
      },
      windowsHide: true
    });

    let resolved = false;

    const onConnected = async () => {
      if (resolved) return;
      resolved = true;
      _restartAttempts = 0;
      _stableSince = Date.now();
      _onUrlChange(_tunnelUrl);
      _onStatusChange({ status: 'running', url: _tunnelUrl });
      // 注册到 Hub
      if (_deviceId && _tunnelUrl) {
        const regResult = await registerWithHub(_deviceId, _deviceName || '', _tunnelUrl);
        if (regResult.ok) { _log('info', '已注册到远程控制中心'); startHeartbeat(); }
        else _log('error', '注册到 Hub 失败: ' + (regResult.error || '未知错误'));
      }
      resolve({ url: _tunnelUrl });
    };

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
      // 连接成功（Quick Tunnel 和命名隧道统一走这里）
      if (text.includes('Connection established') || text.includes('Registered tunnel connection')) {
        onConnected();
      }
    };

    _tunnelProcess.stderr?.on('data', parseOutput);
    _tunnelProcess.stdout?.on('data', parseOutput);

    _autoRestart = true;

    _tunnelProcess.on('close', async (code) => {
      _log('info', `cloudflared 进程退出 (code=${code})`);
      _tunnelProcess = null;
      _tunnelUrl = null;
      _onStatusChange({ status: 'stopped' });
      _onUrlChange(null);

      // 自动重启（非手动停止时），带次数上限 + 指数退避
      if (_autoRestart && code !== 0) {
        // 稳定运行超过 RESTART_RESET_MS 后重置计数
        if (_stableSince && Date.now() - _stableSince > RESTART_RESET_MS) {
          _restartAttempts = 0;
        }
        if (_restartAttempts >= MAX_RESTART_ATTEMPTS) {
          _log('error', `隧道连续重启 ${MAX_RESTART_ATTEMPTS} 次失败，停止重试（请检查网络或配置）`);
          _onStatusChange({ status: 'error', error: '连续重启失败，已停止重试' });
          return;
        }
        _restartAttempts += 1;
        const delay = 5000 * Math.pow(2, _restartAttempts - 1);
        _log('info', `隧道意外断开，${delay / 1000} 秒后自动重连 (${_restartAttempts}/${MAX_RESTART_ATTEMPTS})...`);
        _onStatusChange({ status: 'reconnecting' });
        await new Promise(r => setTimeout(r, delay));
        try {
          const result = await startTunnel(port, { onUrl, onStatus, log, deviceId: _deviceId, deviceName: _deviceName });
          _log('info', `自动重连成功: ${result.url}`);
          if (_deviceId && result.url) {
            await registerWithHub(_deviceId, _deviceName || '', result.url);
            startHeartbeat();
            _log('info', '已重新注册到远程控制中心');
          }
        } catch (e) {
          _log('error', `自动重连失败: ${e.message}`);
          _onStatusChange({ status: 'error', error: '重连失败: ' + e.message });
        }
      }
    });

    _tunnelProcess.on('error', (err) => {
      _log('error', `cloudflared 启动失败: ${err.message}`);
      _tunnelProcess = null;
      _onStatusChange({ status: 'error', error: err.message });
      if (!resolved) { resolved = true; reject(err); }
    });

    // Quick Tunnel / 命名隧道统一超时兜底
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Tunnel 启动超时'));
      }
    }, 30000);
  });
}

function stopTunnel() {
  _stopped = true;
  if (_tunnelProcess) {
    _autoRestart = false; // 手动停止不自动重启
    stopHeartbeat();
    if (_deviceId) unregisterFromHub(_deviceId);
    _log('info', '停止 Cloudflare Tunnel');
    _tunnelProcess.kill('SIGTERM');
    _tunnelProcess = null;
    _tunnelUrl = null;
    _onStatusChange?.({ status: 'stopped' });
    _onUrlChange?.(null);
  }
}

function getTunnelUrl() { return _tunnelUrl; }
function isRunning() { return _tunnelProcess !== null; }
function getStatus() { return { running: isRunning(), url: getTunnelUrl() }; }

module.exports = { startTunnel, stopTunnel, getTunnelUrl, isRunning, getStatus, findCloudflared, setupNamedTunnel, registerWithHub, unregisterFromHub };
