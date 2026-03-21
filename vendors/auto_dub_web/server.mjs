import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const WORKSPACE_DIR = path.join(__dirname, 'workspace');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
const SCRIPTS_DIR = path.join(__dirname, 'scripts');

const PORT = 5001;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']);
const TARGET_WIDTH = 1080;
const TARGET_HEIGHT = 1920;
const SUBTITLE_HORIZONTAL_MARGIN = 64;
const VOICEBOX_BASE_URL = process.env.VOICEBOX_BASE_URL ?? 'http://127.0.0.1:17493';
const VOICEBOX_BOOTSTRAP_SCRIPT = path.join(SCRIPTS_DIR, 'start_voicebox_backend.sh');

const VOICE_FALLBACK = {
  Tingting: '系统语音 zh_CN',
  'Eddy (中文（中国大陆）)': '系统语音 zh_CN',
  'Flo (中文（中国大陆）)': '系统语音 zh_CN',
  Sinji: '系统语音 zh_HK',
  Meijia: '系统语音 zh_TW',
  Samantha: 'System Voice en_US',
  Daniel: 'System Voice en_GB',
};
const VOICE_PRIORITY = [
  'Tingting',
  'Eddy (中文（中国大陆）)',
  'Flo (中文（中国大陆）)',
  'Sinji',
  'Meijia',
  'Samantha',
  'Daniel',
];

await fs.mkdir(WORKSPACE_DIR, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });

let ffmpegFilterSupport = null;
let cachedVoices = null;
let cachedSubtitleFont = null;
let voiceboxProcess = null;
let resolvedFfmpegTools = null;
let ffmpegRepairAttempted = false;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function canExecuteFile(filePath) {
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

async function sendFile(res, filePath, contentType) {
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length,
    });
    res.end(data);
  } catch {
    sendText(res, 404, 'Not Found');
  }
}

function mimeFromExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.vtt') return 'text/vtt; charset=utf-8';
  if (ext === '.srt') return 'application/x-subrip; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function safeFileComponent(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function runCommandCapture(command, args, options = {}) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      resolve({
        ok: false,
        code: -1,
        stdout,
        stderr,
        error: String(error?.message || error || 'spawn failed'),
      });
    });

    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        code: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

async function resolveBrewBinary() {
  const candidates = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew', 'brew'];
  for (const candidate of candidates) {
    const probe = await runCommandCapture(candidate, ['--version']);
    if (probe.ok) {
      return candidate;
    }
  }
  return '';
}

async function resolveBrewPrefix(formula) {
  const brewBinary = await resolveBrewBinary();
  if (!brewBinary) {
    return '';
  }
  const probe = await runCommandCapture(brewBinary, ['--prefix', formula]);
  return probe.ok ? probe.stdout.trim() : '';
}

function uniqueItems(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const key = String(value || '').trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(key);
  }
  return result;
}

async function buildFfmpegCandidates() {
  const localBinDir = path.join(__dirname, 'bin');
  const resourcesBinDir = path.resolve(process.resourcesPath || '', 'bin');
  const managedBinDir = path.resolve(process.env.ANTBOT_MANAGED_BIN || '');
  const ffmpegFullPrefix = await resolveBrewPrefix('ffmpeg-full');

  const ffmpegCandidates = uniqueItems([
    process.env.ANTBOT_FFMPEG_BIN,
    path.join(localBinDir, 'ffmpeg'),
    path.join(localBinDir, 'ffmpeg.exe'),
    path.join(resourcesBinDir, 'ffmpeg'),
    path.join(resourcesBinDir, 'ffmpeg.exe'),
    managedBinDir ? path.join(managedBinDir, 'ffmpeg.exe') : '',
    managedBinDir ? path.join(managedBinDir, 'ffmpeg') : '',
    ffmpegFullPrefix ? path.join(ffmpegFullPrefix, 'bin', 'ffmpeg') : '',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'ffmpeg',
  ]);

  const ffprobeCandidates = uniqueItems([
    process.env.ANTBOT_FFPROBE_BIN,
    path.join(localBinDir, 'ffprobe'),
    path.join(localBinDir, 'ffprobe.exe'),
    path.join(resourcesBinDir, 'ffprobe'),
    path.join(resourcesBinDir, 'ffprobe.exe'),
    managedBinDir ? path.join(managedBinDir, 'ffprobe.exe') : '',
    managedBinDir ? path.join(managedBinDir, 'ffprobe') : '',
    ffmpegFullPrefix ? path.join(ffmpegFullPrefix, 'bin', 'ffprobe') : '',
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    'ffprobe',
  ]);

  return { ffmpegCandidates, ffprobeCandidates };
}

async function probeFfmpegTools(ffmpegBin, ffprobeBin) {
  const versionProbe = await runCommandCapture(ffmpegBin, ['-version']);
  if (!versionProbe.ok) {
    return null;
  }

  const ffprobeProbe = await runCommandCapture(ffprobeBin, ['-version']);
  if (!ffprobeProbe.ok) {
    return null;
  }

  const filtersProbe = await runCommandCapture(ffmpegBin, ['-filters']);
  if (!filtersProbe.ok) {
    return null;
  }

  const combined = `${filtersProbe.stdout}\n${filtersProbe.stderr}`;
  return {
    ffmpegBin,
    ffprobeBin,
    subtitles: /\bsubtitles\b/.test(combined),
    drawtext: /\bdrawtext\b/.test(combined),
    overlay: /\boverlay\b/.test(combined),
  };
}

async function tryRepairFfmpegEnvironment() {
  if (ffmpegRepairAttempted || process.platform !== 'darwin') {
    return false;
  }
  ffmpegRepairAttempted = true;

  const brewBinary = await resolveBrewBinary();
  if (!brewBinary) {
    return false;
  }

  const fullPrefix = await resolveBrewPrefix('ffmpeg-full');
  const actionArgs = fullPrefix
    ? ['reinstall', 'ffmpeg-full']
    : ['install', 'ffmpeg-full'];

  console.log(`[ffmpeg] attempting Homebrew ${actionArgs.join(' ')} ...`);
  const repair = await runCommandCapture(brewBinary, actionArgs);
  if (!repair.ok) {
    const detail = `${repair.stdout || ''}\n${repair.stderr || ''}\n${repair.error || ''}`.trim();
    console.warn(`[ffmpeg] Homebrew repair failed:\n${detail}`);
    return false;
  }

  resolvedFfmpegTools = null;
  ffmpegFilterSupport = null;
  return true;
}

