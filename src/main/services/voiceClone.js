const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createVoiceCloneProfileWithAutoDub,
  resolveAutoDubProjectPath
} = require('./autoDubClient');

async function runVoiceClone(payload, settings, log = () => {}) {
  const logger = typeof log === 'function' ? log : log?.log || (() => {});
  const progress = typeof log === 'function' ? (() => {}) : (log?.progress || (() => {}));
  const samplePath = String(payload?.samplePath || '').trim();
  const referenceText = String(payload?.referenceText || '').trim();
  const profileName = String(payload?.profileName || '').trim();
  const language = String(payload?.language || settings?.voiceClone?.language || 'zh').trim() || 'zh';

  progress({
    status: 'running',
    step: '参数校验',
    percent: 6,
    message: '正在校验样本音频和参考文本...'
  });

  if (!samplePath) {
    throw new Error('请先选择样本音频文件。');
  }

  if (!referenceText) {
    throw new Error('请填写样本音频对应的文本。');
  }

  try {
    await fs.access(samplePath);
  } catch {
    throw new Error(`样本音频不存在：${samplePath}`);
  }

  const autoDubPath = await resolveAutoDubProjectPath(settings?.paths?.editProjectPath || '');
  if (!autoDubPath) {
    throw new Error('未找到 auto_dub_web 项目目录，请先在设置里填写“剪辑项目目录”。');
  }

  logger(`准备创建语音克隆档案：${path.basename(samplePath)}`);
  progress({
    status: 'running',
    step: '环境准备',
    percent: 14,
    message: '正在初始化语音克隆环境...'
  });
  const created = await createVoiceCloneProfileWithAutoDub({
    projectPath: autoDubPath,
    samplePath,
    referenceText,
    profileName,
    language,
    log: logger,
    progress
  });

  if (settings.commands.voiceClone) {
    logger('已配置“语音克隆命令”，当前优先使用内置 Voicebox 克隆流程。');
  }

  progress({
    status: 'running',
    step: '保存结果',
    percent: 96,
    message: '语音克隆已完成，正在保存配置...'
  });

  return {
    voiceId: created.voiceId,
    modelPath: String(settings?.voiceClone?.modelPath || '').trim(),
    samplePath,
    referenceText,
    profileName: created.profileName || profileName,
    language: created.profileLanguage || language
  };
}

module.exports = {
  runVoiceClone
};
