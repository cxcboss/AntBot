const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { editVideo } = require('./editor');
const { shutdownVoicebox } = require('./autoDubClient');
const { recordUsage } = require('./usageTracker');
const { createClipArtifactManager } = require('./clipArtifacts');

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
  const fps = 1 / frameRate;

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

const MAX_VISION_IMAGES_PER_REQUEST = 4;

function createVisionFrameBatches(framePaths) {
  const batches = [];
  for (let i = 0; i < framePaths.length; i += MAX_VISION_IMAGES_PER_REQUEST) {
    batches.push(framePaths.slice(i, i + MAX_VISION_IMAGES_PER_REQUEST));
  }
  return batches;
}

async function recognizeVideoContent(framePaths, apiConfig, progress, abortSignal) {
  const all = [];
  const batches = createVisionFrameBatches(framePaths);
  const totalBatches = batches.length;
  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batch = batches[batchIdx];
    const i = batchIdx * MAX_VISION_IMAGES_PER_REQUEST;
    const pctBase = 15;
    const pctRange = 25;
    const pctStart = pctBase + Math.round((batchIdx / totalBatches) * pctRange);
    const pctEnd = pctBase + Math.round(((batchIdx + 1) / totalBatches) * pctRange);
    progress({ step: 'AI识别', percent: pctStart, message: `识别中 (${i + 1}-${Math.min(i + batch.length, framePaths.length)}/${framePaths.length})...` });
    let microPct = pctStart;
    const microTimer = setInterval(() => {
      microPct = Math.min(microPct + 1, pctEnd - 1);
      progress({ step: 'AI识别', percent: microPct, message: `识别中 (${i + 1}-${Math.min(i + batch.length, framePaths.length)}/${framePaths.length})...` });
    }, 1000);
    const content = [];
    try {
      for (let j = 0; j < batch.length; j++) {
        const buf = await fs.readFile(batch[j]);
        content.push({ type: 'text', text: `[第 ${i + j + 1} 秒]` });
        content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } });
      }
      const ctx = all.length ? `\n\n前面已识别：\n${all.slice(-1).join('\n').slice(-500)}` : '';
      clearInterval(microTimer);
      const r = await callApiWithKeyRotation(apiConfig.baseUrl, apiConfig.apiKeys || [apiConfig.apiKey], apiConfig.modelId, [{ role: 'user', content: [{ type: 'text', text: `这些是一个视频的截图（每秒1帧，共${framePaths.length}秒），第${i + 1}-${Math.min(i + batch.length, framePaths.length)}秒。请详细描述内容，保持连贯性。${ctx}` }, ...content] }], 2000, abortSignal);
      all.push(r);
    } finally { clearInterval(microTimer); }
    progress({ step: 'AI识别', percent: pctEnd, message: `识别中 (${Math.min(i + batch.length, framePaths.length)}/${framePaths.length})...` });
  }
  return all.join('\n\n');
}

/* ── AI SRT generation ── */

async function generateSrt(recognizedContent, stylePrompt, videoDuration, language, apiConfig, progress, abortSignal) {
  progress({ step: '生成字幕', percent: 45, message: '正在生成字幕...' });
  return callApiWithKeyRotation(apiConfig.baseUrl, apiConfig.apiKeys || [apiConfig.apiKey], apiConfig.modelId, [{ role: 'user', content: `以下是视频内容（${videoDuration.toFixed(1)}秒）：\n${recognizedContent}\n\n风格：${stylePrompt || '自然流畅的视频旁白'}\n\n要求：输出标准SRT格式，每句不超20字，总时长<${Math.floor(videoDuration - 1)}秒，每句间隔≥0.3秒，中文每秒约4字。\n\n格式：\n1\n00:00:01,000 --> 00:00:04,000\n第一句话` }], 4000, abortSignal);
}

async function repairSrt(rawSrt, recognizedContent, stylePrompt, videoDuration, apiConfig, abortSignal) {
  const prompt = `上一次生成的字幕无法解析。请重新整理为严格的标准 SRT。\n\n视频时长：${videoDuration.toFixed(1)}秒\n风格：${stylePrompt || '自然流畅的视频旁白'}\n\n视频识别内容：\n${recognizedContent.slice(0, 6000)}\n\n上一次输出：\n${String(rawSrt || '').slice(0, 8000)}\n\n严格要求：\n1. 只输出 SRT，不要 Markdown 代码块、标题或说明。\n2. 时间线必须使用 HH:MM:SS,mmm --> HH:MM:SS,mmm。\n3. 每条字幕之间保留一个空行。\n4. 字幕正文只能包含需要朗读的文案，不能包含序号或时间线。\n5. 每句不超过20字，总时长小于${Math.floor(videoDuration - 1)}秒，每句间隔至少0.3秒。`;
  return callApiWithKeyRotation(apiConfig.baseUrl, apiConfig.apiKeys || [apiConfig.apiKey], apiConfig.modelId, [{ role: 'user', content: prompt }], 4000, abortSignal);
}

