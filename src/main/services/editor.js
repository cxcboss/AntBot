const fs = require('node:fs/promises');
const path = require('node:path');
const { ensureDir } = require('./fileUtil');
const { composeVideoWithDub } = require('./videoComposer');

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

  const useVoiceClone = !!(settings.voiceClone?.voiceId);

  // 如果需要配音克隆，确保 Voicebox 后端运行
  if (voiceoverEnabled && useVoiceClone) {
    const { ensureVoiceCloneBackend, resolveAutoDubProjectPath } = require('./autoDubClient');
    const projectPath = await resolveAutoDubProjectPath('');
    if (!projectPath) throw new Error('未找到语音克隆后端（auto_dub_web），请检查 vendors/auto_dub_web 目录');
    await ensureVoiceCloneBackend(projectPath, log, progress || (() => {}), {
      gpuMode: settings.voiceClone.gpuMode || 'auto'
    });
  }

  log(`开始视频合成：${path.basename(inputVideoPath)}`);

  const result = await composeVideoWithDub({
    inputVideoPath,
    subtitlePath: needsSubtitleFile ? subtitlePath : '',
    outputPath,
    voiceoverEnabled,
    subtitleEnabled,
    ttsMode: useVoiceClone ? 'voice_clone' : 'system',
    cloneProfileId: settings.voiceClone?.voiceId || '',
    cloneLanguage: settings.voiceClone?.language || 'zh',
    dubSpeed: settings.style?.voiceSpeed || 1.0,
    subtitleStyle: {
      textColor: settings.style?.subtitleTextColor,
      strokeColor: settings.style?.subtitleStrokeColor,
      positionPercent: settings.style?.subtitlePositionPercent,
      fontSize: settings.style?.subtitleFontSize || 0,
    },
    log,
    progress,
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
