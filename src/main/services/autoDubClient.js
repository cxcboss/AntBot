const fsNative = require('node:fs');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { constants: fsConstants } = require('node:fs');
const { buildRuntimePath, withRuntimeEnv } = require('./runtimeEnv');

const VOICEBOX_PORT = 17493;
const VOICEBOX_BASE_URL = `http://127.0.0.1:${VOICEBOX_PORT}`;
const startedVoiceboxBackends = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
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
    return major === 3 && minor >= 10 && minor <= 13;
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
    pushCandidate(path.join(localAppData, 'Programs', 'Python', 'Python313', 'python.exe'));
    pushCandidate(path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'));
    pushCandidate(path.join(localAppData, 'Programs', 'Python', 'Python311', 'python.exe'));
    pushCandidate(path.join(localAppData, 'Programs', 'Python', 'Python310', 'python.exe'));
    pushCandidate(path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'));
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
    throw new Error(`未找到可用 Python 3.10~3.13。检测到但不兼容：${unsupported.join(', ')}`);
  }
  return '';
}

async function spawnDetachedProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
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

async function getVoiceboxLogFilePath(projectPath) {
  const safeProjectName = path.basename(projectPath || 'service').replace(/[^a-zA-Z0-9._-]/g, '_') || 'service';
  const logDir = path.join(getRuntimeRoot(), 'logs');
  await fs.mkdir(logDir, { recursive: true });
  return path.join(logDir, `${safeProjectName}.voicebox.log`);
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
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
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
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
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
      stdio: 'ignore',
      windowsHide: true
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
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
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
  const timeoutMs = options.timeoutMs || 6000;
  const method = options.method || 'GET';
  const isFormData = options.body != null && typeof options.body === 'object' && options.body.constructor?.name === 'FormData';
  const url = `${VOICEBOX_BASE_URL}${endpoint}`;

  // FormData 用 fetch()（原生支持 multipart），但需要手动设置 Content-Type
  if (isFormData) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Node.js fetch 不自动为 FormData 设置正确的 Content-Type，需要手动处理
      const boundary = '----VoiceboxFormBoundary' + Date.now().toString(36);
      const parts = [];
      for (const [key, value] of options.body.entries()) {
        parts.push(`--${boundary}\r\n`);
        if (value && typeof value === 'object' && 'arrayBuffer' in value) {
          // Blob/File-like object
          const buf = Buffer.from(await value.arrayBuffer());
          const fname = value.name || 'file';
          const ctype = value.type || 'application/octet-stream';
          parts.push(`Content-Disposition: form-data; name="${key}"; filename="${fname}"\r\nContent-Type: ${ctype}\r\n\r\n`);
          parts.push(buf);
          parts.push('\r\n');
        } else {
          parts.push(`Content-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}\r\n`);
        }
      }
      parts.push(`--${boundary}--\r\n`);
      const bodyBuf = Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p) : p));

      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: bodyBuf,
        signal: controller.signal
      });
      clearTimeout(timer);
      const text = await resp.text();
      let payload;
      try { payload = JSON.parse(text); } catch { payload = text; }
      if (!resp.ok) {
        const detail = typeof payload === 'object' && payload ? JSON.stringify(payload.detail || payload.error || payload) : String(payload || '');
        throw new Error(`Voice clone 引擎请求失败 (${resp.status}): ${detail.slice(0, 300)}`);
      }
      return payload;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  const headers = { ...(options.headers || {}) };
  let bodyData = options.body;
  if (bodyData && typeof bodyData === 'object' && !(bodyData instanceof Buffer)) {
    bodyData = JSON.stringify(bodyData);
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`voicebox 请求超时(${timeoutMs}ms): ${endpoint}`)); }, timeoutMs);
    const req = http.request({
      hostname: '127.0.0.1', port: VOICEBOX_PORT, path: endpoint, method, headers, timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', e => { clearTimeout(timer); reject(e); });
      res.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks).toString('utf8');
        let payload;
        try { payload = JSON.parse(body); } catch { payload = body; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = typeof payload === 'object' && payload ? JSON.stringify(payload.detail || payload.error || payload) : String(payload || '');
          return reject(new Error(`Voice clone 引擎请求失败 (${res.statusCode}): ${detail.slice(0, 200)}`));
        }
        resolve(payload);
      });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function getVoiceCloneProfiles(timeoutMs = 20000) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const payload = await fetchVoiceboxApi('/profiles', { method: 'GET', timeoutMs });
      return Array.isArray(payload) ? payload : [];
    } catch (e) {
      lastError = e;
      // 写入诊断日志
      try {
        const logDir = path.join(os.homedir(), 'AntBot', 'logs');
        const files = require('node:fs').readdirSync(logDir).filter(f => f.startsWith('app-') && f.endsWith('.log')).sort();
        if (files.length) {
          const msg = `[voicebox] getVoiceCloneProfiles 失败(第${attempt}次): ${e.message}`;
          require('node:fs').appendFileSync(path.join(logDir, files[files.length - 1]), msg + '\n');
          // 读取 voicebox 后端日志尾部
          try {
            const vbLogDir = path.join(getRuntimeRoot(), 'logs');
            const vbFiles = require('node:fs').readdirSync(vbLogDir).filter(f => f.includes('voicebox') && f.endsWith('.log')).sort();
            if (vbFiles.length) {
              const tail = require('node:fs').readFileSync(path.join(vbLogDir, vbFiles[vbFiles.length - 1]), 'utf8').split('\n').slice(-10).join('\n');
              require('node:fs').appendFileSync(path.join(logDir, files[files.length - 1]), `[voicebox] 后端日志尾部:\n${tail}\n`);
            }
          } catch {}
        }
      } catch {}
      if (attempt < 3) await sleep(2000);
    }
  }
  throw lastError;
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
    if (status?.loaded) {
      return;
    }
    if (status?.downloading) {
      logger(`检测到语音模型 ${normalizedName} 正在后台下载/加载。`);
      return;
    }

    // 已下载但未加载（或未下载）都触发后端 download 接口：
    // 后端 load_model 对已下载模型命中本地缓存直接加载，不会重新下载。
    await triggerVoiceCloneModelDownload(normalizedName, 15000);
    logger(status?.downloaded
      ? `已触发语音模型 ${normalizedName} 后台加载。`
      : `已触发语音模型 ${normalizedName} 后台下载。首次生成语音时会自动等待模型准备完成。`);
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

  // 检测 Voicebox 后端是否可用（scripts + vendor/voicebox）
  const startScript = path.join(projectPath, 'scripts', 'start_voicebox_backend.sh');
  const voiceboxBackend = path.join(projectPath, 'vendor', 'voicebox', 'backend');

  const [hasScript, hasBackend] = await Promise.all([
    exists(startScript),
    exists(voiceboxBackend)
  ]);

  return hasScript && hasBackend;
}

