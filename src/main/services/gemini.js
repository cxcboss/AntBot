const fs = require('node:fs/promises');
const path = require('node:path');
const { runCommand } = require('./commandRunner');
const { getProfileDir } = require('./startupCheck');
const { launchPersistentChromiumContext } = require('./playwrightUtil');

const GEM_URL = 'https://gemini.google.com/gem/ae555326c619';
const STOP_MESSAGE = '你已让系统停止这条回答';
const GEMINI_READY_TIMEOUT_MS = 90 * 1000;
const GEMINI_POLL_INTERVAL_MS = 1200;
const GEMINI_ERROR_HOLD_MS = 8000;
const GEMINI_SRT_RETRY_MAX = 2;
const GEMINI_FIRST_RESPONSE_WAIT_MS = 10 * 1000;
const GEMINI_RESPONSE_CONFIRM_WAIT_MS = 10 * 1000;
const SRT_TIME_LINE_RE = /^(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{1,3})\s*-->\s*(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/;

function resolveGeminiUrl(settings) {
  const customUrl = String(settings?.subtitle?.geminiUrl || '').trim();
  return customUrl || GEM_URL;
}

function buildPrompt(task) {
  if (task.timeRange) {
    return `${task.videoUrl}\n${task.timeRange}`;
  }
  return String(task.videoUrl || '').trim();
}

function stripMarkdownFence(text) {
  const match = text.match(/```(?:srt|text)?\s*([\s\S]*?)```/i);
  if (!match) {
    return text;
  }
  return match[1];
}

function cleanSubtitleLine(line) {
  let text = String(line || '')
    .replace(/\u200B/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return '';
  }

  text = text.replace(/^[-*•]\s+/, '').trim();
  if (!text) {
    return '';
  }

  if (/^https?:\/\/\S+$/i.test(text)) {
    return '';
  }

  // 过滤模型常见说明性输出，避免被写入字幕导致配音异常。
  if (
    text.length <= 48
    && /^(以下|下面|这是|请|注意|说明|提示|字幕|SRT|输出|回答|视频链接|时间段|仅处理|修正)/.test(text)
    && /(:|：|如下|格式|内容|要求|字幕|链接|时间段|时间轴)/.test(text)
  ) {
    return '';
  }

  if (/^(序号|时间轴|文本行)\s*[:：]/.test(text)) {
    return '';
  }

  if (
    /^[A-Za-z0-9\s#!:._+\-]+$/.test(text)
    && /(trending|viral|gameplay|level\s*up|views?|count\s*master|rmv|subscribe|follow)/i.test(text)
  ) {
    return '';
  }

  if (/^[•・]\s*\d[\d.,万wWkK+ ]*(次|观看|播放|views?)?/i.test(text)) {
    return '';
  }

  return text;
}

function looksLikeTrailingNoiseLine(line) {
  const text = String(line || '').trim();
  if (!text) {
    return false;
  }

  if (/^https?:\/\/\S+$/i.test(text)) {
    return true;
  }

  if (
    /^[A-Za-z0-9\s#!:._+\-]+$/.test(text)
    && /(trending|viral|gameplay|level\s*up|views?|count\s*master|rmv|subscribe|follow)/i.test(text)
  ) {
    return true;
  }

  if (/^[•・]\s*\d[\d.,万wWkK+ ]*(次|观看|播放|views?)?/i.test(text)) {
    return true;
  }

  if (
    !/[\u4E00-\u9FFF]/.test(text)
    && /#/.test(text)
    && text.length <= 96
  ) {
    return true;
  }

  return false;
}

function isSrtContent(text) {
  return /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(text);
}

function parseTimeToMs(token) {
  const raw = String(token || '').trim();
  const match = raw.match(/^(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/);
  if (!match) {
    return -1;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  const millis = Number(match[4].padEnd(3, '0').slice(0, 3));
  return (((hour * 60 + minute) * 60) + second) * 1000 + millis;
}

function normalizeTimeToken(token) {
  const ms = parseTimeToMs(token);
  if (ms < 0) {
    return '';
  }
  return msToSrtTime(ms);
}

function msToSrtTime(ms) {
  const safeMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(safeMs / 3600000);
  const minutes = Math.floor((safeMs % 3600000) / 60000);
  const seconds = Math.floor((safeMs % 60000) / 1000);
  const millis = safeMs % 1000;

  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, '0'))
    .join(':') + `,${String(millis).padStart(3, '0')}`;
}

function textToSrt(text, durationSec = 60) {
  const normalized = text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');

  let lines = normalized
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！？!?；;])/g))
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    lines = ['（无有效字幕内容）'];
  }

  const totalMs = Math.max(Math.round(durationSec * 1000), lines.length * 1200);
  const slotMs = Math.max(Math.floor(totalMs / lines.length), 1200);

  const blocks = lines.map((line, index) => {
    const start = index * slotMs;
    const end = index === lines.length - 1
      ? totalMs
      : Math.max(start + 900, (index + 1) * slotMs - 60);

    return `${index + 1}\n${msToSrtTime(start)} --> ${msToSrtTime(end)}\n${line}`;
  });

  return `${blocks.join('\n\n')}\n`;
}

