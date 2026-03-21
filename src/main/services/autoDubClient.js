const fsNative = require('node:fs');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { constants: fsConstants } = require('node:fs');
const { buildRuntimePath, withRuntimeEnv } = require('./runtimeEnv');
const { ensureWindowsDependency, getManagedBinDir } = require('./dependencyManager');

const AUTO_DUB_PORT = 5001;
const AUTO_DUB_BASE_URL = `http://127.0.0.1:${AUTO_DUB_PORT}`;
const AUTO_DUB_HEALTHCHECK_URL = `${AUTO_DUB_BASE_URL}/api/health`;
const VOICEBOX_PORT = 17493;
const VOICEBOX_BASE_URL = `http://127.0.0.1:${VOICEBOX_PORT}`;
const startedServers = new Map();
const startedVoiceboxBackends = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyErrorWithCause(error) {
  const message = error instanceof Error ? error.message : String(error);
  const causeMessage = error?.cause?.message ? String(error.cause.message) : '';
  if (causeMessage && !message.includes(causeMessage)) {
    return `${message}（cause: ${causeMessage}）`;
  }
  return message;
}

function escapeMultipartHeaderValue(value) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, '%22');
}

function createMultipartBoundary() {
  return `----AntBotBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

async function postAutoDubProcessRequest({ fields, files }) {
  const boundary = createMultipartBoundary();
  const targetUrl = new URL(`${AUTO_DUB_BASE_URL}/api/process`);

  return new Promise((resolve, reject) => {
    const request = http.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('error', reject);
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode || 0,
          headers: response.headers,
          bodyText: Buffer.concat(chunks).toString('utf8')
        });
      });
    });

    request.setTimeout(0);
    request.on('socket', (socket) => {
      socket.setTimeout(0);
      socket.setKeepAlive(true, 1000);
    });
    request.on('error', reject);

    const writeField = (name, value) => {
      request.write(`--${boundary}\r\n`);
      request.write(`Content-Disposition: form-data; name="${escapeMultipartHeaderValue(name)}"\r\n\r\n`);
      request.write(String(value ?? ''));
      request.write('\r\n');
    };

    const writeFile = ({ fieldName, fileName, contentType, buffer }) => {
      request.write(`--${boundary}\r\n`);
      request.write(
        `Content-Disposition: form-data; name="${escapeMultipartHeaderValue(fieldName)}"; filename="${escapeMultipartHeaderValue(fileName)}"\r\n`
      );
      request.write(`Content-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`);
      request.write(buffer);
      request.write('\r\n');
    };

    try {
      for (const [name, value] of Object.entries(fields || {})) {
        writeField(name, value);
      }
      for (const file of files || []) {
        writeFile(file);
      }
      request.end(`--${boundary}--\r\n`);
    } catch (error) {
      request.destroy(error);
    }
  });
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveVoiceboxVenvPython(venvDir) {
  const candidates = process.platform === 'win32'
    ? [
        path.join(venvDir, 'Scripts', 'python.exe'),
        path.join(venvDir, 'bin', 'python')
      ]
    : [
        path.join(venvDir, 'bin', 'python'),
        path.join(venvDir, 'Scripts', 'python.exe')
      ];

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

async function canWritePath(targetPath) {
  if (!targetPath) {
    return false;
  }
  try {
    await fs.access(targetPath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function canExecute(filePath) {
  if (!filePath) {
    return false;
  }
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveNodeBinary() {
  const candidates = [];
  const pushCandidate = (value) => {
    const trimmed = String(value || '').trim();
    if (trimmed) {
      candidates.push(trimmed);
    }
  };

  pushCandidate(process.env.ANTBOT_NODE_BIN);
  if (process.platform === 'win32') {
    pushCandidate(path.join(getManagedBinDir(), 'node-runtime', 'node.exe'));
    pushCandidate(path.join(getManagedBinDir(), 'node.exe'));
    pushCandidate(path.resolve(process.resourcesPath || '', 'bin', 'node.exe'));
  }

  const pathEntries = String(buildRuntimePath(process.env.PATH || ''))
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of pathEntries) {
    pushCandidate(path.join(entry, 'node'));
    if (process.platform === 'win32') {
      pushCandidate(path.join(entry, 'node.exe'));
    }
  }

  pushCandidate('/opt/homebrew/bin/node');
  pushCandidate('/usr/local/bin/node');
  pushCandidate('/usr/bin/node');
  pushCandidate(path.resolve(process.resourcesPath || '', 'bin', 'node'));

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (await canExecute(candidate)) {
      return candidate;
    }
  }

  if (process.platform === 'win32') {
    try {
      return await ensureWindowsDependency('node');
    } catch {
      return '';
    }
  }

  return '';
}

async function resolveBashBinary() {
  const candidates = [];
  const pushCandidate = (value) => {
    const trimmed = String(value || '').trim();
    if (trimmed) {
      candidates.push(trimmed);
    }
  };

  pushCandidate(process.env.ANTBOT_BASH_BIN);
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    pushCandidate(path.join(programFiles, 'Git', 'bin', 'bash.exe'));
    pushCandidate(path.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'));
    pushCandidate(path.join(programFilesX86, 'Git', 'bin', 'bash.exe'));
    pushCandidate(path.join(programFilesX86, 'Git', 'usr', 'bin', 'bash.exe'));
  }
  pushCandidate('/bin/bash');
  pushCandidate('/usr/bin/bash');

  const pathEntries = String(buildRuntimePath(process.env.PATH || ''))
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of pathEntries) {
    pushCandidate(path.join(entry, 'bash'));
    if (process.platform === 'win32') {
      pushCandidate(path.join(entry, 'bash.exe'));
    }
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (await canExecute(candidate)) {
      return candidate;
    }
  }

  return '';
}

async function resolvePythonBinary() {
  const getPythonVersion = (pythonPath) => {
    return new Promise((resolve) => {
      const child = spawn(pythonPath, ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'], {
        stdio: ['ignore', 'pipe', 'ignore']
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk || '');
      });
      child.once('error', () => resolve(''));
      child.once('close', (code) => {
        if (code !== 0) {
          resolve('');
          return;
        }
        resolve(stdout.trim());
      });
    });
  };

  const isSupportedPythonVersion = (versionText) => {
    const match = String(versionText || '').match(/^(\d+)\.(\d+)$/);
    if (!match) {
      return false;
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major === 3 && minor >= 10 && minor <= 12;
  };

  const candidates = [];
  const pushCandidate = (value) => {
    const trimmed = String(value || '').trim();
    if (trimmed) {
      candidates.push(trimmed);
    }
  };

  pushCandidate(process.env.ANTBOT_PYTHON_BIN);
  if (process.platform === 'win32') {
    const home = process.env.USERPROFILE || require('node:os').homedir();
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    pushCandidate(path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'));
    pushCandidate(path.join(localAppData, 'Programs', 'Python', 'Python311', 'python.exe'));
    pushCandidate(path.join(localAppData, 'Programs', 'Python', 'Python310', 'python.exe'));
    pushCandidate(path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'));
    pushCandidate(path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'));
    pushCandidate(path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'));
  }
  pushCandidate('/usr/local/bin/python3.12');
  pushCandidate('/usr/local/bin/python3.11');
  pushCandidate('/usr/local/bin/python3.10');
  pushCandidate('/opt/homebrew/bin/python3.12');
  pushCandidate('/opt/homebrew/bin/python3.11');
  pushCandidate('/opt/homebrew/bin/python3.10');
  pushCandidate('/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12');
  pushCandidate('/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11');
  pushCandidate('/Library/Frameworks/Python.framework/Versions/3.10/bin/python3.10');
  const names = process.platform === 'win32'
    ? ['python.exe', 'python3.exe', 'python', 'python3', 'py.exe', 'py']
    : ['python3.12', 'python3.11', 'python3.10', 'python3', 'python'];

  const pathEntries = String(buildRuntimePath(process.env.PATH || ''))
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of pathEntries) {
    for (const name of names) {
      pushCandidate(path.join(entry, name));
    }
  }

  pushCandidate('/opt/homebrew/bin/python3');
  pushCandidate('/usr/local/bin/python3');
  pushCandidate('/usr/bin/python3');

  const seen = new Set();
  const unsupported = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (await canExecute(candidate)) {
      const version = await getPythonVersion(candidate);
      if (isSupportedPythonVersion(version)) {
        return candidate;
      }
      unsupported.push(`${candidate}(${version || 'unknown'})`);
    }
  }
  if (unsupported.length) {
    throw new Error(`未找到可用 Python 3.10~3.12。检测到但不兼容：${unsupported.join(', ')}`);
  }
  return '';
}

async function spawnDetachedProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    const onError = (error) => {
      reject(error);
    };
    child.once('error', onError);
    child.once('spawn', () => {
      child.removeListener('error', onError);
      resolve(child);
    });
  });
}

function getStartedChild(record) {
  if (!record) {
    return null;
  }
  return record.child || record;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function isStartedChildAlive(record) {
  const child = getStartedChild(record);
  if (!child || child.exitCode !== null) {
    return false;
  }
  return isPidAlive(child.pid);
}

function getRuntimeRoot() {
  const app = getElectronApp();
  return app
    ? app.getPath('userData')
    : path.resolve(process.cwd(), '.antbot-runtime');
}

async function getServiceLogFilePath(projectPath, serviceName) {
  const safeProjectName = path.basename(projectPath || 'service').replace(/[^a-zA-Z0-9._-]/g, '_') || 'service';
  const safeServiceName = String(serviceName || 'service').replace(/[^a-zA-Z0-9._-]/g, '_') || 'service';
  const logDir = path.join(getRuntimeRoot(), 'logs');
  await fs.mkdir(logDir, { recursive: true });
  return path.join(logDir, `${safeProjectName}.${safeServiceName}.log`);
}

async function getAutoDubLogFilePath(projectPath) {
  return getServiceLogFilePath(projectPath, 'auto_dub_web');
}

async function getVoiceboxLogFilePath(projectPath) {
  return getServiceLogFilePath(projectPath, 'voicebox');
}

async function readRecentLogTail(logFilePath, maxLines = 10, maxBytes = 12288) {
  if (!logFilePath) {
    return '';
  }

  try {
    const stats = await fs.stat(logFilePath);
    const start = Math.max(0, stats.size - maxBytes);
    const fileHandle = await fs.open(logFilePath, 'r');
    try {
      const buffer = Buffer.alloc(stats.size - start);
      await fileHandle.read(buffer, 0, buffer.length, start);
      const lines = buffer
        .toString('utf8')
        .split(/\r?\n/g)
        .map((line) => line.trimEnd())
        .filter(Boolean);
      return lines.slice(-maxLines).join('\n');
    } finally {
      await fileHandle.close();
    }
  } catch {
    return '';
  }
}

async function spawnLoggedDetachedProcess(command, args, {
  cwd,
  env,
  logFilePath,
  label = 'service'
}) {
  await fs.mkdir(path.dirname(logFilePath), { recursive: true });
  await fs.appendFile(
    logFilePath,
    `\n[${new Date().toISOString()}] [${label}] starting: ${command} ${args.join(' ')}\n`,
    'utf8'
  );

  const logFd = fsNative.openSync(logFilePath, 'a');

  try {
    const child = await spawnDetachedProcess(command, args, {
      cwd,
      detached: true,
      windowsHide: true,
      env,
      stdio: ['ignore', logFd, logFd]
    });

    child.once('exit', (code, signal) => {
      void fs.appendFile(
        logFilePath,
        `[${new Date().toISOString()}] [${label}] exited: code=${code ?? 'null'} signal=${signal ?? 'null'}\n`,
        'utf8'
      ).catch(() => {});
    });

    return child;
  } finally {
    try {
      fsNative.closeSync(logFd);
    } catch {
      // noop
    }
  }
}

async function runScriptWithLogs(scriptPath, {
  cwd,
  env,
  shellBinary,
  logger = () => {},
  logPrefix = ''
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(shellBinary, [scriptPath], {
      cwd,
      env: withRuntimeEnv(env),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const recentLines = [];

    const logLine = (line) => {
      const text = String(line || '').trim();
      if (!text) {
        return;
      }
      recentLines.push(text);
      if (recentLines.length > 12) {
        recentLines.splice(0, recentLines.length - 12);
      }
      logger(logPrefix ? `${logPrefix}${text}` : text);
    };

    child.stdout.on('data', (chunk) => {
      String(chunk || '')
        .split(/\r?\n/g)
        .forEach(logLine);
    });

    child.stderr.on('data', (chunk) => {
      String(chunk || '')
        .split(/\r?\n/g)
        .forEach(logLine);
    });

    child.once('error', (error) => {
      reject(error);
    });

    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = recentLines.length ? `\n${recentLines.join('\n')}` : '';
        reject(new Error(`脚本执行失败（exit ${code}）：${path.basename(scriptPath)}${tail}`));
      }
    });
  });
}

async function runCommandWithLogs(command, args, {
  cwd,
  env,
  logger = () => {},
  logPrefix = ''
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: withRuntimeEnv(env),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const recentLines = [];

    const logLine = (line) => {
      const text = String(line || '').trim();
      if (!text) {
        return;
      }
      recentLines.push(text);
      if (recentLines.length > 12) {
        recentLines.splice(0, recentLines.length - 12);
      }
      logger(logPrefix ? `${logPrefix}${text}` : text);
    };

    child.stdout.on('data', (chunk) => {
      String(chunk || '')
        .split(/\r?\n/g)
        .forEach(logLine);
    });

    child.stderr.on('data', (chunk) => {
      String(chunk || '')
        .split(/\r?\n/g)
        .forEach(logLine);
    });

    child.once('error', (error) => {
      reject(error);
    });

    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = recentLines.length ? `\n${recentLines.join('\n')}` : '';
        reject(new Error(`命令执行失败（exit ${code}）：${command} ${args.join(' ')}${tail}`));
      }
    });
  });
}

async function canImportPythonModule(pythonBinary, moduleName, cwd) {
  return new Promise((resolve) => {
    const child = spawn(pythonBinary, ['-c', `import ${moduleName}`], {
      cwd,
      stdio: 'ignore'
    });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

async function readCommandStdout(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: withRuntimeEnv(options.env),
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.once('error', () => resolve(''));
    child.once('close', () => resolve(stdout.trim()));
  });
}

async function requestVoiceCloneShutdown() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    await fetch(`${VOICEBOX_BASE_URL}/shutdown`, {
      method: 'POST',
      signal: controller.signal
    }).catch(() => {});
    clearTimeout(timer);
  } catch {
    // noop
  }
}

async function fetchVoiceboxApi(endpoint, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 6000);
  try {
    const response = await fetch(`${VOICEBOX_BASE_URL}${endpoint}`, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal
    });

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    let payload = null;
    try {
      if (contentType.includes('application/json')) {
        payload = await response.json();
      } else {
        payload = await response.text();
      }
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const detail = typeof payload === 'object' && payload
        ? payload.detail || payload.error || JSON.stringify(payload)
        : String(payload || '').trim();
      throw new Error(`Voice clone 引擎请求失败 (${response.status}): ${detail || `HTTP ${response.status}`}`);
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function getVoiceCloneProfiles(timeoutMs = 20000) {
  const payload = await fetchVoiceboxApi('/profiles', {
    method: 'GET',
    timeoutMs
  });
  return Array.isArray(payload) ? payload : [];
}

async function getVoiceCloneModelStatuses(timeoutMs = 15000) {
  const payload = await fetchVoiceboxApi('/models/status', {
    method: 'GET',
    timeoutMs
  });
  return Array.isArray(payload?.models) ? payload.models : [];
}

async function getVoiceCloneModelStatus(modelName, timeoutMs = 15000) {
  const normalizedName = String(modelName || '').trim();
  if (!normalizedName) {
    return null;
  }

  const models = await getVoiceCloneModelStatuses(timeoutMs);
  return models.find((item) => String(item?.model_name || '').trim() === normalizedName) || null;
}

async function triggerVoiceCloneModelDownload(modelName, timeoutMs = 20000) {
  return fetchVoiceboxApi('/models/download', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model_name: modelName
    }),
    timeoutMs
  });
}

async function prewarmVoiceCloneModel(modelName, logger = () => {}) {
  const normalizedName = String(modelName || '').trim();
  if (!normalizedName) {
    return;
  }

  try {
    const status = await getVoiceCloneModelStatus(normalizedName, 8000);
    if (status?.loaded || status?.downloaded) {
      return;
    }
    if (status?.downloading) {
      logger(`检测到语音模型 ${normalizedName} 正在后台下载。`);
      return;
    }

    await triggerVoiceCloneModelDownload(normalizedName, 15000);
    logger(`已触发语音模型 ${normalizedName} 后台下载。首次生成语音时会自动等待模型准备完成。`);
  } catch (error) {
    logger(`语音模型 ${normalizedName} 预热失败：${String(error?.message || error)}`);
  }
}

async function createVoiceCloneProfileDirect({
  profileName,
  language,
  referenceText,
  audioBuffer,
  sampleFileName,
  sampleMimeType
}) {
  const profile = await fetchVoiceboxApi('/profiles', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: profileName,
      description: 'Created from auto_dub_web',
      language
    }),
    timeoutMs: 20000
  });

  const formData = new FormData();
  formData.append('reference_text', referenceText);
  formData.append(
    'file',
    new Blob([audioBuffer], { type: sampleMimeType }),
    sampleFileName
  );

  await fetchVoiceboxApi(`/profiles/${profile.id}/samples`, {
    method: 'POST',
    body: formData,
    timeoutMs: 120000
  });

  return profile;
}

async function killListeningProcessByPort(port, logger = () => {}, label = 'service') {
  if (process.platform === 'win32') {
    const output = await readCommandStdout('cmd.exe', ['/d', '/s', '/c', 'netstat -ano -p tcp']);
    const pids = output
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => line && /LISTENING/i.test(line) && line.includes(`:${port}`))
      .map((line) => {
        const match = line.match(/(\d+)\s*$/);
        return match ? Number(match[1]) : 0;
      })
      .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);

    for (const pid of [...new Set(pids)]) {
      await new Promise((resolve) => {
        const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: ['ignore', 'ignore', 'ignore'],
          windowsHide: true
        });
        child.once('error', () => resolve());
        child.once('close', () => {
          logger(`已终止旧 ${label} 进程：PID ${pid}`);
          resolve();
        });
      });
    }
    return;
  }
  const output = await readCommandStdout('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  const pids = output
    .split(/\s+/g)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 1);

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      logger(`已终止旧 ${label} 进程：PID ${pid}`);
    } catch {
      // noop
    }
  }
}

async function killVoiceboxByPort(logger = () => {}) {
  await killListeningProcessByPort(VOICEBOX_PORT, logger, 'voicebox');
}

async function killAutoDubByPort(logger = () => {}) {
  await killListeningProcessByPort(AUTO_DUB_PORT, logger, 'auto_dub_web');
}

function buildVoiceboxPythonPath(projectPath) {
  const entries = [
    path.join(projectPath, 'vendor', 'voicebox'),
    process.env.PYTHONPATH || ''
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return [...new Set(entries)].join(path.delimiter);
}

async function detectAutoDubProject(projectPath) {
  if (!projectPath) {
    return false;
  }

  const serverFile = path.join(projectPath, 'server.mjs');
  const publicFile = path.join(projectPath, 'public', 'app.js');

  const [hasServer, hasPublic] = await Promise.all([
    exists(serverFile),
    exists(publicFile)
  ]);

  return hasServer && hasPublic;
}

function getElectronApp() {
  try {
    const electron = require('electron');
    return electron?.app || null;
  } catch {
    return null;
  }
}

function isManagedRuntimeAutoDubPath(targetPath) {
  const app = getElectronApp();
  if (!app || !targetPath) {
    return false;
  }
  const managedPath = path.resolve(app.getPath('userData'), 'engines', 'auto_dub_web');
  return path.resolve(targetPath) === managedPath;
}

function shouldCopyAutoDubEntry(sourceRoot, currentPath) {
  const relative = path.relative(sourceRoot, currentPath);
  if (!relative || relative === '.') {
    return true;
  }
  const normalized = relative.split(path.sep).join('/');
  if (normalized === 'data' || normalized.startsWith('data/')) {
    return normalized === 'data/models' || normalized.startsWith('data/models/');
  }
  const blockedPrefixes = [
    'outputs',
    'workspace',
    '.venv-voicebox'
  ];
  return !blockedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

async function syncAutoDubSourceToTarget(sourcePath, targetPath) {
  if (!sourcePath || !targetPath) {
    return;
  }
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return;
  }
  await fs.cp(sourcePath, targetPath, {
    recursive: true,
    force: true,
    filter: (src) => shouldCopyAutoDubEntry(sourcePath, src)
  });
}

async function ensureWritableBundledAutoDub(bundledPath) {
  const app = getElectronApp();
  const runtimeRoot = app
    ? path.join(app.getPath('userData'), 'engines')
    : path.resolve(process.cwd(), '.antbot-runtime', 'engines');

  const runtimePath = path.join(runtimeRoot, 'auto_dub_web');
  await fs.mkdir(runtimeRoot, { recursive: true });

  if (await detectAutoDubProject(runtimePath)) {
    await syncAutoDubSourceToTarget(bundledPath, runtimePath);
    return runtimePath;
  }

  await syncAutoDubSourceToTarget(bundledPath, runtimePath);

  return runtimePath;
}

async function isAutoDubProjectWritable(projectPath) {
  if (!projectPath) {
    return false;
  }
  const projectWritable = await canWritePath(projectPath);
  if (!projectWritable) {
    return false;
  }
  const dataDir = path.join(projectPath, 'data');
  try {
    await fs.mkdir(dataDir, { recursive: true });
  } catch {
    return false;
  }
  return canWritePath(dataDir);
}

async function resolveAutoDubProjectPath(explicitPath) {
  const localVendorPath = path.resolve(process.cwd(), 'vendors', 'auto_dub_web');
  const resourcesCandidate = path.resolve(process.resourcesPath || '', 'vendors', 'auto_dub_web');

  if (explicitPath && await detectAutoDubProject(explicitPath)) {
    if (!await isAutoDubProjectWritable(explicitPath)) {
      return ensureWritableBundledAutoDub(explicitPath);
    }
    if (isManagedRuntimeAutoDubPath(explicitPath)) {
      if (await detectAutoDubProject(localVendorPath)) {
        await syncAutoDubSourceToTarget(localVendorPath, explicitPath);
      } else if (await detectAutoDubProject(resourcesCandidate)) {
        await syncAutoDubSourceToTarget(resourcesCandidate, explicitPath);
      }
    }
    return explicitPath;
  }

  if (await detectAutoDubProject(localVendorPath)) {
    return localVendorPath;
  }

  if (await detectAutoDubProject(resourcesCandidate)) {
    return ensureWritableBundledAutoDub(resourcesCandidate);
  }

  return '';
}

async function waitForAutoDubReady(timeoutMs = 25000) {
  const startedAt = Date.now();
  let lastError = '';
  let lastStatus = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const response = await fetch(AUTO_DUB_HEALTHCHECK_URL, {
        method: 'GET',
        signal: controller.signal
      });
      lastStatus = response.status;
      if (response.ok) {
        return {
          ready: true,
          status: response.status,
          lastError: ''
        };
      }
      lastError = `健康检查返回 HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error?.message || error || '健康检查失败');
    } finally {
      clearTimeout(timer);
    }

    await sleep(700);
  }

  return {
    ready: false,
    status: lastStatus,
    lastError
  };
}

