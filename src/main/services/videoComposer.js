/**
 * videoComposer.js — extracted from vendors/auto_dub_web/server.mjs
 *
 * Core video composition logic: SRT parsing, subtitle rendering, TTS synthesis,
 * audio mixing, and ffmpeg-based video composition.
 */

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { resolveDependencyPath } = require('./dependencyManager');

// ─── Constants ───────────────────────────────────────────────────────────────

const SUBTITLE_HORIZONTAL_MARGIN = 64;
const VOICEBOX_BASE_URL = process.env.VOICEBOX_BASE_URL ?? 'http://127.0.0.1:17493';

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

// ─── Cached state ────────────────────────────────────────────────────────────

let ffmpegFilterSupport = null;
let cachedVoices = null;
let cachedSubtitleFont = null;

// ─── ffmpeg/ffprobe path resolution (via dependencyManager) ───────────────────

async function getFfmpegBin() {
  return await resolveDependencyPath('ffmpeg') || 'ffmpeg';
}

async function getFfprobeBin() {
  return await resolveDependencyPath('ffprobe') || 'ffprobe';
}

// ─── Generic command runner ───────────────────────────────────────────────────

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

function runCommandCapture(command, args, options = {}) {
  return new Promise((resolve) => {
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

// ─── ffmpeg/ffprobe command runners ───────────────────────────────────────────

async function runFfmpegCommand(args, options = {}) {
  const ffmpegBin = await getFfmpegBin();
  if (!ffmpegBin) {
    throw new Error('未找到可用的 ffmpeg。');
  }
  return await runCommand(ffmpegBin, args, options);
}

async function runFfprobeCommand(args, options = {}) {
  const ffprobeBin = await getFfprobeBin();
  if (!ffprobeBin) {
    throw new Error('未找到可用的 ffprobe。');
  }
  return await runCommand(ffprobeBin, args, options);
}

// ─── Dynamic subtitle font size calculation ──────────────────────────────────

function calculateSubtitleFontSize(videoHeight, videoWidth) {
  const shortSide = videoWidth > 0 ? Math.min(videoHeight, videoWidth) : videoHeight;

  // Higher percentage for small videos, lower for large videos
  let percentage;
  if (shortSide <= 360) {
    percentage = 0.06;  // 360p: ~22px
  } else if (shortSide <= 480) {
    percentage = 0.05;  // 480p: ~24px
  } else if (shortSide <= 720) {
    percentage = 0.04;  // 720p: ~29px
  } else {
    percentage = 0.035; // 1080p+: ~38px
  }

  const baseFontSize = Math.round(shortSide * percentage);
  const minFontSize = 18;
  const maxFontSize = 48;
  return Math.max(minFontSize, Math.min(maxFontSize, baseFontSize));
}

function calculateMaxUnitsPerLine(videoWidth, fontSize) {
  const unitWidth = fontSize * 1.2;
  const usableWidth = videoWidth * 0.8;
  return Math.max(8, Math.min(30, Math.floor(usableWidth / unitWidth)));
}

// ─── SRT / Subtitle parsing ──────────────────────────────────────────────────

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

// ─── Subtitle styling helpers ────────────────────────────────────────────────

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

function deriveSubtitleMargin(position, percent, fallbackMargin, videoHeight = 1920) {
  if (!Number.isFinite(percent)) {
    return fallbackMargin;
  }
  const usableHeight = videoHeight - 60;
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
    } else if (/[，。！？；：、""''（）《》【】]/u.test(char)) {
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

  const tokens = text.match(/[A-Za-z0-9]+(?:[''-][A-Za-z0-9]+)*|\s+|./gu) || [text];
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

// ─── ffmpeg filter support ───────────────────────────────────────────────────

async function getFfmpegFilterSupport() {
  if (ffmpegFilterSupport !== null) {
    return ffmpegFilterSupport;
  }

  const ffmpegBin = await getFfmpegBin();
  const ffprobeBin = await getFfprobeBin();

  const filtersProbe = await runCommandCapture(ffmpegBin, ['-filters']);
  if (!filtersProbe.ok) {
    ffmpegFilterSupport = {
      ffmpegBin,
      ffprobeBin,
      subtitles: false,
      drawtext: false,
      overlay: false,
    };
    return ffmpegFilterSupport;
  }

  const combined = `${filtersProbe.stdout}\n${filtersProbe.stderr}`;
  ffmpegFilterSupport = {
    ffmpegBin,
    ffprobeBin,
    subtitles: /\bsubtitles\b/.test(combined),
    drawtext: /\bdrawtext\b/.test(combined),
    overlay: /\boverlay\b/.test(combined),
  };
  return ffmpegFilterSupport;
}

// ─── Subtitle font resolution ────────────────────────────────────────────────

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
  fontSize = 48,
  maxUnits = 38,
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
    // 单行字幕：去除换行符，确保单行显示
    const singleLineText = entry.text.replace(/\n/g, ' ').replace(/\r/g, '').trim();
    await fs.writeFile(textFilePath, singleLineText, 'utf8');

    const escapedTextFilePath = escapeSubtitlesFilterPath(textFilePath);
    const startSec = (entry.startMs / 1000).toFixed(3);
    const endSec = (entry.endMs / 1000).toFixed(3);

    const yExpr = drawtextYExpression(subtitlePosition, subtitleMargin, subtitleYPercent);
    filters.push(
      `drawtext=fontfile='${escapedFontPath}':textfile='${escapedTextFilePath}':fontcolor=${safeTextColor}:fontsize=${fontSize}:borderw=2:bordercolor=${safeStrokeColor}:box=0:line_spacing=8:x=(w-text_w)/2:y=${yExpr}:enable='between(t,${startSec},${endSec})'`,
    );
  }

  return filters.join(',');
}

// ─── ffprobe helpers ─────────────────────────────────────────────────────────

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

async function getVideoDimensions(videoPath) {
  const { stdout } = await runFfprobeCommand([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=s=x:p=0',
    videoPath,
  ]);

  const [width, height] = stdout.trim().split('x').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('无法读取视频分辨率。');
  }
  return { width, height };
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

// ─── Voicebox HTTP helpers ───────────────────────────────────────────────────

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

async function fetchVoiceboxBinary(endpoint, options = {}) {
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

    if (!response.ok) {
      const contentType = response.headers.get('content-type') || '';
      const detail = contentType.includes('application/json')
        ? await response.json().catch(() => null)
        : await response.text().catch(() => '');
      const message = typeof detail === 'object' && detail?.detail
        ? detail.detail
        : detail;
      throw new Error(`Voice clone 引擎请求失败 (${response.status}): ${typeof message === 'string' ? message : JSON.stringify(message)}`);
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Voice clone 引擎请求超时（${endpoint}，${timeoutMs}ms）`);
    }
    throw new Error(`Voice clone 引擎连接失败（${endpoint}）：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Voicebox model readiness helpers ────────────────────────────────────────

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
      await new Promise((resolve) => setTimeout(resolve, 3000));
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

    await new Promise((resolve) => setTimeout(resolve, status?.downloading ? 5000 : 3000));
  }

  throw new Error(`语音模型下载超时：${modelName}`);
}

// ─── TTS synthesis (Voicebox) ────────────────────────────────────────────────

/**
 * Build the Voicebox generation request payload.
 * (Inlined from voicebox-generation.mjs to avoid ESM import.)
 */
function buildVoiceboxGenerationRequest({ profileId, text, language }) {
  return {
    endpoint: '/generate/stream',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profile_id: profileId,
      text,
      language,
      model_size: '1.7B',
      // ICL mode can echo the reference recording before the requested text.
      x_vector_only_mode: true,
    }),
  };
}