async function probeDurationSeconds(videoPath, logger = () => {}) {
  if (!videoPath) {
    return 60;
  }

  try {
    const { stdout } = await runCommand(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
      {
        timeoutMs: 15000
      }
    );

    const duration = Number(String(stdout).trim());
    if (Number.isFinite(duration) && duration > 0) {
      return duration;
    }
  } catch (error) {
    logger(`ffprobe 获取视频时长失败，使用默认 60s：${error.message}`);
  }

  return 60;
}

function extractSrtBlocks(rawText) {
  const cleaned = stripMarkdownFence(String(rawText || '').replace(/\r/g, '').trim());
  if (!cleaned) {
    return [];
  }

  const lines = cleaned
    .split('\n')
    .map((line) => line.replace(/\u200B/g, '').trimEnd());
  const blocks = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    let timeLine = '';
    let indexLine = '';

    if (/^\d+$/.test(line) && i + 1 < lines.length) {
      const next = lines[i + 1].trim();
      if (SRT_TIME_LINE_RE.test(next)) {
        indexLine = line;
        timeLine = next;
        i += 2;
      }
    }

    if (!timeLine && SRT_TIME_LINE_RE.test(line)) {
      timeLine = line;
      i += 1;
    }

    if (!timeLine) {
      i += 1;
      continue;
    }

    const textLines = [];
    while (i < lines.length) {
      const current = lines[i];
      const trimmed = current.trim();
      if (!trimmed) {
        i += 1;
        break;
      }
      if (SRT_TIME_LINE_RE.test(trimmed)) {
        break;
      }
      if (/^\d+$/.test(trimmed) && i + 1 < lines.length && SRT_TIME_LINE_RE.test(lines[i + 1].trim())) {
        break;
      }
      if (textLines.length > 0 && looksLikeTrailingNoiseLine(trimmed)) {
        break;
      }
      textLines.push(trimmed);
      i += 1;
    }

    const match = timeLine.match(SRT_TIME_LINE_RE);
    if (!match) {
      continue;
    }
    const start = normalizeTimeToken(`${match[1]}:${match[2]}:${match[3]},${match[4]}`);
    const end = normalizeTimeToken(`${match[5]}:${match[6]}:${match[7]},${match[8]}`);
    if (!start || !end) {
      continue;
    }

    const startMs = parseTimeToMs(start);
    const endMs = parseTimeToMs(end);
    if (startMs < 0 || endMs <= startMs) {
      continue;
    }

    const text = textLines
      .map((item) => cleanSubtitleLine(item))
      .filter(Boolean)
      .join('\n')
      .trim();

    if (!text) {
      continue;
    }

    blocks.push({
      indexLine,
      start,
      end,
      startMs,
      endMs,
      text
    });
  }

  return blocks;
}

