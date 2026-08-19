const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function logToAppFile(msg) {
  try {
    const logDir = path.join(os.homedir(), 'AntBot', 'logs');
    const files = fs.readdirSync(logDir).filter(f => f.startsWith('app-') && f.endsWith('.log')).sort();
    if (files.length) fs.appendFileSync(path.join(logDir, files[files.length - 1]), `[proxyFetch] ${msg}\n`);
  } catch {}
}

let _proxyUrl = null;
let _proxyDetected = false;

// Windows ProxyServer 可能是多协议格式：
//   "127.0.0.1:7890"（单值）
//   "http=127.0.0.1:7890;https=127.0.0.1:7890"（分号分隔）
//   "socks=127.0.0.1:1080;http=127.0.0.1:7890"（混合）
// 统一提取 http 代理；无 http 段时若存在 http 单值直接用。
function parseWindowsProxyServer(addr) {
  const trimmed = String(addr || '').trim();
  if (!trimmed) return '';
  if (trimmed.includes('=')) {
    const parts = trimmed.split(';').map((p) => p.trim()).filter(Boolean);
    for (const part of parts) {
      if (/^http=/i.test(part)) {
        const value = part.slice(part.indexOf('=') + 1).trim();
        if (value) return value.startsWith('http') ? value : `http://${value}`;
      }
    }
    // 没有 http= 段：取第一个非 socks 的值作为候选（常见 Clash 配置 http 在首位）
    for (const part of parts) {
      if (/^socks(=|$)/i.test(part)) continue;
      const value = part.includes('=') ? part.slice(part.indexOf('=') + 1).trim() : part.trim();
      if (value) return value.startsWith('http') ? value : `http://${value}`;
    }
    // 只有 socks=：返回空（undici 不支持 socks，交给原生 fetch 直连）
    return '';
  }
  return trimmed.startsWith('http') ? trimmed : `http://${trimmed}`;
}

function detectSystemProxy() {
  if (_proxyDetected) return _proxyUrl;
  _proxyDetected = true;
  try {
    // 1. 检查环境变量（最通用）
    const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
    if (envProxy) {
      _proxyUrl = envProxy.startsWith('http') ? envProxy : `http://${envProxy}`;
      logToAppFile(`从环境变量检测到代理: ${_proxyUrl}`);
      return _proxyUrl;
    }

    // 2. 系统代理设置
    if (process.platform === 'win32') {
      const { execSync } = require('node:child_process');
      const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', { encoding: 'utf-8', timeout: 3000, windowsHide: true });
      if (/0x1/.test(out)) {
        const serverOut = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf-8', timeout: 3000, windowsHide: true });
        const match = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+)/);
        if (match) {
          const addr = match[1].trim();
          _proxyUrl = parseWindowsProxyServer(addr);
          logToAppFile(`从 Windows 注册表检测到代理: ${_proxyUrl}`);
        }
      }
    } else if (process.platform === 'darwin') {
      const { execFileSync } = require('node:child_process');
      const out = execFileSync('networksetup', ['-getwebproxy', 'Wi-Fi'], { timeout: 3000, encoding: 'utf-8' });
      if (/Enabled:\s*Yes/.test(out)) {
        const host = out.match(/Server:\s*(.+)$/m)?.[1]?.trim();
        const port = out.match(/Port:\s*(.+)$/m)?.[1]?.trim() || '80';
        if (host) _proxyUrl = `http://${host}:${port}`;
        logToAppFile(`从 macOS 网络设置检测到代理: ${_proxyUrl}`);
      }
    }

    // 3. 探测常见 VPN 代理端口（Clash/V2Ray/Shadowsocks）
    if (!_proxyUrl) {
      // 异步端口探测（非阻塞，结果缓存到下次调用）
      _probeCommonPorts();
    }
  } catch {}
  return _proxyUrl;
}

function _probeCommonPorts() {
  const net = require('node:net');
  const candidates = [7890, 7891, 10809, 10808, 1080, 8080];
  for (const port of candidates) {
    try {
      const sock = net.createConnection({ host: '127.0.0.1', port });
      sock.on('connect', () => {
        sock.destroy();
        if (!_proxyUrl) {
          _proxyUrl = `http://127.0.0.1:${port}`;
          logToAppFile(`探测到本地代理端口: ${port}`);
        }
      });
      sock.on('error', () => sock.destroy());
      setTimeout(() => sock.destroy(), 300);
    } catch {}
  }
}

let _proxyFetch = null;

function getProxyFetch() {
  if (_proxyFetch) return _proxyFetch;

  const proxyUrl = detectSystemProxy();
  if (!proxyUrl) {
    logToAppFile('未检测到系统代理，使用原生 fetch');
    _proxyFetch = globalThis.fetch;
    return _proxyFetch;
  }

  logToAppFile(`检测到系统代理: ${proxyUrl}，尝试使用 undici ProxyAgent`);
  try {
    const { ProxyAgent } = require('undici');
    const agent = new ProxyAgent({ uri: proxyUrl, requestTls: { servername: undefined } });
    _proxyFetch = (url, opts = {}) => {
      const u = typeof url === 'string' ? url : (url?.url || '');
      if (/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.)/i.test(u)) {
        return globalThis.fetch(url, opts);
      }
      return globalThis.fetch(url, { ...opts, dispatcher: agent });
    };
    logToAppFile('ProxyAgent 创建成功');
  } catch (e) {
    logToAppFile(`undici ProxyAgent 不可用: ${e.message}，回退到 http.request 方案`);
    // 回退到 http.request + CONNECT 隧道
    _proxyFetch = createHttpProxyFetch(proxyUrl);
  }

  return _proxyFetch;
}