async function generateVoiceboxClip(profileId, text, language, log = console.log) {
  const modelName = 'qwen-tts-1.7B';
  await waitForVoiceboxModelReady(modelName, log);
  const request = buildVoiceboxGenerationRequest({ profileId, text, language });
  return fetchVoiceboxBinary(request.endpoint, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    timeoutMs: 15 * 60 * 1000,
  });
}

async function synthesizeSpeechWithVoiceClone(clips, profileId, language, ttsDir) {
  const outputs = [];

  for (let i = 0; i < clips.length; i += 1) {
    const entry = clips[i];
    const lineText = entry.text.replace(/\s+/g, ' ').trim();
    console.log(`[voicebox] generating clip ${i + 1}/${clips.length}: ${lineText.slice(0, 60)}`);
    const audioBuffer = await generateVoiceboxClip(profileId, entry.text, language, console.log);
    const output = path.join(ttsDir, `line_${String(i + 1).padStart(5, '0')}.wav`);
    await fs.writeFile(output, audioBuffer);
    console.log(`[voicebox] clip ready ${i + 1}/${clips.length}: streamed wav`);
    outputs.push({ startMs: entry.startMs, filePath: output });
  }

  return outputs;
}

// ─── TTS synthesis (macOS say) ───────────────────────────────────────────────

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