function getElectronApp() {
  try {
    const electron = require('electron');
    return electron?.app || null;
  } catch {
    return null;
  }
}

async function resolveAutoDubProjectPath(explicitPath) {
  const localVendorPath = path.resolve(process.cwd(), 'vendors', 'auto_dub_web');
  const resourcesCandidate = path.resolve(process.resourcesPath || '', 'vendors', 'auto_dub_web');

  if (explicitPath && await detectAutoDubProject(explicitPath)) {
    return explicitPath;
  }

  if (await detectAutoDubProject(localVendorPath)) {
    return localVendorPath;
  }

  if (await detectAutoDubProject(resourcesCandidate)) {
    // 打包态：资源位于只读目录（Windows 上为 C:\Program Files\搬运蚁\resources）。
    // 复制到 ~/AntBot/auto-dub-web 再运行，避免 __pycache__ 写入拒绝、模型落盘失败。
    if (process.platform === 'win32') {
      const writablePath = await ensureWritableAutoDubProject(resourcesCandidate);
      if (writablePath) {
        return writablePath;
      }
    }
    return resourcesCandidate;
  }

  return '';
}

// 将 auto_dub_web 后端复制到 ~/AntBot/auto-dub-web（可写目录），照 bridgeServiceManager 模式。
async function ensureWritableAutoDubProject(sourcePath) {
  const targetDir = path.join(os.homedir(), 'AntBot', 'auto-dub-web');
  const markerPath = path.join(targetDir, '.antbot-copy-version');
  try {
    // 已复制过且完整 → 直接复用；但若 bundled 后端更新（App 升级后代码变更），需重新复制
    if (await detectAutoDubProject(targetDir)) {
      const needsRefresh = await (async () => {
        try {
          const sourceMain = path.join(sourcePath, 'vendor', 'voicebox', 'backend', 'main.py');
          const targetMain = path.join(targetDir, 'vendor', 'voicebox', 'backend', 'main.py');
          const [sourceStat, targetStat] = await Promise.all([
            fs.stat(sourceMain).catch(() => null),
            fs.stat(targetMain).catch(() => null),
          ]);
          return sourceStat && (!targetStat || sourceStat.mtimeMs > targetStat.mtimeMs + 1000);
        } catch {
          return false;
        }
      })();
      if (!needsRefresh) {
        return targetDir;
      }
      console.log('[voicebox] 检测到后端源码更新，重新复制到可写目录...');
    }
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(targetDir, { recursive: true });
    await fs.cp(sourcePath, targetDir, { recursive: true });
    await fs.writeFile(markerPath, new Date().toISOString(), 'utf8').catch(() => {});
    console.log(`[voicebox] 后端已复制到可写目录：${targetDir}`);
    return targetDir;
  } catch (error) {
    console.log(`[voicebox] 复制后端到可写目录失败，回退只读路径：${String(error?.message || error).slice(0, 200)}`);
    return '';
  }
}

