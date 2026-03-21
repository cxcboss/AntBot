const path = require('node:path');
const fs = require('node:fs/promises');
const { runCommand, runCommandArgs } = require('./commandRunner');
const { ensureWindowsDependency, getManagedBinDir } = require('./dependencyManager');

const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const DETECT_TIMEOUT_MS = 12 * 1000;
const INSTALL_TIMEOUT_MS = 12 * 60 * 1000;
const OUTPUT_WAIT_TIMEOUT_MS = 8000;

function uniq(items) {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function isMissingCommandError(error) {
  const message = String(error?.message || error || '');
  return /ENOENT|command not found|not found|No such file or directory/i.test(message);
}

function isYtDlpSslError(error) {
  const message = String(error?.message || error || '');
  return /(SSL:|UNEXPECTED_EOF_WHILE_READING|CERTIFICATE_VERIFY_FAILED|tlsv1 alert|EOF occurred in violation of protocol)/i.test(message);
}

function normalizeVideoUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    if (/youtu\.be|youtube\.com/i.test(url.hostname)) {
      url.searchParams.delete('si');
      url.searchParams.delete('feature');
    }
    return url.toString();
  } catch {
    return String(rawUrl || '').trim();
  }
}

function buildYtDlpArgs(task, outputPath, options = {}) {
  const {
    forceIpv4 = false,
    noCheckCertificates = false,
    urlOverride = ''
  } = options;

  const args = [];
  args.push(
    '--newline',
    '--retries', '6',
    '--fragment-retries', '6',
    '--extractor-retries', '6',
    '--retry-sleep', '2',
    '--socket-timeout', '30'
  );
  if (forceIpv4) {
    args.push('--force-ipv4');
  }
  if (noCheckCertificates) {
    args.push('--no-check-certificates');
  }
  if (task.timeRange) {
    args.push('--download-sections', `*${task.timeRange}`);
  }
  args.push('-o', outputPath, urlOverride || task.videoUrl);
  return args;
}

function toLines(text) {
  return String(text || '')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function compactTail(text, limit = 8) {
  const lines = toLines(text);
  return lines.slice(Math.max(0, lines.length - limit)).join('\n');
}

function normalizeExtractedPath(raw, baseName) {
  const value = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!value) {
    return '';
  }
  if (!value.includes(baseName)) {
    return '';
  }
  return value;
}

function extractPathCandidatesFromOutput(commandOutput, baseName) {
  const lines = toLines(commandOutput);
  const candidates = [];

  for (const line of lines) {
    let match = line.match(/(?:Destination|输出):\s*(.+)$/i);
    if (match) {
      const item = normalizeExtractedPath(match[1], baseName);
      if (item) {
        candidates.push(item);
      }
      continue;
    }

    match = line.match(/(?:Merging formats into|合并为)\s+"([^"]+)"/i);
    if (match) {
      const item = normalizeExtractedPath(match[1], baseName);
      if (item) {
        candidates.push(item);
      }
      continue;
    }

    match = line.match(/(?:Merging formats into|合并为)\s+'([^']+)'/i);
    if (match) {
      const item = normalizeExtractedPath(match[1], baseName);
      if (item) {
        candidates.push(item);
      }
    }
  }

  return uniq(candidates);
}

function scoreByExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const scores = new Map([
    ['.mp4', 120],
    ['.mkv', 110],
    ['.mov', 105],
    ['.webm', 100],
    ['.m4v', 95],
    ['.ts', 90],
    ['.flv', 85],
    ['.avi', 80],
    ['.m4a', 55],
    ['.mp3', 50],
    ['.wav', 45]
  ]);
  return scores.get(ext) || 40;
}