/* ── AI video naming ── */

async function generateVideoName(recognizedContent, apiConfig, abortSignal) {
  try {
    const r = await callApiWithKeyRotation(apiConfig.baseUrl, apiConfig.apiKeys || [apiConfig.apiKey], apiConfig.modelId, [{ role: 'user', content: `根据以下内容起一个简短中文名（不超过8字，无标点）：\n${recognizedContent.slice(0, 500)}` }], 50, abortSignal);
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
    const startMs = +timelineMatch[1] * 3600000 + +timelineMatch[2] * 60000 + +timelineMatch[3] * 1000 + Number(timelineMatch[4].padEnd(3, '0'));
    const endMs = +timelineMatch[5] * 3600000 + +timelineMatch[6] * 60000 + +timelineMatch[7] * 1000 + Number(timelineMatch[8].padEnd(3, '0'));
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

function fmtMs(ms) { const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), l = ms % 1000; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(l).padStart(3, '0')}`; }

function validateAndFixSrt(entries, videoDurationMs) {
  if (!entries.length) throw new Error('AI 未生成有效字幕');
  const fixed = [];
  const videoEnd = videoDurationMs - 1000;
  for (const e of entries) {
    const entry = { ...e };
    const minDur = Math.max(1500, entry.text.length * 250);
    if (entry.endMs - entry.startMs < minDur) entry.endMs = entry.startMs + minDur;
    if (entry.endMs > videoEnd) { entry.endMs = videoEnd; if (entry.startMs >= entry.endMs) entry.startMs = Math.max(0, entry.endMs - minDur); }
    if (fixed.length > 0) { const prev = fixed[fixed.length - 1]; if (entry.startMs - prev.endMs < 300) { entry.startMs = prev.endMs + 300; if (entry.endMs - entry.startMs < minDur) entry.endMs = entry.startMs + minDur; } }
    if (entry.startMs >= videoEnd) break;
    if (entry.endMs > videoEnd) entry.endMs = videoEnd;
    entry.index = fixed.length + 1;
    fixed.push(entry);
  }
  if (!fixed.length) throw new Error('字幕校验后无有效条目');
  return fixed;
}

function entriesToSrt(entries) { return entries.map(e => `${e.index}\n${fmtMs(e.startMs)} --> ${fmtMs(e.endMs)}\n${e.text}`).join('\n\n') + '\n'; }

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
    const rawSrt = await generateSrt(recognizedContent, stylePrompt, videoDuration, language, apiConfig, progress, abortSignal);
    const parsedSrt = await parseSrtWithRepair(rawSrt, async (invalidSrt) => {
      checkAbort();
      log(`AI 字幕格式无效（${String(invalidSrt || '').length} 字），正在自动修复...`);
      progress({ step: '修复字幕', percent: 47, message: '字幕格式异常，正在自动修复...' });
      return repairSrt(invalidSrt, recognizedContent, stylePrompt, videoDuration, apiConfig, abortSignal);
    });
    let entries = parsedSrt.entries;
    entries = validateAndFixSrt(entries, videoDurationMs);
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
    progress({ step: '字幕完成', percent: 50 });

    checkAbort();
    const videoName = await generateVideoName(recognizedContent, apiConfig, abortSignal);
    log(`命名: ${videoName}`);
    progress({ step: '准备完成', percent: 52 });

    await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
    return { srtContent, srtPath, videoName, tmpDir, videoDuration };
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
  log = () => {}, progress = () => {}
}) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true }).catch(() => {});
  progress({ step: '合成视频', percent: 55, message: '正在合成视频...' });

  log(`合成: ${path.basename(videoPath)} → ${path.basename(outputPath)}`);

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
      log
    });

    progress({ step: '完成', percent: 100, message: '合成完成' });
    return { outputPath: result.outputPath || outputPath };
  } finally {
    // 无论成功还是失败，都关闭 voicebox 后端释放内存
    await shutdownVoicebox(log).catch(() => {});
  }
}

/* ── Cleanup ── */

async function cleanupStaleCache(maxAgeMs = 3600000) {
  const artifactManager = createClipArtifactManager();
  await artifactManager.cleanupLegacySmartEditCaches(maxAgeMs);
}

module.exports = { prepareEditVideo, composeEditVideo, cleanupStaleCache, createVisionFrameBatches, parseSrt, parseSrtWithRepair };