// ─── Audio processing ────────────────────────────────────────────────────────

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

// ─── Video composition ───────────────────────────────────────────────────────

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
  subtitleFontSize: subtitleFontSizeInput = 0,
}) {
  const filterSupport = await getFfmpegFilterSupport();
  const hasOriginalAudio = keepOriginalAudio ? await videoHasAudio(videoPath) : false;
  const originalRatio = (originalAudioLevel / 100).toFixed(3);
  const dubRatio = (dubAudioLevel / 100).toFixed(3);
  const subtitleFont = await resolveSubtitleFont();
  console.log(`[subtitle] using font: ${subtitleFont.assName} (${subtitleFont.path})`);

  // 获取视频实际分辨率
  const { width: videoWidth, height: videoHeight } = await getVideoDimensions(videoPath);
  console.log(`[subtitle] video dimensions: ${videoWidth}x${videoHeight}`);

  // 计算动态字体大小
  const fontSize = subtitleFontSizeInput > 0
    ? subtitleFontSizeInput
    : calculateSubtitleFontSize(videoHeight, videoWidth);
  const maxUnits = videoWidth > 0 ? calculateMaxUnitsPerLine(videoWidth, fontSize) : 38;
  console.log(`[subtitle] fontSize=${fontSize}, maxUnits=${maxUnits}`);

  // 直接使用原视频，不缩放，不添加模糊背景
  const filterParts = [
    '[0:v]null[vbase]',
  ];
  const preciseSubtitlePosition = Number.isFinite(subtitleYPercent);
  const effectiveSubtitleMargin = deriveSubtitleMargin(subtitlePosition, subtitleYPercent, subtitleMargin, videoHeight);

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
      fontSize,
      maxUnits,
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
      'WrapStyle=2',  // 禁止自动换行，只在显式 \n 时换行
      `FontName=${subtitleFont.assName}`,
      `FontSize=${fontSize}`,
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
      fontSize,
      maxUnits,
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

// ─── Main entry point ────────────────────────────────────────────────────────

async function composeVideoWithDub({
  inputVideoPath,
  subtitlePath,
  outputPath,
  voiceoverEnabled,
  subtitleEnabled,
  ttsMode,           // 'voice_clone' | 'system'
  cloneProfileId,    // Voicebox profile ID
  cloneLanguage,     // 'zh' | 'en'
  dubSpeed,          // 0.5 - 3.0
  subtitleStyle,     // { textColor, strokeColor, positionPercent, fontSize }
  log,               // (msg) => void
  progress,          // ({percent, step, message}) => void
}) {
  const logFn = log || console.log;
  const progressFn = progress || (() => {});

  // Create temp workspace
  const tmpDir = path.join(os.tmpdir(), 'antbot-compose-' + Date.now());
  const ttsDir = path.join(tmpDir, 'tts');
  const subtitleTextDir = path.join(tmpDir, 'subtitle_texts');
  const voiceTrackPath = path.join(tmpDir, 'voiceover.wav');
  const voiceTrackSpedPath = path.join(tmpDir, 'voiceover_sped.wav');

  await fs.mkdir(ttsDir, { recursive: true });
  await fs.mkdir(subtitleTextDir, { recursive: true });

  // Normalize subtitle style
  const subtitleTextColor = normalizeHexColor(subtitleStyle?.textColor, '#FFA100');
  const subtitleStrokeColor = normalizeHexColor(subtitleStyle?.strokeColor, '#000000');
  const subtitleYPercent = normalizeSubtitleYPercent(subtitleStyle?.positionPercent);
  const subtitleFontSize = Number(subtitleStyle?.fontSize) || 0;

  // Default subtitle position/margin for non-percent mode
  const subtitlePosition = 'bottom';
  const subtitleMargin = 120;

  const dubSpeedNumber = Number(dubSpeed);
  if (!Number.isFinite(dubSpeedNumber) || dubSpeedNumber < 0.5 || dubSpeedNumber > 3.0) {
    throw new Error('配音速度必须在 0.5 到 3.0 之间。');
  }

  try {
    // 1. Parse SRT, split into sentences
    progressFn({ percent: 5, step: 'parsing', message: '解析字幕文件...' });

    let entries = [];
    let sentenceEntries = [];
    if (subtitlePath) {
      const subtitleText = await fs.readFile(subtitlePath, 'utf-8');
      entries = parseSrt(subtitleText);
      if (entries.length === 0) {
        throw new Error('字幕解析失败，未提取到有效文本。');
      }
      logFn(`[compose] parsed ${entries.length} subtitle entries`);
      sentenceEntries = splitSubtitleEntriesIntoSentences(entries);
      if (voiceoverEnabled && sentenceEntries.length === 0) {
        throw new Error('字幕分句失败，未提取到有效句子。');
      }
      logFn(`[compose] split into ${sentenceEntries.length} sentence entries`);
    }

    // 2. Get video duration/dimensions
    progressFn({ percent: 10, step: 'probing', message: '读取视频信息...' });
    const duration = await getDuration(inputVideoPath);
    logFn(`[compose] video duration: ${duration.toFixed(2)}s`);

    // 3. Generate TTS
    let dubSource = 'none';
    if (!voiceoverEnabled) {
      progressFn({ percent: 20, step: 'silent', message: '生成静音轨道...' });
      await generateSilentTrack(duration, voiceTrackPath);
    } else if (ttsMode === 'voice_clone' && cloneProfileId) {
      progressFn({ percent: 20, step: 'tts-clone', message: '语音克隆合成中...' });
      const cloneOutputs = await synthesizeSpeechWithVoiceClone(
        sentenceEntries,
        cloneProfileId,
        cloneLanguage || 'zh',
        ttsDir,
      );
      logFn(`[compose] generated ${cloneOutputs.length} voice clone clips`);
      progressFn({ percent: 60, step: 'mixing', message: '混合配音轨道...' });
      await buildVoiceoverTrack(cloneOutputs, duration, voiceTrackPath, 20, dubSpeedNumber);
      dubSource = 'voice_clone';
    } else {
      progressFn({ percent: 20, step: 'tts-system', message: '系统语音合成中...' });
      // Use first available system voice
      const voices = await getSayVoices();
      const voice = Object.prototype.hasOwnProperty.call(voices, 'Tingting')
        ? 'Tingting'
        : Object.keys(voices)[0];
      const ttsOutputs = await synthesizeSpeech(sentenceEntries, voice, 220, ttsDir);
      logFn(`[compose] generated ${ttsOutputs.length} system TTS clips`);
      progressFn({ percent: 60, step: 'mixing', message: '混合配音轨道...' });
      await buildVoiceoverTrack(ttsOutputs, duration, voiceTrackPath, 18, dubSpeedNumber);
      dubSource = 'tts';
    }

    // 4. Apply dub speed if needed
    progressFn({ percent: 65, step: 'speed', message: '处理配音速度...' });
    if (voiceoverEnabled && Math.abs(dubSpeedNumber - 1) > 1e-6) {
      await applyDubSpeed(voiceTrackPath, voiceTrackSpedPath, dubSpeedNumber);
    } else {
      await fs.copyFile(voiceTrackPath, voiceTrackSpedPath);
    }

    // 5. Compose final video
    progressFn({ percent: 70, step: 'composing', message: '合成最终视频...' });
    const composeResult = await composeVideo({
      videoPath: inputVideoPath,
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
      subtitleFontSize,
      subtitleEnabled,
      keepOriginalAudio: false,
      originalAudioLevel: 0,
      dubAudioLevel: 180,
    });

    progressFn({ percent: 100, step: 'done', message: '合成完成' });

    return {
      outputPath,
      subtitleMode: composeResult.subtitleMode,
      dubSource,
    };
  } finally {
    // 6. Clean up temp files
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

module.exports = {
  composeVideoWithDub,
  parseSrt,
};
