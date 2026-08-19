const fs = require('node:fs/promises');
const path = require('node:path');
const dayjs = require('dayjs');
const { createBrowserPublishBridge, resolveBridgeBaseUrl } = require('./browserPublishBridge');

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

async function ensureBridgeReady({ baseUrl, log, platformHint = 'weixin', timeoutMs = 35000 }) {
  const { bridgeServiceManager } = require('./bridgeServiceManager');
  const { openBrowserForPlatform } = require('./browserLauncher');
  // 动态解析真实可用地址（支持端口漂移）
  let resolvedBaseUrl = baseUrl;
  try {
    resolvedBaseUrl = await resolveBridgeBaseUrl(baseUrl);
  } catch {}
  let bridge = createBrowserPublishBridge({ baseUrl: resolvedBaseUrl, timeoutMs: 5 * 60 * 1000 });
  // 先尝试 3 次快速探测（指数退避）
  for (let i = 0; i < 3; i++) {
    try {
      const st = await bridge.getStatus();
      if (st && (st.status === 'ready' || st.status === 'busy')) {
        if (st.extensionConnected) return { bridge, baseUrl: resolvedBaseUrl, status: st };
        break; // 服务在线但插件未连接，进入拉起浏览器流程
      }
    } catch (e) {
      if (i === 2) log(`桥接探测失败: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  // 服务未就绪，尝试启动
  try {
    log('桥接服务未就绪，尝试自动启动...');
    const started = await bridgeServiceManager.start();
    if (started) {
      resolvedBaseUrl = bridgeServiceManager.getBaseUrl();
      bridge = createBrowserPublishBridge({ baseUrl: resolvedBaseUrl, timeoutMs: 5 * 60 * 1000 });
      // 等待就绪
      for (let i = 0; i < 10; i++) {
        try {
          const st = await bridge.getStatus();
          if (st && (st.status === 'ready' || st.status === 'busy')) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
      log(`桥接服务已启动: ${resolvedBaseUrl}`);
    }
  } catch (e) {
    log(`自动启动桥接失败: ${e.message}`);
  }

  // 检查插件连接，若未连接则尝试拉起浏览器（允许弹新窗口）
  let status;
  try {
    status = await bridge.getStatus();
  } catch (e) {
    throw new Error(`桥接服务未运行: ${e.message}，请在发布页面启动服务后重试`);
  }
  if (!status.extensionConnected) {
    log('浏览器插件未连接，尝试自动打开浏览器...');
    try {
      const platform = platformHint === 'douyin' ? 'douyin' : 'weixin';
      const opened = await openBrowserForPlatform(platform, { allowSpawn: true });
      if (opened.ok) log(`已打开浏览器: ${opened.url}，等待插件连接...`);
      else log(`自动打开浏览器失败: ${opened.error}`);
    } catch (e) {
      log(`打开浏览器异常: ${e.message}`);
    }
    // 轮询等待插件连接 30s
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const s = await bridge.getStatus();
        if (s.extensionConnected) {
          log('浏览器插件已连接');
          return { bridge, baseUrl: resolvedBaseUrl, status: s };
        }
      } catch {}
    }
    throw new Error('浏览器插件未连接，请确认 Chrome 已打开、插件已加载并保持启用（已尝试自动打开浏览器，若仍未连接请手动打开）');
  }
  return { bridge, baseUrl: resolvedBaseUrl, status };
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
    const hintPlatform = platforms[0] === 'douyin' ? 'douyin' : 'weixin';
    const { bridge } = await ensureBridgeReady({
      baseUrl: extensionConfig.baseUrl,
      log,
      platformHint: hintPlatform,
    });
    const bridgeStatus = await bridge.getStatus();
    log(`桥接状态: ${bridgeStatus.status}, 插件连接: ${bridgeStatus.extensionConnected ? '是' : '否'}, 端口: ${bridgeStatus.port || ''}`);
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
        let anyPartial = false;
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
              campaignName: task.campaignName || '',
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
          // H3: 部分成功（如批量多视频中有失败）不当作整体失败
          if (bridgeResult?.partialSuccess) {
            anyPartial = true;
            const failed = (bridgeResult.records || []).filter(r => r && r.status !== 'success');
            log(`[${platformLabel}]部分发布成功，${failed.length} 个视频失败: ${failed.map(r => r.videoName || r.error || '').join('、') || bridgeResult.error || '未知原因'}`);
          } else {
            log(`${platformLabel}发布成功`);
          }
          allResults.push(...(bridgeResult.results || bridgeResult.records || []));
        }
        return {
          mode: 'browser-extension',
          scheduleAt,
          platforms,
          results: allResults,
          partialSuccess: anyPartial,
          partialFailed: anyPartial ? allResults.filter(r => r && r.status !== 'success') : []
        };
      }
  }

  throw new Error('发布桥接服务未运行，请在发布页面启动服务后重试');
}

module.exports = {
  publishVideo,
  resolveTaskPlatforms,
  ensureBridgeReady,
};