async function ensureAutoDubServer(projectPath, logger = () => {}) {
  if (process.platform === 'win32') {
    try {
      await ensureWindowsDependency('ffmpeg', logger);
    } catch (error) {
      logger(`自动准备 FFmpeg 失败：${String(error?.message || error)}`);
    }
  }

  const tracked = startedServers.get(projectPath);
  const trackedChild = getStartedChild(tracked);
  const trackedAlive = isStartedChildAlive(tracked);
  const logFilePath = tracked?.logFilePath || await getAutoDubLogFilePath(projectPath);

  const alreadyReady = await waitForAutoDubReady(1800);
  if (alreadyReady.ready && trackedAlive) {
    return {
      baseUrl: AUTO_DUB_BASE_URL,
      started: false
    };
  }

  if (alreadyReady.ready && !trackedAlive) {
    logger('检测到历史 auto_dub_web 进程，正在重启以应用当前环境...');
    await killAutoDubByPort(logger);
    await sleep(700);
  }

  if (!alreadyReady.ready && trackedAlive) {
    logger('已记录的 auto_dub_web 进程未通过健康检查，正在重启...');
    try {
      trackedChild?.kill('SIGTERM');
    } catch {
      // noop
    }
    startedServers.delete(projectPath);
    await killAutoDubByPort(logger);
    await sleep(900);
  }

  const readyAfterCleanup = await waitForAutoDubReady(1800);
  if (readyAfterCleanup.ready) {
    return {
      baseUrl: AUTO_DUB_BASE_URL,
      started: false
    };
  }

  const nodeBinary = await resolveNodeBinary();
  if (!nodeBinary) {
    throw new Error('未找到 Node.js 运行时。请先安装 Node.js，或在环境变量 ANTBOT_NODE_BIN 中指定 node 路径。');
  }

  const startAttempt = async (attempt) => {
    const nodeDir = path.dirname(nodeBinary);
    const env = withRuntimeEnv({
      PATH: buildRuntimePath(nodeDir, process.env.PATH)
    });

    let child;
    try {
      child = await spawnLoggedDetachedProcess(nodeBinary, ['server.mjs'], {
        cwd: projectPath,
        env,
        logFilePath,
        label: 'auto_dub_web'
      });
    } catch (error) {
      throw new Error(`启动 auto_dub_web 失败：${String(error?.message || error)}`);
    }

    child.unref();
    startedServers.set(projectPath, {
      child,
      logFilePath,
      nodeBinary,
      startedAt: new Date().toISOString()
    });
    logger(`已启动 auto_dub_web 服务（node: ${nodeBinary}，PID: ${child.pid}）。`);

    const ready = await waitForAutoDubReady(50000);
    if (ready.ready) {
      return {
        baseUrl: AUTO_DUB_BASE_URL,
        started: true
      };
    }

    const childAlive = isStartedChildAlive({ child });
    const tail = await readRecentLogTail(logFilePath, 12);

    if (attempt === 1) {
      logger(`auto_dub_web 首次启动未就绪（${ready.lastError || '无详细错误'}），正在自动重试一次...`);
      if (childAlive) {
        try {
          child.kill('SIGTERM');
        } catch {
          // noop
        }
      }
      startedServers.delete(projectPath);
      await killAutoDubByPort(logger);
      await sleep(1000);
      return null;
    }

    const details = [];
    if (ready.lastError) {
      details.push(`健康检查：${ready.lastError}`);
    }
    details.push(`日志：${logFilePath}`);
    if (tail) {
      details.push(`最近日志：\n${tail}`);
    }

    throw new Error(
      `auto_dub_web 服务启动超时。可在目录手动执行：${nodeBinary} server.mjs\n${details.join('\n')}`
    );
  };

  const first = await startAttempt(1);
  if (first) {
    return first;
  }

  const second = await startAttempt(2);
  if (!second) {
    throw new Error(`auto_dub_web 服务启动失败：${logFilePath}`);
  }

  return second;
}

