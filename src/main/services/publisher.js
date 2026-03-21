const fs = require('node:fs/promises');
const dayjs = require('dayjs');
const { runCommand } = require('./commandRunner');
const { getProfileDir } = require('./startupCheck');
const { launchPersistentChromiumContext } = require('./playwrightUtil');

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

const UPLOAD_SELECTORS = [
  'input[type="file"][accept*="video"]',
  'input[type="file"][accept*=".mp4"]',
  'input[type="file"]'
];

const DEFAULT_TOPICS = ['#动画', '#奇葩游戏', '#游戏视频', '#小游戏', '#休闲游戏'];
const WEIXIN_SHORT_TITLE_HINTS = ['概括视频主要内容', '字数建议', '6-16个字符', '短标题'];
const WEIXIN_DESCRIPTION_SELECTORS = [
  '[contenteditable="true"]',
  'textarea',
  '[data-placeholder]',
  '.editor',
  '.ql-editor',
  '[class*="editor"]',
  '[class*="Editor"]',
  'div[contenteditable]'
];
const WEIXIN_POST_CREATE_ROUTE = '**/*post_create*';

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

function parseActivityName(task, outputPath) {
  if (task?.isOriginal) {
    return '';
  }

  const isMetaTaskName = (value) => /^(普通|原创|不原创|非原创)$/i.test(String(value || '').replace(/\s+/g, ''));

  const rawTaskName = String(task?.taskName || '').trim();
  if (isMetaTaskName(rawTaskName)) {
    return '';
  }

  if (rawTaskName) {
    const cleaned = rawTaskName
      .replace(/^(任务|活动)[:：\s]*/i, '')
      .replace(/[，,]\s*(微信|视频号|抖音)\s*$/i, '')
      .trim();
    if (cleaned && !isMetaTaskName(cleaned)) {
      return cleaned;
    }
  }

  const fileStem = String(outputPath || '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.[^./\\]+$/, '')
    .trim();

  if (fileStem) {
    const byPrefixMatch = fileStem.match(/^\d{8}\d*-(.+)$/);
    if (byPrefixMatch && byPrefixMatch[1] && !isMetaTaskName(byPrefixMatch[1])) {
      return byPrefixMatch[1].trim();
    }

    const gameMatch = fileStem.match(/小游戏[-_ ]*([^\s#，,]+)/);
    if (gameMatch && gameMatch[1] && !isMetaTaskName(gameMatch[1])) {
      return gameMatch[1].trim();
    }
  }

  return isMetaTaskName(rawTaskName) ? '' : rawTaskName;
}

function buildPublishTopics(task) {
  const customTopics = Array.isArray(task?.publishTopics)
    ? task.publishTopics.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  return customTopics.length ? uniq(customTopics) : DEFAULT_TOPICS.slice();
}

function buildPublishDescription(task, topics = buildPublishTopics(task)) {
  const customCopy = String(task?.publishCopy || '').trim();
  const topicText = uniq(topics).join(' ').trim();
  return [customCopy, topicText].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function resolveBrowserActionDelay(settings, minimum = 1200) {
  const raw = Number(settings?.browser?.actionDelayMs || 1500);
  if (!Number.isFinite(raw) || raw <= 0) {
    return minimum;
  }
  return Math.max(minimum, raw);
}

async function getFrameElementCount(frame) {
  try {
    return await frame.evaluate(() => {
      let count = document.querySelectorAll('*').length;
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (iframeDoc) {
            count += iframeDoc.querySelectorAll('*').length;
          }
        } catch {
          // noop
        }
      }
      return count;
    });
  } catch {
    return 0;
  }
}

async function resolveWeixinTargetFrame(page, logger = () => {}) {
  let bestFrame = page.mainFrame();
  let bestCount = 0;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const frames = [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame())];
    bestFrame = page.mainFrame();
    bestCount = 0;

    for (const frame of frames) {
      const count = await getFrameElementCount(frame);
      if (count > bestCount) {
        bestCount = count;
        bestFrame = frame;
      }
    }

    if (bestCount > 50) {
      break;
    }

    await page.waitForTimeout(1000);
  }

  logger(`视频号操作上下文已锁定，元素数：${bestCount}`);
  return bestFrame;
}

async function getWeixinActionContexts(target) {
  if (target && typeof target.frames === 'function') {
    const frames = [target.mainFrame(), ...target.frames().filter((frame) => frame !== target.mainFrame())];
    const counted = await Promise.all(frames.map(async (frame) => ({
      frame,
      count: await getFrameElementCount(frame)
    })));

    return counted
      .sort((a, b) => b.count - a.count)
      .map((item) => item.frame);
  }

  if (target && typeof target.page === 'function') {
    const page = target.page();
    if (page && typeof page.frames === 'function') {
      const frames = [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame())];
      const counted = await Promise.all(frames.map(async (frame) => ({
        frame,
        count: await getFrameElementCount(frame)
      })));
      counted.sort((a, b) => b.count - a.count);

      const ordered = [];
      const seen = new Set();
      if (target) {
        ordered.push(target);
        seen.add(target);
      }
      for (const item of counted) {
        if (seen.has(item.frame)) {
          continue;
        }
        seen.add(item.frame);
        ordered.push(item.frame);
      }
      return ordered;
    }
  }

  return [target];
}

async function waitForWeixinComposerReady(page, logger = () => {}) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await page.evaluate(({ selectors, shortTitleHints }) => {
      const isVisible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(node);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        return true;
      };

      const shadowHosts = Array.from(document.querySelectorAll('*'));
      let candidateCount = 0;

      for (const host of shadowHosts) {
        if (!host.shadowRoot) {
          continue;
        }

        for (const selector of selectors) {
          let nodes = [];
          try {
            nodes = Array.from(host.shadowRoot.querySelectorAll(selector));
          } catch {
            nodes = [];
          }

          for (const node of nodes) {
            if (!isVisible(node)) {
              continue;
            }

            const placeholder = String(
              node.getAttribute?.('placeholder')
              || node.getAttribute?.('data-placeholder')
              || ''
            ).trim();

            if (shortTitleHints.some((hint) => placeholder.includes(hint))) {
              continue;
            }

            candidateCount += 1;
          }
        }
      }

      return {
        ready: candidateCount > 0,
        candidateCount,
        bodyPreview: String(document.body?.innerText || '').slice(0, 300)
      };
    }, {
      selectors: WEIXIN_DESCRIPTION_SELECTORS,
      shortTitleHints: WEIXIN_SHORT_TITLE_HINTS
    });

    if (status.ready) {
      logger(`视频号发布编辑器已就绪，检测到 ${status.candidateCount} 个候选输入框。`);
      return true;
    }

    await page.waitForTimeout(500);
  }

  logger('视频号发布编辑器等待超时，继续尝试填写。');
  return false;
}

async function fillWeixinDescriptionField(page, text) {
  return page.evaluate(({ value, selectors, shortTitleHints }) => {
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      return true;
    };

    let largestElement = null;
    let largestWidth = 0;

    for (const host of document.querySelectorAll('*')) {
      if (!host.shadowRoot) {
        continue;
      }

      for (const selector of selectors) {
        let nodes = [];
        try {
          nodes = Array.from(host.shadowRoot.querySelectorAll(selector));
        } catch {
          nodes = [];
        }

        for (const element of nodes) {
          if (!isVisible(element)) {
            continue;
          }

          const rect = element.getBoundingClientRect();
          const placeholder = String(
            element.placeholder
            || element.getAttribute?.('placeholder')
            || element.getAttribute?.('data-placeholder')
            || ''
          ).trim();

          if (shortTitleHints.some((hint) => placeholder.includes(hint))) {
            continue;
          }

          if (rect.width > largestWidth) {
            largestWidth = rect.width;
            largestElement = element;
          }
        }
      }
    }

    if (!largestElement || largestWidth <= 100) {
      return {
        ok: false,
        width: largestWidth,
        content: ''
      };
    }

    largestElement.focus();

    if (largestElement.contentEditable === 'true' || largestElement.getAttribute?.('contenteditable') === 'true') {
      largestElement.innerHTML = '';
      try {
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, value);
      } catch {
        largestElement.textContent = value;
      }
      if (String(largestElement.innerText || largestElement.textContent || '').trim() !== value.trim()) {
        largestElement.textContent = value;
      }
      largestElement.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: 'insertText'
      }));
      largestElement.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: value,
        inputType: 'insertText'
      }));
      largestElement.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        ok: true,
        width: largestWidth,
        content: String(largestElement.innerText || largestElement.textContent || '').trim()
      };
    }

    largestElement.value = '';
    largestElement.dispatchEvent(new Event('input', { bubbles: true }));

    for (const char of value) {
      largestElement.value += char;
      largestElement.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: char,
        inputType: 'insertText'
      }));
    }

    largestElement.dispatchEvent(new Event('change', { bubbles: true }));

    return {
      ok: true,
      width: largestWidth,
      content: String(largestElement.value || '').trim()
    };
  }, {
    value: text,
    selectors: WEIXIN_DESCRIPTION_SELECTORS,
    shortTitleHints: WEIXIN_SHORT_TITLE_HINTS
  });
}

async function readWeixinDescriptionText(page) {
  return page.evaluate(({ selectors, shortTitleHints }) => {
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      return true;
    };

    let largestElement = null;
    let largestWidth = 0;

    for (const host of document.querySelectorAll('*')) {
      if (!host.shadowRoot) {
        continue;
      }

      for (const selector of selectors) {
        let nodes = [];
        try {
          nodes = Array.from(host.shadowRoot.querySelectorAll(selector));
        } catch {
          nodes = [];
        }

        for (const element of nodes) {
          if (!isVisible(element)) {
            continue;
          }

          const rect = element.getBoundingClientRect();
          const placeholder = String(
            element.placeholder
            || element.getAttribute?.('placeholder')
            || element.getAttribute?.('data-placeholder')
            || ''
          ).trim();

          if (shortTitleHints.some((hint) => placeholder.includes(hint))) {
            continue;
          }

          if (rect.width > largestWidth) {
            largestWidth = rect.width;
            largestElement = element;
          }
        }
      }
    }

    if (!largestElement) {
      return '';
    }

    if (largestElement.tagName === 'TEXTAREA' || largestElement.tagName === 'INPUT') {
      return String(largestElement.value || '').trim();
    }

    return String(largestElement.innerText || largestElement.textContent || '').trim();
  }, {
    selectors: WEIXIN_DESCRIPTION_SELECTORS,
    shortTitleHints: WEIXIN_SHORT_TITLE_HINTS
  });
}

async function clearWeixinShortTitleInput(page) {
  return page.evaluate((shortTitleHints) => {
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      return true;
    };

    for (const host of document.querySelectorAll('*')) {
      if (!host.shadowRoot) {
        continue;
      }

      const nodes = host.shadowRoot.querySelectorAll('input[type="text"], textarea, [contenteditable="true"]');
      for (const element of nodes) {
        if (!isVisible(element)) {
          continue;
        }

        const placeholder = String(
          element.placeholder
          || element.getAttribute?.('placeholder')
          || element.getAttribute?.('data-placeholder')
          || ''
        ).trim();

        if (!shortTitleHints.some((hint) => placeholder.includes(hint))) {
          continue;
        }

        element.focus();

        if (element.contentEditable === 'true' || element.getAttribute?.('contenteditable') === 'true') {
          element.innerHTML = '';
          element.textContent = '';
        } else {
          element.value = '';
        }

        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur?.();
        return true;
      }
    }

    return false;
  }, WEIXIN_SHORT_TITLE_HINTS);
}

