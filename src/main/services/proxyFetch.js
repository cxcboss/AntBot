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

function detectSystemProxy() {
  if (_proxyDetected) return _proxyUrl;
  _proxyDetected = true;
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('node:child_process');
      const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', { encoding: 'utf-8', timeout: 3000, windowsHide: true });
      if (/0x1/.test(out)) {
        const serverOut = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf-8', timeout: 3000, windowsHide: true });
        const match = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+)/);
        if (match) {
          const addr = match[1].trim();
          _proxyUrl = addr.startsWith('http') ? addr : `http://${addr}`;
        }
      }
    } else if (process.platform === 'darwin') {
      const { execFileSync } = require('node:child_process');
      const out = execFileSync('networksetup', ['-getwebproxy', 'Wi-Fi'], { timeout: 3000, encoding: 'utf-8' });
      if (/Enabled:\s*Yes/.test(out)) {
        const host = out.match(/Server:\s*(.+)$/m)?.[1]?.trim();
        const port = out.match(/Port:\s*(.+)$/m)?.[1]?.trim() || '80';
        if (host) _proxyUrl = `http://${host}:${port}`;
      }
    }
  } catch {}
  return _proxyUrl;
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
      const connectReq = http.request({
        host: proxy.hostname,
        port: parseInt(proxy.port) || 80,
        method: 'CONNECT',
        path: `${parsedUrl.hostname}:${parsedUrl.port || (isHttps ? 443 : 80)}`
      });

      connectReq.on('connect', (res, socket, head) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          logToAppFile(`CONNECT 被拒绝: HTTP ${res.statusCode}`);
          return globalThis.fetch(url, options).then(resolve).catch(reject);
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
          tlsSocket.on('error', e => { logToAppFile(`TLS 读取错误: ${e.message}`); reject(e); });
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
            resolve({
              ok: statusCode >= 200 && statusCode < 300,
              status: statusCode,
              statusText,
              headers: headerMap,
              text: () => Promise.resolve(bodyPart),
              json: () => Promise.resolve(JSON.parse(bodyPart)),
              arrayBuffer: () => Promise.resolve(Buffer.from(bodyPart).buffer),
              body: null
            });
          });
        });

        tlsSocket.on('error', (e) => {
          logToAppFile(`TLS 握手失败: ${e.message}`);
          globalThis.fetch(url, options).then(resolve).catch(reject);
        });
      });

      connectReq.on('error', (e) => {
        logToAppFile(`CONNECT 失败: ${e.message}`);
        globalThis.fetch(url, options).then(resolve).catch(reject);
      });
      connectReq.end();
    });
  };
}

function proxyFetch(url, options) {
  return getProxyFetch()(url, options);
}

module.exports = { proxyFetch, detectSystemProxy };