async function fetchVoiceCloneStatus(timeoutMs = 6000) {
  try {
    const health = await fetchVoiceboxApi('/health', {
      method: 'GET',
      timeoutMs
    });
    let profiles = [];
    let profileMessage = '';
    try {
      profiles = await getVoiceCloneProfiles(Math.max(timeoutMs, 12000));
    } catch (error) {
      profileMessage = String(error?.message || error || '').trim();
    }

    return {
      available: true,
      message: profileMessage || '语音克隆后端可用',
      profiles,
      health
    };
  } catch (error) {
    return {
      available: false,
      message: String(error?.message || error || '语音克隆状态检测失败'),
      profiles: []
    };
  }
}

async function waitForVoiceCloneReady(timeoutMs = 60000) {
  const startedAt = Date.now();
  let lastStatus = {
    available: false,
    message: '语音克隆状态检测失败',
    profiles: []
  };
  while (Date.now() - startedAt < timeoutMs) {
    lastStatus = await fetchVoiceCloneStatus(5000);
    if (lastStatus.available) {
      return {
        ready: true,
        status: lastStatus
      };
    }
    await sleep(1000);
  }
  return {
    ready: false,
    status: lastStatus
  };
}

async function ensureVoiceCloneBackend(projectPath, logger = () => {}, progress = () => {}, options = {}) {
  const forceRepair = Boolean(options?.forceRepair);
  const tracked = startedVoiceboxBackends.get(projectPath);
  const trackedAlive = isStartedChildAlive(tracked);
  const logFilePath = tracked?.logFilePath || await getVoiceboxLogFilePath(projectPath);
  progress({
    status: 'running',
    step: '检查后端',
    percent: 24,
    message: '正在检测语音克隆后端状态...'
  });

  const initial = await fetchVoiceCloneStatus(5000);
  if (initial.available && !forceRepair) {
    logger(trackedAlive ? '语音克隆后端已就绪。' : '检测到已有可用 voicebox 后端，直接复用。');
    return;
  }
  if (initial.available && forceRepair) {
    logger('语音克隆后端已运行，先重启后端再执行依赖修复。');
    if (trackedAlive) {
      try {
        getStartedChild(tracked)?.kill('SIGTERM');
      } catch {
        // noop
      }
    }
    startedVoiceboxBackends.delete(projectPath);
    await requestVoiceCloneShutdown();
    await sleep(800);
    await killVoiceboxByPort(logger);
    await sleep(600);
  }

  const scriptsDir = path.join(projectPath, 'scripts');
  const setupScript = path.join(scriptsDir, 'setup_voicebox_backend.sh');
  const startScript = path.join(scriptsDir, 'start_voicebox_backend.sh');
  const venvDir = path.join(projectPath, '.venv-voicebox');
  const venvPython = await resolveVoiceboxVenvPython(venvDir);
  const backendMain = path.join(projectPath, 'vendor', 'voicebox', 'backend', 'main.py');
  const backendRequirements = path.join(projectPath, 'vendor', 'voicebox', 'backend', 'requirements.txt');
  const dataDir = path.join(projectPath, 'data');
  const modelsDir = path.join(dataDir, 'models');

  const [hasSetupScript, hasStartScript, hasVenvPython, hasBackendMain, hasBackendRequirements] = await Promise.all([
    exists(setupScript),
    exists(startScript),
    exists(venvPython),
    exists(backendMain),
    exists(backendRequirements)
  ]);

  if (!hasStartScript && process.platform !== 'win32') {
    throw new Error('缺少 start_voicebox_backend.sh，无法启动语音克隆后端。');
  }

  const readPythonVersion = (pythonPath) => {
    return new Promise((resolve) => {
      const child = spawn(pythonPath, ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'], {
        stdio: ['ignore', 'pipe', 'ignore']
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk || '');
      });
      child.once('error', () => resolve(''));
      child.once('close', (code) => {
        if (code !== 0) {
          resolve('');
          return;
        }
        resolve(stdout.trim());
      });
    });
  };

  const isSupportedVersion = (versionText) => {
    const match = String(versionText || '').match(/^(\d+)\.(\d+)$/);
    if (!match) {
      return false;
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major === 3 && minor >= 10 && minor <= 12;
  };

  let venvOk = hasVenvPython;
  if (hasVenvPython) {
    const venvVersion = await readPythonVersion(venvPython);
    if (!isSupportedVersion(venvVersion)) {
      logger(`检测到旧版虚拟环境 Python ${venvVersion || 'unknown'}，将自动重建。`);
      await fs.rm(venvDir, { recursive: true, force: true });
      venvOk = false;
    }
  }

  const hasCompleteBackendRepo = hasBackendMain && hasBackendRequirements;
  if (!hasCompleteBackendRepo) {
    logger('检测到 voicebox 仓库结构不完整，准备重新初始化。');
  }

  const needsSetup = forceRepair || !(venvOk && hasCompleteBackendRepo);
  const needsBash = needsSetup || process.platform !== 'win32';
  const bashBinary = needsBash ? await resolveBashBinary() : '';
  if (needsBash && !bashBinary) {
    throw new Error('未找到 bash，无法初始化或启动 voicebox 后端。');
  }

  if (needsSetup) {
    if (!hasSetupScript) {
      throw new Error('缺少 setup_voicebox_backend.sh，无法初始化语音克隆环境。');
    }

    const pythonBinary = await resolvePythonBinary();
    if (!pythonBinary) {
      throw new Error('未找到可用 Python 3.10~3.12。');
    }

    progress({
      status: 'running',
      step: '安装依赖',
      percent: 40,
      message: `${forceRepair ? '正在修复 voicebox 依赖' : '首次运行，正在安装 voicebox 依赖'}（Python: ${pythonBinary}）...`
    });
    logger(`${forceRepair ? '开始修复' : '开始初始化'} voicebox 环境（python: ${pythonBinary}）。`);

    const env = {
      ...process.env,
      PYTHON_BIN: pythonBinary
    };
    await runScriptWithLogs(setupScript, {
      cwd: projectPath,
      env,
      shellBinary: bashBinary,
      logger,
      logPrefix: '[voicebox setup] '
    });
  }

  const resolvedVenvPython = await resolveVoiceboxVenvPython(venvDir);
  if (await exists(resolvedVenvPython)) {
    const hasLibrosaCore = await canImportPythonModule(resolvedVenvPython, 'librosa.core', projectPath);
    if (!hasLibrosaCore) {
      progress({
        status: 'running',
        step: '修复依赖',
        percent: 68,
        message: '检测到 librosa.core 缺失，正在执行定向修复...'
      });
      logger('检测到 librosa.core 缺失，执行 pip 定向修复。');
      await runCommandWithLogs(resolvedVenvPython, [
        '-m',
        'pip',
        'install',
        '--upgrade',
        'librosa==0.10.2.post1',
        'soundfile>=0.12.0,<0.14'
      ], {
        cwd: projectPath,
        env: withRuntimeEnv(),
        logger,
        logPrefix: '[voicebox fix] '
      });

      const fixed = await canImportPythonModule(resolvedVenvPython, 'librosa.core', projectPath);
      if (!fixed) {
        throw new Error('voicebox 依赖修复失败：librosa.core 仍不可用。');
      }
      logger('librosa.core 修复完成。');
    }
  }

  const existing = startedVoiceboxBackends.get(projectPath);
  const existingChild = getStartedChild(existing);
  if (!existingChild || existingChild.exitCode !== null) {
    progress({
      status: 'running',
      step: '启动后端',
      percent: 62,
      message: '正在启动 voicebox 后端服务...'
    });
    logger('启动 voicebox 后端服务。');

    const launchCommand = process.platform === 'win32'
      ? resolvedVenvPython
      : bashBinary;
    const launchArgs = process.platform === 'win32'
      ? [
          '-u',
          '-m',
          'backend.main',
          '--host',
          '127.0.0.1',
          '--port',
          String(VOICEBOX_PORT),
          '--data-dir',
          dataDir
        ]
      : [startScript];
    const launchEnv = process.platform === 'win32'
      ? withRuntimeEnv({
          PYTHONUNBUFFERED: '1',
          PYTHONPATH: buildVoiceboxPythonPath(projectPath),
          VOICEBOX_DATA_DIR: dataDir,
          VOICEBOX_MODELS_DIR: modelsDir
        })
      : withRuntimeEnv({
          PYTHONUNBUFFERED: '1'
        });

    const child = await spawnLoggedDetachedProcess(launchCommand, launchArgs, {
      cwd: projectPath,
      env: launchEnv,
      logFilePath,
      label: 'voicebox'
    });
    child.unref();
    startedVoiceboxBackends.set(projectPath, {
      child,
      logFilePath
    });
  }

  progress({
    status: 'running',
    step: '等待就绪',
    percent: 74,
    message: '等待 voicebox 后端就绪...'
  });

  const ready = await waitForVoiceCloneReady(process.platform === 'win32' ? 180000 : 70000);
  if (!ready.ready) {
    const details = [];
    if (ready.status?.message) {
      details.push(`健康检查：${ready.status.message}`);
    }
    details.push(`日志：${logFilePath}`);
    const tail = await readRecentLogTail(logFilePath, 20, 16384);
    if (tail) {
      details.push(`最近日志：\n${tail}`);
    }
    throw new Error(`语音克隆后端不可用。已尝试自动安装/启动。\n${details.join('\n')}`);
  }
  logger('voicebox 后端已就绪。');
  await prewarmVoiceCloneModel('qwen-tts-1.7B', logger);
}