async function existsFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function waitForOutputFile(filePath, timeoutMs = OUTPUT_WAIT_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await existsFile(filePath)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

async function resolveDownloadedOutputPath(tempDir, baseName, expectedPath, options = {}) {
  const {
    commandOutput = '',
    searchDirs = []
  } = options;

  if (await waitForOutputFile(expectedPath)) {
    return expectedPath;
  }

  const explicitCandidates = extractPathCandidatesFromOutput(commandOutput, baseName);
  for (const explicitPath of explicitCandidates) {
    const absolutePath = path.isAbsolute(explicitPath)
      ? explicitPath
      : path.join(tempDir, explicitPath);
    if (await existsFile(absolutePath)) {
      return absolutePath;
    }
  }

  const dirs = uniq([tempDir, ...searchDirs].filter(Boolean));
  const skippedSuffixes = ['.part', '.ytdl', '.tmp'];
  const skippedNameParts = ['.info.json', '.description', '.jpg', '.jpeg', '.png', '.webp', '.vtt', '.srt'];
  const candidates = [];

  for (const dir of dirs) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const name = entry.name;
      if (!(name === baseName || name.startsWith(`${baseName}.`) || name.startsWith(`${baseName}-`))) {
        continue;
      }
      if (skippedSuffixes.some((suffix) => name.endsWith(suffix))) {
        continue;
      }
      if (skippedNameParts.some((part) => name.includes(part))) {
        continue;
      }

      const fullPath = path.join(dir, name);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isFile() && stat.size > 0) {
          candidates.push({
            fullPath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            extScore: scoreByExtension(fullPath)
          });
        }
      } catch {
        // noop
      }
    }
  }

  if (!candidates.length) {
    return '';
  }

  candidates.sort((a, b) => {
    if (b.extScore !== a.extScore) {
      return b.extScore - a.extScore;
    }
    if (b.mtimeMs !== a.mtimeMs) {
      return b.mtimeMs - a.mtimeMs;
    }
    return b.size - a.size;
  });

  return candidates[0].fullPath;
}