function createHttpProxyFetch(proxyUrl) {
  const proxy = new URL(proxyUrl);
  return async (url, options = {}) => {
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.)/i.test(url);
    if (isLocal) return globalThis.fetch(url, options);

    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const err = new Error('已取消');
        err.name = 'AbortError';
        reject(err);
        try { connectReq.destroy(); } catch {}
      };
      const cleanupSignal = () => {
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
      };
      if (options.signal) {
        if (options.signal.aborted) return onAbort();
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      const connectReq = http.request({
        host: proxy.hostname,
        port: parseInt(proxy.port) || 80,
        method: 'CONNECT',
        path: `${parsedUrl.hostname}:${parsedUrl.port || (isHttps ? 443 : 80)}`
      });

      connectReq.on('connect', (res, socket, head) => {
        if (options.signal?.aborted) { socket.destroy(); cleanupSignal(); return; }
        if (res.statusCode !== 200) {
          socket.destroy();
          logToAppFile(`CONNECT 被拒绝: HTTP ${res.statusCode}`);
          cleanupSignal();
          return reject(new Error(`代理 CONNECT 被拒绝: HTTP ${res.statusCode}`));
        }
        logToAppFile(`CONNECT 成功 → ${parsedUrl.hostname}，建立 TLS...`);

        // 在隧道 socket 上建立 TLS 连接
        const tlsSocket = require('node:tls').connect({
          socket,
          servername: parsedUrl.hostname,
          host: parsedUrl.hostname
        }, () => {
          logToAppFile(`TLS 握手成功 → ${parsedUrl.hostname}`);
          // TLS 连接就绪，发送 HTTP 请求
          const reqPath = parsedUrl.pathname + parsedUrl.search;
          const headerLines = [
            `${options.method || 'GET'} ${reqPath} HTTP/1.1`,
            `Host: ${parsedUrl.hostname}`,
            'Connection: close'
          ];
          if (options.headers) {
            for (const [k, v] of Object.entries(options.headers)) {
              headerLines.push(`${k}: ${v}`);
            }
          }
          if (options.body) {
            const bodyBuf = typeof options.body === 'string' ? Buffer.from(options.body) : options.body;
            headerLines.push(`Content-Length: ${Buffer.byteLength(bodyBuf)}`);
          }
          headerLines.push('', '');
          tlsSocket.write(headerLines.join('\r\n'));
          if (options.body) {
            const bodyBuf = typeof options.body === 'string' ? Buffer.from(options.body) : options.body;
            tlsSocket.write(bodyBuf);
          }

          // 读取响应
          const chunks = [];
          tlsSocket.on('data', chunk => chunks.push(chunk));
          tlsSocket.on('error', e => { logToAppFile(`TLS 读取错误: ${e.message}`); cleanupSignal(); reject(e); });
          tlsSocket.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const headerEnd = raw.indexOf('\r\n\r\n');
            const headerPart = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw;
            const bodyPart = headerEnd >= 0 ? raw.slice(headerEnd + 4) : '';
            const statusMatch = headerPart.match(/^HTTP\/\d\.\d\s+(\d+)\s*(.*)/);
            const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;
            const statusText = statusMatch ? statusMatch[2] : '';
            logToAppFile(`响应: HTTP ${statusCode} (${bodyPart.length} bytes)`);
            const headerMap = new Map();
            for (const line of headerPart.split('\r\n').slice(1)) {
              const idx = line.indexOf(':');
              if (idx > 0) headerMap.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
            }
            const bodyBytes = Buffer.from(bodyPart, 'utf8');
            cleanupSignal();
            resolve({
              ok: statusCode >= 200 && statusCode < 300,
              status: statusCode,
              statusText,
              headers: headerMap,
              text: () => Promise.resolve(bodyPart),
              json: () => Promise.resolve(JSON.parse(bodyPart)),
              arrayBuffer: () => Promise.resolve(bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength)),
              body: new ReadableStream({
                start(controller) {
                  controller.enqueue(bodyBytes);
                  controller.close();
                }
              })
            });
          });
        });

        tlsSocket.on('error', (e) => {
          logToAppFile(`TLS 握手失败: ${e.message}`);
          cleanupSignal();
          reject(e);
        });
      });

      connectReq.on('error', (e) => {
        logToAppFile(`CONNECT 失败: ${e.message}`);
        cleanupSignal();
        reject(e);
      });
      connectReq.end();
    });
  };
}

function proxyFetch(url, options) {
  return getProxyFetch()(url, options);
}

module.exports = { proxyFetch, detectSystemProxy, parseWindowsProxyServer };
