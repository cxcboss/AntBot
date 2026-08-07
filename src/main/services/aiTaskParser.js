const dayjs = require('dayjs');
const { callApiWithKeyRotation, hasApiConfig } = require('./apiClient');
const { parseTaskInput, parsePublishTime, PLATFORM_KEYS } = require('./parser');

const DEFAULT_PLATFORMS = [PLATFORM_KEYS.VIDEO_CHANNEL];
const DEFAULT_IS_ORIGINAL = false;
const DEFAULT_TOPICS = ['#动画', '#奇葩游戏', '#游戏', '#小游戏', '#休闲游戏'];
const DEFAULT_INTERVAL_MINUTES = [40, 70];
const VALID_PLATFORMS = new Set(Object.values(PLATFORM_KEYS));
const URL_RE = /https?:\/\/[^\s，,）)\]】"'<>]+?(?=\s|$|https?:\/\/|[）)])/gi;

function splitLines(inputText) {
  return String(inputText || '')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function normalizePlatforms(value) {
  const list = Array.isArray(value) ? value : [value];
  const result = [];
  for (const item of list) {
    const p = String(item || '').toLowerCase();
    if (p === '视频号' || p === '微信' || p === 'weixin' || p === 'videochannel' || p === 'videoChannel') {
      result.push(PLATFORM_KEYS.VIDEO_CHANNEL);
    } else if (p === '抖音' || p === 'douyin') {
      result.push(PLATFORM_KEYS.DOUYIN);
    } else if (VALID_PLATFORMS.has(p)) {
      result.push(p);
    }
  }
  return result.length ? [...new Set(result)] : null;
}

function normalizeTopics(value) {
  const list = Array.isArray(value) ? value : [];
  const result = [];
  for (const item of list) {
    const t = String(item || '').trim();
    if (!t) continue;
    result.push(t.startsWith('#') ? t : `#${t}`);
  }
  return result.length ? [...new Set(result)].slice(0, 5) : null;
}

function normalizeIsOriginal(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value || '').toLowerCase();
  if (/^(false|0|否|不原创|非原创)$/.test(text)) return false;
  if (/^(true|1|是|原创)$/.test(text)) return true;
  return null;
}

function parseTimeValue(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const text = String(value).trim();
  if (!text) return null;
  const full = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s*(\d{1,2})[:时](\d{1,2})分?$/);
  if (full) {
    const [, y, m, d, h, min] = full;
    const parsed = dayjs(`${y}-${m}-${d} ${h}:${min}`);
    return parsed.isValid() ? parsed.toDate() : null;
  }
  const hm = text.match(/^(\d{1,2})[:时](\d{1,2})分?$/);
  if (hm) {
    const [, h, min] = hm;
    let parsed = dayjs(new Date()).hour(Number(h)).minute(Number(min)).second(0);
    if (!parsed.isValid()) return null;
    if (parsed.isBefore(dayjs(new Date()).second(0))) parsed = parsed.add(1, 'day');
    return parsed.toDate();
  }
  const fallback = dayjs(text);
  return fallback.isValid() ? fallback.toDate() : null;
}

function parseStartAt(value) {
  const d = parseTimeValue(value);
  if (!d) return null;
  if (d.getTime() < Date.now()) return new Date(d.getTime() + 24 * 60 * 60 * 1000);
  return d;
}

function parseChineseRelativeTime(text) {
  const m = String(text || '').match(/(今天|明天|后天)?\s*(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|半夜)?\s*(\d{1,2})点\s*(?:(\d{1,2})分|半)?/);
  if (!m) return null;
  const [, dayWord, part, hourStr, minStr] = m;
  let hour = Number(hourStr);
  if (hour < 1 || hour > 24) return null;
  let minute = minStr ? Number(minStr) : (String(m[0]).includes('半') ? 30 : 0);
  if (minute > 59) return null;
  if (/(下午|傍晚|晚上|夜里|半夜)/.test(part || '') && hour < 12) hour += 12;
  if (/(凌晨|半夜|夜里)/.test(part || '') && hour === 12) hour = 0;
  let d = dayjs(new Date());
  if (dayWord === '明天') d = d.add(1, 'day');
  else if (dayWord === '后天') d = d.add(2, 'day');
  d = d.hour(hour).minute(minute).second(0);
  if (!d.isValid()) return null;
  if (d.isBefore(dayjs(new Date()).second(0))) d = d.add(1, 'day');
  return d.toDate();
}