async function setWeixinLocationNone(page, logger = () => {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await page.evaluate(async () => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const isVisible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(node);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        return true;
      };
      const getHosts = () => Array.from(document.querySelectorAll('*')).filter((node) => node.shadowRoot);

      for (const host of getHosts()) {
        const allNodes = host.shadowRoot.querySelectorAll('div, span, button');
        for (const node of allNodes) {
          const className = String(node.className || '').toLowerCase();
          const text = String(node.textContent || '').trim();
          if (!isVisible(node) || !text || text.length >= 20) {
            continue;
          }
          if (className.includes('location') || text === '位置') {
            node.click();
            await delay(500);

            const dropdownItems = host.shadowRoot.querySelectorAll('div, li, span, button');
            for (const item of dropdownItems) {
              const itemText = String(item.textContent || '').trim();
              if (!isVisible(item) || !itemText) {
                continue;
              }
              if (itemText === '不显示位置' || itemText === '不显示') {
                item.click();
                await delay(500);
                return { ok: true };
              }
            }
          }
        }
      }

      return { ok: false };
    });

    if (result.ok) {
      logger('已设置位置：不显示。');
      return true;
    }

    await page.waitForTimeout(600);
  }

  logger('未识别到位置设置入口，跳过位置设置。');
  return false;
}

async function closeWeixinPickers(page) {
  return page.evaluate(() => {
    document.body?.click?.();

    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      return true;
    };

    for (const host of document.querySelectorAll('*')) {
      if (!host.shadowRoot) {
        continue;
      }

      const closeButtons = host.shadowRoot.querySelectorAll(
        'button[class*="close"], .close, [aria-label="关闭"], [aria-label="close"]'
      );
      for (const button of closeButtons) {
        if (isVisible(button)) {
          button.click();
        }
      }
    }

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true
    }));

    return true;
  });
}

async function fillWeixinDescriptionAndTopics(page, description, topics, logger = () => {}) {
  const expectedTopics = uniq(topics);
  let wroteSomething = false;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const fillResult = await fillWeixinDescriptionField(page, description);
    if (!fillResult.ok) {
      await page.waitForTimeout(1000);
      continue;
    }

    wroteSomething = true;
    await page.waitForTimeout(1200);

    const currentText = await readWeixinDescriptionText(page);
    if (hasAllTopics(currentText || fillResult.content, expectedTopics)) {
      logger('视频号已写入文案与话题。');
      return {
        ok: true,
        verified: true,
        content: currentText || fillResult.content
      };
    }
  }

  return {
    ok: wroteSomething,
    verified: false,
    content: await readWeixinDescriptionText(page)
  };
}