function sanitizeSrt(rawText, options = {}) {
  const {
    minBlocks = 1
  } = options;

  const blocks = extractSrtBlocks(rawText);
  if (blocks.length < minBlocks) {
    return '';
  }

  blocks.sort((a, b) => {
    if (a.startMs !== b.startMs) {
      return a.startMs - b.startMs;
    }
    return a.endMs - b.endMs;
  });

  const filtered = [];
  let lastEnd = -1;
  for (const block of blocks) {
    if (block.startMs < 0 || block.endMs <= block.startMs) {
      continue;
    }
    if (lastEnd >= 0 && block.endMs <= lastEnd) {
      continue;
    }
    filtered.push(block);
    lastEnd = block.endMs;
  }

  if (filtered.length < minBlocks) {
    return '';
  }

  const out = filtered.map((block, idx) => {
    return `${idx + 1}\n${block.start} --> ${block.end}\n${block.text}`;
  }).join('\n\n');

  return `${out}\n`;
}

async function normalizeToSrt(rawText, inputVideoPath, logger = () => {}, options = {}) {
  const {
    allowTextToSrtFallback = true,
    minBlocks = 1
  } = options;

  const sanitizedSrt = sanitizeSrt(rawText, { minBlocks });
  if (sanitizedSrt) {
    return sanitizedSrt;
  }

  if (!allowTextToSrtFallback) {
    return '';
  }

  const cleaned = stripMarkdownFence((rawText || '').trim());
  const durationSec = await probeDurationSeconds(inputVideoPath, logger);
  logger('Gemini 未返回标准 SRT，已自动转换为 SRT。');
  const fallbackSrt = textToSrt(cleaned, durationSec);
  return sanitizeSrt(fallbackSrt, { minBlocks: 1 }) || fallbackSrt;
}

async function inspectGeminiComposerState(page) {
  return page.evaluate(() => {
    const selectors = [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][aria-label]',
      'div[contenteditable="true"]',
      'textarea[aria-label]',
      'textarea'
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
    const walkRoot = (root) => {
      roots.push(root);
      const nodes = root.querySelectorAll('*');
      for (const node of nodes) {
        if (node.shadowRoot) {
          walkRoot(node.shadowRoot);
        }
      }
    };
    walkRoot(document);

    const queryDeep = (selector) => {
      const matches = [];
      for (const root of roots) {
        try {
          matches.push(...root.querySelectorAll(selector));
        } catch {
          // noop
        }
      }
      return matches;
    };

    let target = null;
    for (const selector of selectors) {
      target = queryDeep(selector).find((node) => isVisible(node) && !node.disabled && !node.readOnly);
      if (target) {
        break;
      }
    }

    const bodyText = (document.body?.innerText || '')
      .replace(/\s+/g, ' ')
      .trim();
    const bodyPreview = bodyText.slice(0, 160);
    const url = location.href || '';
    const title = document.title || '';
    const loginLike = /accounts\.google\.com|ServiceLogin|signin/i.test(url)
      || /(登录|Sign in|Choose an account)/i.test(bodyPreview);

    return {
      ready: Boolean(target),
      mode: target?.tagName === 'TEXTAREA' ? 'textarea' : (target ? 'contenteditable' : ''),
      fieldHint: target?.getAttribute?.('aria-label')
        || target?.getAttribute?.('placeholder')
        || target?.tagName
        || '',
      url,
      title,
      loginLike,
      bodyPreview
    };
  });
}