function extractCampaign(rawLine) {
  const text = String(rawLine || '');
  const match = text.match(/(?:活动|参加活动|星图任务)\s*[：:]?\s*([^\s,，。；;|/《》]+)/);
  if (!match) return '';
  const name = String(match[1] || '').trim();
  if (!name || /^(不需要|无|不参加|没有|否|false)$/.test(name)) return '';
  return name;
}

function extractLineOverrides(line) {
  const overrides = {};
  const timeRangeMatch = line.match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/);
  if (timeRangeMatch) overrides.timeRange = timeRangeMatch[0].replace(/\s/g, '');

  const clean = line.replace(/https?:\/\/[^\s，,）)\]】"'<>]+/gi, ' ');

  if (!overrides.timeRange) {
    const full = clean.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s*(\d{1,2})[:时](\d{1,2})分?/);
    if (full) {
      const [, y, m, d, h, min] = full;
      const parsed = dayjs(`${y}-${m}-${d} ${h}:${min}`);
      if (parsed.isValid()) overrides.publishAt = parsed.toDate();
    }
  }
  if (!overrides.publishAt && !overrides.timeRange) {
    const hm = clean.match(/(\d{1,2})[:时](\d{1,2})分?/);
    if (hm) {
      const [, h, min] = hm;
      let parsed = dayjs(new Date()).hour(Number(h)).minute(Number(min)).second(0);
      if (parsed.isValid()) {
        if (parsed.isBefore(dayjs(new Date()).second(0))) parsed = parsed.add(1, 'day');
        overrides.publishAt = parsed.toDate();
      }
    }
  }
  if (!overrides.publishAt && !overrides.timeRange) {
    const cn = parseChineseRelativeTime(clean);
    if (cn) overrides.publishAt = cn;
  }

  if (/(不原创|非原创|不需要原创|不用原创|不要原创|无需原创)/.test(clean)) overrides.isOriginal = false;
  else if (/原创/.test(clean)) overrides.isOriginal = true;
  if (/(立刻发布|立即发布|马上发布|立刻|立即)/.test(clean)) overrides.publishImmediately = true;

  if (/抖音/.test(clean) && !/(微信|视频号)/.test(clean)) overrides.platforms = [PLATFORM_KEYS.DOUYIN];
  else if (/(微信|视频号)/.test(clean) && !/抖音/.test(clean)) overrides.platforms = [PLATFORM_KEYS.VIDEO_CHANNEL];
  else if (/抖音/.test(clean)) overrides.platforms = [PLATFORM_KEYS.VIDEO_CHANNEL, PLATFORM_KEYS.DOUYIN];

  const topics = (clean.match(/#[^\s#]+/g) || []).filter(Boolean);
  if (topics.length) overrides.publishTopics = normalizeTopics(topics);

  return overrides;
}

function extractUrls(line) {
  return String(line || '').match(URL_RE) || [];
}

function looksLikeBareLine(line) {
  const clean = line.replace(/https?:\/\/[^\s，,）)\]】"'<>]+/gi, ' ').trim();
  if (!clean) return true;
  if (/(活动|标题|文案|默认|全部|所有|每隔|每\d+分钟|明天|今天|后天|上午|下午|晚上|凌晨|中午|分组|【|】|《|》|，|,)/.test(clean)) return false;
  const tokens = clean.split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const TIME_TOKEN = /^(\d{1,2}[时:]\d{1,2}分?|\d{1,2}月\d{1,2}日\d{1,2}[时:]\d{1,2}分?|\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\d{1,2}[时:]\d{1,2}分?|\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})$/;
  return tokens.every((tok) => TIME_TOKEN.test(tok) || /^(发?微信|发?视频号|发?抖音)$/.test(tok) || /^(原创|不原创|非原创)$/.test(tok) || /^#[^\s#]+$/.test(tok));
}

function shouldUseAI(inputText) {
  const lines = splitLines(inputText);
  if (!lines.length) return false;
  return !lines.every((line) => looksLikeBareLine(line));
}

/* ── AI 解析 ── */

function buildSystemPrompt() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const nowText = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${pad(now.getHours())}:${pad(now.getMinutes())}（周${weekdays[now.getDay()]}）`;
  return `你是 AntBot 短视频任务解析器。用户输入一段自由文本，可能包含：
1. 默认值声明（开头部分，如"全部发抖音原创"、"明天10点开始每3分钟一条"、"活动：双11"、"标题《双11第N期》"）
2. 多行任务，每行至少一个视频下载链接（http/https 开头）
3. 行内修饰（如"不原创"、"13:30"、"发视频号"、"#话题"）
4. 分组声明（如"原创-抖音："开头的段落，作用于其后的行）

当前真实时间：${nowText}。所有相对时间（今天/明天/后天/上午/下午/晚上/凌晨/中午）必须以上述时间为基准换算成具体 "YYYY-MM-DD HH:mm"，不得使用其他日期。

请解析为 JSON，严格按以下格式输出，不要输出任何其他内容：
{"defaults":{"platforms":["videoChannel"|"douyin"|两者],"isOriginal":true|false|null,"startAt":"HH:mm"|null,"intervalMinutes":[min,max]|null,"topics":["#话题"]|null,"titleTemplate":"含{N}的模板"|null,"campaignName":"活动名"|null,"publishCopy":"文案"|null},"tasks":[{"videoUrl":"https://...","publishAt":"YYYY-MM-DD HH:mm"或"HH:mm"或null,"platforms":同defaults可省略,"isOriginal":同defaults可省略,"topics":同defaults可省略,"title":标题|null,"campaignName":活动名|null,"publishCopy":文案|null}]}

规则：
- 每个任务必须有且仅有一个 videoUrl（http/https 开头）
- tasks 顺序保持用户输入顺序；分组/默认声明不产生任务
- 只有用户明确写的内容才填，未提及字段一律 null（不要猜测，不要填默认值）
- 平台只能是 videoChannel（视频号/微信）或 douyin（抖音）
- 话题以 # 开头；发布文案是用户给的准确文案，不是生成
- 相对时间（今天/明天/后天/上午/下午/晚上）换算成具体 "YYYY-MM-DD HH:mm"；纯时间 "HH:mm" 表示今天；换算必须以"当前真实时间"为基准
- 用户写"第N期"类标题模板时 titleTemplate 用 {N} 表示序号
- 行内修饰只作用于对应行，默认声明作用于全部行`;
}

const SYSTEM_PROMPT = buildSystemPrompt();

function parseAIJson(content) {
  if (!content) throw new Error('AI 返回为空');
  const match = String(content).match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI 返回不是 JSON');
  return JSON.parse(match[0]);
}

async function callAIParser(inputText, apiConfig, log = () => {}, abortSignal = null) {
  if (!hasApiConfig(apiConfig)) {
    throw new Error('未配置 AI 解析所需的 API 配置');
  }
  const content = await callApiWithKeyRotation(
    apiConfig,
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: inputText }
    ],
    4000,
    abortSignal,
    log
  );
  return parseAIJson(content);
}

/* ── 任务组装 ── */

function buildTask(item, defaults, index, rawLine, taskDefaults = null) {
  const platforms = normalizePlatforms(item.platforms) || normalizePlatforms(defaults.platforms) || normalizePlatforms(taskDefaults?.platforms) || DEFAULT_PLATFORMS.slice();
  const isOriginal = normalizeIsOriginal(item.isOriginal) ?? normalizeIsOriginal(defaults.isOriginal) ?? normalizeIsOriginal(taskDefaults?.isOriginal) ?? DEFAULT_IS_ORIGINAL;
  const topics = normalizeTopics(item.topics) || normalizeTopics(defaults.topics) || normalizeTopics(taskDefaults?.topics) || DEFAULT_TOPICS.slice();
  const publishCopy = String(item.publishCopy || defaults.publishCopy || '').trim();
  const campaignName = String(item.campaignName || defaults.campaignName || extractCampaign(rawLine) || '').trim();

  let taskName = String(item.title || '').trim();
  if (!taskName && defaults.titleTemplate) {
    taskName = renderTitleTemplate(defaults.titleTemplate, index + 1);
  }
  if (!taskName) taskName = '普通';

  return {
    rawLine,
    publishAt: parseTimeValue(item.publishAt),
    taskName,
    isOriginal,
    videoUrl: String(item.videoUrl || '').trim(),
    timeRange: item.timeRange || '',
    platforms,
    publishCopy,
    publishTopics: topics,
    campaignName
  };
}

function renderTitleTemplate(template, n) {
  return String(template || '').replace(/\{N\}|第\s*N\s*期/g, (m) => {
    if (m.includes('期')) return `第${n}期`;
    return String(n);
  }).trim();
}

function scheduleTasks(tasks, defaults, taskDefaults = null) {
  if (!tasks.length) return;
  let prev = null;
  const interval = Array.isArray(defaults.intervalMinutes) && defaults.intervalMinutes.length >= 2
    ? defaults.intervalMinutes
    : (Array.isArray(taskDefaults?.intervalMinutes) && taskDefaults.intervalMinutes.length >= 2
      ? taskDefaults.intervalMinutes
      : DEFAULT_INTERVAL_MINUTES);
  const useInterval = tasks.length > 1;
  for (const t of tasks) {
    if (t.publishAt) {
      prev = t.publishAt;
      continue;
    }
    if (t._explicitImmediate) {
      t.publishAt = new Date();
      prev = t.publishAt;
      continue;
    }
    if (useInterval) {
      if (prev === null || t._batchStart) {
        prev = parseStartAt(t._declStartAt || defaults.startAt) || new Date();
      } else {
        prev = new Date(prev.getTime() + randInt(interval[0], interval[1]) * 60000);
      }
      t.publishAt = prev;
    } else if (t._declStartAt || defaults.startAt) {
      t.publishAt = parseStartAt(t._declStartAt || defaults.startAt);
    }
  }
}

function validateTasks(tasks) {
  return tasks.filter((t) => /^https?:\/\//i.test(t.videoUrl || ''));
}

/* ── 规则解析（降级/裸链接路径） ── */

function extractDeclaration(line) {
  const decl = {};
  const clean = String(line || '').replace(/https?:\/\/[^\s，,）)\]】"'<>]+/gi, ' ');
  if (/抖音/.test(clean) && !/(微信|视频号)/.test(clean)) decl.platforms = [PLATFORM_KEYS.DOUYIN];
  else if (/(微信|视频号)/.test(clean) && !/抖音/.test(clean)) decl.platforms = [PLATFORM_KEYS.VIDEO_CHANNEL];
  else if (/抖音/.test(clean)) decl.platforms = [PLATFORM_KEYS.VIDEO_CHANNEL, PLATFORM_KEYS.DOUYIN];
  if (/(不原创|非原创|不需要原创|不用原创|不要原创|无需原创)/.test(clean)) decl.isOriginal = false;
  else if (/原创/.test(clean)) decl.isOriginal = true;
  if (/(立刻发布|立即发布|马上发布|立刻|立即)/.test(clean)) decl.startAt = null;
  const topics = (clean.match(/#[^\s#]+/g) || []).filter(Boolean);
  if (topics.length) decl.topics = normalizeTopics(topics);
  const interval = clean.match(/(?:每|每隔|间隔)\s*(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s*分钟/);
  if (interval) {
    decl.intervalMinutes = interval[2] ? [Number(interval[1]), Number(interval[2])] : [Number(interval[1]), Number(interval[1])];
  }
  const hm = clean.match(/(\d{1,2})[时:](\d{1,2})分?/);
  if (hm) decl.startAt = `${String(hm[1]).padStart(2, '0')}:${String(hm[2]).padStart(2, '0')}`;
  else {
    const hour = clean.match(/(\d{1,2})\s*点(?!半)/);
    if (hour) decl.startAt = parseChineseHour(Number(hour[1]));
  }
  const template = clean.match(/《([^》]*)》/);
  if (template) {
    const t = template[1].trim();
    if (t) decl.titleTemplate = t;
  }
  const campaign = extractCampaign(clean);
  if (campaign) decl.campaignName = campaign;
  return decl;
}

function parseChineseHour(n) {
  const now = new Date();
  const candidate = new Date();
  candidate.setHours(n, 0, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    if (n <= 11) {
      candidate.setHours(n + 12, 0, 0, 0);
    }
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }
  return candidate;
}

const DECLARATION_HINT = /(全部|默认|所有|每隔|每\s*\d+\s*分钟|间隔|活动|参加活动|星图任务|标题|文案|都是|每个|每一条|下面的|剩下的)/;
// 分组指示词：出现时声明作用于后续所有行（分组语义）
const GROUP_HINT = /(都是|全部|所有|每个|每一条|每一条都|下面的|剩下的|以下)/;
// 单条指示词：声明只作用于本行
const SINGLE_HINT = /(这条|这个|这一个|这条视频|这个视频|该条)/;

function parseByRules(inputText, taskDefaults = null) {
  const lines = splitLines(inputText);
  const decl = { platforms: null, isOriginal: null, startAt: null, intervalMinutes: null, topics: null, titleTemplate: null, campaignName: '', publishCopy: '' };
  const warnings = [];
  const tasks = [];
  let pendingBatchStart = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const urls = extractUrls(line);

    if (!urls.length) {
      if (DECLARATION_HINT.test(line)) {
        Object.assign(decl, extractDeclaration(line));
      } else {
        warnings.push(`第 ${i + 1} 行缺少视频链接，已跳过`);
      }
      continue;
    }

    const prefix = line.slice(0, line.search(/https?:\/\//i) < 0 ? line.length : line.search(/https?:\/\//i));
    const isGroup = GROUP_HINT.test(prefix);
    const isSingle = SINGLE_HINT.test(prefix);
    if (isGroup) {
      Object.assign(decl, extractDeclaration(prefix));
      pendingBatchStart = true;
    }

    const overrides = extractLineOverrides(line);
    let legacy = null;
    try {
      legacy = parseTaskInput(line)[0];
    } catch {}

    for (let k = 0; k < urls.length; k++) {
      const url = urls[k];
      let taskName = '普通';
      const n = tasks.length + 1;
      if (decl.titleTemplate) {
        taskName = renderTitleTemplate(decl.titleTemplate, n);
      } else if (legacy?.taskName && legacy.taskName !== '普通' && k === 0) {
        taskName = legacy.taskName;
      }
      const task = {
        rawLine: line,
        publishAt: overrides.publishAt || null,
        _explicitImmediate: overrides.publishImmediately || false,
        _declStartAt: decl.startAt,
        _batchStart: !tasks.length || pendingBatchStart,
        taskName,
        isOriginal: overrides.isOriginal ?? decl.isOriginal ?? legacy?.isOriginal ?? normalizeIsOriginal(taskDefaults?.isOriginal) ?? DEFAULT_IS_ORIGINAL,
        videoUrl: url,
        timeRange: overrides.timeRange || legacy?.timeRange || '',
        platforms: overrides.platforms || decl.platforms || legacy?.platforms || normalizePlatforms(taskDefaults?.platforms) || DEFAULT_PLATFORMS.slice(),
        publishCopy: legacy?.publishCopy || decl.publishCopy || '',
        publishTopics: overrides.publishTopics || decl.topics || (legacy?.publishTopics?.length ? legacy.publishTopics : normalizeTopics(taskDefaults?.topics) || DEFAULT_TOPICS.slice()),
        campaignName: extractCampaign(line) || decl.campaignName,
        _declStartAt: decl.startAt
      };
      tasks.push(task);
      pendingBatchStart = false;
    }
  }

  return { tasks, warnings, defaults: decl };
}

/* ── 主入口 ── */

async function parseTaskInputSmart(inputText, options = {}) {
  const { apiConfig, log = () => {}, taskDefaults = null, signal = null } = options;
  const lines = splitLines(inputText);
  const warnings = [];
  if (!lines.length) return { tasks: [], warnings, source: 'none' };

  let source = 'regex';
  let parsed = null;
  const useAI = shouldUseAI(inputText);
  if (useAI && apiConfig) {
    try {
      parsed = await callAIParser(inputText, apiConfig, log, signal);
      source = 'ai';
    } catch (err) {
      warnings.push(`AI 解析失败，已按默认规则识别：${err.message}`);
    }
  }

  let tasks;
  let defaults = {};
  if (parsed && Array.isArray(parsed.tasks)) {
    defaults = parsed.defaults && typeof parsed.defaults === 'object' ? parsed.defaults : {};
    const byLine = new Map();
    parsed.tasks.forEach((item, i) => {
      const rawLine = lines[i] || '';
      const task = buildTask(item, defaults, i, rawLine, taskDefaults);
      byLine.set(i, task);
    });
    tasks = [...byLine.values()];
  } else {
    const ruleResult = parseByRules(inputText, taskDefaults);
    tasks = ruleResult.tasks;
    defaults = ruleResult.defaults || {};
    warnings.push(...ruleResult.warnings);
  }

  const valid = validateTasks(tasks);
  const dropped = tasks.length - valid.length;
  if (dropped > 0) warnings.push(`${dropped} 条任务缺少有效视频链接，已忽略`);

  scheduleTasks(valid, defaults, taskDefaults);

  const now = Date.now();
  return {
    tasks: valid.map((t, i) => ({ id: `${now}-${i}`, ...t, ai: source === 'ai' })),
    warnings,
    source,
    defaults: {
      platforms: normalizePlatforms(defaults.platforms) || normalizePlatforms(taskDefaults?.platforms) || DEFAULT_PLATFORMS.slice(),
      isOriginal: normalizeIsOriginal(defaults.isOriginal) ?? normalizeIsOriginal(taskDefaults?.isOriginal) ?? DEFAULT_IS_ORIGINAL,
      topics: normalizeTopics(defaults.topics) || normalizeTopics(taskDefaults?.topics) || DEFAULT_TOPICS.slice(),
      intervalMinutes: Array.isArray(defaults.intervalMinutes) && defaults.intervalMinutes.length >= 2
        ? defaults.intervalMinutes
        : (Array.isArray(taskDefaults?.intervalMinutes) && taskDefaults.intervalMinutes.length >= 2
          ? taskDefaults.intervalMinutes
          : DEFAULT_INTERVAL_MINUTES.slice())
    }
  };
}

module.exports = {
  parseTaskInputSmart,
  parseTaskInput,
  parsePublishTime,
  shouldUseAI,
  DEFAULT_PLATFORMS,
  DEFAULT_IS_ORIGINAL,
  DEFAULT_TOPICS,
  DEFAULT_INTERVAL_MINUTES,
  PLATFORM_KEYS
};