async function installWeixinScheduleInterceptor(context, publishAt, logger = () => {}) {
  if (!publishAt) {
    return async () => {};
  }

  const expectedTimestamp = dayjs(publishAt).valueOf();
  let injected = false;

  const handler = async (route) => {
    const request = route.request();
    const postData = request.postData();

    if (!postData) {
      await route.continue();
      return;
    }

    try {
      const body = JSON.parse(postData);
      body.effectiveTime = Math.floor(expectedTimestamp / 1000);
      injected = true;
      await route.continue({
        postData: JSON.stringify(body)
      });
    } catch (error) {
      logger(`视频号定时发布请求注入失败，已回退原请求：${error.message}`);
      await route.continue();
    }
  };

  await context.route(WEIXIN_POST_CREATE_ROUTE, handler);
  logger(`已启用视频号定时发布请求拦截：${dayjs(publishAt).format('YYYY-MM-DD HH:mm')}`);

  return async () => {
    await context.unroute(WEIXIN_POST_CREATE_ROUTE, handler).catch(() => {});
    if (!injected) {
      logger('视频号发布请求未命中 post_create 拦截。');
    }
  };
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

async function gotoPlatformPage(page, platform, logger = () => {}) {
  let lastError = null;
  for (const url of platform.urls) {
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 90000
      });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      logger(`已进入${platform.label}发布页：${page.url()}`);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法打开${platform.label}发布页：${String(lastError?.message || lastError)}`);
}

async function ensureLoggedIn(page, platform) {
  const url = page.url();
  const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 1600));
  const loginKeywords = platform.key === 'videoChannel'
    ? platform.loginKeywords.filter((keyword) => keyword !== '微信')
    : platform.loginKeywords;
  const looksLikeLogin = /login|signin|passport|account|扫码|sign in/i.test(url)
    || loginKeywords.some((keyword) => bodyText.includes(keyword));

  if (looksLikeLogin) {
    throw new Error(`${platform.label}未登录，请先在设置中点击“登录${platform.label}”完成登录。`);
  }
}

async function findUploadInput(page) {
  const scanFrames = () => [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame())];

  for (let round = 0; round < 80; round += 1) {
    for (const frame of scanFrames()) {
      for (const selector of UPLOAD_SELECTORS) {
        const locator = frame.locator(selector).first();
        const count = await locator.count().catch(() => 0);
        if (!count) {
          continue;
        }
        return {
          frame,
          locator,
          selector
        };
      }
    }
    await page.waitForTimeout(500);
  }

  return null;
}

async function uploadVideoByInput(page, outputPath, logger = () => {}) {
  const target = await findUploadInput(page);
  if (!target) {
    throw new Error('未找到上传入口（input[type=file]）。');
  }
  await target.locator.setInputFiles(outputPath);
  logger(`已通过 ${target.selector} 选择视频文件。`);
}

async function fillDescriptionField(page, text) {
  if (!text) {
    return {
      ok: false,
      content: ''
    };
  }

  return page.evaluate((value) => {
    const selectors = [
      '[contenteditable="true"]',
      'textarea[placeholder*="描述"]',
      'textarea',
      'input[placeholder*="标题"]',
      'input[placeholder*="描述"]'
    ];

    const isVisible = (node) => {
      if (!node) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return false;
      }
      const style = window.getComputedStyle(node);
      if (!style || style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      if (node.closest('[aria-hidden="true"], [hidden]')) {
        return false;
      }
      return true;
    };

    const roots = [];
    const walk = (root) => {
      roots.push(root);
      const all = root.querySelectorAll('*');
      for (const node of all) {
        if (node.shadowRoot) {
          walk(node.shadowRoot);
        }
      }
    };
    walk(document);

    const queryDeep = (selector) => {
      const result = [];
      for (const root of roots) {
        try {
          result.push(...root.querySelectorAll(selector));
        } catch {
          // noop
        }
      }
      return result;
    };

    const candidates = [];
    for (const selector of selectors) {
      for (const node of queryDeep(selector)) {
        if (!isVisible(node) || node.disabled || node.readOnly) {
          continue;
        }
        const placeholder = String(node.getAttribute?.('placeholder') || '');
        if (placeholder.includes('短标题')) {
          continue;
        }
        candidates.push(node);
      }
    }

    if (!candidates.length) {
      return {
        ok: false,
        content: ''
      };
    }

    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    });

    const target = candidates[0];
    target.focus();

    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
      target.value = value;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        ok: true,
        content: String(target.value || '').trim()
      };
    }

    try {
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, value);
    } catch {
      // noop
    }
    if (!target.innerText || target.innerText.trim() !== value.trim()) {
      target.textContent = value;
    }
    target.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    return {
      ok: true,
      content: String(target.innerText || target.textContent || '').trim()
    };
  }, text);
}

async function readCurrentDescriptionText(page) {
  return page.evaluate(() => {
    const selectors = [
      '[contenteditable="true"]',
      'textarea[placeholder*="描述"]',
      'textarea',
      'input[placeholder*="标题"]',
      'input[placeholder*="描述"]'
    ];

    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      if (node.closest('[aria-hidden="true"], [hidden]')) return false;
      return true;
    };

    const roots = [];
    const walk = (root) => {
      roots.push(root);
      const all = root.querySelectorAll('*');
      for (const node of all) {
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    };
    walk(document);

    const candidates = [];
    for (const root of roots) {
      for (const selector of selectors) {
        let nodes = [];
        try {
          nodes = Array.from(root.querySelectorAll(selector));
        } catch {
          nodes = [];
        }
        for (const node of nodes) {
          if (!isVisible(node)) {
            continue;
          }
          const placeholder = String(node.getAttribute?.('placeholder') || '');
          if (placeholder.includes('短标题')) {
            continue;
          }
          const text = node.tagName === 'TEXTAREA' || node.tagName === 'INPUT'
            ? String(node.value || '').trim()
            : String(node.innerText || node.textContent || '').trim();
          if (!text) {
            continue;
          }
          const rect = node.getBoundingClientRect();
          candidates.push({
            text,
            area: rect.width * rect.height
          });
        }
      }
    }

    if (!candidates.length) {
      return '';
    }
    candidates.sort((a, b) => b.area - a.area);
    return candidates[0].text;
  });
}

function normalizeComparableText(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/#/g, '')
    .trim()
    .toLowerCase();
}

function hasAllTopics(text, topics) {
  const normalized = normalizeComparableText(text);
  return topics.every((topic) => {
    const key = normalizeComparableText(topic);
    return key && normalized.includes(key);
  });
}

async function fillDescriptionAndTopics(page, platform, description, topics, logger = () => {}) {
  if (platform.key === 'videoChannel') {
    const specific = await fillWeixinDescriptionAndTopics(page, description, topics, logger);
    if (specific.ok) {
      return specific;
    }
    logger('视频号专用文案填写未命中，回退通用填写逻辑。');
  }

  const expectedTopics = uniq(topics);
  let wroteSomething = false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fillResult = await fillDescriptionField(page, description);
    if (!fillResult.ok) {
      await page.waitForTimeout(700);
      continue;
    }
    wroteSomething = true;

    await page.waitForTimeout(900);
    const currentText = await readCurrentDescriptionText(page);
    const ok = hasAllTopics(currentText || fillResult.content, expectedTopics);
    if (ok) {
      logger(`${platform.label}已写入文案与话题。`);
      return {
        ok: true,
        verified: true,
        content: currentText || fillResult.content
      };
    }

    logger(`${platform.label}文案校验未通过，准备重试（${attempt + 1}/3）...`);
    await page.waitForTimeout(1000);
  }

  return {
    ok: wroteSomething,
    verified: false,
    content: await readCurrentDescriptionText(page)
  };
}

async function selectWeixinActivity(target, activityName, logger = () => {}) {
  if (!activityName) {
    return false;
  }

  logger('活动选择策略：shadow-root-scope-v2');
  const expectedActivityText = `微信小游戏 · ${activityName}`;

  const joinActivityInContext = async (context) => context.evaluate(async ({ name, expectedText, shortTitleHints }) => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const normalizeActivityText = (text) => String(text || '')
      .replace(/\s+/g, '')
      .replace(/[·•]/g, '')
      .replace(/^微信小游戏/, '')
      .replace(/^(任务|活动)/, '')
      .trim();
    const activitySimilarity = (candidateText, targetText) => {
      const candidate = normalizeActivityText(candidateText);
      const target = normalizeActivityText(targetText);
      if (!candidate || !target) {
        return 0;
      }
      if (candidate === target) {
        return 1;
      }
      let shared = 0;
      const counts = new Map();
      for (const char of target) {
        counts.set(char, (counts.get(char) || 0) + 1);
      }
      for (const char of candidate) {
        const left = counts.get(char) || 0;
        if (left > 0) {
          counts.set(char, left - 1);
          shared += 1;
        }
      }
      let prefix = 0;
      const maxPrefix = Math.min(candidate.length, target.length);
      while (prefix < maxPrefix && candidate[prefix] === target[prefix]) {
        prefix += 1;
      }
      return ((shared / Math.max(candidate.length, target.length)) * 0.75)
        + ((prefix / Math.max(candidate.length, target.length)) * 0.25);
    };
    const isVisible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(element);
      return Boolean(style && style.display !== 'none' && style.visibility !== 'hidden');
    };
    const getShadowHosts = () => Array.from(document.querySelectorAll('*')).filter((node) => node.shadowRoot);
    const getAllRoots = () => {
      const roots = [document];
      for (const host of getShadowHosts()) {
        if (host.shadowRoot) {
          roots.push(host.shadowRoot);
        }
      }
      return roots;
    };
    let lastStage = 'panel';
    const verifySelectedActivity = async () => {
      await delay(500);
      for (const root of getAllRoots()) {
        const nodes = root.querySelectorAll('div, span, p');
        for (const node of nodes) {
          const text = String(node.textContent || '').trim();
          if (!isVisible(node) || !text || text.length >= 80 || !text.includes('微信小游戏 ·')) {
            continue;
          }
          if (text === expectedText || text.includes(expectedText.replace('微信小游戏 · ', ''))) {
            return true;
          }
        }
      }
      return false;
    };
    const normalizeCandidateText = (text) => String(text || '')
      .replace(/\s+/g, '')
      .replace(/[·•]/g, '')
      .replace(/^微信小游戏/, '')
      .replace(/^(任务|活动)/, '')
      .trim();
    const normalizedName = normalizeCandidateText(name);
    const normalizedExpected = normalizeCandidateText(expectedText);
    const matchesActivityName = (itemText) => {
      const normalizedItem = normalizeCandidateText(itemText);
      if (!normalizedItem) {
        return false;
      }
      if (normalizedName && normalizedItem.includes(normalizedName)) {
        return true;
      }
      if (normalizedExpected && normalizedItem.includes(normalizedExpected)) {
        return true;
      }
      return false;
    };
    const isNoJoinOption = (text) => /不参加|不参与|不加入|不设置/.test(String(text || ''));
    const isOptionContainer = (node, text) => {
      if (!node) return false;
      const tag = node.tagName || '';
      const className = String(node.className || '').toLowerCase();
      if (tag === 'LI' || node.getAttribute?.('role') === 'option') {
        return true;
      }
      if (className.includes('option') || className.includes('item') || className.includes('dropdown')) {
        return true;
      }
      if (tag === 'DIV' && text && text.length > 4 && text.length < 80) {
        return true;
      }
      return false;
    };
    const buildDropdownRoots = () => getAllRoots();
    const collectOptionEntries = ({ requireMatch }) => {
      const dropdownRoots = buildDropdownRoots();
      const entries = [];
      const seenTexts = new Set();
      for (const root of dropdownRoots) {
        const dropdownItems = root.querySelectorAll('li, [role="option"], div, span, p');
        for (const item of dropdownItems) {
          const itemText = String(item.textContent || '').trim();
          if (!isVisible(item) || !itemText || itemText.length >= 100) {
            continue;
          }
          if (requireMatch && !matchesActivityName(itemText)) {
            continue;
          }
          if (!requireMatch && !isOptionContainer(item, itemText)) {
            continue;
          }
          if (seenTexts.has(itemText)) {
            continue;
          }
          seenTexts.add(itemText);
          const clickTarget = item.closest?.('li,[role="option"],button,div') || item;
          entries.push({ item, clickTarget, text: itemText, score: 0 });
        }
      }
      return entries;
    };
    const scoreEntries = (entries) => entries.map((entry) => {
      const itemText = entry.text;
      const similarity = activitySimilarity(itemText, expectedText);
      const normalizedItem = normalizeCandidateText(itemText);
      let score = similarity;
      if (normalizedItem === normalizedExpected || itemText === expectedText) {
        score += 10;
      } else if (normalizedExpected && normalizedItem.includes(normalizedExpected)) {
        score += 6;
      } else if (normalizedName && normalizedItem.includes(normalizedName)) {
        score += 4;
      } else if (itemText.startsWith('微信小游戏') && itemText.includes(name)) {
        score += 3;
      } else if (itemText.includes(name)) {
        score += 2;
      }
      return { ...entry, score };
    });
    const waitForDropdownOptions = async (timeoutMs = 7000) => {
      const startedAt = Date.now();
      let matchedItems = [];
      let allOptions = [];
      while ((Date.now() - startedAt) < timeoutMs) {
        allOptions = collectOptionEntries({ requireMatch: false });
        matchedItems = scoreEntries(collectOptionEntries({ requireMatch: true }));
        if (allOptions.length || matchedItems.length) {
          return { matchedItems, allOptions };
        }
        await delay(300);
      }
      return { matchedItems, allOptions };
    };
    const selectMatchedItems = async (matchedItems, allOptions) => {
      lastStage = 'option';
      const safeMatched = (matchedItems || []).filter((entry) => !isNoJoinOption(entry.text));
      const safeOptions = (allOptions || []).filter((entry) => !isNoJoinOption(entry.text));
      let candidates = safeMatched.length ? safeMatched : safeOptions;

      if (!candidates.length && allOptions && allOptions.length >= 2 && isNoJoinOption(allOptions[0].text)) {
        candidates = [allOptions[1]];
      }

      candidates.sort((a, b) => (b.score || 0) - (a.score || 0) || a.text.length - b.text.length);
      const selectedItem = candidates[0];
      if (!selectedItem) {
        return { ok: false, stage: 'option-empty' };
      }
      await delay(2000);
      selectedItem.clickTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await delay(800);
      selectedItem.clickTarget.click();
      await delay(2000);
      if (await verifySelectedActivity()) {
        return { ok: true, selectedText: selectedItem.text };
      }
      for (const item of candidates) {
        if (item === selectedItem) {
          continue;
        }
        await delay(2000);
        item.clickTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await delay(800);
        item.clickTarget.click();
        await delay(2000);
        if (await verifySelectedActivity()) {
          return { ok: true, selectedText: item.text };
        }
      }
      return { ok: false, stage: 'verify' };
    };
    const closeDropdown = async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      await delay(300);
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
      await delay(300);
      if (document.body) {
        document.body.click();
      }
      await delay(300);
    };

    const collectDropdownItems = (root) => {
      const items = [];
      const seenTexts = new Set();
      const candidates = root.querySelectorAll('div, li, span');
      for (const item of candidates) {
        const itemText = String(item.textContent || '').trim();
        if (!isVisible(item) || !itemText || itemText.length >= 100) {
          continue;
        }
        const itemClass = String(item.className || '').toLowerCase();
        if (
          itemClass.includes('option')
          || itemClass.includes('item')
          || itemClass.includes('dropdown')
          || item.tagName === 'LI'
          || (item.tagName === 'DIV' && itemText.length > 5 && itemText.length < 50)
        ) {
          if (seenTexts.has(itemText)) {
            continue;
          }
          seenTexts.add(itemText);
          items.push({ node: item, text: itemText });
        }
      }
      return items;
    };
    const waitForDropdownItems = async (root, timeoutMs = 7000) => {
      const startedAt = Date.now();
      let items = [];
      while ((Date.now() - startedAt) < timeoutMs) {
        items = collectDropdownItems(root);
        if (items.length) {
          return items;
        }
        await delay(300);
      }
      return items;
    };
    const pickItemFromLists = (items) => {
      const safeItems = items.filter((entry) => !isNoJoinOption(entry.text));
      if (!safeItems.length && items.length >= 2 && isNoJoinOption(items[0].text)) {
        return items[1];
      }
      return safeItems[0] || items[0] || null;
    };

    const shadowHosts = document.querySelectorAll('*');
    for (const host of shadowHosts) {
      if (!host.shadowRoot) {
        continue;
      }
      const root = host.shadowRoot;
      const divs = root.querySelectorAll('div');
      for (const div of divs) {
        const className = String(div.className || '').toLowerCase();
        const text = String(div.textContent || '').trim();
        if (!isVisible(div) || text.length >= 20) {
          continue;
        }
        if (!((className.includes('activity') || text === '活动') && text.length < 20)) {
          continue;
        }

        lastStage = 'input';
        div.click();
        await delay(2000);

        const inputs = root.querySelectorAll('input, [contenteditable="true"]');
        for (const input of inputs) {
          const placeholder = String(input.placeholder || input.getAttribute('placeholder') || '').trim();
          if (!isVisible(input) || (input.type && input.type !== 'text')) {
            continue;
          }
          if (shortTitleHints.some((hint) => placeholder.includes(hint))) {
            continue;
          }

          input.focus();
          input.click();
          await delay(800);
          if ('value' in input) {
            input.value = '';
          } else {
            input.textContent = '';
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await delay(800);

          for (const char of name) {
            if ('value' in input) {
              input.value += char;
            } else {
              input.textContent = `${input.textContent || ''}${char}`;
            }
            input.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }));
            await delay(80);
          }
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await delay(2000);
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, which: 40, bubbles: true }));
          await delay(600);

          let dropdownItems = await waitForDropdownItems(root, 7000);
          let matchedItems = dropdownItems.filter((entry) => matchesActivityName(entry.text));
          if (!matchedItems.length && dropdownItems.length) {
            const fallback = pickItemFromLists(dropdownItems);
            if (fallback) {
              fallback.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await delay(800);
              fallback.node.click();
              await delay(2000);
              if (await verifySelectedActivity()) {
                return { ok: true, selectedText: fallback.text };
              }
            }
          } else if (matchedItems.length) {
            matchedItems = matchedItems.map((entry) => {
              const similarity = activitySimilarity(entry.text, expectedText);
              return { ...entry, score: similarity };
            }).sort((a, b) => (b.score || 0) - (a.score || 0) || a.text.length - b.text.length);
            const selected = matchedItems[0];
            if (selected) {
              selected.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await delay(800);
              selected.node.click();
              await delay(2000);
              if (await verifySelectedActivity()) {
                return { ok: true, selectedText: selected.text };
              }
              for (const item of matchedItems.slice(1)) {
                item.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await delay(800);
                item.node.click();
                await delay(2000);
                if (await verifySelectedActivity()) {
                  return { ok: true, selectedText: item.text };
                }
              }
            }
          }

          lastStage = dropdownItems.length ? 'option' : 'option-empty';
        }
      }
    }

    return { ok: false, stage: lastStage };
  }, {
    name: activityName,
    expectedText: expectedActivityText,
    shortTitleHints: WEIXIN_SHORT_TITLE_HINTS
  });

  const verifyInContext = async (context) => context.evaluate(({ expectedText }) => {
    const normalizeActivityText = (text) => String(text || '')
      .replace(/\s+/g, '')
      .replace(/[·•]/g, '')
      .replace(/^微信小游戏/, '')
      .replace(/^(任务|活动)/, '')
      .trim();
    const activitySimilarity = (candidateText, targetText) => {
      const candidate = normalizeActivityText(candidateText);
      const target = normalizeActivityText(targetText);
      if (!candidate || !target) {
        return 0;
      }
      if (candidate === target) {
        return 1;
      }
      let shared = 0;
      const counts = new Map();
      for (const char of target) {
        counts.set(char, (counts.get(char) || 0) + 1);
      }
      for (const char of candidate) {
        const left = counts.get(char) || 0;
        if (left > 0) {
          counts.set(char, left - 1);
          shared += 1;
        }
      }
      let prefix = 0;
      const maxPrefix = Math.min(candidate.length, target.length);
      while (prefix < maxPrefix && candidate[prefix] === target[prefix]) {
        prefix += 1;
      }
      return ((shared / Math.max(candidate.length, target.length)) * 0.75)
        + ((prefix / Math.max(candidate.length, target.length)) * 0.25);
    };
    const isVisible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(element);
      return Boolean(style && style.display !== 'none' && style.visibility !== 'hidden');
    };

    const roots = [document];
    for (const node of document.querySelectorAll('*')) {
      if (node.shadowRoot) {
        roots.push(node.shadowRoot);
      }
    }

    let bestText = '';
    let bestScore = 0;
    for (const root of roots) {
      for (const node of root.querySelectorAll('div, span, p')) {
        const text = String(node.textContent || '').trim();
        if (!isVisible(node) || !text || text.length >= 80 || !text.includes('微信小游戏 ·')) {
          continue;
        }
        const score = activitySimilarity(text, expectedText);
        if (score > bestScore) {
          bestScore = score;
          bestText = text;
        }
      }
    }

    return {
      matched: bestText === expectedText || bestScore >= 0.82,
      text: bestText,
      score: bestScore
    };
  }, {
    expectedText: expectedActivityText
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const contexts = await getWeixinActionContexts(target);
    let stage = 'panel';
    let selectedText = '';
    for (const context of contexts) {
      const joined = await joinActivityInContext(context).catch(() => ({ ok: false, stage: 'exception' }));
      if (!joined?.ok) {
        stage = joined?.stage || stage;
        continue;
      }

      selectedText = joined.selectedText || '';
      const verifyContexts = await getWeixinActionContexts(target);
      for (const verifyContext of verifyContexts) {
        const verified = await verifyInContext(verifyContext).catch(() => ({ matched: false, text: '', score: 0 }));
        if (verified?.matched) {
          await clearWeixinShortTitleInput(verifyContext).catch(() => {});
          logger(`已选择任务/活动：${verified.text || selectedText || expectedActivityText}`);
          return true;
        }
        if (verified?.text) {
          stage = `verify:${verified.text}`;
        }
      }

      stage = 'verify';
    }

    logger(`任务/活动选择未完成，阶段：${stage}，准备重试（${attempt + 1}/3）...`);
    if (contexts[0] && typeof contexts[0].waitForTimeout === 'function') {
      await contexts[0].waitForTimeout(1200);
    } else if (target && typeof target.waitForTimeout === 'function') {
      await target.waitForTimeout(1200);
    }
  }

  logger(`任务/活动选择失败：${activityName}，期望：${expectedActivityText}`);
  return false;
}

async function declareWeixinOriginal(target, logger = () => {}) {
  const EXACT_ORIGINAL_TERMS_TEXT = '我已阅读并同意《原创声明须知》和《使用条款》。如滥用声明，平台将驳回并予以相关处置。';
  const EXACT_ORIGINAL_TERMS_REGEX = /我已阅读并同意.*原创声明须知.*使用条款.*如滥用声明/;
  const BROAD_ORIGINAL_TERMS_REGEX = /我已阅读并同意.*(原创声明须知|使用条款|如滥用声明)/;
  const ORIGINAL_POPUP_TITLE_REGEX = /原创权益/;
  const getContextLabel = async (context, index) => {
    const fallback = `context-${index + 1}`;
    if (!context) {
      return fallback;
    }
    try {
      if (typeof context.url === 'function') {
        const url = context.url();
        if (url) {
          return `${fallback}:${url}`;
        }
      }
    } catch {
      // noop
    }
    return fallback;
  };

  const inspectPopupInContext = async (context) => context.evaluate(() => {
    const roots = [document];
    for (const node of document.querySelectorAll('*')) {
      if (node.shadowRoot) {
        roots.push(node.shadowRoot);
      }
    }

    const hits = [];
    const isInterestingText = (text) => {
      const value = String(text || '').replace(/\s+/g, '');
      if (!value || value.length < 2) {
        return false;
      }
      return value.includes('原创权益')
        || value.includes('我已阅读并同意')
        || value.includes('原创声明须知')
        || value.includes('使用条款')
        || value.includes('如滥用声明')
        || value === '声明原创'
        || value.includes('声明原创');
    };

    for (const root of roots) {
      for (const element of root.querySelectorAll('label, button, [role="button"], [role="checkbox"], div, span')) {
        const text = String(element.textContent || '').trim();
        if (!isInterestingText(text)) {
          continue;
        }
        hits.push({
          tag: String(element.tagName || '').toLowerCase(),
          role: String(element.getAttribute?.('role') || ''),
          disabled: Boolean(element.disabled || element.getAttribute?.('aria-disabled') === 'true'),
          text: text.slice(0, 160)
        });
        if (hits.length >= 12) {
          return hits;
        }
      }
    }

    return hits;
  });

  const isOriginalPopupVisibleInContext = async (context) => {
    if (!context || typeof context.locator !== 'function') {
      return false;
    }
    const titleLocators = [
      context.locator('h1, h2, h3, h4, div, span').filter({ hasText: ORIGINAL_POPUP_TITLE_REGEX }),
      context.locator('text=原创权益')
    ];

    for (const locator of titleLocators) {
      const count = await locator.count().catch(() => 0);
      if (!count) {
        continue;
      }
      const first = locator.first();
      const visible = await first.isVisible().catch(() => false);
      if (visible) {
        return true;
      }
    }
    return false;
  };

  const getDeclareButtonStateInContext = async (context) => {
    if (!context || typeof context.locator !== 'function') {
      return {
        found: false,
        visible: false,
        enabled: false,
        text: '',
        className: ''
      };
    }

    const declareLocators = [
      context.locator('button, [role="button"]').filter({ hasText: /^声明原创$/ }),
      context.locator('button, [role="button"]').filter({ hasText: '声明原创' }),
      context.locator('div, span').filter({ hasText: /^声明原创$/ }),
      context.locator('text=声明原创')
    ];

    for (const locator of declareLocators) {
      const count = await locator.count().catch(() => 0);
      if (!count) {
        continue;
      }
      const first = locator.first();
      const visible = await first.isVisible().catch(() => false);
      const snapshot = await first.evaluate((node) => {
        const style = window.getComputedStyle(node);
        const className = typeof node.className === 'string'
          ? node.className
          : String(node.getAttribute?.('class') || '');
        const disabled = Boolean(
          node.disabled
            || node.hasAttribute?.('disabled')
            || node.getAttribute?.('aria-disabled') === 'true'
            || style.pointerEvents === 'none'
            || className.toLowerCase().includes('disabled')
        );
        return {
          text: String(node.textContent || '').trim(),
          className,
          disabled
        };
      }).catch(() => ({
        text: '',
        className: '',
        disabled: true
      }));

      return {
        found: true,
        visible,
        enabled: visible && !snapshot.disabled,
        text: snapshot.text,
        className: snapshot.className
      };
    }

    return {
      found: false,
      visible: false,
      enabled: false,
      text: '',
      className: ''
    };
  };

  const handlePopupByLocatorInContext = async (context) => {
    if (!context || typeof context.evaluate !== 'function') {
      return { ok: false, stage: 'locator-unsupported' };
    }
    return context.evaluate(async ({ exactTermsText }) => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalize = (text) => String(text || '').replace(/\s+/g, '');
      const isVisible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(node);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        return true;
      };
      const getRoots = () => {
        const roots = [document];
        for (const node of document.querySelectorAll('*')) {
          if (node.shadowRoot) {
            roots.push(node.shadowRoot);
          }
        }
        return roots;
      };
      const clickNode = async (node) => {
        if (!node || !isVisible(node)) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        const clientX = rect.left + Math.max(1, rect.width / 2);
        const clientY = rect.top + Math.max(1, rect.height / 2);
        const payload = {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX,
          clientY
        };
        const pointerPayload = {
          ...payload,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true
        };
        node.dispatchEvent(new PointerEvent('pointerdown', pointerPayload));
        node.dispatchEvent(new MouseEvent('mousedown', payload));
        node.dispatchEvent(new PointerEvent('pointerup', pointerPayload));
        node.dispatchEvent(new MouseEvent('mouseup', payload));
        node.dispatchEvent(new MouseEvent('click', payload));
        node.click?.();
        await delay(350);
        return true;
      };
      const dispatchInputEvents = (node) => {
        if (!node) {
          return;
        }
        node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        node.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      };
      const getAncestorText = (node) => {
        let current = node;
        for (let depth = 0; current && depth < 6; depth += 1) {
          const text = normalize(current.textContent || '');
          if (text) {
            return text;
          }
          current = current.parentElement;
        }
        return '';
      };
      const matchesTermsText = (text) => (
        text.includes('我已阅读并同意')
        && (
          text.includes('原创声明须知')
          || text.includes('使用条款')
          || text === normalize(exactTermsText)
        )
      );
      const isPopupVisible = () => {
        for (const root of getRoots()) {
          for (const element of root.querySelectorAll('div, span, h1, h2, h3, h4')) {
            const text = normalize(element.textContent);
            if (
              isVisible(element)
              && text.includes('原创权益')
              && text.includes('我已阅读并同意')
              && text.includes('声明原创')
            ) {
              return true;
            }
          }
        }
        return false;
      };
      const getDeclareState = () => {
        const candidates = [];
        for (const root of getRoots()) {
          for (const node of root.querySelectorAll('button, [role="button"]')) {
            if (!isVisible(node)) {
              continue;
            }
            const text = String(node.textContent || '').trim();
            if (!(text === '声明原创' || text.includes('声明原创'))) {
              continue;
            }
            const className = typeof node.className === 'string'
              ? node.className
              : String(node.getAttribute?.('class') || '');
            const style = window.getComputedStyle(node);
            const disabled = Boolean(
              node.disabled
              || node.hasAttribute?.('disabled')
              || node.getAttribute?.('aria-disabled') === 'true'
              || style.pointerEvents === 'none'
              || className.toLowerCase().includes('disabled')
            );
            const primaryScore = /primary|btn_primary|weui-desktop-btn_primary/i.test(className) ? 1 : 0;
            candidates.push({ node, text, className, disabled, primaryScore });
          }
        }
        candidates.sort((a, b) => b.primaryScore - a.primaryScore);
        const first = candidates[0];
        return first
          ? {
            found: true,
            visible: true,
            enabled: !first.disabled,
            text: first.text,
            className: first.className,
            node: first.node
          }
          : {
            found: false,
            visible: false,
            enabled: false,
            text: '',
            className: '',
            node: null
          };
      };
      const getTermsCandidates = () => {
        const candidates = [];
        for (const root of getRoots()) {
          for (const checkbox of root.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
            const parent = checkbox.closest('label') || checkbox.closest('div') || checkbox.parentElement;
            const parentText = normalize(parent?.textContent || '');
            const ancestorText = getAncestorText(parent || checkbox);
            const text = parentText || ancestorText || normalize(checkbox.textContent || '');
            if (!matchesTermsText(text)) {
              continue;
            }
            candidates.push({
              checkbox,
              parent,
              source: 'checkbox',
              text
            });
          }
        }
        return candidates;
      };
      const isCheckboxChecked = (node) => {
        if (!node) {
          return false;
        }
        if (typeof node.checked === 'boolean') {
          return node.checked;
        }
        return node.getAttribute?.('aria-checked') === 'true';
      };
      const clickTermsCandidate = async (candidate) => {
        const checkbox = candidate?.checkbox || null;
        const parent = candidate?.parent || checkbox?.closest?.('label') || checkbox?.parentElement || null;
        if (checkbox && !isCheckboxChecked(checkbox)) {
          await clickNode(checkbox);
          if (isCheckboxChecked(checkbox)) {
            return true;
          }
        }
        if (parent) {
          await clickNode(parent);
          if (checkbox && isCheckboxChecked(checkbox)) {
            return true;
          }
          const rect = parent.getBoundingClientRect();
          const pointTarget = document.elementFromPoint(
            rect.left + Math.min(18, Math.max(8, rect.width * 0.08)),
            rect.top + rect.height / 2
          );
          if (pointTarget) {
            await clickNode(pointTarget);
            if (checkbox && isCheckboxChecked(checkbox)) {
              return true;
            }
          }
        }
        return checkbox ? isCheckboxChecked(checkbox) : false;
      };

      if (!isPopupVisible()) {
        return { ok: false, stage: 'popup-not-visible' };
      }

      const beforeStateRaw = getDeclareState();
      const beforeState = {
        found: beforeStateRaw.found,
        visible: beforeStateRaw.visible,
        enabled: beforeStateRaw.enabled,
        text: beforeStateRaw.text,
        className: beforeStateRaw.className
      };

      const termsCandidates = getTermsCandidates();

      let termsClicked = false;
      for (let index = 0; index < Math.min(termsCandidates.length, 12); index += 1) {
        const candidate = termsCandidates[index];
        const checkbox = candidate?.checkbox || null;
        if (checkbox && !isCheckboxChecked(checkbox)) {
          checkbox.focus?.();
          if (checkbox.matches?.('input[type="checkbox"]')) {
            checkbox.checked = true;
            dispatchInputEvents(checkbox);
            await delay(250);
          }
          if (!isCheckboxChecked(checkbox)) {
            checkbox.click?.();
            dispatchInputEvents(checkbox);
            await delay(250);
          }
          if (!isCheckboxChecked(checkbox) && checkbox.parentElement) {
            checkbox.parentElement.click?.();
            await delay(250);
          }
          dispatchInputEvents(checkbox);
          await delay(400);
        }
        const checked = isCheckboxChecked(checkbox) || await clickTermsCandidate(candidate);
        termsClicked = true;
        const declareState = getDeclareState();
        if (!checked && !declareState.enabled) {
          continue;
        }
        if (declareState.enabled) {
          const afterTermsState = {
            found: declareState.found,
            visible: declareState.visible,
            enabled: declareState.enabled,
            text: declareState.text,
            className: declareState.className
          };
          const clicked = await clickNode(declareState.node);
          if (!clicked) {
            return {
              ok: false,
              stage: 'declare-button-click-failed',
              details: { beforeState, afterTermsState, termsStage: 'terms-row-enabled-declare', termsCount: termsCandidates.length }
            };
          }
          for (let retry = 0; retry < 14; retry += 1) {
            await delay(300);
            const popupStillVisible = isPopupVisible();
            if (!popupStillVisible) {
              return {
                ok: true,
                stage: 'declare-clicked-locator',
                details: { beforeState, afterTermsState, termsStage: 'terms-row-enabled-declare', termsCount: termsCandidates.length }
              };
            }
          }
          return {
            ok: false,
            stage: 'declare-clicked-but-popup-still-visible',
            details: { beforeState, afterTermsState, termsStage: 'terms-row-enabled-declare', termsCount: termsCandidates.length }
          };
        }
      }

      const afterTermsStateRaw = getDeclareState();
      const afterTermsState = {
        found: afterTermsStateRaw.found,
        visible: afterTermsStateRaw.visible,
        enabled: afterTermsStateRaw.enabled,
        text: afterTermsStateRaw.text,
        className: afterTermsStateRaw.className
      };

      return {
        ok: false,
        stage: termsClicked ? 'declare-button-still-disabled-after-terms' : 'terms-locator-not-found',
        details: {
          beforeState,
          afterTermsState,
          termsStage: termsClicked ? 'terms-row-clicked' : 'terms-locator-not-found',
          termsCount: termsCandidates.length,
          termsSources: termsCandidates.slice(0, 8).map((item) => item.source || 'unknown')
        }
      };
    }, { exactTermsText: EXACT_ORIGINAL_TERMS_TEXT });
  };

  const clickOriginalCheckboxInContext = async (context) => context.evaluate(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const randomDelay = () => delay(300 + Math.floor(Math.random() * 221));
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      return true;
    };
    const roots = [document];
    for (const node of document.querySelectorAll('*')) {
      if (node.shadowRoot) {
        roots.push(node.shadowRoot);
      }
    }

    for (const root of roots) {
      for (const checkbox of root.querySelectorAll('input[type="checkbox"]')) {
        const parent = checkbox.closest('label') || checkbox.closest('div') || checkbox.parentElement;
        const text = String(parent?.textContent || '').trim();
        if (!isVisible(checkbox) || !(text.includes('声明原创') || text.includes('原创标记'))) {
          continue;
        }
        if (checkbox.checked) {
          return { ok: true, stage: 'already-checked' };
        }
        await randomDelay();
        checkbox.click();
        await delay(2000);
        return { ok: true, stage: 'clicked' };
      }
    }

    return { ok: false, stage: 'original-checkbox-not-found' };
  });

  const handlePopupInContext = async (context) => context.evaluate(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const randomDelay = () => delay(300 + Math.floor(Math.random() * 221));
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      return true;
    };
    const getRoots = () => {
      const roots = [document];
      for (const node of document.querySelectorAll('*')) {
        if (node.shadowRoot) {
          roots.push(node.shadowRoot);
        }
      }
      return roots;
    };
    const clickBestTarget = async (node) => {
      if (!node) {
        return false;
      }
      const target = node.closest('label')
        || node.closest('[role="checkbox"]')
        || node.closest('button')
        || node.closest('[role="button"]')
        || node.closest('div')
        || node;
      if (!isVisible(target)) {
        return false;
      }
      await randomDelay();
      target.click();
      await randomDelay();
      return true;
    };
    const dispatchMouseSequence = async (node) => {
      if (!node || !isVisible(node)) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      const clientX = rect.left + Math.max(1, rect.width / 2);
      const clientY = rect.top + Math.max(1, rect.height / 2);
      const payload = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX,
        clientY
      };
      const pointerPayload = {
        ...payload,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      };
      node.dispatchEvent(new PointerEvent('pointerdown', pointerPayload));
      node.dispatchEvent(new MouseEvent('mousedown', payload));
      node.dispatchEvent(new PointerEvent('pointerup', pointerPayload));
      node.dispatchEvent(new MouseEvent('mouseup', payload));
      node.dispatchEvent(new MouseEvent('click', payload));
      await randomDelay();
      return true;
    };
    const isTermsText = (text) => {
      const normalized = String(text || '').replace(/\s+/g, '');
      if (!normalized.includes('我已阅读并同意')) {
        return false;
      }
      return normalized.includes('原创声明须知')
        || normalized.includes('使用条款')
        || normalized.includes('如滥用声明');
    };

    let foundConfirmCheckbox = false;
    for (let retry = 0; retry < 10; retry += 1) {
      for (const root of getRoots()) {
        for (const checkbox of root.querySelectorAll('input[type="checkbox"]')) {
          const parent = checkbox.closest('label') || checkbox.closest('div') || checkbox.parentElement;
          const text = String(parent?.textContent || '').trim();
          if (!isTermsText(text)) {
            continue;
          }
          foundConfirmCheckbox = true;
          if (!checkbox.checked) {
            if (isVisible(checkbox)) {
              checkbox.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await randomDelay();
              checkbox.click();
              await randomDelay();
            } else {
              await clickBestTarget(parent || checkbox);
            }
          }
          break;
        }
        if (foundConfirmCheckbox) {
          break;
        }
      }

      if (foundConfirmCheckbox) {
        break;
      }

      for (const root of getRoots()) {
        for (const element of root.querySelectorAll('*')) {
          const text = String(element.textContent || '').trim();
          if (!isTermsText(text) || text.length >= 500) {
            continue;
          }
          const checkbox = element.querySelector('input[type="checkbox"]')
            || element.parentElement?.querySelector('input[type="checkbox"]');
          foundConfirmCheckbox = true;
          if (checkbox) {
            if (!checkbox.checked) {
              if (isVisible(checkbox)) {
                checkbox.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await randomDelay();
                checkbox.click();
                await randomDelay();
              } else {
                await clickBestTarget(element);
              }
            }
          } else {
            await clickBestTarget(element);
          }
          break;
        }
        if (foundConfirmCheckbox) {
          break;
        }
      }

      if (foundConfirmCheckbox) {
        break;
      }

      await randomDelay();
    }

    if (!foundConfirmCheckbox) {
      return { ok: false, stage: 'terms-checkbox-not-found' };
    }

    await randomDelay();

    for (let retry = 0; retry < 5; retry += 1) {
      for (const root of getRoots()) {
        for (const button of root.querySelectorAll('button, [role="button"], div, span')) {
          const text = String(button.textContent || '').trim();
          const disabled = Boolean(button.disabled || button.getAttribute?.('aria-disabled') === 'true');
          if (!isVisible(button) || disabled || !text || !text.includes('声明原创')) {
            continue;
          }
          await dispatchMouseSequence(button);
          await delay(600);
          let popupVisibleAfterClick = false;
          for (let retry = 0; retry < 12; retry += 1) {
            popupVisibleAfterClick = false;
            for (const popupRoot of getRoots()) {
              for (const element of popupRoot.querySelectorAll('div, span, h1, h2, h3, h4')) {
                const text = String(element.textContent || '').trim();
                if (text.includes('原创权益') && isVisible(element)) {
                  popupVisibleAfterClick = true;
                  break;
                }
              }
              if (popupVisibleAfterClick) {
                break;
              }
            }
            if (!popupVisibleAfterClick) {
              break;
            }
            await delay(300);
          }
          return popupVisibleAfterClick
            ? { ok: false, stage: 'declare-clicked-but-popup-still-visible-dom' }
            : { ok: true, stage: 'declare-clicked' };
        }
      }
      await randomDelay();
    }

    return { ok: false, stage: 'declare-button-not-found' };
  });

  const verifyOriginalInContext = async (context) => context.evaluate(() => {
    const roots = [document];
    for (const node of document.querySelectorAll('*')) {
      if (node.shadowRoot) {
        roots.push(node.shadowRoot);
      }
    }

    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      return true;
    };

    let popupVisible = false;
    for (const root of roots) {
      for (const element of root.querySelectorAll('div, span, h1, h2, h3, h4')) {
        const text = String(element.textContent || '').trim();
        if (text.includes('原创权益') && isVisible(element)) {
          popupVisible = true;
          break;
        }
      }
      if (popupVisible) {
        break;
      }
    }

    let mainChecked = false;
    for (const root of roots) {
      for (const checkbox of root.querySelectorAll('input[type="checkbox"]')) {
        const parent = checkbox.closest('label') || checkbox.closest('div') || checkbox.parentElement;
        const text = String(parent?.textContent || '').trim();
        if (text.includes('声明原创') || text.includes('原创标记')) {
          mainChecked = Boolean(checkbox.checked);
          break;
        }
      }
      if (mainChecked) {
        break;
      }
    }
    return {
      mainChecked,
      popupVisible,
      confirmed: mainChecked && !popupVisible
    };
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const contexts = await getWeixinActionContexts(target);
    logger(`原创声明开始尝试（${attempt + 1}/3），候选上下文：${contexts.length}`);
    let checkboxClicked = false;

    for (let index = 0; index < contexts.length; index += 1) {
      const context = contexts[index];
      const contextLabel = await getContextLabel(context, index);
      const clicked = await clickOriginalCheckboxInContext(context).catch(() => ({ ok: false }));
      logger(`原创声明主复选框检查：${contextLabel} -> ${clicked?.stage || 'not-found'}`);
      if (!clicked?.ok) {
        continue;
      }
      if (clicked.stage === 'already-checked') {
        const popupVisible = await isOriginalPopupVisibleInContext(context).catch(() => false);
        const verify = await verifyOriginalInContext(context).catch(() => ({
          mainChecked: true,
          popupVisible,
          confirmed: false
        }));
        logger(`原创声明主复选框已勾选，继续确认弹窗：${contextLabel} -> ${JSON.stringify(verify)}`);
        if (verify?.confirmed) {
          logger('已完成原创声明（already-checked-confirmed）。');
          return true;
        }
        checkboxClicked = true;
        break;
      }
      checkboxClicked = true;
      break;
    }

    if (!checkboxClicked) {
      logger(`原创声明未完成（original-checkbox-not-found），准备重试（${attempt + 1}/3）...`);
      await contexts[0]?.waitForTimeout?.(1200);
      continue;
    }

    const popupContexts = await getWeixinActionContexts(target);
    let popupHandled = false;
    let popupStage = 'popup-not-found';
    for (let index = 0; index < popupContexts.length; index += 1) {
      const context = popupContexts[index];
      const contextLabel = await getContextLabel(context, index);
      const popupVisible = await isOriginalPopupVisibleInContext(context).catch(() => false);
      logger(`原创声明弹窗可见性：${contextLabel} -> ${popupVisible ? 'visible' : 'hidden'}`);
      if (!popupVisible) {
        continue;
      }
      const handledByLocator = await handlePopupByLocatorInContext(context).catch(() => ({ ok: false }));
      logger(`原创声明弹窗 Locator 处理：${contextLabel} -> ${handledByLocator?.stage || 'failed'}${handledByLocator?.details ? ` ${JSON.stringify(handledByLocator.details)}` : ''}`);
      if (handledByLocator?.ok) {
        popupHandled = true;
        popupStage = handledByLocator.stage || 'declare-clicked-locator';
        break;
      }
      if (
        handledByLocator?.stage === 'declare-clicked-but-popup-still-visible'
        && handledByLocator?.details?.afterTermsState?.enabled
      ) {
        popupHandled = true;
        popupStage = 'declare-clicked-soft';
        logger(`原创声明弹窗已点击确认按钮，按页面结果继续：${contextLabel}`);
        break;
      }
      if (handledByLocator?.stage) {
        popupStage = handledByLocator.stage;
      }
    }

    const allowDomFallback = new Set([
      'popup-not-visible',
      'locator-unsupported',
      'terms-row-empty',
      'terms-row-hidden',
      'terms-locator-not-found',
      'declare-button-not-found-after-terms',
      'declare-locator-not-found'
    ]).has(popupStage);

    if (!popupHandled && allowDomFallback) {
      for (let index = 0; index < popupContexts.length; index += 1) {
        const context = popupContexts[index];
        const contextLabel = await getContextLabel(context, index);
        const handled = await handlePopupInContext(context).catch(() => ({ ok: false }));
        logger(`原创声明弹窗 DOM 处理：${contextLabel} -> ${handled?.stage || 'failed'}`);
        if (handled?.ok) {
          popupHandled = true;
          popupStage = handled.stage || 'declare-clicked';
          break;
        }
        if (handled?.stage) {
          popupStage = handled.stage;
        }
      }
    }

    if (!popupHandled) {
      for (let index = 0; index < popupContexts.length; index += 1) {
        const context = popupContexts[index];
        const contextLabel = await getContextLabel(context, index);
        const popupDebug = await inspectPopupInContext(context).catch(() => []);
        if (popupDebug.length) {
          logger(`原创声明弹窗调试候选：${contextLabel} -> ${JSON.stringify(popupDebug)}`);
          break;
        }
      }
      logger(`原创声明未完成（${popupStage}），准备重试（${attempt + 1}/3）...`);
      await popupContexts[0]?.waitForTimeout?.(1200);
      continue;
    }

    if (popupStage === 'declare-clicked-soft') {
      await popupContexts[0]?.waitForTimeout?.(1200);
      logger('已完成原创声明（soft-confirm）。');
      return true;
    }

    await popupContexts[0]?.waitForTimeout?.(1200);
    let sawPopupClosedAfterDeclare = false;
    let sawMainCheckedAfterDeclare = false;
    let verifyContexts = [];
    for (let verifyAttempt = 0; verifyAttempt < 8; verifyAttempt += 1) {
      verifyContexts = await getWeixinActionContexts(target);
      for (let index = 0; index < verifyContexts.length; index += 1) {
        const context = verifyContexts[index];
        const contextLabel = await getContextLabel(context, index);
        const verified = await verifyOriginalInContext(context).catch(() => ({
          mainChecked: false,
          popupVisible: false,
          confirmed: false
        }));
        logger(`原创声明结果校验：${contextLabel} -> ${JSON.stringify(verified)}`);
        if (verified?.mainChecked) {
          sawMainCheckedAfterDeclare = true;
        }
        if (verified && verified.popupVisible === false) {
          sawPopupClosedAfterDeclare = true;
        }
        if (verified?.confirmed) {
          logger('已完成原创声明（confirmed）。');
          return true;
        }
      }
      if (
        popupHandled
        && (popupStage === 'declare-clicked-locator' || popupStage === 'declare-clicked')
        && sawPopupClosedAfterDeclare
        && (sawMainCheckedAfterDeclare || verifyAttempt >= 2)
      ) {
        logger('已完成原创声明（popup-closed-after-confirm）。');
        return true;
      }
      await verifyContexts[0]?.waitForTimeout?.(600);
    }

    logger(`原创声明未完成（verify-failed），准备重试（${attempt + 1}/3）...`);
    await verifyContexts[0]?.waitForTimeout?.(1200);
  }

  logger('原创声明未完成（verify-failed）。');
  return false;
}

async function setWeixinSchedulePublish(page, publishAt, logger = () => {}) {
  if (!publishAt) {
    return false;
  }

  const payload = {
    year: dayjs(publishAt).format('YYYY'),
    month: dayjs(publishAt).format('MM'),
    day: dayjs(publishAt).format('DD'),
    hour: dayjs(publishAt).format('HH'),
    minute: dayjs(publishAt).format('mm'),
    dateValue: dayjs(publishAt).format('YYYY-MM-DD'),
    timeValue: dayjs(publishAt).format('HH:mm')
  };

  const result = await page.evaluate(async (target) => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      return true;
    };

    const getHosts = () => Array.from(document.querySelectorAll('*')).filter((node) => node.shadowRoot);

    const fillVisibleInputs = (predicate, value) => {
      let count = 0;
      for (const host of getHosts()) {
        const inputs = host.shadowRoot.querySelectorAll('input');
        for (const input of inputs) {
          if (!isVisible(input)) {
            continue;
          }
          const placeholder = String(input.placeholder || input.getAttribute('placeholder') || '').trim();
          const type = String(input.type || '').toLowerCase();
          if (!predicate({ placeholder, type })) {
            continue;
          }
          input.focus();
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.blur();
          count += 1;
        }
      }
      return count;
    };

    const getCurrentMonth = (panel) => {
      const monthDisplay = panel.querySelector('[class*="month"], [class*="title"], .weui-desktop-picker__header, .picker-header');
      if (monthDisplay) {
        const text = String(monthDisplay.textContent || '').trim();
        const monthMatch = text.match(/(\d{4})年(\d{1,2})月|(\d{1,2})月|(\d{4})-(\d{2})/);
        if (monthMatch) {
          if (monthMatch[2]) return Number.parseInt(monthMatch[2], 10);
          if (monthMatch[3]) return Number.parseInt(monthMatch[3], 10);
          if (monthMatch[5]) return Number.parseInt(monthMatch[5], 10);
        }
      }

      const allElements = panel.querySelectorAll('span, div');
      for (const element of allElements) {
        const text = String(element.textContent || '').trim();
        const match = text.match(/(\d{1,2})月/);
        if (match) {
          return Number.parseInt(match[1], 10);
        }
      }

      return new Date().getMonth() + 1;
    };

    const findNextMonthButton = (panel) => {
      const selectors = [
        '[class*="next"]',
        '[class*="arrow-right"]',
        '[class*="right"]',
        'a[title*="下"]',
        'button[title*="下"]'
      ];

      for (const selector of selectors) {
        const buttons = panel.querySelectorAll(selector);
        for (const button of buttons) {
          const className = String(button.className || '').toLowerCase();
          if (className.includes('month') || className.includes('next') || className.includes('right') || className.includes('arrow')) {
            return button;
          }
        }
      }

      return null;
    };

    const findPrevMonthButton = (panel) => {
      const selectors = [
        '[class*="prev"]',
        '[class*="arrow-left"]',
        '[class*="left"]',
        'a[title*="上"]',
        'button[title*="上"]'
      ];

      for (const selector of selectors) {
        const buttons = panel.querySelectorAll(selector);
        for (const button of buttons) {
          const className = String(button.className || '').toLowerCase();
          if (className.includes('month') || className.includes('prev') || className.includes('left') || className.includes('arrow')) {
            return button;
          }
        }
      }

      return null;
    };

    const selectDateTime = async () => {
      await delay(1000);

      for (const host of getHosts()) {
        const panels = host.shadowRoot.querySelectorAll(
          'dl[class*="picker"], div[class*="picker"], div[class*="calendar"], .el-picker-panel, .date-picker, .weui-desktop-picker'
        );

        for (const panel of panels) {
          if (!isVisible(panel)) {
            continue;
          }

          const targetMonth = Number.parseInt(target.month, 10);

          for (let attempt = 0; attempt < 12; attempt += 1) {
            const currentMonth = getCurrentMonth(panel);
            if (currentMonth === targetMonth) {
              break;
            }

            const button = currentMonth < targetMonth ? findNextMonthButton(panel) : findPrevMonthButton(panel);
            if (!button) {
              break;
            }
            button.click();
            await delay(800);
          }

          const days = panel.querySelectorAll('td');
          for (const dayCell of days) {
            const text = String(dayCell.textContent || '').trim();
            const className = String(dayCell.className || '').toLowerCase();
            if (
              text === String(Number.parseInt(target.day, 10))
              && !className.includes('disabled')
              && !className.includes('prev')
              && !className.includes('next')
              && !className.includes('out')
            ) {
              dayCell.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await delay(200);
              dayCell.click();
              await delay(600);
              break;
            }
          }

          const ddElements = panel.querySelectorAll('dd');
          for (const dd of ddElements) {
            if (!String(dd.className || '').includes('time')) {
              continue;
            }

            dd.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await delay(300);
            dd.click();
            await delay(700);

            const options = dd.querySelectorAll('li');
            let hourSelected = false;
            let minuteSelected = false;

            for (const option of options) {
              const text = String(option.textContent || '').trim();
              if (!hourSelected && text === target.hour) {
                option.click();
                await delay(300);
                hourSelected = true;
                continue;
              }
              if (hourSelected && !minuteSelected && text === target.minute) {
                option.click();
                await delay(300);
                minuteSelected = true;
                break;
              }
            }
          }

          const buttons = host.shadowRoot.querySelectorAll('button');
          for (const button of buttons) {
            const text = String(button.textContent || '').trim();
            if ((text === '确定' || text === '确认') && isVisible(button)) {
              button.click();
              await delay(1000);
              break;
            }
          }

          return true;
        }
      }

      return false;
    };

    let toggleClicked = false;
    for (const host of getHosts()) {
      const elements = host.shadowRoot.querySelectorAll('div, span, label, button');
      for (const element of elements) {
        const text = String(element.textContent || '').trim();
        if (!text || text.length >= 30 || text.includes('不定时')) {
          continue;
        }
        if (!isVisible(element)) {
          continue;
        }
        if (text.includes('定时发表') || text.includes('定时发布')) {
          element.click();
          toggleClicked = true;
          break;
        }
      }
      if (toggleClicked) {
        break;
      }
    }

    if (!toggleClicked) {
      return { ok: false, stage: 'toggle' };
    }

    await delay(1500);

    let radioSelected = false;
    for (const host of getHosts()) {
      const radios = host.shadowRoot.querySelectorAll('input[type="radio"]');
      for (const radio of radios) {
        const parent = radio.closest('label') || radio.closest('div') || radio.parentElement;
        const text = String(parent?.textContent || '').trim();
        if (text.includes('定时') && !text.includes('不定时')) {
          radio.click();
          radioSelected = true;
          break;
        }
      }
      if (radioSelected) {
        break;
      }
    }

    await delay(1200);

    let pickerOpened = false;
    for (const host of getHosts()) {
      const inputs = host.shadowRoot.querySelectorAll('input[type="text"], input:not([type])');
      for (const input of inputs) {
        const placeholder = String(input.placeholder || input.getAttribute('placeholder') || '').trim();
        if (!isVisible(input)) {
          continue;
        }
        if (
          placeholder.includes('时间')
          || placeholder.includes('日期')
          || placeholder.includes('选择')
          || placeholder.includes('发布时间')
        ) {
          input.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await delay(300);
          input.focus();
          input.click();
          pickerOpened = true;
          break;
        }
      }
      if (pickerOpened) {
        break;
      }
    }

    await delay(1500);

    const dateCount = fillVisibleInputs(
      ({ placeholder, type }) => type === 'date' || placeholder.includes('日期') || placeholder.includes('选择日期'),
      target.dateValue
    );
    const timeCount = fillVisibleInputs(
      ({ placeholder, type }) => type === 'time' || placeholder.includes('时间') || placeholder.includes('选择时间'),
      target.timeValue
    );
    const dateTimeCount = fillVisibleInputs(
      ({ placeholder, type }) => type === 'datetime-local' || placeholder.includes('发布时间'),
      `${target.dateValue} ${target.timeValue}`
    );

    const picked = await selectDateTime();

    const bodyText = String(document.body?.innerText || '').replace(/\s+/g, '');
    const inputValues = [];
    for (const host of getHosts()) {
      const inputs = host.shadowRoot.querySelectorAll('input');
      for (const input of inputs) {
        inputValues.push(String(input.value || '').replace(/\s+/g, ''));
      }
    }

    const verified = bodyText.includes(target.timeValue)
      || inputValues.some((value) => value.includes(target.dateValue) || value.includes(target.timeValue));

    return {
      ok: Boolean(toggleClicked && (radioSelected || pickerOpened) && (picked || dateCount || timeCount || dateTimeCount || verified)),
      stage: picked ? 'picked' : (verified ? 'verified' : 'partial'),
      toggleClicked,
      radioSelected,
      pickerOpened,
      dateCount,
      timeCount,
      dateTimeCount,
      verified
    };
  }, payload);

  if (result.ok) {
    logger(`已设置视频号定时发布：${dayjs(publishAt).format('YYYY-MM-DD HH:mm')}`);
    return true;
  }

  logger(`视频号定时发布专用逻辑未完成，阶段：${result.stage}`);
  return false;
}

async function setSchedulePublish(page, platform, publishAt, logger = () => {}) {
  if (!publishAt) {
    return false;
  }

  if (platform.key === 'videoChannel') {
    const specific = await setWeixinSchedulePublish(page, publishAt, logger);
    if (specific) {
      return true;
    }
    logger('视频号定时控件专用逻辑未成功，回退通用设置。');
  }

  const dateValue = dayjs(publishAt).format('YYYY-MM-DD');
  const timeValue = dayjs(publishAt).format('HH:mm');

  const toggled = await page.evaluate((scheduleKeywords) => {
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };

    const roots = [];
    const walk = (root) => {
      roots.push(root);
      const all = root.querySelectorAll('*');
      for (const node of all) {
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    };
    walk(document);

    const clickMatch = (nodes) => {
      for (const node of nodes) {
        const text = (node.textContent || '').trim();
        if (!text || text.includes('不定时')) {
          continue;
        }
        if (!scheduleKeywords.some((word) => text.includes(word))) {
          continue;
        }
        if (!isVisible(node)) {
          continue;
        }
        node.click();
        return true;
      }
      return false;
    };

    for (const root of roots) {
      const buttons = root.querySelectorAll('button, label, span, div, input[type="radio"]');
      if (clickMatch(buttons)) {
        return true;
      }
    }
    return false;
  }, platform.scheduleKeywords);

  await page.waitForTimeout(1200);

  const filled = await page.evaluate(({ dateInput, timeInput }) => {
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };

    const roots = [];
    const walk = (root) => {
      roots.push(root);
      const all = root.querySelectorAll('*');
      for (const node of all) {
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    };
    walk(document);

    const fillVisibleInput = (predicate, value) => {
      let count = 0;
      for (const root of roots) {
        const inputs = root.querySelectorAll('input');
        for (const input of inputs) {
          if (!isVisible(input) || input.disabled || input.readOnly) {
            continue;
          }
          const placeholder = String(input.getAttribute('placeholder') || '');
          const type = String(input.getAttribute('type') || '').toLowerCase();
          if (!predicate({ placeholder, type })) {
            continue;
          }
          input.focus();
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.blur();
          count += 1;
        }
      }
      return count;
    };

    const dateCount = fillVisibleInput(
      ({ placeholder, type }) => type === 'date' || placeholder.includes('日期') || placeholder.includes('选择日期'),
      dateInput
    );
    const timeCount = fillVisibleInput(
      ({ placeholder, type }) => type === 'time' || placeholder.includes('时间') || placeholder.includes('选择时间'),
      timeInput
    );
    const dateTimeCount = fillVisibleInput(
      ({ placeholder, type }) => type === 'datetime-local' || placeholder.includes('发布时间'),
      `${dateInput} ${timeInput}`
    );

    const combinedCount = fillVisibleInput(
      ({ placeholder, type }) => type === 'text' && (placeholder.includes('发布时间') || placeholder.includes('日期时间')),
      `${dateInput} ${timeInput}`
    );

    return {
      dateCount,
      timeCount,
      dateTimeCount,
      combinedCount
    };
  }, {
    dateInput: dateValue,
    timeInput: timeValue
  });

  const verify = await page.evaluate(({ dateInput, timeInput }) => {
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, '');
    const dateNoDash = dateInput.replace(/-/g, '');
    const compactDateTime = `${dateInput}${timeInput}`;
    const compactCnDate = `${Number(dateInput.slice(5, 7))}月${Number(dateInput.slice(8, 10))}日${timeInput}`;

    const hasTextHint = bodyText.includes(compactDateTime)
      || bodyText.includes(`${dateInput}${timeInput.slice(0, 2)}时${timeInput.slice(3, 5)}分`)
      || bodyText.includes(compactCnDate.replace(/\s+/g, ''))
      || (bodyText.includes('定时') && bodyText.includes(timeInput));

    const allInputs = Array.from(document.querySelectorAll('input'));
    const hasInputHint = allInputs.some((input) => {
      const value = String(input.value || '').replace(/\s+/g, '');
      if (!value) {
        return false;
      }
      return value.includes(dateInput)
        || value.includes(timeInput)
        || value.includes(compactDateTime)
        || value.includes(dateNoDash);
    });

    return {
      hasTextHint,
      hasInputHint
    };
  }, {
    dateInput: dateValue,
    timeInput: timeValue
  });

  const success = Boolean(
    toggled
    || filled.dateCount
    || filled.timeCount
    || filled.dateTimeCount
    || filled.combinedCount
    || verify.hasInputHint
    || verify.hasTextHint
  );
  if (success) {
    logger(`已尝试设置${platform.label}定时发布：${dayjs(publishAt).format('YYYY-MM-DD HH:mm')}`);
  } else {
    logger(`${platform.label}未识别到可操作的定时控件。`);
  }
  return success;
}

async function clickPublishButton(page, platform, logger = () => {}) {
  if (platform.key === 'videoChannel') {
    const clicked = await page.evaluate(() => {
      const isVisible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(node);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        return true;
      };

      const publishButtons = [];

      for (const button of document.querySelectorAll('button')) {
        const text = String(button.textContent || '').trim();
        if (!text || !isVisible(button)) {
          continue;
        }
        const disabled = Boolean(
          button.disabled
            || button.hasAttribute?.('disabled')
            || button.getAttribute?.('aria-disabled') === 'true'
        );
        if (disabled || text.includes('定时')) {
          continue;
        }
        if (text === '发表' || text === '发布') {
          publishButtons.push({ button, text, priority: 1, source: 'document' });
        } else if (text === '立即发表' || text === '立即发布') {
          publishButtons.push({ button, text, priority: 2, source: 'document' });
        } else if ((text.includes('发表') || text.includes('发布')) && !text.includes('定时')) {
          publishButtons.push({ button, text, priority: 3, source: 'document' });
        }
      }

      for (const host of document.querySelectorAll('*')) {
        if (!host.shadowRoot) {
          continue;
        }
        for (const button of host.shadowRoot.querySelectorAll('button')) {
          const text = String(button.textContent || '').trim();
          if (!text || !isVisible(button)) {
            continue;
          }
          const className = typeof button.className === 'string'
            ? button.className
            : String(button.getAttribute?.('class') || '');
          const disabled = Boolean(
            button.disabled
            || button.hasAttribute?.('disabled')
            || button.getAttribute?.('aria-disabled') === 'true'
          );
          if (disabled || text.includes('定时')) {
            continue;
          }
          if (text === '发表' || text === '发布') {
            publishButtons.push({ button, text, priority: 1, source: 'shadow', className });
          } else if (text === '立即发表' || text === '立即发布') {
            publishButtons.push({ button, text, priority: 2, source: 'shadow', className });
          } else if ((text.includes('发表') || text.includes('发布')) && !text.includes('定时')) {
            publishButtons.push({ button, text, priority: 3, source: 'shadow', className });
          }
        }
      }

      const debugCandidates = publishButtons.slice(0, 12).map((item) => ({
        text: item.text,
        priority: item.priority,
        source: item.source,
        className: item.className || ''
      }));

      publishButtons.sort((a, b) => {
        if (a.priority !== b.priority) {
          return a.priority - b.priority;
        }
        return 0;
      });

      if (!publishButtons.length) {
        return { ok: false, text: '', candidates: debugCandidates };
      }

      publishButtons[0].button.click();
      return {
        ok: true,
        text: publishButtons[0].text,
        candidates: debugCandidates
      };
    });

    if (Array.isArray(clicked.candidates) && clicked.candidates.length) {
      logger(`视频号发布按钮候选：${JSON.stringify(clicked.candidates)}`);
    }
    if (clicked.ok) {
      return clicked;
    }
  }

  const clicked = await page.evaluate((publishKeywords) => {
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };

    const roots = [];
    const walk = (root) => {
      roots.push(root);
      const all = root.querySelectorAll('*');
      for (const node of all) {
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    };
    walk(document);

    const denyWords = ['定时', '高清', '草稿', '取消', '保存'];
    const candidates = [];

    for (const root of roots) {
      const buttons = root.querySelectorAll('button, [role="button"]');
      for (const button of buttons) {
        const text = (button.textContent || '').trim();
        if (!text || denyWords.some((word) => text.includes(word))) {
          continue;
        }
        if (!isVisible(button) || button.disabled) {
          continue;
        }
        let score = 0;
        for (const keyword of publishKeywords) {
          if (text === keyword) {
            score = Math.max(score, 100);
          } else if (text.includes(keyword)) {
            score = Math.max(score, 80);
          }
        }
        if (score <= 0) {
          continue;
        }
        candidates.push({ button, text, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length) {
      return { ok: false, text: '' };
    }

    candidates[0].button.click();
    return { ok: true, text: candidates[0].text };
  }, platform.publishKeywords);

  return clicked;
}

async function waitForWeixinListRedirect(page, timeoutMs, logger = () => {}) {
  try {
    await page.waitForURL(/\/platform\/post\/list(?:[/?#]|$)/, {
      timeout: timeoutMs,
      waitUntil: 'domcontentloaded'
    });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    logger(`视频号页面已跳转到列表页：${page.url()}`);
    return {
      success: true,
      reason: 'redirected-to-list',
      url: page.url()
    };
  } catch {
    return null;
  }
}

async function waitPublishResult(page, platform, scheduleEnabled, publishSignals = {}, logger = () => {}) {
  const timeoutMs = platform.key === 'videoChannel' ? 180 * 1000 : 90 * 1000;
  const startedAt = Date.now();
  const successWords = scheduleEnabled
    ? uniq([...platform.successKeywords, '定时发布', '定时发表'])
    : uniq(platform.successKeywords);
  const failWords = ['失败', '错误', '请重试', '网络异常'];
  let lastSnapshot = null;
  let postCreateObservedLogged = false;
  let redirectResult = null;

  if (platform.key === 'videoChannel') {
    waitForWeixinListRedirect(page, timeoutMs, logger)
      .then((result) => {
        redirectResult = result;
      })
      .catch(() => {});
  }

  while (Date.now() - startedAt < timeoutMs) {
    if (redirectResult?.success) {
      return redirectResult;
    }

    let snapshot;
    try {
      snapshot = await page.evaluate(({ okWords, badWords, publishKeywords }) => {
        const text = (document.body?.innerText || '').slice(0, 3000);
        const success = okWords.some((word) => text.includes(word));
        const failed = badWords.some((word) => text.includes(word));

        const roots = [];
        const walk = (root) => {
          roots.push(root);
          const all = root.querySelectorAll('*');
          for (const node of all) {
            if (node.shadowRoot) {
              walk(node.shadowRoot);
            }
          }
        };
        walk(document);

        const publishButtonPresent = roots.some((root) => Array.from(root.querySelectorAll('button'))
          .some((button) => {
            const label = String(button.textContent || '').trim();
            if (!label || button.disabled) {
              return false;
            }
            if (label.includes('定时')) {
              return false;
            }
            return publishKeywords.some((keyword) => label.includes(keyword));
          }));

        return {
          textPreview: text.slice(0, 240),
          success,
          failed,
          publishButtonPresent,
          url: location.href
        };
      }, {
        okWords: successWords,
        badWords: failWords,
        publishKeywords: platform.publishKeywords
      });
    } catch (error) {
      const message = String(error?.message || error || '');
      if (
        platform.key === 'videoChannel'
        && (
          message.includes('Execution context was destroyed')
          || message.includes('Cannot find context')
          || message.includes('Frame was detached')
        )
      ) {
        await page.waitForTimeout(1000);
        continue;
      }
      throw error;
    }
    lastSnapshot = snapshot;

    if (snapshot.success) {
      return {
        success: true,
        reason: 'page-success-keyword',
        url: snapshot.url
      };
    }
    if (snapshot.failed) {
      throw new Error(`${platform.label}页面提示发布失败：${snapshot.textPreview}`);
    }

    if (platform.key === 'videoChannel') {
      if (/\/platform\/post\/list/.test(snapshot.url)) {
        return {
          success: true,
          reason: 'redirected-to-list',
          url: snapshot.url
        };
      }
      if (publishSignals.postCreateOk && !postCreateObservedLogged) {
        logger('视频号发布请求已提交，正在等待页面跳转到列表页...');
        postCreateObservedLogged = true;
      }
    }

    await page.waitForTimeout(1800);
  }

  if (redirectResult?.success) {
    return redirectResult;
  }

  if (platform.key === 'videoChannel') {
    if (publishSignals.postCreateOk) {
      logger(`${platform.label}结果等待超时，但 post_create 已成功返回，按成功处理。`);
      return {
        success: true,
        reason: 'post-create-network-ok-timeout',
        url: page.url()
      };
    }

    if (lastSnapshot && /\/platform\/post\/list/.test(lastSnapshot.url || '')) {
      logger(`${platform.label}结果等待超时，但页面已跳转到列表页，按成功处理。`);
      return {
        success: true,
        reason: 'redirected-to-list-timeout',
        url: lastSnapshot.url
      };
    }

    if (lastSnapshot && !lastSnapshot.publishButtonPresent && publishSignals.postCreateSeen) {
      logger(`${platform.label}结果等待超时，但发布按钮已消失且检测到 post_create 请求，按成功处理。`);
      return {
        success: true,
        reason: 'button-disappeared-after-post-create',
        url: lastSnapshot.url || page.url()
      };
    }
  }

  logger(`${platform.label}发布结果等待超时，未检测到明确成功提示。`);
  return {
    success: false,
    timeout: true,
    url: page.url()
  };
}

async function publishByPlaywright({
  platformKey,
  outputPath,
  task,
  settings,
  log
}) {
  const platform = PLATFORM_CONFIG[platformKey];
  if (!platform) {
    throw new Error(`不支持的平台：${platformKey}`);
  }

  const profileDir = getProfileDir(platform.key, settings?.__userId);
  const context = await launchPersistentChromiumContext(profileDir, {
    headless: !settings.browser.showAutomationWindow,
    args: ['--disable-blink-features=AutomationControlled']
  }, log);
  const publishSignals = {
    postCreateSeen: false,
    postCreateOk: false,
    postCreateStatus: 0,
    postCreateUrl: ''
  };
  const onResponse = (response) => {
    if (platform.key !== 'videoChannel') {
      return;
    }
    const url = String(response.url?.() || '');
    if (!/channels\.weixin\.qq\.com/i.test(url) || !/post_create/i.test(url)) {
      return;
    }
    const status = Number(response.status?.() || 0);
    publishSignals.postCreateSeen = true;
    publishSignals.postCreateStatus = status;
    publishSignals.postCreateUrl = url;
    if (status >= 200 && status < 400) {
      publishSignals.postCreateOk = true;
    }
  };
  context.on('response', onResponse);
  const uninstallScheduleInterceptor = platform.key === 'videoChannel'
    ? await installWeixinScheduleInterceptor(context, task.publishAt, log)
    : async () => {};
  const stepDelayMs = resolveBrowserActionDelay(settings, 1500);
  const longStepDelayMs = Math.max(3000, stepDelayMs * 2);

  try {
    const page = context.pages()[0] || await context.newPage();
    await gotoPlatformPage(page, platform, log);
    await ensureLoggedIn(page, platform);

    await uploadVideoByInput(page, outputPath, log);
    await page.waitForTimeout(12000);
    let weixinTarget = platform.key === 'videoChannel'
      ? await resolveWeixinTargetFrame(page, log)
      : page.mainFrame();
    if (platform.key === 'videoChannel') {
      await waitForWeixinComposerReady(weixinTarget, log);
    }

    const topics = buildPublishTopics(task);
    const descText = buildPublishDescription(task, topics);
    const descResult = await fillDescriptionAndTopics(weixinTarget, platform, descText, topics, log);
    if (!descResult.ok) {
      throw new Error(`${platform.label}文案填写失败，未找到可用输入框。`);
    }
    if (!descResult.verified) {
      log(`${platform.label}话题校验未完全通过，已保留本次填写结果并继续发布。`);
    }
    await page.waitForTimeout(stepDelayMs);

    if (platform.key === 'videoChannel') {
      // Verified video-channel flow. Keep this sequence stable; adjust copy/topic behavior above instead.
      await setWeixinLocationNone(weixinTarget, log);
      await weixinTarget.waitForTimeout(stepDelayMs);

      const activityName = parseActivityName(task, outputPath);
      if (activityName) {
        const activitySelected = await selectWeixinActivity(weixinTarget, activityName, log);
        if (!activitySelected) {
          throw new Error(`视频号任务/活动选择失败：${activityName}`);
        }
        await weixinTarget.waitForTimeout(stepDelayMs);
      } else {
        log('未识别到任务/活动名，跳过任务选择。');
      }

      if (task.isOriginal) {
        const originalDeclared = await declareWeixinOriginal(weixinTarget, log);
        if (!originalDeclared) {
          throw new Error('视频号原创声明失败，请在发布页手动完成原创声明后重试。');
        }
        log('原创声明已完成，等待页面稳定后按原发布逻辑继续...');
        await page.waitForTimeout(Math.max(3000, longStepDelayMs));
        await weixinTarget.waitForTimeout(stepDelayMs);
      }
    }

    const scheduleEnabled = await setSchedulePublish(weixinTarget, platform, task.publishAt, log);
    if (task.publishAt && !scheduleEnabled) {
      throw new Error(`${platform.label}定时发布设置失败，已停止本次发布，避免误发为立即发布。`);
    }
    if (platform.key === 'videoChannel' && scheduleEnabled) {
      await weixinTarget.waitForTimeout(longStepDelayMs);
      await closeWeixinPickers(weixinTarget).catch(() => {});
      await weixinTarget.waitForTimeout(1000);
    }
    if (platform.key === 'videoChannel') {
      log('点击发表前，先关闭可能残留的弹层...');
      await closeWeixinPickers(weixinTarget).catch(() => {});
      await weixinTarget.waitForTimeout(800);
    }

    const clicked = await clickPublishButton(weixinTarget, platform, log);
    if (!clicked.ok) {
      throw new Error(`${platform.label}未找到可点击的发布按钮。`);
    }
    log(`${platform.label}已点击发布按钮：${clicked.text || '发布'}`);
    if (platform.key === 'videoChannel') {
      await page.waitForTimeout(Math.max(3000, stepDelayMs));
    }

    const publishResult = await waitPublishResult(page, platform, scheduleEnabled, publishSignals, log);
    if (!publishResult.success) {
      throw new Error(`${platform.label}发布结果未确认成功（超时）。`);
    }
    if (platform.key === 'videoChannel') {
      await page.waitForTimeout(longStepDelayMs);
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    }

    return {
      platform: platformKey,
      platformLabel: platform.label,
      published: true,
      scheduled: Boolean(task.publishAt && scheduleEnabled),
      url: publishResult.url
    };
  } finally {
    context.off('response', onResponse);
    await uninstallScheduleInterceptor().catch(() => {});
    await context.close();
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

  const results = [];
  for (const platform of platforms) {
    log(`开始发布到${PLATFORM_CONFIG[platform].label}...`);
    const result = await publishByPlaywright({
      platformKey: platform,
      outputPath,
      task,
      settings,
      log
    });
    results.push(result);
  }

  return {
    mode: 'playwright',
    scheduleAt,
    platforms,
    results
  };
}

module.exports = {
  publishVideo,
  resolveTaskPlatforms
};