async function ensureFfmpegTools({ allowRepair = true } = {}) {
  if (resolvedFfmpegTools !== null) {
    return resolvedFfmpegTools;
  }

  const { ffmpegCandidates, ffprobeCandidates } = await buildFfmpegCandidates();
  const ffprobeByDir = new Map();
  let firstValidTools = null;

  for (const candidate of ffprobeCandidates) {
    if (candidate.includes(path.sep) && !await canExecuteFile(candidate)) {
      continue;
    }
    const key = candidate.includes(path.sep) ? path.dirname(candidate) : candidate;
    ffprobeByDir.set(key, candidate);
  }

  for (const ffmpegBin of ffmpegCandidates) {
    if (ffmpegBin.includes(path.sep) && !await canExecuteFile(ffmpegBin)) {
      continue;
    }

    const dirKey = ffmpegBin.includes(path.sep) ? path.dirname(ffmpegBin) : ffmpegBin;
    const preferredPairs = uniqueItems([
      ffprobeByDir.get(dirKey),
      ffmpegBin.includes(path.sep) ? path.join(path.dirname(ffmpegBin), 'ffprobe') : '',
      ...ffprobeCandidates,
    ]);

    for (const ffprobeBin of preferredPairs) {
      if (ffprobeBin.includes(path.sep) && !await canExecuteFile(ffprobeBin)) {
        continue;
      }
      const tools = await probeFfmpegTools(ffmpegBin, ffprobeBin);
      if (tools) {
        if (!firstValidTools) {
          firstValidTools = tools;
        }
        if (tools.subtitles || tools.drawtext) {
          resolvedFfmpegTools = tools;
          ffmpegFilterSupport = tools;
          return tools;
        }
      }
    }
  }

  if (allowRepair && await tryRepairFfmpegEnvironment()) {
    return await ensureFfmpegTools({ allowRepair: false });
  }

  resolvedFfmpegTools = firstValidTools || {
    ffmpegBin: '',
    ffprobeBin: '',
    subtitles: false,
    drawtext: false,
    overlay: false,
  };
  ffmpegFilterSupport = resolvedFfmpegTools;
  return resolvedFfmpegTools;
}

async function runFfmpegCommand(args, options = {}) {
  const tools = await ensureFfmpegTools();
  if (!tools.ffmpegBin) {
    throw new Error('未找到可用的 ffmpeg。macOS 上请安装或修复 ffmpeg-full。');
  }
  return await runCommand(tools.ffmpegBin, args, options);
}

async function runFfprobeCommand(args, options = {}) {
  const tools = await ensureFfmpegTools();
  if (!tools.ffprobeBin) {
    throw new Error('未找到可用的 ffprobe。macOS 上请安装或修复 ffmpeg-full。');
  }
  return await runCommand(tools.ffprobeBin, args, options);
}

function parseTimestampToMs(value) {
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) {
    throw new Error(`非法时间戳: ${value}`);
  }
  const [hour, minute, second, milli] = match.slice(1).map((v) => Number(v));
  return ((hour * 60 + minute) * 60 + second) * 1000 + milli;
}

function parseSrt(srtText) {
  const blocks = srtText.replace(/\r/g, '').trim().split(/\n\s*\n/g);
  const entries = [];

  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length < 2) {
      continue;
    }

    let timeline = '';
    let textStart = 1;

    if (lines[0].includes('-->')) {
      timeline = lines[0];
      textStart = 1;
    } else if (lines.length >= 3 && lines[1].includes('-->')) {
      timeline = lines[1];
      textStart = 2;
    } else {
      continue;
    }

    const parts = timeline.split('-->');
    if (parts.length !== 2) {
      continue;
    }

    const startMs = parseTimestampToMs(parts[0]);
    const endMs = parseTimestampToMs(parts[1]);
    const text = lines.slice(textStart).join('\n').trim();

    if (!text || endMs <= startMs) {
      continue;
    }

    entries.push({ startMs, endMs, text });
  }

  return entries;
}

function normalizeToggle(value, fallback = true) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(text)) return true;
  if (['0', 'false', 'off', 'no'].includes(text)) return false;
  return fallback;
}

function splitTextIntoSentences(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const matches = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/g);
  if (!matches || matches.length === 0) return [normalized];
  return matches.map((item) => item.trim()).filter(Boolean);
}

function splitSubtitleEntriesIntoSentences(entries) {
  const result = [];

  for (const entry of entries) {
    const sentences = splitTextIntoSentences(entry.text);
    if (sentences.length === 0) continue;

    const totalDuration = Math.max(1, entry.endMs - entry.startMs);
    const weights = sentences.map((sentence) =>
      Math.max(sentence.replace(/\s+/g, '').length, 1),
    );
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);

    let cursor = entry.startMs;
    for (let i = 0; i < sentences.length; i += 1) {
      const sentence = sentences[i];
      if (i === sentences.length - 1) {
        result.push({ startMs: cursor, endMs: entry.endMs, text: sentence });
        break;
      }

      const ratio = weights[i] / weightSum;
      const allocated = Math.max(80, Math.round(totalDuration * ratio));
      let endMs = cursor + allocated;
      if (endMs >= entry.endMs) {
        endMs = entry.endMs - 1;
      }
      if (endMs <= cursor) {
        endMs = cursor + 1;
      }
      result.push({ startMs: cursor, endMs, text: sentence });
      cursor = endMs;
    }
  }

  return result;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `命令失败: ${command} ${args.join(' ')}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`,
          ),
        );
      }
    });
  });
}

function buildVoiceboxUrl(endpoint) {
  return `${VOICEBOX_BASE_URL}${endpoint}`;
}