async function waitForGeminiComposerReady(page, settings, logger = () => {}) {
  const timeoutMs = Math.max(
    GEMINI_READY_TIMEOUT_MS,
    Math.min(150000, (Number(settings?.browser?.actionDelayMs || 1500) + 800) * 30)
  );
  const startedAt = Date.now();
  let rounds = 0;
  let lastUrl = '';
  let lastTitle = '';
  let lastState = null;

  while (Date.now() - startedAt < timeoutMs) {
    let state;
    try {
      state = await inspectGeminiComposerState(page);
    } catch (error) {
      state = {
        ready: false,
        url: page.url?.() || '',
        title: '',
        loginLike: false,
        bodyPreview: '',
        error: String(error?.message || error)
      };
    }
    lastState = state;

    if (state.url && (state.url !== lastUrl || state.title !== lastTitle)) {
      logger(`Gemini 页面：${state.title || '--'} | ${state.url}`);
      lastUrl = state.url;
      lastTitle = state.title || '';
    }

    if (state.ready) {
      logger(`Gemini 输入区已就绪（${state.mode || 'unknown'}）。`);
      return state;
    }

    if (rounds > 0 && rounds % 8 === 0) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      logger(`等待 Gemini 输入区加载中（${elapsed}s）...`);
    }

    rounds += 1;
    await page.waitForTimeout(GEMINI_POLL_INTERVAL_MS);
  }

  const hint = lastState?.loginLike
    ? '当前页面疑似登录态页面，请确认 Gemini 账号已可直接进入对话页。'
    : '页面已打开但输入区未就绪，可能是网络慢或页面结构加载延迟。';
  const pageInfo = `${lastState?.title || '--'} | ${lastState?.url || page.url?.() || ''}`.trim();
  throw new Error(`未找到 Gemini 输入框（等待 ${Math.round(timeoutMs / 1000)}s）。${hint} 当前页面：${pageInfo}`);
}

async function trySendPrompt(page, prompt, logger = () => {}) {
  const injected = await page.evaluate((text) => {
    const selectors = [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][aria-label]',
      'div[contenteditable="true"]',
      'textarea[aria-label]',
      'textarea'
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
    const walkRoot = (root) => {
      roots.push(root);
      const nodes = root.querySelectorAll('*');
      for (const node of nodes) {
        if (node.shadowRoot) {
          walkRoot(node.shadowRoot);
        }
      }
    };
    walkRoot(document);

    const queryDeep = (selector) => {
      const matches = [];
      for (const root of roots) {
        try {
          matches.push(...root.querySelectorAll(selector));
        } catch {
          // noop
        }
      }
      return matches;
    };

    let target = null;
    for (const selector of selectors) {
      target = queryDeep(selector).find((node) => isVisible(node) && !node.disabled && !node.readOnly);
      if (target) {
        break;
      }
    }

    if (!target) {
      return { ok: false, reason: 'input-not-found' };
    }

    target.focus();

    if (target.tagName === 'TEXTAREA') {
      target.value = text;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, mode: 'textarea' };
    }

    try {
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, text);
    } catch {
      // noop
    }
    if (!target.innerText || target.innerText.trim() !== text.trim()) {
      target.textContent = text;
    }
    target.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return { ok: true, mode: 'contenteditable' };
  }, prompt);

  if (!injected.ok) {
    logger(`Gemini 输入框写入失败：${injected.reason || 'unknown'}`);
    return false;
  }

  logger(`Gemini 输入框已写入（${injected.mode}）`);

  const sendSelectors = [
    'button[aria-label*="Send"]',
    'button[aria-label*="发送"]',
    'button[aria-label*="提交"]',
    'button[mattooltip*="Send"]',
    'button[mattooltip*="发送"]',
    'button:has-text("Send")',
    'button:has-text("发送")',
    'button:has-text("提交")'
  ];

  for (const selector of sendSelectors) {
    const button = page.locator(selector).first();
    if (await button.count().catch(() => 0)) {
      try {
        await button.click({ timeout: 1500 });
        logger(`Gemini 已点击发送按钮（${selector}）。`);
        return true;
      } catch {
        // noop
      }
    }
  }

  await page.keyboard.press('Meta+Enter').catch(() => {});
  await page.keyboard.press('Control+Enter').catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
  logger('Gemini 发送按钮未命中，已尝试键盘发送。');
  return true;
}

