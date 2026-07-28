const fs = require('node:fs/promises');
const path = require('node:path');
const dayjs = require('dayjs');
const { runCommand } = require('./commandRunner');
const { createBrowserPublishBridge } = require('./browserPublishBridge');

const PLATFORM_CONFIG = {
  videoChannel: {
    key: 'videoChannel',
    label: '视频号',
    urls: [
      'https://channels.weixin.qq.com/platform/post/create',
      'https://channels.weixin.qq.com/platform',
      'https://channels.weixin.qq.com'
    ],
    loginKeywords: ['登录', '扫码', '微信', 'sign in', '登录后使用'],
    publishKeywords: ['发表', '发布', '立即发表', '立即发布'],
    scheduleKeywords: ['定时发表', '定时发布'],
    successKeywords: ['发表成功', '发布成功', '已发布', '提交成功', '已提交', '审核中']
  },
  douyin: {
    key: 'douyin',
    label: '抖音',
    urls: [
      'https://creator.douyin.com/creator-micro/content/publish',
      'https://creator.douyin.com/creator-micro/content/upload',
      'https://creator.douyin.com'
    ],
    loginKeywords: ['登录', '扫码', '抖音号登录', 'sign in'],
    publishKeywords: ['发布', '立即发布', '发表', '立即发表'],
    scheduleKeywords: ['定时发布'],
    successKeywords: ['发布成功', '已发布', '提交成功', '已提交', '审核中']
  }
};

function uniq(items) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function resolveTaskPlatforms(task, settings) {
  if (Array.isArray(task?.platforms) && task.platforms.length) {
    return uniq(task.platforms).filter((item) => PLATFORM_CONFIG[item]);
  }

  const fallbackRaw = String(settings?.publish?.platform || '');
  if (/抖音/i.test(fallbackRaw)) {
    return ['douyin'];
  }
  if (/(微信|视频号)/.test(fallbackRaw)) {
    return ['videoChannel'];
  }

  return ['videoChannel'];
}

async function ensureOutputVideoExists(outputPath) {
  try {
    const stat = await fs.stat(outputPath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error('empty');
    }
  } catch {
    throw new Error(`发布失败，视频文件不存在或为空：${outputPath}`);
  }
}

async function publishVideo(taskContext) {
  const {
    task,
    settings,
    outputPath,
    log
  } = taskContext;

  await ensureOutputVideoExists(outputPath);
  const scheduleAt = task.publishAt ? dayjs(task.publishAt).format('YYYY-MM-DD HH:mm') : '';
  const platforms = resolveTaskPlatforms(task, settings);
  log(`发布平台: ${platforms.join(', ')}`);

  const extensionConfig = settings?.publish?.browserExtension;
  log(`桥接配置: enabled=${extensionConfig?.enabled}, baseUrl=${extensionConfig?.baseUrl}`);

  if (extensionConfig?.enabled) {
    const bridge = createBrowserPublishBridge({
      baseUrl: extensionConfig.baseUrl,
      timeoutMs: 5 * 60 * 1000
    });
    try {
      const bridgeStatus = await bridge.getStatus();
      log(`桥接状态: ${bridgeStatus.status}`);
      if (bridgeStatus.status === 'ready' || bridgeStatus.status === 'busy') {
        // 发布前检测平台登录状态
        for (const platform of platforms) {
          const platformLabel = platform === 'videoChannel' ? '视频号' : '抖音';
          try {
            const loginResult = await bridge.checkLogin({ platform: platform === 'videoChannel' ? 'weixin' : platform });
            if (!loginResult.loggedIn) {
              throw new Error(`${platformLabel}未登录，请先在浏览器中扫码登录`);
            }
            log(`${platformLabel}已登录`);
          } catch (loginErr) {
            if (loginErr.message.includes('未登录')) throw loginErr;
            log(`${platformLabel}登录检测跳过: ${loginErr.message}`);
          }
        }
        const allResults = [];
        for (const platform of platforms) {
          const platformLabel = platform === 'videoChannel' ? '视频号' : '抖音';
          const videoStat = await fs.stat(outputPath);
          log(`发布到${platformLabel}: ${path.basename(outputPath)} (${(videoStat.size/1024/1024).toFixed(1)}MB), platform=${platform === 'videoChannel' ? 'weixin' : platform}`);
          const bridgeResult = await bridge.publish({
            videos: [{
              name: path.basename(outputPath),
              path: outputPath,
              size: videoStat.size
            }],
            settings: {
              isOriginal: Boolean(task.isOriginal),
              scheduledPublish: Boolean(task.publishAt),
              scheduleTime: task.publishAt ? new Date(task.publishAt).toISOString() : '',
              publishCopy: task.publishCopy || '',
              publishTopics: Array.isArray(task.publishTopics) ? task.publishTopics : [],
              autoGenerate: false,
              autoRetry: false,
              timeoutSeconds: 180
            },
            videoPath: path.dirname(outputPath),
            platform: platform === 'videoChannel' ? 'weixin' : platform,
            onProgress: event => log(`[${platformLabel}] ${event.step || event.detail || event.status || ''}`)
          });
          log(`${platformLabel}发布成功`);
          allResults.push(...(bridgeResult.results || bridgeResult.records || []));
        }
        return {
          mode: 'browser-extension',
          scheduleAt,
          platforms,
          results: allResults
        };
      }
    } catch (error) {
      throw error;
    }
  }

  if (settings.commands.publish) {
    for (const platform of platforms) {
      await runCommand(settings.commands.publish, {
        cwd: settings.paths.publishProjectPath || undefined,
        log,
        timeoutMs: 25 * 60 * 1000,
        variables: {
          video: outputPath,
          scheduleAt,
          taskName: task.taskName,
          platform,
          original: task.isOriginal ? '1' : '0'
        }
      });
    }

    return {
      mode: 'custom-command',
      scheduleAt,
      platforms
    };
  }

  throw new Error('发布桥接服务未运行，请在发布页面启动服务后重试');
}

module.exports = {
  publishVideo,
  resolveTaskPlatforms
};