function toFileNameFromOutputUrl(outputUrl) {
  if (!outputUrl || !outputUrl.startsWith('/outputs/')) {
    return '';
  }
  return decodeURIComponent(outputUrl.slice('/outputs/'.length));
}

function getAudioMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.ogg') return 'audio/ogg';
  return 'application/octet-stream';
}

function isDuplicateProfileNameError(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('unique constraint failed: profiles.name')
    || text.includes('profiles.name')
    || text.includes('already exists')
    || text.includes('重复');
}

function isMissingLibrosaError(message) {
  const text = String(message || '').toLowerCase();
  return text.includes("no module named 'librosa.core'")
    || text.includes('no module named "librosa.core"')
    || text.includes('librosa.core');
}

function buildUniqueProfileName(baseName, existingNames) {
  const normalizedBase = String(baseName || '').trim() || 'AntBot';
  if (!existingNames.has(normalizedBase)) {
    return normalizedBase;
  }
  for (let i = 2; i <= 9999; i += 1) {
    const candidate = `${normalizedBase}-${i}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }
  return `${normalizedBase}-${Date.now()}`;
}

async function createVoiceCloneProfileWithAutoDub({
  projectPath,
  samplePath,
  referenceText,
  profileName,
  language = 'zh',
  log = () => {},
  progress = () => {}
}) {
  const logger = typeof log === 'function' ? log : (() => {});

  progress({
    status: 'running',
    step: '启动服务',
    percent: 18,
    message: '正在启动 auto_dub_web 服务...'
  });
  await ensureAutoDubServer(projectPath, logger);
  await ensureVoiceCloneBackend(projectPath, logger, progress);

  progress({
    status: 'running',
    step: '上传样本',
    percent: 84,
    message: '正在上传样本音频和参考文本...'
  });

  const statusSnapshot = await fetchVoiceCloneStatus(6000);
  const existingNames = new Set(
    (statusSnapshot.profiles || [])
      .map((item) => String(item?.name || '').trim())
      .filter(Boolean)
  );

  const baseProfileName = (profileName || '').trim() || `AntBot-${Date.now()}`;
  let selectedProfileName = buildUniqueProfileName(baseProfileName, existingNames);
  if (selectedProfileName !== baseProfileName) {
    logger(`检测到重名档案，自动改名为：${selectedProfileName}`);
  }

  const audioBuffer = await fs.readFile(samplePath);
  let payload = null;
  let lastError = null;
  let repairedMissingLibrosa = false;
  logger(`正在创建语音档案：${selectedProfileName}`);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const createdProfile = await createVoiceCloneProfileDirect({
        profileName: selectedProfileName,
        language: (language || '').trim() || 'zh',
        referenceText: (referenceText || '').trim(),
        audioBuffer,
        sampleFileName: path.basename(samplePath),
        sampleMimeType: getAudioMimeType(samplePath)
      });
      payload = {
        ok: true,
        profile: createdProfile
      };
      break;
    } catch (error) {
      payload = null;
      const message = String(error?.message || error || '语音克隆创建失败');
      if (isMissingLibrosaError(message) && !repairedMissingLibrosa) {
        repairedMissingLibrosa = true;
        progress({
          status: 'running',
          step: '修复依赖',
          percent: 70,
          message: '检测到 librosa 缺失，正在自动修复依赖并重试...'
        });
        logger('检测到 librosa 缺失，自动修复 voicebox 依赖后重试。');
        await ensureVoiceCloneBackend(projectPath, logger, progress, { forceRepair: true });
        logger(`修复完成，继续重试创建语音档案：${selectedProfileName}`);
        continue;
      }
      if (isDuplicateProfileNameError(message) && attempt < 3) {
        existingNames.add(selectedProfileName);
        const nextName = buildUniqueProfileName(baseProfileName, existingNames);
        logger(`档案名已存在，自动重试：${selectedProfileName} -> ${nextName}`);
        selectedProfileName = nextName;
        continue;
      }

      lastError = new Error(message);
      break;
    }
  }

  if (!payload?.profile?.id) {
    throw lastError || new Error('语音克隆创建失败：未返回档案信息。');
  }

  progress({
    status: 'running',
    step: '生成档案',
    percent: 92,
    message: '语音克隆档案已创建。'
  });

  return {
    voiceId: payload.profile.id,
    profileName: payload.profile.name || profileName || '',
    profileLanguage: payload.profile.language || language || 'zh'
  };
}

async function resolveVoiceCloneProfile({
  projectPath,
  voiceCloneId,
  voiceCloneProfileName,
  voiceCloneSamplePath,
  voiceCloneReferenceText,
  language = 'zh',
  log = () => {}
}) {
  const desiredId = String(voiceCloneId || '').trim();
  const desiredName = String(voiceCloneProfileName || '').trim();
  const samplePath = String(voiceCloneSamplePath || '').trim();
  const referenceText = String(voiceCloneReferenceText || '').trim();

  if (!desiredId && !desiredName) {
    return {
      useVoiceClone: false,
      profileId: '',
      language
    };
  }

  await ensureVoiceCloneBackend(projectPath, log, () => {});
  const profiles = await getVoiceCloneProfiles();
  const normalizedProfiles = Array.isArray(profiles) ? profiles : [];

  if (desiredId) {
    const matchedById = normalizedProfiles.find((item) => String(item?.id || '').trim() === desiredId);
    if (matchedById) {
      return {
        useVoiceClone: true,
        profileId: desiredId,
        profileName: matchedById.name || desiredName,
        language: matchedById.language || language
      };
    }
  }

  if (desiredName) {
    const matchedByName = normalizedProfiles.find((item) => String(item?.name || '').trim() === desiredName);
    if (matchedByName) {
      log(`已将失效的语音档案 ID 自动对齐为当前档案：${matchedByName.name} (${matchedByName.id})`);
      return {
        useVoiceClone: true,
        profileId: String(matchedByName.id || '').trim(),
        profileName: matchedByName.name || desiredName,
        language: matchedByName.language || language
      };
    }
  }

  if (normalizedProfiles.length === 1) {
    const onlyProfile = normalizedProfiles[0];
    log(`当前仅检测到一个语音档案，已自动使用：${onlyProfile.name} (${onlyProfile.id})`);
    return {
      useVoiceClone: true,
      profileId: String(onlyProfile.id || '').trim(),
      profileName: onlyProfile.name || desiredName,
      language: onlyProfile.language || language
    };
  }

  const availableNames = normalizedProfiles
    .map((item) => String(item?.name || '').trim())
    .filter(Boolean)
    .slice(0, 8);

  if (samplePath && referenceText) {
    try {
      await fs.access(samplePath);
      log('当前保存的克隆音色未找到，正在使用已保存样本自动恢复语音档案...');
      const existingNames = new Set(
        normalizedProfiles
          .map((item) => String(item?.name || '').trim())
          .filter(Boolean)
      );
      const baseProfileName = desiredName || `AntBot-${Date.now()}`;
      const selectedProfileName = buildUniqueProfileName(baseProfileName, existingNames);
      if (selectedProfileName !== baseProfileName) {
        log(`检测到档案名冲突，自动恢复为新档案名：${selectedProfileName}`);
      }
      const audioBuffer = await fs.readFile(samplePath);
      const createdProfile = await createVoiceCloneProfileDirect({
        profileName: selectedProfileName,
        language: (language || '').trim() || 'zh',
        referenceText,
        audioBuffer,
        sampleFileName: path.basename(samplePath),
        sampleMimeType: getAudioMimeType(samplePath)
      });
      log(`已自动恢复语音档案：${createdProfile.name || selectedProfileName} (${createdProfile.id})`);
      return {
        useVoiceClone: true,
        profileId: String(createdProfile.id || '').trim(),
        profileName: createdProfile.name || selectedProfileName,
        language: createdProfile.language || language,
        recovered: true
      };
    } catch (error) {
      log(`自动恢复语音档案失败：${String(error?.message || error)}`);
    }
  }

  throw new Error(
    '当前保存的克隆音色已失效或不存在，请重新在“克隆”面板生成一次音色。'
    + (availableNames.length ? ` 当前可用档案：${availableNames.join('、')}` : ' 当前后端未检测到可用档案。')
  );
}

async function processWithAutoDub({
  projectPath,
  inputVideoPath,
  subtitlePath,
  outputPath,
  subtitleEnabled = true,
  voiceoverEnabled = true,
  voiceCloneId,
  voiceCloneProfileName,
  voiceCloneSamplePath,
  voiceCloneReferenceText,
  voiceCloneLanguage,
  voiceSpeed,
  subtitleTextColor,
  subtitleStrokeColor,
  subtitlePositionPercent,
  log = () => {}
}) {
  await ensureAutoDubServer(projectPath, log);
  const voiceoverOn = voiceoverEnabled !== false;
  const subtitleOn = voiceoverOn && subtitleEnabled !== false;
  const needsSubtitleFile = voiceoverOn || subtitleOn;

  const voiceClone = voiceoverOn
    ? await resolveVoiceCloneProfile({
      projectPath,
      voiceCloneId,
      voiceCloneProfileName,
      voiceCloneSamplePath,
      voiceCloneReferenceText,
      language: voiceCloneLanguage || 'zh',
      log
    })
    : {
      useVoiceClone: false,
      profileId: '',
      language: voiceCloneLanguage || 'zh'
    };

  if (needsSubtitleFile && !subtitlePath) {
    throw new Error('缺少字幕文件，无法进行配音或字幕处理。');
  }

  const [videoBuffer, subtitleBuffer] = await Promise.all([
    fs.readFile(inputVideoPath),
    needsSubtitleFile ? fs.readFile(subtitlePath) : null
  ]);

  const useVoiceClone = Boolean(voiceoverOn && voiceClone.useVoiceClone && voiceClone.profileId);
  const autoDubLogFilePath = await getAutoDubLogFilePath(projectPath);
  const requestFields = {
    tts_mode: useVoiceClone ? 'voice_clone' : 'system',
    voice: 'Tingting',
    rate: '220',
    clone_profile_id: useVoiceClone ? voiceClone.profileId : '',
    clone_language: voiceClone.language || 'zh',
    dub_speed: String(voiceSpeed || 1.1),
    subtitle_position: 'bottom',
    subtitle_margin: '120',
    subtitle_text_color: String(subtitleTextColor || '#FFA100'),
    subtitle_stroke_color: String(subtitleStrokeColor || '#000000'),
    subtitle_y_percent: String(
      Math.max(0, Math.min(100, Number.isFinite(Number(subtitlePositionPercent)) ? Number(subtitlePositionPercent) : 12))
    ),
    subtitle_enabled: subtitleOn ? 'on' : 'off',
    voiceover_enabled: voiceoverOn ? 'on' : 'off',
    keep_original_audio: 'on',
    original_audio_level: '45',
    dub_audio_level: '180'
  };
  const buildAutoDubFailureDetails = async () => {
    const details = [];
    const health = await waitForAutoDubReady(4000);
    details.push(`健康检查：${health.ready ? '服务可达' : (health.lastError || `HTTP ${health.status || 0}`)}`);
    details.push(`日志：${autoDubLogFilePath}`);
    const tail = await readRecentLogTail(autoDubLogFilePath, 20, 16384);
    if (tail) {
      details.push(`最近日志：\n${tail}`);
    }
    return details;
  };

  log(`已向 auto_dub_web 提交处理请求（配音模式：${voiceoverOn ? (useVoiceClone ? 'voice_clone' : 'system') : 'off'}）。`);

  let response;
  try {
    response = await postAutoDubProcessRequest({
      fields: requestFields,
      files: [
        {
          fieldName: 'video_file',
          fileName: path.basename(inputVideoPath),
          contentType: 'video/mp4',
          buffer: videoBuffer
        },
        ...(needsSubtitleFile
          ? [{
            fieldName: 'srt_file',
            fileName: path.basename(subtitlePath),
            contentType: 'application/x-subrip',
            buffer: subtitleBuffer
          }]
          : [])
      ]
    });
  } catch (error) {
    const details = await buildAutoDubFailureDetails();
    throw new Error(
      `auto_dub_web 请求失败：${stringifyErrorWithCause(error)}\n${details.join('\n')}`
    );
  }

  log(`auto_dub_web 已返回响应（HTTP ${response.statusCode}）。`);

  let payload;
  try {
    payload = response.bodyText ? JSON.parse(response.bodyText) : null;
  } catch {
    payload = null;
  }

  if (response.statusCode < 200 || response.statusCode >= 300 || !payload?.ok) {
    const message = payload?.error || `auto_dub_web 处理失败（HTTP ${response.statusCode}）`;
    const details = await buildAutoDubFailureDetails();
    throw new Error(`${message}\n${details.join('\n')}`);
  }

  const expectedSubtitleMode = subtitleOn ? 'burned' : 'none';
  if (payload.subtitleMode !== expectedSubtitleMode) {
    throw new Error(`字幕模式异常（subtitleMode=${payload.subtitleMode || 'unknown'}），已停止输出。`);
  }

  const outputName = toFileNameFromOutputUrl(payload.outputUrl);
  if (!outputName) {
    throw new Error('auto_dub_web 未返回输出文件路径。');
  }

  const sourceOutputPath = path.join(projectPath, 'outputs', outputName);
  await fs.copyFile(sourceOutputPath, outputPath);

  return {
    mode: 'auto_dub_web',
    outputPath,
    subtitleMode: payload.subtitleMode,
    dubSource: payload.dubSource,
    voiceClone: useVoiceClone
      ? {
        voiceId: voiceClone.profileId,
        profileName: voiceClone.profileName || voiceCloneProfileName || '',
        language: voiceClone.language || voiceCloneLanguage || 'zh',
        recovered: Boolean(voiceClone.recovered)
      }
      : null
  };
}

module.exports = {
  detectAutoDubProject,
  resolveAutoDubProjectPath,
  createVoiceCloneProfileWithAutoDub,
  processWithAutoDub
};