function getYtDlpBinaryCandidates() {
  return uniq([
    process.env.ANTBOT_YTDLP_BIN,
    path.join(getManagedBinDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
    path.resolve(process.resourcesPath || '', 'bin', 'yt-dlp'),
    path.resolve(process.resourcesPath || '', 'bin', 'yt-dlp.exe'),
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    'yt-dlp'
  ]);
}

function getPythonCandidates() {
  const candidates = [
    process.env.ANTBOT_PYTHON_BIN,
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
    '/opt/homebrew/bin/python3.10',
    '/usr/local/bin/python3.12',
    '/usr/local/bin/python3.11',
    '/usr/local/bin/python3.10',
    '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12',
    '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11',
    '/Library/Frameworks/Python.framework/Versions/3.10/bin/python3.10'
  ];

  const names = ['python3.12', 'python3.11', 'python3.10', 'python3', 'python'];
  const pathEntries = String(process.env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of pathEntries) {
    for (const name of names) {
      candidates.push(path.join(entry, name));
    }
  }

  candidates.push('/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3', 'python');
  return uniq(candidates);
}

async function canRun(command, args, cwd) {
  try {
    await runCommandArgs(command, args, {
      cwd,
      timeoutMs: DETECT_TIMEOUT_MS,
      log: () => {}
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveYtDlpLauncher({ settings, log }) {
  const cwd = settings.paths.youtubeProjectPath || undefined;

  for (const bin of getYtDlpBinaryCandidates()) {
    if (await canRun(bin, ['--version'], cwd)) {
      if (bin !== 'yt-dlp') {
        log(`检测到可用下载器：${bin}`);
      }
      return {
        command: bin,
        prefixArgs: [],
        mode: 'yt-dlp'
      };
    }
  }

  if (process.platform === 'win32') {
    try {
      const managedBinary = await ensureWindowsDependency('yt-dlp', log);
      if (await canRun(managedBinary, ['--version'], cwd)) {
        log(`已自动准备 yt-dlp：${managedBinary}`);
        return {
          command: managedBinary,
          prefixArgs: [],
          mode: 'yt-dlp'
        };
      }
    } catch (error) {
      log(`自动准备 yt-dlp 失败：${String(error?.message || error)}`);
    }
  }

  log('未检测到可用 yt-dlp 可执行文件，尝试 python -m yt_dlp...');
  const pythonCandidates = getPythonCandidates();

  for (const python of pythonCandidates) {
    if (await canRun(python, ['-m', 'yt_dlp', '--version'], cwd)) {
      log(`使用 Python 模块下载器：${python} -m yt_dlp`);
      return {
        command: python,
        prefixArgs: ['-m', 'yt_dlp'],
        mode: 'python-yt_dlp'
      };
    }
  }

  for (const python of pythonCandidates) {
    if (!(await canRun(python, ['--version'], cwd))) {
      continue;
    }
    log(`下载器缺失，尝试自动安装 yt-dlp（${python}）...`);
    try {
      await runCommandArgs(python, ['-m', 'pip', 'install', '--user', '-U', 'yt-dlp'], {
        cwd,
        timeoutMs: INSTALL_TIMEOUT_MS,
        log
      });
    } catch (error) {
      log(`自动安装失败（${python}）：${String(error?.message || error)}`);
      continue;
    }

    if (await canRun(python, ['-m', 'yt_dlp', '--version'], cwd)) {
      log('yt-dlp 自动安装完成。');
      return {
        command: python,
        prefixArgs: ['-m', 'yt_dlp'],
        mode: 'python-yt_dlp'
      };
    }
  }

  throw new Error(
    '未找到可用下载器。请安装 yt-dlp（例如：brew install yt-dlp），或在设置中填写“下载命令”。'
  );
}

async function downloadVideo(taskContext) {
  const {
    task,
    tempDir,
    baseName,
    settings,
    log
  } = taskContext;

  const outputPath = path.join(tempDir, `${baseName}.mp4`);
  const cwd = settings.paths.youtubeProjectPath || undefined;

  if (settings.commands.download) {
    let result;
    try {
      result = await runCommand(settings.commands.download, {
        cwd,
        log,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        variables: {
          url: task.videoUrl,
          output: outputPath,
          timeRange: task.timeRange,
          taskName: task.taskName,
          original: task.isOriginal ? '1' : '0'
        }
      });
    } catch (error) {
      if (isMissingCommandError(error)) {
        throw new Error(
          `${String(error?.message || error)}\n` +
          '下载命令中的可执行文件不存在。可清空“下载命令”使用内置下载器，或安装对应命令后重试。'
        );
      }
      throw error;
    }

    const commandOutput = `${result?.stdout || ''}\n${result?.stderr || ''}`;
    const resolvedPath = await resolveDownloadedOutputPath(tempDir, baseName, outputPath, {
      commandOutput,
      searchDirs: [cwd]
    });
    if (!resolvedPath) {
      const outputTail = compactTail(commandOutput);
      throw new Error(
        `下载命令执行完成，但未找到视频输出文件：${outputPath}` +
        (outputTail ? `\n下载日志：\n${outputTail}` : '')
      );
    }
    if (resolvedPath !== outputPath) {
      log(`下载输出文件路径与预期不一致，已自动使用：${resolvedPath}`);
    }

    return {
      outputPath: resolvedPath,
      mode: 'custom-command'
    };
  }

  const launcher = await resolveYtDlpLauncher({ settings, log });
  const normalizedUrl = normalizeVideoUrl(task.videoUrl);
  const attempts = [
    {
      name: '默认参数',
      args: buildYtDlpArgs(task, outputPath, {
        urlOverride: normalizedUrl || task.videoUrl
      })
    },
    {
      name: 'IPv4 加强重试',
      args: buildYtDlpArgs(task, outputPath, {
        forceIpv4: true,
        urlOverride: normalizedUrl || task.videoUrl
      })
    },
    {
      name: 'IPv4 + 跳过证书校验',
      args: buildYtDlpArgs(task, outputPath, {
        forceIpv4: true,
        noCheckCertificates: true,
        urlOverride: normalizedUrl || task.videoUrl
      })
    }
  ];

  let result = null;
  let lastError = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    if (index > 0) {
      log(`下载重试策略：${attempt.name}`);
    }
    try {
      result = await runCommandArgs(launcher.command, [
        ...launcher.prefixArgs,
        ...attempt.args
      ], {
        cwd,
        log,
        timeoutMs: DOWNLOAD_TIMEOUT_MS
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (!isYtDlpSslError(error) || index === attempts.length - 1) {
        throw error;
      }
      log(`检测到 SSL 下载错误，准备切换策略重试：${attempt.name}`);
    }
  }

  if (!result) {
    throw lastError || new Error('下载失败：未知错误');
  }

  const commandOutput = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  const resolvedPath = await resolveDownloadedOutputPath(tempDir, baseName, outputPath, {
    commandOutput,
    searchDirs: [cwd]
  });
  if (!resolvedPath) {
    const outputTail = compactTail(commandOutput);
    throw new Error(
      `视频下载完成，但未找到输出文件。期望路径：${outputPath}\n` +
      '请确认链接可下载，或在设置中填写自定义“下载命令”。' +
      (outputTail ? `\n下载日志：\n${outputTail}` : '')
    );
  }
  if (resolvedPath !== outputPath) {
    log(`下载输出文件路径与预期不一致，已自动使用：${resolvedPath}`);
  }

  return {
    outputPath: resolvedPath,
    mode: launcher.mode
  };
}

module.exports = {
  downloadVideo
};