async function readGeminiResponseState(page) {
  return page.evaluate(() => {
    const uniqueTexts = (nodes) => {
      const seen = new Set();
      const texts = [];
      for (const node of nodes) {
        const text = String(node?.innerText || '').trim();
        if (!text || seen.has(text)) {
          continue;
        }
        seen.add(text);
        texts.push(text);
      }
      return texts;
    };

    const modelContainers = uniqueTexts(
      document.querySelectorAll('[data-message-author-role="model"], message-content, .response-content, .model-response-text')
    );

    const codeLikeTexts = [];
    for (const selector of ['[data-message-author-role="model"]', 'message-content', '.response-content', '.model-response-text']) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        const codeTexts = uniqueTexts(node.querySelectorAll('pre, code'));
        for (const text of codeTexts) {
          codeLikeTexts.push(text);
        }
      }
    }

    const fallbackTexts = uniqueTexts(document.querySelectorAll('.markdown'));
    const candidatesRaw = codeLikeTexts.length
      ? codeLikeTexts
      : (modelContainers.length ? modelContainers : fallbackTexts);

    const responses = [];
    const seen = new Set();
    for (const text of candidatesRaw) {
      if (!text || seen.has(text)) {
        continue;
      }
      seen.add(text);
      responses.push(text);
    }

    const srtResponses = responses.filter((text) => /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(text));
    const preferredResponses = srtResponses.length ? srtResponses : responses;
    const latestResponse = preferredResponses[preferredResponses.length - 1] || responses[responses.length - 1] || '';
    const longestResponse = preferredResponses.slice().sort((a, b) => b.length - a.length)[0] || latestResponse;
    const signature = responses
      .map((text) => `${text.length}:${text.slice(0, 96)}`)
      .join('|');

    const generating = Array.from(document.querySelectorAll('button'))
      .some((button) => /Stop|停止/.test((button.innerText || '').trim()));

    return {
      generating,
      responsesCount: responses.length,
      latestResponse,
      longestResponse,
      signature
    };
  });
}

async function waitForGeminiAnswer(page, logger = () => {}, baselineState = null) {
  const timeoutMs = 8 * 60 * 1000;
  const startedAt = Date.now();
  let stableRounds = 0;
  let previousAnswer = '';
  let newAnswerSeen = false;
  const baseline = baselineState || await readGeminiResponseState(page);
  logger(`Gemini 已发送，先等待 ${Math.round(GEMINI_FIRST_RESPONSE_WAIT_MS / 1000)} 秒再检查回复内容...`);
  await page.waitForTimeout(GEMINI_FIRST_RESPONSE_WAIT_MS);

  while (Date.now() - startedAt < timeoutMs) {
    const currentState = await readGeminiResponseState(page);
    const hasNewResponse = currentState.responsesCount > baseline.responsesCount
      || (currentState.signature !== baseline.signature && currentState.latestResponse !== baseline.latestResponse);

    const answer = hasNewResponse
      ? (currentState.latestResponse || currentState.longestResponse || '')
      : '';

    if (answer) {
      newAnswerSeen = true;
    }

    if (answer && answer === previousAnswer) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
      previousAnswer = answer;
    }

    if (answer && !currentState.generating && stableRounds >= 3) {
      logger(`Gemini 回复已稳定，额外等待 ${Math.round(GEMINI_RESPONSE_CONFIRM_WAIT_MS / 1000)} 秒确认内容完整...`);
      await page.waitForTimeout(GEMINI_RESPONSE_CONFIRM_WAIT_MS);
      const confirmState = await readGeminiResponseState(page);
      const confirmed = confirmState.latestResponse || answer;
      if (confirmed.length >= answer.length) {
        return confirmed;
      }
      return answer;
    }

    if (!newAnswerSeen && stableRounds === 0 && (Date.now() - startedAt) > 20000) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      logger(`Gemini 已发送，等待新回答中（${elapsed}s）...`);
    }

    await page.waitForTimeout(2000);
  }

  logger('Gemini 结果等待超时。');
  return newAnswerSeen ? previousAnswer : '';
}