async function fetchVoicebox(endpoint, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(buildVoiceboxUrl(endpoint), {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });

    let payload = null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      payload = await response.json();
    } else {
      payload = await response.text();
    }

    if (!response.ok) {
      const detail =
        typeof payload === 'object' && payload && Object.prototype.hasOwnProperty.call(payload, 'detail')
          ? payload.detail
          : payload;
      throw new Error(`Voice clone 引擎请求失败 (${response.status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }

    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Voice clone 引擎请求超时（${endpoint}，${timeoutMs}ms）`);
    }
    throw new Error(`Voice clone 引擎连接失败（${endpoint}）：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function unwrapVoiceboxDetail(payload) {
  if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'detail')) {
    return payload.detail;
  }
  return payload;
}

function getVoiceboxDownloadState(payload) {
  const detail = unwrapVoiceboxDetail(payload);
  if (!detail || typeof detail !== 'object' || !detail.downloading) {
    return null;
  }
  return {
    downloading: true,
    modelName: String(detail.model_name ?? '').trim(),
    message: String(detail.message ?? '').trim(),
  };
}

async function getVoiceboxModelStatus(modelName, timeoutMs = 15000) {
  const payload = await fetchVoicebox('/models/status', { timeoutMs });
  const models = Array.isArray(payload?.models) ? payload.models : [];
  return models.find((item) => String(item?.model_name ?? '').trim() === modelName) ?? null;
}

async function triggerVoiceboxModelDownload(modelName, timeoutMs = 20000) {
  return fetchVoicebox('/models/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_name: modelName }),
    timeoutMs,
  });
}

async function waitForVoiceboxModelReady(modelName, log = console.log, timeoutMs = 90 * 60 * 1000) {
  const startedAt = Date.now();
  let lastLogAt = 0;
  let downloadTriggered = false;

  while (Date.now() - startedAt < timeoutMs) {
    let status = null;
    try {
      status = await getVoiceboxModelStatus(modelName);
    } catch (error) {
      const now = Date.now();
      if (now - lastLogAt >= 10000) {
        log(`[voicebox] 查询模型状态失败，继续重试：${error instanceof Error ? error.message : String(error)}`);
        lastLogAt = now;
      }
      await delay(3000);
      continue;
    }

    if (status?.loaded || status?.downloaded) {
      log(`[voicebox] 模型已就绪：${modelName}`);
      return;
    }

    if (!downloadTriggered && (!status || (!status.downloading && !status.downloaded))) {
      try {
        await triggerVoiceboxModelDownload(modelName);
        log(`[voicebox] 已触发模型下载：${modelName}`);
      } catch (error) {
        log(`[voicebox] 触发模型下载失败，稍后继续等待：${error instanceof Error ? error.message : String(error)}`);
      }
      downloadTriggered = true;
    }

    const now = Date.now();
    if (now - lastLogAt >= 10000) {
      log(`[voicebox] 模型 ${modelName} ${status?.downloading ? '下载中' : '准备中'}，继续等待...`);
      lastLogAt = now;
    }

    await delay(status?.downloading ? 5000 : 3000);
  }

  throw new Error(`语音模型下载超时：${modelName}`);
}

async function generateVoiceboxClip(profileId, text, language, log = console.log) {
  while (true) {
    const payload = await fetchVoicebox('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile_id: profileId,
        text,
        language,
        model_size: '1.7B',
      }),
      timeoutMs: 15 * 60 * 1000,
    });

    const downloadState = getVoiceboxDownloadState(payload);
    if (!downloadState?.downloading) {
      return payload;
    }

    const modelName = downloadState.modelName || 'qwen-tts-1.7B';
    log(`[voicebox] ${downloadState.message || `模型 ${modelName} 正在下载`}，自动等待完成...`);
    await waitForVoiceboxModelReady(modelName, log);
  }
}

async function checkVoiceboxHealth() {
  try {
    const data = await fetchVoicebox('/health', { timeoutMs: 4000 });
    return { available: true, data };
  } catch {
    return { available: false, data: null };
  }
}

async function startVoiceboxBackendIfPossible() {
  const health = await checkVoiceboxHealth();
  if (health.available) {
    return true;
  }

  try {
    await fs.access(VOICEBOX_BOOTSTRAP_SCRIPT);
  } catch {
    return false;
  }

  voiceboxProcess = spawn('bash', [VOICEBOX_BOOTSTRAP_SCRIPT], {
    cwd: __dirname,
    stdio: 'ignore',
    detached: true,
  });
  voiceboxProcess.unref();

  for (let i = 0; i < 40; i += 1) {
    await delay(500);
    const now = await checkVoiceboxHealth();
    if (now.available) {
      return true;
    }
  }

  return false;
}

async function ensureVoiceboxAvailable() {
  const ready = await startVoiceboxBackendIfPossible();
  if (!ready) {
    throw new Error(
      '语音克隆后端不可用。请先运行 scripts/setup_voicebox_backend.sh 和 scripts/start_voicebox_backend.sh。',
    );
  }
}

async function getVoiceCloneProfiles() {
  await ensureVoiceboxAvailable();
  return await fetchVoicebox('/profiles', { timeoutMs: 20000 });
}

async function createVoiceCloneProfile({ name, language, sampleFile, referenceText }) {
  await ensureVoiceboxAvailable();

  const profile = await fetchVoicebox('/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      description: 'Created from auto_dub_web',
      language,
    }),
    timeoutMs: 20000,
  });

  const formData = new FormData();
  formData.append('reference_text', referenceText);
  formData.append('file', sampleFile, sampleFile.name || 'sample.wav');

  await fetchVoicebox(`/profiles/${profile.id}/samples`, {
    method: 'POST',
    body: formData,
    timeoutMs: 120000,
  });

  return profile;
}

function escapeSubtitlesFilterPath(filePath) {
  return filePath
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/]/g, '\\]')
    .replace(/'/g, "\\\\'");
}

function normalizeSubtitlePosition(position) {
  const value = String(position || '').trim().toLowerCase();
  if (value === 'top' || value === 'middle' || value === 'bottom') {
    return value;
  }
  return 'bottom';
}

function normalizeSubtitleMargin(margin) {
  const parsed = Number(margin);
  if (!Number.isFinite(parsed)) return 120;
  return Math.min(600, Math.max(0, Math.round(parsed)));
}

function normalizeSubtitleYPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 12;
  return Math.min(100, Math.max(0, parsed));
}

function normalizeHexColor(input, fallback) {
  const text = String(input || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(text)) {
    return text.toUpperCase();
  }
  return fallback.toUpperCase();
}

function hexToAssColor(hexColor) {
  const normalized = normalizeHexColor(hexColor, '#FFFFFF').slice(1);
  const rr = normalized.slice(0, 2);
  const gg = normalized.slice(2, 4);
  const bb = normalized.slice(4, 6);
  return `&H00${bb}${gg}${rr}`;
}

function subtitleAlignment(position, percent = Number.NaN) {
  if (Number.isFinite(percent)) {
    if (percent >= 67) return 8;
    if (percent >= 34) return 5;
    return 2;
  }
  if (position === 'top') return 8;
  if (position === 'middle') return 5;
  return 2;
}

function deriveSubtitleMargin(position, percent, fallbackMargin) {
  if (!Number.isFinite(percent)) {
    return fallbackMargin;
  }
  const usableHeight = TARGET_HEIGHT - 60;
  if (percent >= 67) {
    return Math.round(((100 - percent) / 100) * usableHeight);
  }
  if (percent >= 34) {
    return Math.round(Math.abs(50 - percent) / 100 * usableHeight);
  }
  return Math.round((percent / 100) * usableHeight);
}

function drawtextYExpression(position, margin, percent = Number.NaN) {
  if (Number.isFinite(percent)) {
    const ratio = ((100 - percent) / 100).toFixed(4);
    return `(h-text_h)*${ratio}`;
  }
  if (position === 'top') return String(margin);
  if (position === 'middle') return '(h-text_h)/2';
  return `h-text_h-${margin}`;
}

function estimateWrapUnits(token) {
  let units = 0;
  for (const char of Array.from(String(token || ''))) {
    if (/\s/.test(char)) {
      units += 0.55;
    } else if (/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/u.test(char)) {
      units += 2;
    } else if (/[A-Z0-9]/.test(char)) {
      units += 1.15;
    } else if (/[a-z]/.test(char)) {
      units += 0.95;
    } else if (/[，。！？；：、“”‘’（）《》【】]/u.test(char)) {
      units += 1.15;
    } else if (/[.,!?;:'"()[\]{}]/.test(char)) {
      units += 0.8;
    } else {
      units += 1.35;
    }
  }
  return units;
}

function wrapSubtitleParagraph(paragraph, maxUnits = 38) {
  const text = String(paragraph || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }

  const tokens = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|\s+|./gu) || [text];
  const lines = [];
  let current = '';
  let currentUnits = 0;

  const flush = () => {
    const line = current.trim();
    if (line) {
      lines.push(line);
    }
    current = '';
    currentUnits = 0;
  };

  for (const token of tokens) {
    const tokenUnits = estimateWrapUnits(token);

    if (tokenUnits > maxUnits && token.trim()) {
      if (current.trim()) {
        flush();
      }

      let segment = '';
      let segmentUnits = 0;
      for (const char of Array.from(token)) {
        const charUnits = estimateWrapUnits(char);
        if (segment && segmentUnits + charUnits > maxUnits) {
          lines.push(segment.trim());
          segment = '';
          segmentUnits = 0;
        }
        segment += char;
        segmentUnits += charUnits;
      }
      if (segment.trim()) {
        current = segment;
        currentUnits = segmentUnits;
      }
      continue;
    }

    if (current && currentUnits + tokenUnits > maxUnits) {
      flush();
    }

    current += token;
    currentUnits += tokenUnits;
  }

  flush();
  return lines.join('\n');
}

function wrapSubtitleText(text, maxUnits = 38) {
  return String(text || '')
    .split(/\n+/)
    .map((paragraph) => wrapSubtitleParagraph(paragraph, maxUnits))
    .filter(Boolean)
    .join('\n');
}

function buildAtTempoFilter(speed) {
  if (speed <= 0) {
    throw new Error('配音速度必须大于 0。');
  }
  if (Math.abs(speed - 1) < 1e-6) {
    return 'anull';
  }

  const parts = [];
  let remain = speed;
  while (remain > 2.0 + 1e-6) {
    parts.push('atempo=2.0');
    remain /= 2.0;
  }
  while (remain < 0.5 - 1e-6) {
    parts.push('atempo=0.5');
    remain /= 0.5;
  }
  parts.push(`atempo=${remain.toFixed(4)}`);
  return parts.join(',');
}

async function getFfmpegFilterSupport() {
  if (ffmpegFilterSupport !== null) {
    return ffmpegFilterSupport;
  }

  ffmpegFilterSupport = await ensureFfmpegTools();
  return ffmpegFilterSupport;
}

async function getSayVoices() {
  if (cachedVoices !== null) {
    return cachedVoices;
  }

  try {
    const { stdout } = await runCommand('say', ['-v', '?']);
    const allVoices = {};

    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line) continue;

      const left = line.split('#')[0]?.trimEnd() ?? '';
      const localeMatch = left.match(/\s([a-z]{2}_[A-Z]{2})\s*$/);
      if (!localeMatch || typeof localeMatch.index !== 'number') continue;

      const locale = localeMatch[1];
      const voiceName = left.slice(0, localeMatch.index).trim();
      if (!voiceName) continue;

      allVoices[voiceName] = `系统语音 ${locale}`;
    }

    const ordered = {};
    for (const voiceName of VOICE_PRIORITY) {
      if (allVoices[voiceName]) {
        ordered[voiceName] = allVoices[voiceName];
      }
    }

    const remaining = Object.keys(allVoices)
      .filter((voiceName) => !Object.prototype.hasOwnProperty.call(ordered, voiceName))
      .sort((a, b) => a.localeCompare(b));

    for (const voiceName of remaining) {
      ordered[voiceName] = allVoices[voiceName];
    }

    cachedVoices = Object.keys(ordered).length > 0 ? ordered : VOICE_FALLBACK;
  } catch {
    cachedVoices = VOICE_FALLBACK;
  }

  return cachedVoices;
}

function formatVttTimestamp(ms) {
  const total = Math.max(0, Math.floor(ms));
  const hour = Math.floor(total / 3600000);
  const minute = Math.floor((total % 3600000) / 60000);
  const second = Math.floor((total % 60000) / 1000);
  const milli = total % 1000;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

function buildVttContent(entries) {
  const blocks = entries.map((entry, index) => {
    return `${index + 1}\n${formatVttTimestamp(entry.startMs)} --> ${formatVttTimestamp(entry.endMs)}\n${entry.text}`;
  });
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

async function videoHasAudio(videoPath) {
  const { stdout } = await runFfprobeCommand([
    '-v',
    'error',
    '-select_streams',
    'a',
    '-show_entries',
    'stream=index',
    '-of',
    'csv=p=0',
    videoPath,
  ]);
  return stdout.trim().length > 0;
}

function getSubtitleFontCandidates() {
  if (process.platform === 'win32') {
    const windowsRoot = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
    return [
      {
        path: path.join(windowsRoot, 'Fonts', 'msyh.ttc'),
        assName: 'Microsoft YaHei'
      },
      {
        path: path.join(windowsRoot, 'Fonts', 'msyhbd.ttc'),
        assName: 'Microsoft YaHei'
      },
      {
        path: path.join(windowsRoot, 'Fonts', 'simhei.ttf'),
        assName: 'SimHei'
      },
      {
        path: path.join(windowsRoot, 'Fonts', 'simsun.ttc'),
        assName: 'SimSun'
      }
    ];
  }

  if (process.platform === 'darwin') {
    return [
      {
        path: '/System/Library/Fonts/Hiragino Sans GB.ttc',
        assName: 'Hiragino Sans GB'
      },
      {
        path: '/System/Library/Fonts/STHeiti Medium.ttc',
        assName: 'Heiti SC'
      },
      {
        path: '/System/Library/Fonts/STHeiti Light.ttc',
        assName: 'Heiti SC'
      },
      {
        path: '/Library/Fonts/Arial Unicode.ttf',
        assName: 'Arial Unicode MS'
      }
    ];
  }

  return [
    {
      path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
      assName: 'Noto Sans CJK SC'
    },
    {
      path: '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
      assName: 'Noto Sans CJK SC'
    },
    {
      path: '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
      assName: 'WenQuanYi Micro Hei'
    }
  ];
}

async function resolveSubtitleFont() {
  if (cachedSubtitleFont !== null) {
    return cachedSubtitleFont;
  }

  const candidates = getSubtitleFontCandidates();
  for (const candidate of candidates) {
    try {
      await fs.access(candidate.path);
      cachedSubtitleFont = candidate;
      return cachedSubtitleFont;
    } catch {
      continue;
    }
  }

  cachedSubtitleFont = candidates[0];
  return cachedSubtitleFont;
}

async function buildDrawtextFilter(
  entries,
  subtitleTextDir,
  subtitlePosition,
  subtitleMargin,
  subtitleYPercent,
  subtitleTextColor,
  subtitleStrokeColor,
) {
  const subtitleFont = await resolveSubtitleFont();
  const escapedFontPath = escapeSubtitlesFilterPath(subtitleFont.path);
  const safeTextColor = normalizeHexColor(subtitleTextColor, '#FFA100');
  const safeStrokeColor = normalizeHexColor(subtitleStrokeColor, '#000000');

  await fs.mkdir(subtitleTextDir, { recursive: true });

  const filters = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const textFilePath = path.join(subtitleTextDir, `sub_${String(i + 1).padStart(5, '0')}.txt`);
    const wrappedText = wrapSubtitleText(entry.text, 38);
    await fs.writeFile(textFilePath, wrappedText, 'utf8');

    const escapedTextFilePath = escapeSubtitlesFilterPath(textFilePath);
    const startSec = (entry.startMs / 1000).toFixed(3);
    const endSec = (entry.endMs / 1000).toFixed(3);

    const yExpr = drawtextYExpression(subtitlePosition, subtitleMargin, subtitleYPercent);
    filters.push(
      `drawtext=fontfile='${escapedFontPath}':textfile='${escapedTextFilePath}':fontcolor=${safeTextColor}:fontsize=48:borderw=2:bordercolor=${safeStrokeColor}:box=0:line_spacing=8:x=(w-text_w)/2:y=${yExpr}:enable='between(t,${startSec},${endSec})'`,
    );
  }

  return filters.join(',');
}

async function getDuration(videoPath) {
  const { stdout } = await runFfprobeCommand([
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]);

  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('无法读取视频时长。');
  }
  return duration;
}

async function synthesizeSpeech(clips, voice, rate, ttsDir) {
  const outputs = [];

  for (let i = 0; i < clips.length; i += 1) {
    const entry = clips[i];
    const output = path.join(ttsDir, `line_${String(i + 1).padStart(5, '0')}.aiff`);
    const text = entry.text.replace(/\s+/g, ' ').trim();

    await runCommand('say', ['-v', voice, '-r', String(rate), '-o', output, text]);

    outputs.push({ startMs: entry.startMs, filePath: output });
  }

  return outputs;
}

async function synthesizeSpeechWithVoiceClone(clips, profileId, language, ttsDir) {
  await ensureVoiceboxAvailable();
  const outputs = [];

  for (let i = 0; i < clips.length; i += 1) {
    const entry = clips[i];
    const lineText = entry.text.replace(/\s+/g, ' ').trim();
    console.log(`[voicebox] generating clip ${i + 1}/${clips.length}: ${lineText.slice(0, 60)}`);
    const generated = await generateVoiceboxClip(profileId, entry.text, language, console.log);

    const audioResp = await fetch(buildVoiceboxUrl(`/audio/${generated.id}`));
    if (!audioResp.ok) {
      throw new Error(`下载克隆语音失败: ${audioResp.status}`);
    }
    const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
    const output = path.join(ttsDir, `line_${String(i + 1).padStart(5, '0')}.wav`);
    await fs.writeFile(output, audioBuffer);
    console.log(`[voicebox] clip ready ${i + 1}/${clips.length}: ${generated.id}`);
    outputs.push({ startMs: entry.startMs, filePath: output });
  }

  return outputs;
}

async function buildVoiceoverTrack(ttsOutputs, durationSec, outputAudioPath, ttsGainDb = 18, delayScale = 1) {
  if (ttsOutputs.length === 0) {
    throw new Error('字幕内容为空，无法生成配音。');
  }

  const args = ['-y'];
  for (const item of ttsOutputs) {
    args.push('-i', item.filePath);
  }

  const filterParts = [];
  for (let i = 0; i < ttsOutputs.length; i += 1) {
    const { startMs } = ttsOutputs[i];
    const delayMs = Math.max(0, Math.round(startMs * (Number.isFinite(delayScale) ? delayScale : 1)));
    filterParts.push(
      `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${delayMs}|${delayMs},volume=${ttsGainDb}dB[a${i}]`,
    );
  }

  const inputRefs = ttsOutputs.map((_, i) => `[a${i}]`).join('');
  filterParts.push(
    `${inputRefs}amix=inputs=${ttsOutputs.length}:normalize=0,dynaudnorm=f=200:g=31,alimiter=limit=0.99[outa]`,
  );

  args.push(
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    '[outa]',
    '-t',
    durationSec.toFixed(3),
    '-c:a',
    'pcm_s16le',
    outputAudioPath,
  );

  await runFfmpegCommand(args);
}

async function generateSilentTrack(durationSec, outputAudioPath) {
  await runFfmpegCommand([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t',
    durationSec.toFixed(3),
    '-c:a',
    'pcm_s16le',
    outputAudioPath,
  ]);
}

async function transcodeExternalDubTrack(inputAudioPath, durationSec, outputAudioPath) {
  await runFfmpegCommand([
    '-y',
    '-i',
    inputAudioPath,
    '-af',
    `aformat=sample_rates=48000:channel_layouts=stereo,apad=pad_dur=${durationSec.toFixed(3)}`,
    '-t',
    durationSec.toFixed(3),
    '-c:a',
    'pcm_s16le',
    outputAudioPath,
  ]);
}

async function applyDubSpeed(inputAudioPath, outputAudioPath, speed) {
  const atempoFilter = buildAtTempoFilter(speed);
  await runFfmpegCommand([
    '-y',
    '-i',
    inputAudioPath,
    '-af',
    atempoFilter,
    '-c:a',
    'pcm_s16le',
    outputAudioPath,
  ]);
}

async function composeVideo({
  videoPath,
  subtitlesPath,
  voiceTrackPath,
  outputPath,
  subtitleEntries,
  subtitleTextDir,
  subtitlePosition,
  subtitleMargin,
  subtitleYPercent,
  subtitleTextColor,
  subtitleStrokeColor,
  subtitleEnabled,
  keepOriginalAudio,
  originalAudioLevel,
  dubAudioLevel,
}) {
  const filterSupport = await getFfmpegFilterSupport();
  const hasOriginalAudio = keepOriginalAudio ? await videoHasAudio(videoPath) : false;
  const originalRatio = (originalAudioLevel / 100).toFixed(3);
  const dubRatio = (dubAudioLevel / 100).toFixed(3);
  const subtitleFont = await resolveSubtitleFont();
  console.log(`[subtitle] using font: ${subtitleFont.assName} (${subtitleFont.path})`);
  const filterParts = [
    `[0:v]scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=increase,crop=${TARGET_WIDTH}:${TARGET_HEIGHT},boxblur=20:10[bg]`,
    `[0:v]scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease[fg]`,
    '[bg][fg]overlay=(W-w)/2:(H-h)/2[vbase]',
  ];
  const preciseSubtitlePosition = Number.isFinite(subtitleYPercent);
  const effectiveSubtitleMargin = deriveSubtitleMargin(subtitlePosition, subtitleYPercent, subtitleMargin);

  let subtitleMode = 'burned';
  const subtitleOn = subtitleEnabled !== false;
  if (!subtitleOn) {
    subtitleMode = 'none';
    filterParts.push('[vbase]null[vout]');
  } else if (preciseSubtitlePosition && filterSupport.drawtext) {
    const drawtextFilter = await buildDrawtextFilter(
      subtitleEntries,
      subtitleTextDir,
      subtitlePosition,
      effectiveSubtitleMargin,
      subtitleYPercent,
      subtitleTextColor,
      subtitleStrokeColor,
    );
    filterParts.push(`[vbase]${drawtextFilter}[vout]`);
  } else if (filterSupport.subtitles) {
    const subtitleFilterPath = escapeSubtitlesFilterPath(subtitlesPath);
    const style = [
      `PrimaryColour=${hexToAssColor(subtitleTextColor || '#FFA100')}`,
      `OutlineColour=${hexToAssColor(subtitleStrokeColor || '#000000')}`,
      'BackColour=&H00000000',
      'BorderStyle=1',
      'Outline=2',
      'Shadow=0',
      'WrapStyle=0',
      `FontName=${subtitleFont.assName}`,
      'FontSize=22',
      `Alignment=${subtitleAlignment(subtitlePosition, subtitleYPercent)}`,
      `MarginL=${SUBTITLE_HORIZONTAL_MARGIN}`,
      `MarginR=${SUBTITLE_HORIZONTAL_MARGIN}`,
      `MarginV=${effectiveSubtitleMargin}`,
    ].join(',');
    filterParts.push(`[vbase]subtitles=filename='${subtitleFilterPath}':force_style='${style}'[vout]`);
  } else if (filterSupport.drawtext) {
    const drawtextFilter = await buildDrawtextFilter(
      subtitleEntries,
      subtitleTextDir,
      subtitlePosition,
      effectiveSubtitleMargin,
      subtitleYPercent,
      subtitleTextColor,
      subtitleStrokeColor,
    );
    filterParts.push(`[vbase]${drawtextFilter}[vout]`);
  } else {
    throw new Error(
      `当前 ffmpeg 环境不支持字幕烧录（ffmpeg=${filterSupport.ffmpegBin || 'unknown'}，subtitles=${String(filterSupport.subtitles)}，drawtext=${String(filterSupport.drawtext)}）。`
    );
  }

  if (hasOriginalAudio) {
    filterParts.push(
      `[0:a:0]aformat=sample_rates=48000:channel_layouts=stereo,volume=${originalRatio}[aorig]`,
    );
    filterParts.push(
      `[1:a:0]aformat=sample_rates=48000:channel_layouts=stereo,volume=${dubRatio}[adub]`,
    );
    filterParts.push(
      `[aorig][adub]amix=inputs=2:weights='1 1':normalize=0,dynaudnorm=f=180:g=27,alimiter=limit=0.98[aout]`,
    );
  } else {
    filterParts.push(
      `[1:a:0]aformat=sample_rates=48000:channel_layouts=stereo,volume=${dubRatio},dynaudnorm=f=180:g=27,alimiter=limit=0.98[aout]`,
    );
  }

  const args = [
    '-y',
    '-i',
    videoPath,
    '-i',
    voiceTrackPath,
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-c:a',
    'aac',
    '-b:a',
    '320k',
    '-movflags',
    '+faststart',
    '-shortest',
    outputPath,
  ];

  await runFfmpegCommand(args);

  return {
    subtitleMode,
    subtitleUrl: null,
  };
}

async function processJob(
  videoFile,
  subtitleFile,
  voice,
  rate,
  ttsMode,
  cloneProfileId,
  cloneLanguage,
  dubSpeed,
  subtitlePositionRaw,
  subtitleMarginRaw,
  subtitleYPercentRaw,
  subtitleTextColorRaw,
  subtitleStrokeColorRaw,
  subtitleEnabled,
  voiceoverEnabled,
  keepOriginalAudio,
  originalAudioLevel,
  dubAudioLevel,
  externalDubFile,
) {
  const videoName = safeFileComponent(videoFile.name || 'input.mp4');
  const videoExt = path.extname(videoName).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(videoExt)) {
    throw new Error('视频格式不支持，请上传 mp4/mov/mkv/avi/webm/m4v。');
  }

  const needSubtitleFile = Boolean(subtitleEnabled || voiceoverEnabled);
  const hasSubtitleFile = subtitleFile instanceof File;
  if (needSubtitleFile && !hasSubtitleFile) {
    throw new Error('请上传 .srt 字幕文件。');
  }
  let subtitleName = 'subtitle.srt';
  if (hasSubtitleFile) {
    subtitleName = safeFileComponent(subtitleFile.name || 'subtitle.srt');
    const subtitleExt = path.extname(subtitleName).toLowerCase();
    if (subtitleExt !== '.srt') {
      throw new Error('字幕文件必须是 .srt 格式。');
    }
  }

  const useExternalDub = Boolean(voiceoverEnabled && externalDubFile instanceof File && externalDubFile.size > 0);
  const useVoiceClone = Boolean(voiceoverEnabled && !useExternalDub && ttsMode === 'voice_clone');

  if (voiceoverEnabled && !useExternalDub && !useVoiceClone) {
    const voices = await getSayVoices();
    if (!Object.prototype.hasOwnProperty.call(voices, voice)) {
      throw new Error('选择的音色无效。');
    }
  }

  if (useVoiceClone && !cloneProfileId) {
    throw new Error('请选择语音克隆档案。');
  }

  const rateNumber = Number(rate);
  if (!Number.isFinite(rateNumber) || rateNumber < 80 || rateNumber > 600) {
    throw new Error('语速必须在 80 到 600 之间。');
  }

  const originalAudioLevelNumber = Number(originalAudioLevel);
  if (!Number.isFinite(originalAudioLevelNumber) || originalAudioLevelNumber < 0 || originalAudioLevelNumber > 200) {
    throw new Error('原声音量必须在 0 到 200 之间。');
  }

  const dubAudioLevelNumber = Number(dubAudioLevel);
  if (!Number.isFinite(dubAudioLevelNumber) || dubAudioLevelNumber < 50 || dubAudioLevelNumber > 350) {
    throw new Error('配音音量必须在 50 到 350 之间。');
  }

  const dubSpeedNumber = Number(dubSpeed);
  if (!Number.isFinite(dubSpeedNumber) || dubSpeedNumber < 0.5 || dubSpeedNumber > 3.0) {
    throw new Error('配音速度必须在 0.5 到 3.0 之间。');
  }

  const subtitlePosition = normalizeSubtitlePosition(subtitlePositionRaw);
  const subtitleMargin = normalizeSubtitleMargin(subtitleMarginRaw);
  const subtitleYPercent = normalizeSubtitleYPercent(subtitleYPercentRaw);
  const subtitleTextColor = normalizeHexColor(subtitleTextColorRaw, '#FFA100');
  const subtitleStrokeColor = normalizeHexColor(subtitleStrokeColorRaw, '#000000');

  const jobId = crypto.randomUUID().slice(0, 12);
  const jobDir = path.join(WORKSPACE_DIR, jobId);
  const ttsDir = path.join(jobDir, 'tts');
  const subtitleTextDir = path.join(jobDir, 'subtitle_texts');
  await fs.mkdir(ttsDir, { recursive: true });
  await fs.mkdir(subtitleTextDir, { recursive: true });

  const videoPath = path.join(jobDir, `video${videoExt}`);
  const subtitlePath = path.join(jobDir, 'subtitles.srt');
  const voiceTrackPath = path.join(jobDir, 'voiceover.wav');
  const voiceTrackSpedPath = path.join(jobDir, 'voiceover_sped.wav');
  const outputName = `dubbed_${jobId}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  const videoBuffer = Buffer.from(await videoFile.arrayBuffer());
  await fs.writeFile(videoPath, videoBuffer);

  let entries = [];
  let sentenceEntries = [];
  if (hasSubtitleFile) {
    const subtitleBuffer = Buffer.from(await subtitleFile.arrayBuffer());
    await fs.writeFile(subtitlePath, subtitleBuffer);

    const subtitleText = subtitleBuffer.toString('utf-8');
    entries = parseSrt(subtitleText);
    if (entries.length === 0) {
      throw new Error('字幕解析失败，未提取到有效文本。');
    }
    sentenceEntries = splitSubtitleEntriesIntoSentences(entries);
    if (voiceoverEnabled && sentenceEntries.length === 0) {
      throw new Error('字幕分句失败，未提取到有效句子。');
    }
  }

  const duration = await getDuration(videoPath);
  if (!voiceoverEnabled) {
    await generateSilentTrack(duration, voiceTrackPath);
  } else if (useExternalDub) {
    const dubAudioName = safeFileComponent(externalDubFile.name || 'external_dub.wav');
    const dubAudioExt = path.extname(dubAudioName).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(dubAudioExt)) {
      throw new Error('外部配音文件格式不支持，请上传 mp3/wav/m4a/aac/flac/ogg。');
    }

    const externalDubPath = path.join(jobDir, `external_dub${dubAudioExt}`);
    const externalDubBuffer = Buffer.from(await externalDubFile.arrayBuffer());
    await fs.writeFile(externalDubPath, externalDubBuffer);
    await transcodeExternalDubTrack(externalDubPath, duration, voiceTrackPath);
  } else if (useVoiceClone) {
    const cloneOutputs = await synthesizeSpeechWithVoiceClone(
      sentenceEntries,
      cloneProfileId,
      cloneLanguage || 'zh',
      ttsDir,
    );
    await buildVoiceoverTrack(cloneOutputs, duration, voiceTrackPath, 20, dubSpeedNumber);
  } else {
    const ttsOutputs = await synthesizeSpeech(sentenceEntries, voice, rateNumber, ttsDir);
    await buildVoiceoverTrack(ttsOutputs, duration, voiceTrackPath, 18, dubSpeedNumber);
  }

  if (voiceoverEnabled && Math.abs(dubSpeedNumber - 1) > 1e-6) {
    await applyDubSpeed(voiceTrackPath, voiceTrackSpedPath, dubSpeedNumber);
  } else {
    await fs.copyFile(voiceTrackPath, voiceTrackSpedPath);
  }

  const composeResult = await composeVideo({
    videoPath,
    subtitlesPath: subtitlePath,
    voiceTrackPath: voiceTrackSpedPath,
    outputPath,
    subtitleEntries: entries,
    subtitleTextDir,
    subtitlePosition,
    subtitleMargin,
    subtitleYPercent,
    subtitleTextColor,
    subtitleStrokeColor,
    subtitleEnabled,
    keepOriginalAudio,
    originalAudioLevel: originalAudioLevelNumber,
    dubAudioLevel: dubAudioLevelNumber,
  });

  return {
    outputName,
    subtitleMode: composeResult.subtitleMode,
    subtitleUrl: composeResult.subtitleUrl,
    dubSource: !voiceoverEnabled ? 'none' : useExternalDub ? 'external' : useVoiceClone ? 'voice_clone' : 'tts',
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) {
      sendText(res, 400, 'Bad Request');
      return;
    }

    if (req.method === 'GET' && req.url === '/') {
      await sendFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && req.url === '/style.css') {
      await sendFile(res, path.join(PUBLIC_DIR, 'style.css'), 'text/css; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && req.url === '/app.js') {
      await sendFile(res, path.join(PUBLIC_DIR, 'app.js'), 'application/javascript; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && req.url === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'auto_dub_web',
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/voices') {
      const voices = await getSayVoices();
      const defaultVoice = Object.prototype.hasOwnProperty.call(voices, 'Tingting')
        ? 'Tingting'
        : Object.keys(voices)[0];
      sendJson(res, 200, {
        voices,
        defaultVoice,
        provider: 'macos-say',
        voiceHint: '剪映官方私有音色无法直接调用，当前使用系统语音（可选更多音色）。',
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/voice-clone/status') {
      const available = await startVoiceboxBackendIfPossible();
      if (!available) {
        sendJson(res, 200, {
          available: false,
          profiles: [],
          message: '语音克隆后端未就绪，请先执行 scripts/setup_voicebox_backend.sh',
        });
        return;
      }
      const profiles = await getVoiceCloneProfiles();
      sendJson(res, 200, {
        available: true,
        profiles,
        message: '语音克隆后端可用',
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/voice-clone/create') {
      const request = new Request('http://localhost/api/voice-clone/create', {
        method: 'POST',
        headers: req.headers,
        body: req,
        duplex: 'half',
      });
      const formData = await request.formData();
      const profileName = String(formData.get('profile_name') ?? '').trim();
      const language = String(formData.get('language') ?? 'zh').trim();
      const referenceText = String(formData.get('reference_text') ?? '').trim();
      const sampleAudioRaw = formData.get('sample_audio');

      if (!profileName) {
        sendJson(res, 400, { ok: false, error: '请填写克隆声音名称。' });
        return;
      }
      if (!referenceText) {
        sendJson(res, 400, { ok: false, error: '请填写样本对应的参考文本。' });
        return;
      }
      if (!(sampleAudioRaw instanceof File) || sampleAudioRaw.size <= 0) {
        sendJson(res, 400, { ok: false, error: '请上传克隆样本音频。' });
        return;
      }

      const profile = await createVoiceCloneProfile({
        name: profileName,
        language,
        sampleFile: sampleAudioRaw,
        referenceText,
      });

      sendJson(res, 200, {
        ok: true,
        profile,
      });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/outputs/')) {
      const filename = decodeURIComponent(req.url.replace('/outputs/', ''));
      if (!filename || filename.includes('..') || filename.includes('/')) {
        sendText(res, 400, 'Invalid path');
        return;
      }

      const filePath = path.join(OUTPUT_DIR, filename);
      await sendFile(res, filePath, mimeFromExtension(filePath));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/process') {
      const request = new Request('http://localhost/api/process', {
        method: 'POST',
        headers: req.headers,
        body: req,
        duplex: 'half',
      });

      const formData = await request.formData();
      const videoFile = formData.get('video_file');
      const subtitleFile = formData.get('srt_file');
      const voice = String(formData.get('voice') ?? 'Tingting');
      const rate = String(formData.get('rate') ?? '220');
      const ttsMode = String(formData.get('tts_mode') ?? 'system');
      const cloneProfileId = String(formData.get('clone_profile_id') ?? '').trim();
      const cloneLanguage = String(formData.get('clone_language') ?? 'zh').trim();
      const dubSpeed = String(formData.get('dub_speed') ?? '1.0');
      const subtitlePosition = String(formData.get('subtitle_position') ?? 'bottom');
      const subtitleMargin = String(formData.get('subtitle_margin') ?? '120');
      const subtitleYPercent = String(formData.get('subtitle_y_percent') ?? '12');
      const subtitleTextColor = String(formData.get('subtitle_text_color') ?? '#FFA100');
      const subtitleStrokeColor = String(formData.get('subtitle_stroke_color') ?? '#000000');
      const subtitleEnabled = normalizeToggle(formData.get('subtitle_enabled'), true);
      const voiceoverEnabled = normalizeToggle(formData.get('voiceover_enabled'), true);
      const keepOriginalAudio = formData.get('keep_original_audio') !== null;
      const originalAudioLevel = String(formData.get('original_audio_level') ?? '45');
      const dubAudioLevel = String(formData.get('dub_audio_level') ?? '180');
      const externalDubFileRaw = formData.get('dub_audio_file');
      const externalDubFile =
        externalDubFileRaw instanceof File && externalDubFileRaw.size > 0 ? externalDubFileRaw : null;

      if (!(videoFile instanceof File)) {
        sendJson(res, 400, { ok: false, error: '请上传视频文件。' });
        return;
      }

      const needSubtitleFile = subtitleEnabled || voiceoverEnabled;
      if (needSubtitleFile && !(subtitleFile instanceof File)) {
        sendJson(res, 400, { ok: false, error: '请上传 .srt 字幕文件。' });
        return;
      }
      if (!new Set(['system', 'voice_clone']).has(ttsMode)) {
        sendJson(res, 400, { ok: false, error: '无效的配音来源。' });
        return;
      }

      const result = await processJob(
        videoFile,
        subtitleFile,
        voice,
        rate,
        ttsMode,
        cloneProfileId,
        cloneLanguage,
        dubSpeed,
        subtitlePosition,
        subtitleMargin,
        subtitleYPercent,
        subtitleTextColor,
        subtitleStrokeColor,
        subtitleEnabled,
        voiceoverEnabled,
        keepOriginalAudio,
        originalAudioLevel,
        dubAudioLevel,
        externalDubFile,
      );
      sendJson(res, 200, {
        ok: true,
        outputUrl: `/outputs/${result.outputName}`,
        subtitleMode: result.subtitleMode,
        subtitleUrl: result.subtitleUrl,
        dubSource: result.dubSource,
      });
      return;
    }

    sendText(res, 404, 'Not Found');
  } catch (error) {
    console.error(
      `[api] request failed ${req?.method || 'UNKNOWN'} ${req?.url || ''}:`,
      error instanceof Error ? error.stack || error.message : error,
    );
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : '未知错误',
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://127.0.0.1:${PORT}`);
});

// Long-running dubbing jobs can easily exceed Node's default 5-minute request timeout.
server.requestTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 65000;
server.headersTimeout = 0;
