const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { editVideo } = require('./editor');
const { shutdownVoicebox } = require('./autoDubClient');
const { recordUsage } = require('./usageTracker');
const { createClipArtifactManager } = require('./clipArtifacts');

/* ── Subtitle text cleanup (professional subtitle standards) ── */

function cleanSubtitleText(text) {
  if (!text) return text;

  // 移除换行符，确保单行字幕显示
  text = text.replace(/\n/g, ' ').replace(/\r/g, '');

  // First, normalize multiple consecutive periods to ellipsis
  // But preserve "..." as it's a valid ellipsis representation
  // Convert "。。。。" or "...." (4+ chars) to "…"
  text = text.replace(/[。]{4,}/g, '…');
  text = text.replace(/[.]{4,}/g, '…');

  // Normalize "..." (3 dots) to unicode ellipsis
  text = text.replace(/\.{3}/g, '…');

  // Clean up multiple consecutive punctuation marks
  text = text.replace(/[！!]{2,}/g, '！');  // Multiple exclamations → single Chinese
  text = text.replace(/[？?]{2,}/g, '？');  // Multiple questions → single Chinese

  // Normalize single English punctuation to Chinese for consistency
  // (Only when at end of text or before closing punctuation)
  text = text.replace(/!([》）"'\s]*$)/g, '！');
  text = text.replace(/\?([》）"'\s]*$)/g, '？');

  // Now remove trailing periods (。.) - subtitles are fragments, not sentences
  // But be careful not to remove ellipsis "…"
  // Handle period before closing quotes/brackets: 。" → "
  text = text.replace(/[。.]+([》）"'\s]*$)/g, '$1');

  // Remove trailing commas if they're the last character
  // (Keep commas in the middle of text for natural pauses)
  text = text.replace(/，+$/, '');

  // Trim whitespace
  text = text.trim();

  return text;
}

/* ── Helpers ── */

function resolveFfmpegBin(name) {
  for (const c of [path.join('/opt/homebrew/bin', name), path.join('/usr/local/bin', name), path.join('/usr/bin', name), name]) {
    if (fsSync.existsSync(c)) return c;
  }
  return name;
}

function runFfmpeg(args, timeoutMs = 120000, abortSignal) {
  const bin = resolveFfmpegBin('ffmpeg');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg 超时')); }, timeoutMs);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch {} };
    if (abortSignal) { if (abortSignal.aborted) onAbort(); else abortSignal.addEventListener('abort', onAbort, { once: true }); }
    child.once('close', (code) => { clearTimeout(timer); if (abortSignal) abortSignal.removeEventListener('abort', onAbort); code === 0 ? resolve() : reject(new Error(`ffmpeg 失败 (exit ${code}): ${stderr.slice(-300)}`)); });
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function getVideoInfo(videoPath) {
  const bin = resolveFfmpegBin('ffprobe');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [
      '-v', 'error', '-print_format', 'json',
      '-show_format', '-show_streams', videoPath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe 失败 (${bin}): ${stderr.slice(0, 200)}`));
      try {
        const info = JSON.parse(stdout);
        const videoStream = (info.streams || []).find(s => s.codec_type === 'video');
        resolve({
          duration: parseFloat(info.format?.duration) || 0,
          width: videoStream?.width || 0,
          height: videoStream?.height || 0,
        });
      } catch (e) { reject(new Error(`ffprobe 解析失败: ${e.message}`)); }
    });
    child.once('error', (e) => reject(new Error(`ffprobe 启动失败 (${bin}): ${e.message}`)));
  });
}

async function callApiWithKeyRotation(baseUrl, apiKeys, modelId, messages, maxTokens = 4000, abortSignal, log = () => {}) {
  const keys = Array.isArray(apiKeys) ? apiKeys.filter(Boolean) : [apiKeys].filter(Boolean);
  if (!keys.length) throw new Error('未配置 API Key');
  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    // 每个 key 最多重试 2 次（网络错误时）
    for (let retry = 0; retry < 2; retry++) {
      try {
        const result = await callApi(baseUrl, keys[i], modelId, messages, maxTokens, abortSignal);
        await recordUsage(keys[i], true).catch(() => {});
        return result;
      } catch (err) {
        lastError = err;
        if (err.message === '已取消') throw err;
        const isRateLimit = err.message.includes('429');
        const isNetwork = err.message.includes('网络') || err.message.includes('ECONNRESET') || err.message.includes('ECONNREFUSED') || err.message.includes('UND_ERR') || err.message.includes('超时');
        await recordUsage(keys[i], false, isRateLimit).catch(() => {});
        if (isRateLimit) {
          if (i < keys.length - 1) { log(`Key ${i + 1} 限频，切换到 Key ${i + 2}`); break; }
          throw err;
        }
        if (isNetwork && retry < 1) {
          log(`网络错误，${(retry + 1) * 3}秒后重试...`);
          await new Promise(r => setTimeout(r, (retry + 1) * 3000));
          continue;
        }
        throw err;
      }
    }
  }
  throw lastError;
}

async function callApi(baseUrl, apiKey, modelId, messages, maxTokens = 4000, abortSignal) {
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  const bodyStr = JSON.stringify({ model: modelId, messages, max_tokens: maxTokens });
  const bodySizeKB = Math.round(Buffer.byteLength(bodyStr, 'utf8') / 1024);
  const apiSignal = abortSignal || AbortSignal.timeout(120000);
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: bodyStr, signal: apiSignal });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const status = response.status;
      const reason = {
        400: '请求格式错误',
        401: 'API Key 无效或已过期',
        403: '没有权限访问此模型',
        404: '模型不存在或 API 地址错误',
        413: '请求内容太大（图片过多）',
        429: 'API 调用频率超限，请稍后重试',
        500: 'API 服务器内部错误',
        502: 'API 服务不可用',
        503: 'API 服务过载',
      }[status] || `HTTP 错误`;
      throw new Error(`${reason} (${status})，${bodySizeKB}KB：${errText.slice(0, 200)}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('已取消');
    if (err.message.includes('HTTP 错误') || err.message.includes('请求格式') || err.message.includes('API Key')) throw err;
    // 网络错误 - 详细记录
    const cause = err.cause?.code || err.cause?.message || '';
    const reason = {
      'ECONNREFUSED': 'API 服务未启动或地址错误',
      'ECONNRESET': '连接被重置（请求可能太大或网络不稳定）',
      'ENOTFOUND': 'API 域名无法解析，请检查网络',
      'ETIMEDOUT': '连接超时，请检查网络',
      'UND_ERR_SOCKET': '连接中断（请求内容可能太大）',
      'UND_ERR_HEADERS_TIMEOUT': '响应超时',
    }[cause] || `网络错误`;
    const detail = `${reason}（${cause || err.name}），请求 ${bodySizeKB}KB，URL: ${url}`;
    throw new Error(detail);
  }
}

/* ── Frame extraction ── */

async function extractFrames(videoPath, outputDir, progress, abortSignal, frameRate = 1, videoWidth = 0) {
  await fs.mkdir(outputDir, { recursive: true });
  for (const f of (await fs.readdir(outputDir).catch(() => []))) { if (f.startsWith('frame_') && f.endsWith('.jpg')) await fs.unlink(path.join(outputDir, f)).catch(() => {}); }

  // 自动帧率：根据视频时长动态调整
  let effectiveFrameRate = frameRate;
  if (frameRate <= 0 || frameRate === 'auto') {
    // 默认0.5fps，短视频1fps，长视频0.5fps
    effectiveFrameRate = videoWidth > 0 ? 1 : 0.5; // 如果有宽度信息用1fps，否则0.5fps
  }
  const fps = 1 / effectiveFrameRate;

  // 根据源视频分辨率动态决定压缩参数
  let scaleFilter = '';
  let qualityArgs = ['-q:v', '5'];
  if (videoWidth > 0 && videoWidth <= 720) {
    // 720p：缩到 480px，中等压缩（保证请求体 < 200KB）
    scaleFilter = ',scale=480:-1';
    qualityArgs = ['-q:v', '6'];
  } else if (videoWidth > 0 && videoWidth <= 1280) {
    scaleFilter = ',scale=384:-1';
    qualityArgs = ['-q:v', '7'];
  } else {
    scaleFilter = ',scale=320:-1';
    qualityArgs = ['-q:v', '8'];
  }

  const vf = `fps=${fps}${scaleFilter}`;
  progress({ step: '抽帧', percent: 5, message: `正在提取视频帧 (${fps.toFixed(1)}fps, ${videoWidth || '?'}px)...` });
  await runFfmpeg(['-i', videoPath, '-vf', vf, ...qualityArgs, '-y', path.join(outputDir, 'frame_%05d.jpg')], 120000, abortSignal);
  return (await fs.readdir(outputDir)).filter(f => f.startsWith('frame_') && f.endsWith('.jpg')).sort().map(f => path.join(outputDir, f));
}

/* ── AI video recognition ── */

const MAX_VISION_IMAGES_PER_REQUEST = 6; // 从4增加到6，减少API调用次数
const MAX_CONCURRENT_BATCHES = 3; // 并发批次数

function createVisionFrameBatches(framePaths) {
  const batches = [];
  for (let i = 0; i < framePaths.length; i += MAX_VISION_IMAGES_PER_REQUEST) {
    batches.push(framePaths.slice(i, i + MAX_VISION_IMAGES_PER_REQUEST));
  }
  return batches;
}

// 识别结果缓存
const recognitionCache = new Map();
const RECOGNITION_CACHE_MAX_SIZE = 50;

async function getRecognitionCacheKey(framePaths) {
  // 使用视频目录、帧数量和首帧文件大小作为缓存键，避免不同视频产生碰撞
  if (!framePaths.length) return 'empty';
  const firstFrame = framePaths[0];
  const stat = await fs.stat(firstFrame).catch(() => null);
  const size = stat ? stat.size : 0;
  return `${path.dirname(firstFrame)}-${framePaths.length}-${size}`;
}

async function recognizeVideoContent(framePaths, apiConfig, progress, abortSignal) {
  // 检查缓存
  const cacheKey = await getRecognitionCacheKey(framePaths);
  if (recognitionCache.has(cacheKey)) {
    progress({ step: 'AI识别', percent: 40, message: '使用缓存的识别结果...' });
    return recognitionCache.get(cacheKey);
  }

  const all = [];
  const batches = createVisionFrameBatches(framePaths);
  const totalBatches = batches.length;
  const results = new Array(totalBatches);

  // 并发处理批次
  const executing = new Set();
  let completedCount = 0;

  const processBatch = async (batchIdx) => {
    const batch = batches[batchIdx];
    const i = batchIdx * MAX_VISION_IMAGES_PER_REQUEST;
    const pctBase = 15;
    const pctRange = 25;
    const pctStart = pctBase + Math.round((batchIdx / totalBatches) * pctRange);
    const pctEnd = pctBase + Math.round(((batchIdx + 1) / totalBatches) * pctRange);

    progress({ step: 'AI识别', percent: pctStart, message: `识别中 (${i + 1}-${Math.min(i + batch.length, framePaths.length)}/${framePaths.length})...` });

    const content = [];
    try {
      for (let j = 0; j < batch.length; j++) {
        const buf = await fs.readFile(batch[j]);
        content.push({ type: 'text', text: `[第 ${i + j + 1} 秒]` });
        content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } });
      }

      // 获取前面批次的上下文（已完成的批次）
      const prevContext = [];
      for (let k = 0; k < batchIdx; k++) {
        if (results[k]) prevContext.push(results[k]);
      }
      const ctx = prevContext.length ? `\n\n前面已识别：\n${prevContext.slice(-1).join('\n').slice(-500)}` : '';

      const r = await callApiWithKeyRotation(apiConfig.baseUrl, apiConfig.apiKeys || [apiConfig.apiKey], apiConfig.modelId, [{ role: 'user', content: [{ type: 'text', text: `这些是一个视频的截图（每秒1帧，共${framePaths.length}秒），第${i + 1}-${Math.min(i + batch.length, framePaths.length)}秒。请详细描述内容，保持连贯性。${ctx}` }, ...content] }], 2000, abortSignal);

      results[batchIdx] = r;
      completedCount++;
      progress({ step: 'AI识别', percent: pctEnd, message: `识别中 (${completedCount}/${totalBatches}批完成)...` });
    } catch (err) {
      results[batchIdx] = '';
      completedCount++;
      throw err;
    }
  };

  // 并发执行，最多 MAX_CONCURRENT_BATCHES 个并发
  const errors = [];
  const queue = batches.map((_, i) => i);
  while (queue.length || executing.size) {
    while (executing.size < MAX_CONCURRENT_BATCHES && queue.length) {
      const idx = queue.shift();
      const promise = processBatch(idx)
        .then(() => executing.delete(promise))
        .catch((err) => {
          executing.delete(promise);
          errors.push(err);
        });
      executing.add(promise);
    }
    if (executing.size) await Promise.race(executing);
  }

  // 如果所有批次都失败，抛出错误
  if (errors.length > 0 && errors.length === totalBatches) {
    throw new Error(`AI识别失败: ${errors[0].message}`);
  }

  // 按顺序组装结果
  const result = results.filter(Boolean).join('\n\n');

  // 存入缓存
  if (result) {
    // 清理过大的缓存
    if (recognitionCache.size >= RECOGNITION_CACHE_MAX_SIZE) {
      const firstKey = recognitionCache.keys().next().value;
      recognitionCache.delete(firstKey);
    }
    recognitionCache.set(cacheKey, result);
  }

  return result;
}

/* ── Content truncation ── */

const MAX_RECOGNIZED_CONTENT_LENGTH = 15000;

function truncateRecognizedContent(content, maxLength = MAX_RECOGNIZED_CONTENT_LENGTH) {
  if (!content || content.length <= maxLength) return content;
  // 保留开头和结尾，中间截断
  const headLen = Math.floor(maxLength * 0.4);
  const tailLen = Math.floor(maxLength * 0.4);
  const head = content.slice(0, headLen);
  const tail = content.slice(-tailLen);
  return `${head}\n\n...（内容过多已截断）...\n\n${tail}`;
}

function calculateMaxTokens(videoDuration) {
  const base = 8000;
  const perMinute = 2000;
  const maxLimit = 20000;
  return Math.min(base + Math.floor(videoDuration / 60 * perMinute), maxLimit);
}

/* ── Style instruction builder ── */

function buildStyleInstruction(stylePrompt) {
  const baseRules = `你是一个专业的短视频旁白文案撰稿人。

【必须做到】
- 给每个可见角色取名字（小红、小明、大灰狼、小火龙等），全程使用名字称呼
- 使用第一人称"我"或第二人称"你"、"我们"
- 像朋友聊天一样自然，有互动感（"你们觉得呢？"、"评论区告诉我"）
- 每3-5句至少出现一次情绪感叹（"哇！"、"哎呀！"、"太厉害了！"）
- 口语化，不要书面语
- 节奏有快有慢，不要均匀

【绝对禁止】
- 禁止使用"角色"、"玩家"、"它"、"这个人"、"视频中的人"等泛称
- 禁止书面语
- 禁止每句字数接近均匀

【互动元素要求】
- 30秒以下视频：至少1次互动（如"你们觉得呢？"、"猜猜接下来会怎样？"）
- 30-60秒：至少2次互动
- 60秒以上：至少3次互动

【输出前自检】
在输出SRT之前，先在脑中列出你将使用的所有角色名字。
写完全部字幕后，自检：如果出现泛称，替换为具体名字。`;

  if (stylePrompt) {
    return `${baseRules}

【风格参考】
以下是目标风格示例，请完全模仿这个风格：
${stylePrompt}`;
  }

  return baseRules;
}

/* ── AI SRT generation ── */

async function generateSrt(recognizedContent, stylePrompt, videoDuration, language, apiConfig, progress, abortSignal) {
  progress({ step: '生成字幕', percent: 45, message: '正在生成字幕...' });
  const truncatedContent = truncateRecognizedContent(recognizedContent);
  const maxTokens = calculateMaxTokens(videoDuration);
  const expectedSubs = Math.max(6, Math.floor(videoDuration / 8));
  const styleInstruction = buildStyleInstruction(stylePrompt);

  const systemMessage = styleInstruction;
  const userMessage = `以下是视频内容（${videoDuration.toFixed(0)}秒）：
${truncatedContent}

【格式要求】
- 输出标准SRT格式
- 每句不超过40字（长句更自然，像真人说话）
- 根据内容自然断句，不要均匀分配时间
- 快节奏部分（动作、紧张）句子紧凑
- 慢节奏部分（停顿、强调）适当留白
- 模仿真人说话的节奏感
- 总时长<${Math.floor(videoDuration - 1)}秒

【SRT格式示例】
1
00:00:01,000 --> 00:00:06,000
第一句长文案

请根据视频内容生成字幕。`;

  return callApiWithKeyRotation(
    apiConfig.baseUrl,
    apiConfig.apiKeys || [apiConfig.apiKey],
    apiConfig.modelId,
    [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage }
    ],
    maxTokens,
    abortSignal
  );
}

async function repairSrt(rawSrt, recognizedContent, stylePrompt, videoDuration, apiConfig, abortSignal) {
  const truncatedContent = truncateRecognizedContent(recognizedContent, 6000);
  const maxTokens = calculateMaxTokens(videoDuration);
  const expectedSubs = Math.max(6, Math.floor(videoDuration / 8));
  const styleInstruction = buildStyleInstruction(stylePrompt);

  const systemMessage = styleInstruction;
  const userMessage = `上一次生成的字幕无法解析。请重新整理为严格的标准 SRT。

视频时长：${videoDuration.toFixed(0)}秒

视频识别内容：
${truncatedContent}

上一次输出：
${String(rawSrt || '').slice(0, 8000)}

【严格格式要求】
- 只输出 SRT，不要 Markdown 代码块、标题或说明
- 时间线必须使用 HH:MM:SS,mmm --> HH:MM:SS,mmm
- 每条字幕之间保留一个空行
- 字幕正文只能包含需要朗读的文案，不能包含序号或时间线
- 每句不超过40字（长句更自然），生成约${expectedSubs}条字幕，总时长小于${Math.floor(videoDuration - 1)}秒

请根据以上内容重新生成字幕。`;

  return callApiWithKeyRotation(
    apiConfig.baseUrl,
    apiConfig.apiKeys || [apiConfig.apiKey],
    apiConfig.modelId,
    [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage }
    ],
    maxTokens,
    abortSignal
  );
}

/* ── AI video naming ── */

async function generateVideoName(recognizedContent, apiConfig, abortSignal) {
  try {
    const r = await callApiWithKeyRotation(apiConfig.baseUrl, apiConfig.apiKeys || [apiConfig.apiKey], apiConfig.modelId, [{ role: 'user', content: `根据以下内容起一个简短中文名（不超过8字，无标点）：\n${recognizedContent.slice(0, 500)}` }], 200, abortSignal);
    return r.replace(/[\s\n"'"《》【】]/g, '').slice(0, 8) || '视频';
  } catch { return '视频'; }
}

/* ── SRT parsing & validation ── */

const SRT_TIMELINE_RE = /^(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{1,3})\s*(?:-->|->|→)\s*(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/;
const SRT_TIMESTAMP_FRAGMENT_RE = /\d{1,2}:[0-5]\d:[0-5]\d[,.]\d{1,3}/;

function parseSrt(srtText) {
  const lines = String(srtText || '').replace(/\r/g, '').split('\n');
  const entries = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    let index = entries.length + 1;
    let timelineMatch = null;

    if (/^\d+$/.test(line) && i + 1 < lines.length) {
      const nextLine = lines[i + 1].trim();
      timelineMatch = nextLine.match(SRT_TIMELINE_RE);
      if (timelineMatch) {
        index = Number(line);
        i += 2;
      } else if (SRT_TIMESTAMP_FRAGMENT_RE.test(nextLine)) {
        throw new Error(`AI 返回的字幕时间线格式异常：${nextLine}`);
      }
    }

    if (!timelineMatch) {
      timelineMatch = line.match(SRT_TIMELINE_RE);
      if (timelineMatch) i += 1;
    }

    if (!timelineMatch) {
      if (SRT_TIMESTAMP_FRAGMENT_RE.test(line)) {
        throw new Error(`AI 返回的字幕时间线格式异常：${line}`);
      }
      i += 1;
      continue;
    }

    const textLines = [];
    while (i < lines.length) {
      const textLine = lines[i].trim();
      if (!textLine) {
        i += 1;
        if (textLines.length) break;
        continue;
      }
      if (textLine.match(SRT_TIMELINE_RE)) break;
      if (/^\d+$/.test(textLine) && i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (nextLine.match(SRT_TIMELINE_RE)) break;
        if (SRT_TIMESTAMP_FRAGMENT_RE.test(nextLine)) {
          throw new Error(`AI 返回的字幕时间线格式异常：${nextLine}`);
        }
      }
      if (SRT_TIMESTAMP_FRAGMENT_RE.test(textLine)) {
        throw new Error(`AI 返回的字幕时间线格式异常：${textLine}`);
      }
      textLines.push(textLine);
      i += 1;
    }

    const text = textLines.join('\n').trim();
    if (!text) continue;
    const startMs = +timelineMatch[1] * 3600000 + +timelineMatch[2] * 60000 + +timelineMatch[3] * 1000 + Number(timelineMatch[4].padStart(3, '0'));
    const endMs = +timelineMatch[5] * 3600000 + +timelineMatch[6] * 60000 + +timelineMatch[7] * 1000 + Number(timelineMatch[8].padStart(3, '0'));
    entries.push({ index, startMs, endMs, text });
  }
  return entries;
}

async function parseSrtWithRepair(rawSrt, repair) {
  try {
    const entries = parseSrt(rawSrt);
    if (entries.length) return { entries, srtText: rawSrt, repaired: false };
  } catch {}

  const repairedSrt = await repair(rawSrt);
  let entries;
  try {
    entries = parseSrt(repairedSrt);
  } catch (err) {
    throw new Error(`AI 字幕格式修复失败：${err.message}`);
  }
  if (!entries.length) throw new Error('AI 多次未生成有效字幕');
  return { entries, srtText: repairedSrt, repaired: true };
}

function fmtMs(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const l = Math.floor(ms % 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(l).padStart(3, '0')}`;
}

/* ── Dynamic subtitle font size calculation ── */

function calculateSubtitleFontSize(videoHeight, videoWidth) {
  // Use the shorter dimension to handle both horizontal and vertical videos
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

function calculateMaxCharsPerLine(videoWidth, fontSize) {
  const charWidth = fontSize * 1.0;
  const usableWidth = videoWidth * 0.8;
  // Minimum 8 chars per line, maximum 30
  return Math.max(8, Math.min(30, Math.floor(usableWidth / charWidth)));
}

function validateAndFixSrt(entries, videoDurationMs) {
  if (!entries.length) throw new Error('AI 未生成有效字幕');
  const fixed = [];
  const videoEnd = videoDurationMs - 1000;
  for (const e of entries) {
    const entry = { ...e };
    const stType = detectSentenceType(entry.text);
    const minDur = calculateNaturalDuration(entry.text, stType);
    if (entry.endMs - entry.startMs < minDur) entry.endMs = entry.startMs + minDur;
    if (entry.endMs > videoEnd) { entry.endMs = videoEnd; if (entry.startMs >= entry.endMs) entry.startMs = Math.max(0, entry.endMs - minDur); }
    if (fixed.length > 0) {
      const prev = fixed[fixed.length - 1];
      const prevType = detectSentenceType(prev.text);
      const gap = calculateGap(prevType, stType);
      if (entry.startMs - prev.endMs < gap) {
        entry.startMs = prev.endMs + gap;
        if (entry.endMs - entry.startMs < minDur) entry.endMs = entry.startMs + minDur;
      }
    }
    if (entry.startMs >= videoEnd) break;
    if (entry.endMs > videoEnd) entry.endMs = videoEnd;
    entry.index = fixed.length + 1;
    fixed.push(entry);
  }
  if (!fixed.length) throw new Error('字幕校验后无有效条目');

  // 确保最后一句字幕有足够时间朗读完
  if (fixed.length > 0) {
    const lastEntry = fixed[fixed.length - 1];
    const lastDuration = lastEntry.endMs - lastEntry.startMs;
    const minLastDuration = Math.max(2000, lastEntry.text.length * 300); // 每字300ms，最少2秒
    if (lastDuration < minLastDuration) {
      lastEntry.endMs = Math.min(videoDurationMs, lastEntry.startMs + minLastDuration);
    }
  }

  return fixed;
}

function entriesToSrt(entries) { return entries.map(e => `${e.index}\n${fmtMs(e.startMs)} --> ${fmtMs(e.endMs)}\n${e.text}`).join('\n\n') + '\n'; }

/* ── Dynamic gap timing helpers ── */

function detectSentenceType(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return 'statement';

  // Interjections: very short exclamatory words (1-4 chars, no main clause)
  if (trimmed.length <= 4 && /^[哇呀嗯哦哎哈嘿噢欸哟]+[！！？?。.]*$/.test(trimmed)) return 'interjection';

  // Exclamation: ends with ! or contains strong exclamatory words
  if (/！$|!$/.test(trimmed)) return 'exclamation';
  if (/太[厉害可怕精彩震撼强高]|真的是太|我的天|天[哪呐]|不会吧/.test(trimmed)) return 'exclamation';

  // Question: ends with ? or contains question patterns
  if (/？$|\?$/.test(trimmed)) return 'question';
  if (/吗$|呢$|吧[？?]$|怎么|为什么|什么|谁[是说]|哪里|多少|几$/.test(trimmed)) return 'question';

  // Dramatic: ellipses, em dashes, dramatic keywords
  if (/…|\.\.\.|——|──/.test(trimmed)) return 'dramatic';
  if (/突然|忽然|没想到|居然|竟然|不可思议|难以置信|紧张|屏住呼吸/.test(trimmed)) return 'dramatic';

  // Continuation: mid-sentence (no terminal punctuation, or ends with comma/semicolon/connective)
  if (/[，,；;…]$/.test(trimmed) || !/[。！？.!]$/.test(trimmed)) return 'continuation';

  return 'statement';
}

function calculateGap(currentType, _nextType) {
  // Gap after the current sentence (ms) - letting content breathe naturally
  const gapMap = {
    'exclamation':      600,  // let emotion land
    'question':         350,  // audience thinking time
    'dramatic':         500,  // pause for effect
    'topic_shift':      450,  // clear separation
    'interjection':     150,  // quick, keep flowing
    'continuation':      80,  // flow naturally
    'statement':        250,  // default
  };
  return gapMap[currentType] ?? 250;
}

function calculateNaturalDuration(text, sentenceType) {
  const charCount = (text || '').length;
  let duration = charCount * 250;

  // Punctuation pauses (additive)
  const commas   = (text.match(/[，,]/g) || []).length;
  const periods  = (text.match(/[。.]/g) || []).length;
  const ellipses = (text.match(/…|\.\.\./g) || []).length;
  const qMarks   = (text.match(/[？?]/g) || []).length;
  const eMarks   = (text.match(/[！!]/g) || []).length;

  duration += commas * 200;
  duration += periods * 400;
  duration += ellipses * 600;
  duration += qMarks * 400;
  duration += eMarks * 300;

  // Numbers need more processing time for the audience
  duration += (text.match(/\d+/g) || []).length * 150;

  // Sentence type multiplier (relative to statement baseline)
  const typeMultiplier = {
    'exclamation':   0.7,   // shorter, punchy
    'question':      1.2,   // thinking time
    'dramatic':      1.3,   // slower, suspenseful
    'interjection':  0.5,   // very short
    'continuation':  0.85,  // flowing
    'statement':     1.0,   // baseline
  };
  duration = Math.round(duration * (typeMultiplier[sentenceType] ?? 1.0));

  return Math.max(MIN_SEGMENT_DURATION, Math.min(duration, 12000));
}

/* ── Subtitle splitting for long lines ── */

const PUNCTUATION_RE = /[，。！？,!?]/;
const SPLIT_THRESHOLD = 15;
const MIN_SEGMENT_DURATION = 1500;

function splitLongSubtitle(entry) {
  const { text, startMs, endMs } = entry;
  if (text.length <= SPLIT_THRESHOLD) return [entry];

  const segments = splitTextAtBoundaries(text);
  if (segments.length <= 1) return [entry];

  // Calculate dynamic gaps based on sentence types of each segment
  const segmentTypes = segments.map(s => detectSentenceType(s));
  const segmentGaps = [];
  for (let i = 0; i < segments.length - 1; i++) {
    segmentGaps.push(calculateGap(segmentTypes[i], segmentTypes[i + 1]));
  }
  const totalGapTime = segmentGaps.reduce((sum, g) => sum + g, 0);

  const totalDuration = endMs - startMs;
  const numSegments = segments.length;
  const availableDuration = totalDuration - totalGapTime;

  const minRequiredDuration = numSegments * MIN_SEGMENT_DURATION;
  if (availableDuration < minRequiredDuration) {
    const maxPossibleSegments = Math.floor(availableDuration / MIN_SEGMENT_DURATION);
    if (maxPossibleSegments < 2) {
      return [entry];
    }
    return reduceSegments(entry, segments, maxPossibleSegments, startMs, endMs, availableDuration);
  }

  const totalChars = segments.reduce((sum, seg) => sum + seg.length, 0);
  const extraTime = availableDuration - minRequiredDuration;
  const timePerExtraChar = extraTime / totalChars;

  const result = [];
  let currentStart = startMs;

  for (let i = 0; i < segments.length; i++) {
    const segmentText = segments[i];
    const extraDuration = segmentText.length * timePerExtraChar;
    const segmentDuration = MIN_SEGMENT_DURATION + extraDuration;
    const segmentEnd = (i === segments.length - 1)
      ? endMs
      : Math.min(endMs, currentStart + segmentDuration);

    result.push({
      ...entry,
      text: segmentText,
      startMs: Math.round(currentStart),
      endMs: Math.round(segmentEnd)
    });

    const gap = (i < segments.length - 1) ? segmentGaps[i] : 0;
    currentStart = segmentEnd + gap;
  }

  return result;
}

function reduceSegments(entry, segments, maxSegments, startMs, endMs, availableDuration) {
  const mergedSegments = [];
  let i = 0;

  while (i < segments.length) {
    const remaining = segments.length - i;
    const slotsLeft = maxSegments - mergedSegments.length;

    if (remaining <= slotsLeft) {
      mergedSegments.push(segments[i]);
      i++;
    } else {
      const mergeCount = Math.ceil(remaining / slotsLeft);
      let merged = '';
      for (let j = 0; j < mergeCount && i + j < segments.length; j++) {
        merged += segments[i + j];
      }
      mergedSegments.push(merged);
      i += mergeCount;
    }
  }

  // Calculate dynamic gaps for merged segments
  const mergedTypes = mergedSegments.map(s => detectSentenceType(s));
  const mergedGaps = [];
  for (let gi = 0; gi < mergedSegments.length - 1; gi++) {
    mergedGaps.push(calculateGap(mergedTypes[gi], mergedTypes[gi + 1]));
  }

  const numSegments = mergedSegments.length;
  const minRequiredDuration = numSegments * MIN_SEGMENT_DURATION;
  const totalChars = mergedSegments.reduce((sum, seg) => sum + seg.length, 0);
  const extraTime = Math.max(0, availableDuration - minRequiredDuration);
  const timePerExtraChar = extraTime / totalChars;

  const result = [];
  let currentStart = startMs;

  for (let k = 0; k < mergedSegments.length; k++) {
    const segmentText = mergedSegments[k];
    const extraDuration = segmentText.length * timePerExtraChar;
    const segmentDuration = MIN_SEGMENT_DURATION + extraDuration;
    const segmentEnd = (k === mergedSegments.length - 1)
      ? endMs
      : Math.min(endMs, currentStart + segmentDuration);

    result.push({
      ...entry,
      text: segmentText,
      startMs: Math.round(currentStart),
      endMs: Math.round(segmentEnd)
    });

    const gap = (k < mergedSegments.length - 1) ? mergedGaps[k] : 0;
    currentStart = segmentEnd + gap;
  }

  return result;
}

function splitTextAtBoundaries(text) {
  if (text.length <= SPLIT_THRESHOLD) return [text];

  const punctuationPositions = [];
  for (let i = 0; i < text.length; i++) {
    if (PUNCTUATION_RE.test(text[i])) {
      punctuationPositions.push(i);
    }
  }

  if (punctuationPositions.length > 0) {
    return splitAtPunctuation(text, punctuationPositions);
  }

  return splitAtNaturalBoundary(text);
}

function splitAtPunctuation(text, positions) {
  const segments = [];
  let lastSplit = 0;

  for (const pos of positions) {
    const splitPoint = pos + 1;
    const segment = text.slice(lastSplit, splitPoint).trim();
    if (segment.length > 0) {
      segments.push(segment);
    }
    lastSplit = splitPoint;
  }

  const remaining = text.slice(lastSplit).trim();
  if (remaining.length > 0) {
    if (remaining.length <= SPLIT_THRESHOLD) {
      segments.push(remaining);
    } else {
      const subSegments = splitAtNaturalBoundary(remaining);
      segments.push(...subSegments);
    }
  }

  return segments;
}

function splitAtNaturalBoundary(text) {
  if (text.length <= SPLIT_THRESHOLD) return [text];

  const midPoint = Math.floor(text.length / 2);
  let bestSplit = midPoint;

  const searchStart = Math.max(0, midPoint - 5);
  const searchEnd = Math.min(text.length, midPoint + 5);

  for (let i = searchStart; i < searchEnd; i++) {
    const char = text[i];
    if (char === ' ' || char === '、' || char === '；' || char === '：') {
      bestSplit = i + 1;
      break;
    }
    if (i > 0 && /[一-鿿]/.test(text[i - 1]) && /[一-鿿]/.test(text[i])) {
      bestSplit = i;
    }
  }

  const firstHalf = text.slice(0, bestSplit).trim();
  const secondHalf = text.slice(bestSplit).trim();

  const segments = [];
  if (firstHalf.length > 0) segments.push(firstHalf);
  if (secondHalf.length > 0) segments.push(secondHalf);

  const finalSegments = [];
  for (const seg of segments) {
    if (seg.length > SPLIT_THRESHOLD) {
      finalSegments.push(...forceSplit(seg));
    } else {
      finalSegments.push(seg);
    }
  }
  return finalSegments.length > 0 ? finalSegments : [text];
}

function forceSplit(text) {
  if (text.length <= SPLIT_THRESHOLD) return [text];

  const segments = [];
  let remaining = text;

  while (remaining.length > SPLIT_THRESHOLD) {
    let splitPoint = SPLIT_THRESHOLD;

    const searchStart = Math.max(0, splitPoint - 3);
    const searchEnd = Math.min(remaining.length, splitPoint + 3);
    for (let i = searchStart; i < searchEnd; i++) {
      if (remaining[i] === ' ' || remaining[i] === '、') {
        splitPoint = i + 1;
        break;
      }
    }

    segments.push(remaining.slice(0, splitPoint).trim());
    remaining = remaining.slice(splitPoint).trim();
  }

  if (remaining.length > 0) segments.push(remaining);
  return segments;
}

function splitLongSubtitles(entries) {
  const result = [];

  for (const entry of entries) {
    const splitEntries = splitLongSubtitle(entry);
    result.push(...splitEntries);
  }

  // Apply punctuation cleanup to each segment (professional subtitle standards)
  result.forEach(entry => {
    entry.text = cleanSubtitleText(entry.text);
  });

  // Remove entries that became empty after cleanup
  const filtered = result.filter(e => e.text.length > 0);

  for (let i = 0; i < filtered.length; i++) {
    filtered[i].index = i + 1;
  }

  return filtered;
}

/* ── Phase 1: Prepare (frames + AI recognition + SRT + naming) ── */

async function prepareEditVideo({
  taskId, videoPath, stylePrompt, apiConfig, language = 'zh', frameRate = 1,
  dataDir,
  abortSignal, log = () => {}, progress = () => {}
}) {
  if (!videoPath) throw new Error('请选择视频文件');
  if (!apiConfig?.baseUrl || (!apiConfig?.apiKey && !apiConfig?.apiKeys?.length)) throw new Error('请先配置 API');
  const checkAbort = () => { if (abortSignal?.aborted) throw new Error('已取消'); };

  log(`视频: ${path.basename(videoPath)}`);
  log(`API: ${apiConfig.baseUrl} | 模型: ${apiConfig.modelId || '(未指定)'}`);
  if (stylePrompt) log(`风格: ${stylePrompt.slice(0, 60)}...`);

  const videoInfo = await getVideoInfo(videoPath);
  const videoDuration = videoInfo.duration;
  if (videoDuration <= 0) throw new Error('无法获取视频时长');
  const videoDurationMs = Math.floor(videoDuration * 1000);
  log(`视频: ${videoDuration.toFixed(1)}s, ${videoInfo.width}x${videoInfo.height}`);

  const artifactManager = createClipArtifactManager({ dataDir, log });
  const cacheTaskId = taskId || `smart-edit-${Date.now()}`;
  const tmpDir = await artifactManager.ensureTaskCache(cacheTaskId, {
    status: 'preparing',
    videoPath,
    language,
    frameRate,
  });
  const framesDir = path.join(tmpDir, 'frames');
  const srtPath = path.join(tmpDir, 'subtitle.srt');

  try {
    checkAbort();
    const framePaths = await extractFrames(videoPath, framesDir, progress, abortSignal, frameRate, videoInfo.width);
    if (!framePaths.length) throw new Error('抽帧失败');
    log(`抽帧: ${framePaths.length} 帧`);
    progress({ step: '抽帧', percent: 12 });

    checkAbort();
    const recognizedContent = await recognizeVideoContent(framePaths, apiConfig, progress, abortSignal);
    log(`识别: ${recognizedContent.length} 字`);
    if (!recognizedContent.trim()) throw new Error('AI 未识别到内容');
    progress({ step: '识别完成', percent: 42 });

    checkAbort();
    // 并行执行 SRT 生成和视频命名
    const [rawSrt, videoName] = await Promise.all([
      generateSrt(recognizedContent, stylePrompt, videoDuration, language, apiConfig, progress, abortSignal),
      generateVideoName(recognizedContent, apiConfig, abortSignal)
    ]);

    const parsedSrt = await parseSrtWithRepair(rawSrt, async (invalidSrt) => {
      checkAbort();
      log(`AI 字幕格式无效（${String(invalidSrt || '').length} 字），正在自动修复...`);
      progress({ step: '修复字幕', percent: 47, message: '字幕格式异常，正在自动修复...' });
      return repairSrt(invalidSrt, recognizedContent, stylePrompt, videoDuration, apiConfig, abortSignal);
    });
    let entries = parsedSrt.entries;
    entries = validateAndFixSrt(entries, videoDurationMs);
    entries = splitLongSubtitles(entries);
    // Additional cleanup pass for professional subtitle standards
    entries = entries.map(e => ({ ...e, text: cleanSubtitleText(e.text) }));
    entries = entries.filter(e => e.text.length > 0);
    const srtContent = entriesToSrt(entries);
    await fs.writeFile(srtPath, srtContent, 'utf-8');
    await artifactManager.writeTaskManifest(cacheTaskId, {
      status: 'ready',
      videoPath,
      srtPath,
      videoDuration,
    });
    if (parsedSrt.repaired) log('字幕格式自动修复完成');
    log(`字幕: ${entries.length} 句`);
    log(`命名: ${videoName}`);
    progress({ step: '字幕完成', percent: 50 });

    checkAbort();

    await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
    return { srtContent, srtPath, videoName, tmpDir, videoDuration, videoWidth: videoInfo.width, videoHeight: videoInfo.height };
  } catch (err) {
    await artifactManager.cleanupTaskCache({ id: cacheTaskId, tmpDir }).catch(() => {});
    throw err;
  }
}

/* ── Phase 2: Compose (delegates to original editVideo) ── */

async function composeEditVideo({
  videoPath, srtPath, outputPath,
  voiceProfileId, voiceProfileName, language = 'zh', voiceSpeed = 1.1,
  subtitleStyle = {},
  videoWidth = 0, videoHeight = 0,
  abortSignal,
  log = () => {}, progress = () => {}
}) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true }).catch(() => {});
  progress({ step: '合成视频', percent: 55, message: '正在合成视频...' });

  const fontSize = videoHeight > 0 ? calculateSubtitleFontSize(videoHeight, videoWidth) : 48;
  log(`合成: ${path.basename(videoPath)} → ${path.basename(outputPath)} (fontSize=${fontSize})`);

  try {
    const result = await editVideo({
      task: { taskName: path.basename(videoPath) },
      settings: {
        style: {
          voiceoverEnabled: true,
          subtitleEnabled: true,
          voiceSpeed,
          subtitleTextColor: subtitleStyle.textColor || '#FFA100',
          subtitleStrokeColor: subtitleStyle.strokeColor || '#000000',
          subtitlePositionPercent: subtitleStyle.positionPercent ?? 12,
          subtitleFontSize: fontSize,
        },
        voiceClone: {
          voiceId: voiceProfileId || '',
          profileName: voiceProfileName || '',
          samplePath: '',
          referenceText: '',
          language: language || 'zh',
        },
        paths: { editProjectPath: '' },
        commands: {},
      },
      inputVideoPath: videoPath,
      subtitlePath: srtPath,
      outputPath,
      abortSignal,
      log
    });

    progress({ step: '完成', percent: 100, message: '合成完成' });
    return { outputPath: result.outputPath || outputPath };
  } finally {
    // 不在这里关闭 voicebox，由调度器统一管理（带延迟预热）
  }
}

/* ── Cleanup ── */

async function cleanupStaleCache(maxAgeMs = 3600000) {
  const artifactManager = createClipArtifactManager();
  await artifactManager.cleanupLegacySmartEditCaches(maxAgeMs);
}

module.exports = {
  prepareEditVideo, composeEditVideo, cleanupStaleCache, createVisionFrameBatches,
  parseSrt, parseSrtWithRepair, splitLongSubtitles, validateAndFixSrt,
  detectSentenceType, calculateGap, calculateNaturalDuration,
  truncateRecognizedContent, calculateMaxTokens, buildStyleInstruction,
  generateSrt, repairSrt, extractFrames, recognizeVideoContent, generateVideoName,
  splitLongSubtitle, splitTextAtBoundaries, splitAtPunctuation, splitAtNaturalBoundary, forceSplit,
  fmtMs, entriesToSrt, cleanSubtitleText,
  calculateSubtitleFontSize, calculateMaxCharsPerLine,
};
