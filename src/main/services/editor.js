const fs = require('node:fs/promises');
const path = require('node:path');
const { ensureDir } = require('./fileUtil');
const { resolveAutoDubProjectPath, processWithAutoDub } = require('./autoDubClient');

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
    log
  } = taskContext;

  const voiceoverEnabled = settings?.style?.voiceoverEnabled !== false;
  const subtitleEnabled = voiceoverEnabled && settings?.style?.subtitleEnabled !== false;
  const needsSubtitleFile = voiceoverEnabled || subtitleEnabled;

  await ensureReadableFile(inputVideoPath, '输入视频文件');
  if (needsSubtitleFile) {
    await ensureReadableFile(subtitlePath, '字幕文件');
  }
  await ensureDir(path.dirname(outputPath));

  const autoDubProjectPath = await resolveAutoDubProjectPath(settings.paths.editProjectPath);
  if (autoDubProjectPath) {
    log(`使用 auto_dub_web 处理视频：${autoDubProjectPath}`);
    return processWithAutoDub({
      projectPath: autoDubProjectPath,
      inputVideoPath,
      subtitlePath: needsSubtitleFile ? subtitlePath : '',
      outputPath,
      subtitleEnabled,
      voiceoverEnabled,
      voiceCloneId: settings.voiceClone.voiceId || '',
      voiceCloneProfileName: settings.voiceClone.profileName || '',
      voiceCloneSamplePath: settings.voiceClone.samplePath || '',
      voiceCloneReferenceText: settings.voiceClone.referenceText || '',
      voiceCloneLanguage: settings.voiceClone.language || 'zh',
      voiceCloneGpuMode: settings.voiceClone.gpuMode || 'auto',
      voiceSpeed: settings.style.voiceSpeed,
      subtitleTextColor: settings.style.subtitleTextColor,
      subtitleStrokeColor: settings.style.subtitleStrokeColor,
      subtitlePositionPercent: settings.style.subtitlePositionPercent,
      subtitleFontSize: settings.style.subtitleFontSize || 0,
      log
    });
  }

  await fs.copyFile(inputVideoPath, outputPath);
  log('未配置剪辑命令，且未找到 auto_dub_web，已直接复制原视频到输出目录（占位模式）。');

  return {
    outputPath,
    mode: 'passthrough'
  };
}

module.exports = {
  editVideo
};