async function fetchVoiceCloneStatus(timeoutMs = 6000) {
  try {
    const health = await fetchVoiceboxApi('/health', {
      method: 'GET',
      timeoutMs
    });

    // 必须等模型加载完成才算就绪，否则后续 API 调用会失败
    if (!health.model_loaded) {
      return {
        available: false,
        message: `模型加载中（${health.model_downloaded ? '已下载' : '未下载'}）`,
        profiles: [],
        health
      };
    }

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

// ─── Windows 原生 voicebox 初始化（无需 Git Bash）────────────────────────────
// 复用 ipc/voicebox.js 的 python -m venv + pip install 流程：
// 1. 创建 venv（如不存在）
// 2. 升级 pip + 基础包
// 3. 安装 requirements.txt（Python 3.13 自动改写 numba 约束）
// 4. 检测 NVIDIA GPU → 有则装 CUDA PyTorch（requirements 装完后再装，避免被覆盖）

async function runCommandCollect(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: withRuntimeEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    if (options.timeout) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGTERM'); } catch {}
        resolve({ ok: false, code: -2, stdout, stderr, error: `命令超时(${(options.timeout / 1000).toFixed(0)}s)` });
      }, options.timeout);
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr, error: String(error?.message || error) });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
  });
}

async function detectNvidiaGpuName() {
  const result = await runCommandCollect('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 15000 });
  if (result.ok) {
    const name = String(result.stdout || '').trim().split('\n')[0]?.trim();
    return name || '';
  }
  return '';
}

async function detectInstalledTorchSource(venvDir, logger) {
  const venvPython = await resolveVoiceboxVenvPython(venvDir);
  if (!(await exists(venvPython))) {
    return 'none';
  }
  const result = await runCommandCollect(
    venvPython,
    ['-c', 'import torch; print(torch.__version__); print(torch.cuda.is_available())'],
    { timeout: 20000 },
  );
  if (!result.ok) {
    logger('[voicebox] 无法检测 torch 来源（torch 未安装或导入失败）。');
    return 'unknown';
  }
  const lines = String(result.stdout || '').trim().split('\n');
  const version = lines[0]?.trim() || '';
  const cudaAvailable = String(lines[1] || '').trim() === 'True';
  logger(`[voicebox] torch ${version}${cudaAvailable ? '（CUDA 可用）' : '（CPU）'}`);
  return cudaAvailable ? 'cuda' : 'cpu';
}

// Windows 上安装 CUDA PyTorch（requirements 装完后调用，--no-deps 避免覆盖其它依赖）
async function installWindowsCudaTorch({ venvDir, projectPath, gpuName, logger }) {
  const venvPython = await resolveVoiceboxVenvPython(venvDir);
  logger(`[voicebox] 检测到 NVIDIA GPU：${gpuName}，正在安装 CUDA PyTorch...`);
  const result = await runCommandCollect(
    venvPython,
    [
      '-u', '-m', 'pip', 'install', 'torch', 'torchaudio',
      '--index-url', 'https://download.pytorch.org/whl/cu121',
      '--force-reinstall', '--no-deps',
      '--timeout', '60', '--retries', '5',
    ],
    { cwd: projectPath, timeout: 90 * 60 * 1000 },
  );
  if (!result.ok) {
    logger(`[voicebox] CUDA PyTorch 安装失败（exit ${result.code}）：${String(result.stderr || result.error || '').slice(0, 300)}`);
  } else {
    logger('[voicebox] CUDA PyTorch 安装完成。');
  }
}

async function setupVoiceboxBackendWindowsNative({
  pythonBinary,
  venvDir,
  projectPath,
  venvPython,
  requirementsPath,
  gpuMode,
  logger,
  progress,
}) {
  // 1. 创建 venv
  const venvExists = await exists(venvPython);
  if (!venvExists) {
    progress({ status: 'running', step: '安装依赖', percent: 42, message: '正在创建虚拟环境...' });
    logger('[voicebox] 创建虚拟环境...');
    const venvResult = await runCommandCollect(pythonBinary, ['-m', 'venv', venvDir], { cwd: projectPath, timeout: 120000 });
    if (!venvResult.ok) {
      const detail = String(venvResult.stderr || venvResult.error || '').slice(0, 300);
      throw new Error(`虚拟环境创建失败（exit ${venvResult.code}）：${detail}\n请确认已安装 Python 3.10-3.13（Microsoft Store 版 Python 可能缺少 venv 模块，请从 python.org 安装）`);
    }
  }

  // 2. 升级 pip + 基础包
  progress({ status: 'running', step: '安装依赖', percent: 46, message: '正在升级 pip...' });
  const pipUpgrade = await runCommandCollect(
    venvPython,
    ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel', 'setuptools', 'huggingface_hub'],
    { cwd: projectPath, timeout: 180000 },
  );
  if (!pipUpgrade.ok) {
    throw new Error(`pip 升级失败（exit ${pipUpgrade.code}）：${String(pipUpgrade.stderr || pipUpgrade.error || '').slice(0, 200)}`);
  }

  // 3. Python 3.13 numba 约束改写
  let effectiveRequirementsPath = requirementsPath;
  const pyVersion = await runCommandCollect(venvPython, ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'], { timeout: 20000 });
  const pyMinor = Number((String(pyVersion.stdout || '').match(/^3\.(\d+)$/) || [])[1] || 0);
  if (pyMinor >= 13) {
    try {
      const raw = await fs.readFile(requirementsPath, 'utf8');
      const patched = raw.replace(/numba>=0\.60\.0,<0\.61\.0/g, 'numba>=0.61.2,<0.62.0');
      if (patched !== raw) {
        const tmpReqs = path.join(os.tmpdir(), `antbot-voicebox-reqs-${Date.now()}.txt`);
        await fs.writeFile(tmpReqs, patched, 'utf8');
        effectiveRequirementsPath = tmpReqs;
        logger('[voicebox] 检测到 Python 3.13，已自动适配 numba 版本约束');
      }
    } catch (error) {
      logger(`[voicebox] requirements 改写失败，按原文件安装：${String(error?.message || error).slice(0, 150)}`);
    }
  }

  // 4. 安装 requirements
  progress({ status: 'running', step: '安装依赖', percent: 50, message: '正在安装 voicebox 依赖（首次需下载模型库，可能较慢）...' });
  logger('[voicebox] 安装 requirements.txt...');
  const reqResult = await runCommandCollect(
    venvPython,
    ['-u', '-m', 'pip', 'install', '-r', effectiveRequirementsPath],
    { cwd: projectPath, timeout: 90 * 60 * 1000 },
  );
  if (!reqResult.ok) {
    const detail = String(reqResult.stderr || reqResult.error || '').split(/\r?\n/).filter(Boolean).slice(-6).join('\n');
    throw new Error(`voicebox 依赖安装失败（exit ${reqResult.code}）：\n${detail || '未知错误'}`);
  }

  // 4.5 Windows GPU：requirements 装完后按需装 CUDA PyTorch
  if (process.platform === 'win32' && gpuMode !== 'cpu') {
    const gpuName = await detectNvidiaGpuName();
    if (gpuName) {
      await installWindowsCudaTorch({ venvDir, projectPath, gpuName, logger });
    } else {
      logger('[voicebox] 未检测到 NVIDIA GPU，使用 CPU 模式。');
    }
  }

  logger('[voicebox] Windows 原生初始化完成。');
}

async function ensureVoiceCloneBackend(projectPath, logger = () => {}, progress = () => {}, options = {}) {
  const forceRepair = Boolean(options?.forceRepair);
  const gpuMode = options?.gpuMode || 'auto';
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
  // Store venv in user data directory (not in project path which may be recreated)
  // 统一使用 ~/AntBot 作为数据目录，与 ipc.js 保持一致
  const userDataDir = path.join(os.homedir(), 'AntBot');
  const voiceboxEnvDir = path.join(userDataDir, 'voicebox-env');
  const voiceboxDataDir = path.join(userDataDir, 'voicebox-data');
  await fs.mkdir(voiceboxEnvDir, { recursive: true }).catch(() => {});
  const venvDir = path.join(voiceboxEnvDir, '.venv-voicebox');
  const setupMarker = path.join(voiceboxEnvDir, '.voicebox-setup-done');
  const venvPython = await resolveVoiceboxVenvPython(venvDir);
  const backendMain = path.join(projectPath, 'vendor', 'voicebox', 'backend', 'main.py');
  const backendRequirements = path.join(projectPath, 'vendor', 'voicebox', 'backend', 'requirements.txt');
  const dataDir = voiceboxDataDir; // 使用固定数据目录，不随项目路径变化
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

  const hasCompleteBackendRepo = hasBackendMain && hasBackendRequirements;

  const readPythonVersion = (pythonPath) => {
    return new Promise((resolve) => {
      const child = spawn(pythonPath, ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
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
    return major === 3 && minor >= 10 && minor <= 13;
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

  // Check setup completion marker (stored in data directory, survives app rebuilds)
  // Marker is only valid if venv Python binary actually exists
  const hasSetupMarker = await exists(setupMarker);
  const venvPythonExists = venvOk && hasVenvPython && await exists(venvPython);
  if (hasSetupMarker && venvPythonExists && hasCompleteBackendRepo && !forceRepair) {
    logger('voicebox 环境已就绪，跳过依赖安装，直接启动后端。');
    const existing = startedVoiceboxBackends.get(projectPath);
    const existingChild = getStartedChild(existing);
    if (!existingChild || existingChild.exitCode !== null) {
      const bashBinary = await resolveBashBinary();
      const launchCommand = process.platform === 'win32' ? venvPython : bashBinary;
      const startScript = path.join(projectPath, 'scripts', 'start_voicebox_backend.sh');
      const launchArgs = process.platform === 'win32'
        ? ['-u', '-m', 'backend.main', '--host', '127.0.0.1', '--port', '17493', '--data-dir', voiceboxDataDir]
        : [startScript];
      const voiceboxDevice = gpuMode === 'cpu' ? 'cpu' : gpuMode === 'gpu' ? 'cuda' : '';
      const env = { ...process.env, VOICEBOX_PYTHON: venvPython, VENV_DIR: venvDir, VOICEBOX_DATA_DIR: voiceboxDataDir, VOICEBOX_MODELS_DIR: path.join(voiceboxDataDir, 'models'), ...(voiceboxDevice ? { VOICEBOX_DEVICE: voiceboxDevice } : {}) };
      const logFilePath = await getVoiceboxLogFilePath(projectPath);
      const voiceboxCwd = process.platform === 'win32' ? path.join(projectPath, 'vendor', 'voicebox') : projectPath;
      const child = await spawnLoggedDetachedProcess(launchCommand, launchArgs, {
        cwd: voiceboxCwd, env, logFilePath, label: 'voicebox'
      });
      child.unref(); // 防止 detached 子进程句柄阻塞 App 退出
      startedVoiceboxBackends.set(projectPath, { child, logFilePath });
      progress({ status: 'running', step: '启动后端', percent: 80, message: '正在启动 voicebox 后端...' });
      await waitForVoiceCloneReady(15000);
      logger('voicebox 后端已就绪（跳过安装）。');
    } else {
      logger('voicebox 后端已在运行。');
    }
    return;
  }

  const needsSetup = forceRepair || !(venvOk && hasCompleteBackendRepo);
  // Windows 走原生 python venv + pip（无需 Git Bash）；macOS/Linux 走 bash 脚本
  const needsBash = needsSetup && process.platform !== 'win32';
  const bashBinary = needsBash ? await resolveBashBinary() : '';
  if (needsBash && !bashBinary) {
    throw new Error('未找到 bash，无法初始化或启动 voicebox 后端。');
  }

  if (needsSetup) {
    const pythonBinary = await resolvePythonBinary();
    if (!pythonBinary) {
      throw new Error('未找到可用 Python 3.10~3.13。');
    }

    progress({
      status: 'running',
      step: '安装依赖',
      percent: 40,
      message: `${forceRepair ? '正在修复 voicebox 依赖' : '首次运行，正在安装 voicebox 依赖'}（Python: ${pythonBinary}）...`
    });
    logger(`${forceRepair ? '开始修复' : '开始初始化'} voicebox 环境（python: ${pythonBinary}）。`);

    if (process.platform === 'win32') {
      // Windows 原生初始化：python -m venv + pip install（复用 voicebox:install 的同款流程）
      await setupVoiceboxBackendWindowsNative({
        pythonBinary,
        venvDir,
        projectPath,
        venvPython,
        requirementsPath: backendRequirements,
        gpuMode,
        logger,
        progress
      });
    } else {
      if (!hasSetupScript) {
        throw new Error('缺少 setup_voicebox_backend.sh，无法初始化语音克隆环境。');
      }
      const env = {
        ...process.env,
        PYTHON_BIN: pythonBinary,
        VENV_DIR: venvDir  // Override default venv location to data directory
      };
      await runScriptWithLogs(setupScript, {
        cwd: projectPath,
        env,
        shellBinary: bashBinary,
        logger,
        logPrefix: '[voicebox setup] '
      });
    }

    // Write setup completion marker（记录 torch 来源，防 CUDA/CPU 互相覆盖）
    const torchSource = await detectInstalledTorchSource(venvDir, logger);
    await fs.writeFile(setupMarker, JSON.stringify({
      completedAt: new Date().toISOString(),
      pythonBinary,
      projectPath,
      torchSource,
      platform: process.platform
    }), 'utf-8').catch(() => {});
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
          VOICEBOX_MODELS_DIR: modelsDir,
          VENV_DIR: venvDir
        })
      : withRuntimeEnv({
          PYTHONUNBUFFERED: '1',
          VENV_DIR: venvDir,
          VOICEBOX_DATA_DIR: dataDir,
          VOICEBOX_MODELS_DIR: modelsDir
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
  logger('合成步骤2a: prewarmVoiceCloneModel...');
  await prewarmVoiceCloneModel('qwen-tts-1.7B', logger);
  logger('合成步骤2a完成: prewarm done');
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
    step: '检查后端',
    percent: 18,
    message: '正在检查语音克隆后端...'
  });
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

  // 裁剪音频到 30 秒（voicebox 限制）
  const trimmedPath = samplePath + '.trimmed.wav';
  let finalSamplePath = samplePath;
  try {
    const { spawn: spawnTrim } = require('node:child_process');
    const { resolveDependencyPath } = require('./dependencyManager');
    const ffmpegBin = await resolveDependencyPath('ffmpeg') || 'ffmpeg';
    await new Promise((resolve, reject) => {
      const child = spawnTrim(ffmpegBin, ['-i', samplePath, '-t', '30', '-ar', '24000', '-ac', '1', '-y', trimmedPath], { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.slice(0, 200))));
      child.on('error', reject);
    });
    finalSamplePath = trimmedPath;
    logger('音频已裁剪到 30 秒以内');
  } catch (e) {
    logger(`音频裁剪失败，使用原始文件: ${e.message}`);
  }

  const audioBuffer = await fs.readFile(finalSamplePath);
  // 清理临时裁剪文件
  if (finalSamplePath !== samplePath) { await fs.unlink(trimmedPath).catch(() => {}); }

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
  gpuMode = 'auto',
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

  log('resolveVoiceCloneProfile: ensureVoiceCloneBackend...');
  await ensureVoiceCloneBackend(projectPath, log, () => {}, { gpuMode });
  log('resolveVoiceCloneProfile: getVoiceCloneProfiles...');
  // 等待 voicebox 稳定（模型加载后可能需要时间初始化）
  await sleep(3000);
  const profiles = await getVoiceCloneProfiles();
  log(`resolveVoiceCloneProfile: got ${Array.isArray(profiles) ? profiles.length : 0} profiles, desiredId=${desiredId}, desiredName=${desiredName}, samplePath=${samplePath ? 'set' : 'empty'}`);
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

  // 预置音色自动注册：WAV 文件存在但 voicebox 数据库里没有，自动注册
  if (desiredId) {
    // 预置音色保存在 ~/AntBot/voicebox-data/profiles/<voiceId>/ref.wav
    const wavPath = path.join(os.homedir(), 'AntBot', 'voicebox-data', 'profiles', desiredId, 'ref.wav');
    try {
      await fs.access(wavPath);
      log(`预置音色 ${desiredId} 的 WAV 文件存在，自动注册到 voicebox...`);
      const audioBuffer = await fs.readFile(wavPath);
      const createdProfile = await createVoiceCloneProfileDirect({
        profileName: desiredName || desiredId,
        language: language || 'zh',
        referenceText: '预置音色',
        audioBuffer,
        sampleFileName: 'ref.wav',
        sampleMimeType: 'audio/wav'
      });
      log(`预置音色已注册：${createdProfile.name} (${createdProfile.id})`);
      return {
        useVoiceClone: true,
        profileId: String(createdProfile.id || '').trim(),
        profileName: createdProfile.name || desiredName,
        language: createdProfile.language || language
      };
    } catch (e) {
      if (e.code !== 'ENOENT') log(`预置音色注册失败：${e.message}`);
    }
  }

  throw new Error(
    '当前保存的克隆音色已失效或不存在，请重新在”克隆”面板生成一次音色。'
    + (availableNames.length ? ` 当前可用档案：${availableNames.join('、')}` : ' 当前后端未检测到可用档案。')
  );
}

function getManagedChildren() {
  const children = [];
  for (const [, rec] of startedVoiceboxBackends) {
    const c = getStartedChild(rec);
    if (c && c.exitCode === null) children.push(c);
  }
  return children;
}

async function shutdownVoicebox(logger = () => {}) {
  // 优雅关闭
  await requestVoiceCloneShutdown();
  // 等待进程退出，SIGTERM 无效则用 SIGKILL
  for (const [key, rec] of startedVoiceboxBackends) {
    const child = getStartedChild(rec);
    if (child && child.exitCode === null) {
      try { child.kill('SIGTERM'); } catch {}
      // 3 秒后如果还没退出，强制杀
      await new Promise(r => setTimeout(r, 3000));
      try { if (child.exitCode === null) child.kill('SIGKILL'); } catch {}
    }
    startedVoiceboxBackends.delete(key);
  }
  // 确保端口释放
  await killVoiceboxByPort(logger);
  logger('voicebox 后端已关闭');
}

module.exports = {
  detectAutoDubProject,
  resolveAutoDubProjectPath,
  createVoiceCloneProfileWithAutoDub,
  resolveVoiceCloneProfile,
  ensureVoiceCloneBackend,
  shutdownVoicebox,
  getManagedChildren,
  prewarmVoiceCloneModel
};
