const fs = require('node:fs/promises');
const path = require('node:path');
const { ensureDir } = require('./fileUtil');
const { composeVideoWithDub } = require('./videoComposer');
const { isAzureVoiceId, azureVoiceShortName } = require('./azureTts');

async function ensureReadableFile(filePath, label) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error('empty');
    }
  } catch {
    throw new Error(`${label}不存在或为空：${filePath}`);
  }
}

async function editVideo(taskContext) {
  const {
    task,
    settings,
    inputVideoPath,
    subtitlePath,
    outputPath,
    abortSignal,
    log,
    progress
  } = taskContext;

  const voiceoverEnabled = settings?.style?.voiceoverEnabled !== false;
  const subtitleEnabled = voiceoverEnabled && settings?.style?.subtitleEnabled !== false;
  const needsSubtitleFile = voiceoverEnabled || subtitleEnabled;

  await ensureReadableFile(inputVideoPath, '输入视频文件');
  if (needsSubtitleFile) {
    await ensureReadableFile(subtitlePath, '字幕文件');
  }
  await ensureDir(path.dirname(outputPath));

  const rawVoiceId = settings.voiceClone?.voiceId || '';
  const useAzureTts = isAzureVoiceId(rawVoiceId);
  const useVoiceClone = !useAzureTts && !!(settings.voiceClone?.profileName || rawVoiceId);

  let cloneProfileId = '';
  let cloneProfileName = '';

  // 如果需要配音克隆：确保后端运行，并解析/自动恢复有效的音色档案。
  // 安装在非 C 盘/升级/后端数据重建后，旧 voiceId 可能失效（后端返回 404 Profile not found），
  // resolveVoiceCloneProfile 会依次按 ID → 名称 → 唯一档案 → 样本自动恢复兜底。
  if (voiceoverEnabled && useVoiceClone) {
    const { resolveVoiceCloneProfile, resolveAutoDubProjectPath } = require('./autoDubClient');
    const projectPath = await resolveAutoDubProjectPath('');
    if (!projectPath) throw new Error('未找到语音克隆后端（auto_dub_web），请检查 vendors/auto_dub_web 目录');
    const resolved = await resolveVoiceCloneProfile({
      projectPath,
      voiceCloneId: settings.voiceClone?.voiceId,
      voiceCloneProfileName: settings.voiceClone?.profileName,
      voiceCloneSamplePath: settings.voiceClone?.samplePath,
      voiceCloneReferenceText: settings.voiceClone?.referenceText,
      language: settings.voiceClone?.language || 'zh',
      gpuMode: settings.voiceClone?.gpuMode || 'auto',
      log,
    });
    if (!resolved?.useVoiceClone || !resolved.profileId) {
      throw new Error('音色档案不可用，请重新在"克隆"面板生成一次音色');
    }
    cloneProfileId = resolved.profileId;
    cloneProfileName = resolved.profileName || '';
    if (resolved.recovered) {
      log(`已自动恢复失效的音色档案：${cloneProfileName} (${cloneProfileId})`);
    }
  }

  log(`开始视频合成：${path.basename(inputVideoPath)}`);

  const result = await composeVideoWithDub({
    inputVideoPath,
    subtitlePath: needsSubtitleFile ? subtitlePath : '',
    outputPath,
    voiceoverEnabled,
    subtitleEnabled,
    ttsMode: useAzureTts ? 'azure' : (useVoiceClone ? 'voice_clone' : 'system'),
    azureVoiceId: useAzureTts ? azureVoiceShortName(rawVoiceId) : '',
    cloneProfileId,
    cloneProfileName,
    cloneLanguage: settings.voiceClone?.language || 'zh',
    dubSpeed: settings.style?.voiceSpeed || 1.0,
    subtitleStyle: {
      textColor: settings.style?.subtitleTextColor,
      strokeColor: settings.style?.subtitleStrokeColor,
      positionPercent: settings.style?.subtitlePositionPercent,
      fontSize: settings.style?.subtitleFontSize || 0,
    },
    abortSignal,
    log,
    progress,
    gpuMode: settings.voiceClone?.gpuMode || 'auto',
  });

  return {
    outputPath: result.outputPath || outputPath,
    mode: result.dubSource || 'composed',
    subtitleMode: result.subtitleMode,
    dubSource: result.dubSource,
  };
}

module.exports = {
  editVideo
};