async function generateSubtitle(taskContext) {
  const {
    task,
    tempDir,
    baseName,
    settings,
    inputVideoPath,
    log
  } = taskContext;

  const subtitlePath = path.join(tempDir, `${baseName}.srt`);

  if (settings.commands.gemini) {
    const { stdout } = await runCommand(settings.commands.gemini, {
      log,
      timeoutMs: 10 * 60 * 1000,
      variables: {
        url: task.videoUrl,
        timeRange: task.timeRange,
        output: subtitlePath,
        prompt: buildPrompt(task)
      }
    });

    let text = '';
    try {
      text = await fs.readFile(subtitlePath, 'utf-8');
    } catch {
      text = String(stdout || '').trim();
    }

    if (!text) {
      throw new Error('字幕命令执行后未得到字幕内容。');
    }

    const srtText = await normalizeToSrt(text, inputVideoPath, log, {
      allowTextToSrtFallback: true,
      minBlocks: 1
    });
    await fs.writeFile(subtitlePath, srtText, 'utf-8');

    return {
      subtitlePath,
      mode: 'custom-command'
    };
  }

  const profileDir = getProfileDir('gemini', settings?.__userId || settings?.__geminiProfileId);
  const geminiUrl = resolveGeminiUrl(settings);
  const context = await launchPersistentChromiumContext(profileDir, {
    headless: !settings.browser.showAutomationWindow,
    args: ['--disable-blink-features=AutomationControlled']
  }, log);

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(geminiUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(Math.max(settings.browser.actionDelayMs || 1500, 1800));
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await waitForGeminiComposerReady(page, settings, log);

    const prompt = buildPrompt(task);
    const baselineState = await readGeminiResponseState(page);
    let sendOK = false;
    for (let i = 0; i < 3; i += 1) {
      sendOK = await trySendPrompt(page, prompt, log);
      if (sendOK) {
        break;
      }
      log(`Gemini 发送失败，准备重试（${i + 1}/3）...`);
      await page.waitForTimeout(1200);
      await waitForGeminiComposerReady(page, settings, log);
    }

    if (!sendOK) {
      throw new Error('未找到 Gemini 输入框或发送按钮。请确认 Gemini 页面可正常输入后重试。');
    }

    let answer = await waitForGeminiAnswer(page, log, baselineState);

    if (answer.includes(STOP_MESSAGE)) {
      log('Gemini 返回“已停止回答”，自动重试一次。');
      await page.waitForTimeout(1200);
      const retryBaselineState = await readGeminiResponseState(page);
      await trySendPrompt(page, prompt, log);
      answer = await waitForGeminiAnswer(page, log, retryBaselineState);
    }

    if (!answer) {
      throw new Error('Gemini 未返回可用字幕内容。');
    }

    let srtText = await normalizeToSrt(answer, inputVideoPath, log, {
      allowTextToSrtFallback: false,
      minBlocks: 1
    });

    for (let retry = 0; !srtText && retry < GEMINI_SRT_RETRY_MAX; retry += 1) {
      log(`Gemini 返回内容不是标准 SRT，正在请求重新生成（${retry + 1}/${GEMINI_SRT_RETRY_MAX}）...`);
      const retryBaselineState = await readGeminiResponseState(page);
      const sent = await trySendPrompt(page, prompt, log);
      if (!sent) {
        continue;
      }
      answer = await waitForGeminiAnswer(page, log, retryBaselineState);
      if (answer.includes(STOP_MESSAGE)) {
        log('Gemini 返回“已停止回答”，继续重试。');
        continue;
      }
      srtText = await normalizeToSrt(answer, inputVideoPath, log, {
        allowTextToSrtFallback: false,
        minBlocks: 1
      });
    }

    if (!srtText) {
      throw new Error('Gemini 多次返回非标准 SRT，已停止本次任务以避免错误配音。');
    }

    await fs.writeFile(subtitlePath, srtText, 'utf-8');

    return {
      subtitlePath,
      mode: 'playwright',
      textLength: srtText.length
    };
  } catch (error) {
    if (settings.browser.showAutomationWindow) {
      log(`Gemini 自动化失败，窗口将在 ${Math.round(GEMINI_ERROR_HOLD_MS / 1000)} 秒后关闭，便于观察页面状态。`);
      await context.pages()[0]?.waitForTimeout(GEMINI_ERROR_HOLD_MS).catch(() => {});
    }
    throw error;
  } finally {
    await context.close();
  }
}

module.exports = {
  generateSubtitle,
  buildPrompt,
  STOP_MESSAGE,
  isSrtContent,
  textToSrt
};
