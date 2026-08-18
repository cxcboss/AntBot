const fs = require('node:fs/promises');
const path = require('node:path');

const AZURE_ID_PREFIX = 'azure:';

const AZURE_TTS_VOICES = [
  { id: 'azure:zh-CN-XiaoxiaoNeural', name: '晓晓（女·温柔）' },
  { id: 'azure:zh-CN-XiaoyiNeural', name: '晓伊（女·活泼）' },
  { id: 'azure:zh-CN-XiaohanNeural', name: '晓涵（女·甜美）' },
  { id: 'azure:zh-CN-XiaochenNeural', name: '晓辰（女·清亮）' },
  { id: 'azure:zh-CN-YunxiNeural', name: '云希（男·阳光）' },
  { id: 'azure:zh-CN-YunjianNeural', name: '云健（男·沉稳）' },
  { id: 'azure:zh-CN-YunyangNeural', name: '云扬（男·新闻播报）' },
  { id: 'azure:zh-CN-YunfengNeural', name: '云枫（男·磁性）' },
  { id: 'azure:zh-CN-YunxiaNeural', name: '云夏（男·清爽）' },
  { id: 'azure:zh-TW-HsiaoChenNeural', name: '曉臻（女·台湾）' },
  { id: 'azure:zh-HK-HiuMaanNeural', name: '曉曼（女·粤语）' },
];

function isAzureVoiceId(voiceId) {
  return typeof voiceId === 'string' && voiceId.startsWith(AZURE_ID_PREFIX);
}

function azureVoiceShortName(voiceId) {
  return isAzureVoiceId(voiceId) ? voiceId.slice(AZURE_ID_PREFIX.length) : '';
}

function getAzureVoiceName(voiceId) {
  const shortName = azureVoiceShortName(voiceId);
  const found = AZURE_TTS_VOICES.find((v) => v.id === voiceId);
  return found ? found.name : shortName;
}

function getAzureVoices() {
  return AZURE_TTS_VOICES.map((v) => ({ id: v.id, name: v.name, source: 'azure' }));
}

async function synthesizeWithAzure(clips, voiceId, ttsDir, options = {}) {
  const shortName = azureVoiceShortName(voiceId);
  if (!shortName) {
    throw new Error(`无效的 Azure 音色：${voiceId}`);
  }

  const logFn = options.log || console.log;
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
  const outputs = [];
  const errors = [];

  const synthesizeOne = async (idx, entry) => {
    const lineText = entry.text.replace(/\s+/g, ' ').trim();
    if (!lineText) {
      outputs[idx] = null;
      return;
    }
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (options.signal?.aborted) {
        throw new Error('已取消');
      }
      const tts = new MsEdgeTTS();
      try {
        logFn(`[azure-tts] clip ${idx + 1}/${clips.length} (attempt ${attempt}): ${lineText.slice(0, 60)}`);
        await tts.setMetadata(shortName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const dir = path.join(ttsDir, `seg_${idx}`);
        await fs.mkdir(dir, { recursive: true });
        const res = await tts.toFile(dir, lineText);
        const finalPath = path.join(ttsDir, `line_${String(idx + 1).padStart(5, '0')}.mp3`);
        await fs.rename(res.audioFilePath, finalPath);
        await fs.rm(dir, { recursive: true, force: true });
        outputs[idx] = { startMs: entry.startMs, filePath: finalPath };
        logFn(`[azure-tts] clip ready ${idx + 1}/${clips.length}`);
        return;
      } catch (err) {
        lastErr = err;
        logFn(`[azure-tts] attempt ${attempt} failed: ${err.message}`);
        if (options.signal?.aborted) {
          throw new Error('已取消');
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      } finally {
        try { tts.close(); } catch { /* noop */ }
      }
    }
    throw lastErr || new Error('Azure TTS 合成失败');
  };

  const concurrency = 2;
  const queue = clips.map((_, i) => i);
  const executing = new Set();
  while (queue.length || executing.size) {
    while (executing.size < concurrency && queue.length) {
      const idx = queue.shift();
      const promise = synthesizeOne(idx, clips[idx])
        .catch((err) => { errors.push({ idx, err }); })
        .finally(() => { executing.delete(promise); });
      executing.add(promise);
    }
    if (executing.size) {
      await Promise.race(executing);
    }
  }

  if (errors.length) {
    const first = errors[0];
    const msg = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|network/i.test(first.err?.message || '')
      ? 'Azure TTS 合成失败：无法连接微软语音服务，请检查网络后重试'
      : `Azure TTS 合成失败：${first.err?.message || '未知错误'}`;
    throw new Error(msg);
  }

  const result = [];
  for (let i = 0; i < clips.length; i += 1) {
    if (outputs[i]) {
      result.push(outputs[i]);
    }
  }
  return result;
}

module.exports = {
  AZURE_TTS_VOICES,
  AZURE_ID_PREFIX,
  isAzureVoiceId,
  azureVoiceShortName,
  getAzureVoiceName,
  getAzureVoices,
  synthesizeWithAzure,
};