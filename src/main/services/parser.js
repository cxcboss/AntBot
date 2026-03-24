const dayjs = require('dayjs');

const PLATFORM_KEYS = {
  VIDEO_CHANNEL: 'videoChannel',
  DOUYIN: 'douyin'
};

function splitCommaParts(line, preserveEmpty = false) {
  const parts = String(line || '')
    .split(/[，,]/g)
    .map((item) => item.trim());
  return preserveEmpty ? parts : parts.filter(Boolean);
}

function normalizeCommaParts(line) {
  return splitCommaParts(line, false);
}

function normalizeToken(text) {
  return String(text || '').replace(/\s+/g, '').trim();
}

function resolveOriginalFlag(parts, fallbackText = '') {
  const tokens = Array.isArray(parts) ? parts : [parts];
  const normalized = tokens
    .map((part) => normalizeToken(part))
    .filter(Boolean);

  if (!normalized.length && fallbackText) {
    normalized.push(normalizeToken(fallbackText));
  }

  const hasNonOriginal = normalized.some((part) => part.includes('不原创') || part.includes('非原创'));
  if (hasNonOriginal) {
    return false;
  }

  return normalized.some((part) => part.includes('原创'));
}

function stripFieldLabel(text, label) {
  return String(text || '')
    .replace(new RegExp(`^${label}\\s*[：:]?\\s*`, 'i'), '')
    .trim();
}

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

function parseTopicTokens(rawTopicText) {
  const cleaned = stripFieldLabel(rawTopicText, '话题');
  if (!cleaned) {
    return [];
  }

  const hashtagMatches = cleaned.match(/#[^\s#]+/g);
  if (hashtagMatches?.length) {
    return uniq(hashtagMatches);
  }

  return uniq(
    cleaned
      .split(/[\s、；;|/]+/g)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => (item.startsWith('#') ? item : `#${item}`))
  );
}

function looksLikeTopicField(text) {
  const cleaned = stripFieldLabel(text, '话题');
  return /#/.test(cleaned) || /^(话题)\s*[：:]/i.test(String(text || ''));
}

function looksLikeStructuredTaskBeforeUrl(beforeUrlParts) {
  if (beforeUrlParts.some((part) => part === '')) {
    return true;
  }
  if (beforeUrlParts.length >= 4) {
    return true;
  }
  if (beforeUrlParts.some((part) => /^(文案|话题)\s*[：:]/i.test(part))) {
    return true;
  }
  if (beforeUrlParts.some((part) => /#/.test(part))) {
    return true;
  }
  if (beforeUrlParts.length >= 3 && parsePublishTime(beforeUrlParts[1])) {
    return true;
  }
  return false;
}

function extractStructuredFields(beforeUrlParts, fallbackTaskName = '普通') {
  const slots = beforeUrlParts.slice();
  const taskSlot = String(slots.pop() || '').trim();
  const normalizedSlots = slots.map((item) => String(item || '').trim());
  let publishCopy = '';
  let publishTopics = [];
  let publishAt = null;

  if (normalizedSlots.length >= 3) {
    const [copySlot = '', topicSlot = '', publishSlot = ''] = normalizedSlots;
    publishCopy = stripFieldLabel(copySlot, '文案');
    publishTopics = parseTopicTokens(topicSlot);
    publishAt = parsePublishTime(publishSlot);
  } else if (normalizedSlots.length === 2) {
    const [first, second] = normalizedSlots;
    const secondAsTime = parsePublishTime(second);
    if (secondAsTime) {
      publishAt = secondAsTime;
      if (looksLikeTopicField(first)) {
        publishTopics = parseTopicTokens(first);
      } else {
        publishCopy = stripFieldLabel(first, '文案');
      }
    } else {
      publishCopy = stripFieldLabel(first, '文案');
      publishTopics = parseTopicTokens(second);
      if (!publishCopy && looksLikeTopicField(first) && !publishTopics.length) {
        publishTopics = parseTopicTokens(first);
      }
    }
  } else if (normalizedSlots.length === 1) {
    const [only] = normalizedSlots;
    const onlyAsTime = parsePublishTime(only);
    if (onlyAsTime) {
      publishAt = onlyAsTime;
    } else if (looksLikeTopicField(only)) {
      publishTopics = parseTopicTokens(only);
    } else {
      publishCopy = stripFieldLabel(only, '文案');
    }
  }

  const taskName = taskSlot || fallbackTaskName;

  return {
    publishAt,
    taskName,
    publishCopy,
    publishTopics
  };
}

function isPlatformHintToken(token) {
  const normalized = normalizeToken(token);
  return /^(微信|视频号|抖音)(发布)?$/.test(normalized);
}

function parseTaskPlatforms(rawLine) {
  const text = String(rawLine || '');
  const hasVideoChannel = /(微信|视频号)/.test(text);
  const hasDouyin = /抖音/.test(text);

  if (hasVideoChannel && hasDouyin) {
    return [PLATFORM_KEYS.VIDEO_CHANNEL, PLATFORM_KEYS.DOUYIN];
  }
  if (hasDouyin) {
    return [PLATFORM_KEYS.DOUYIN];
  }
  if (hasVideoChannel) {
    return [PLATFORM_KEYS.VIDEO_CHANNEL];
  }
  return [PLATFORM_KEYS.VIDEO_CHANNEL];
}

function parsePublishTime(rawTime) {
  if (!rawTime) {
    return null;
  }

  const now = new Date();
  const normalized = rawTime.replace(/\s+/g, '');

  const fullDateMatch = normalized.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(\d{1,2})[:时](\d{1,2})分?$/);
  if (fullDateMatch) {
    const [, y, m, d, h, min] = fullDateMatch;
    const parsed = dayjs(`${y}-${m}-${d} ${h}:${min}`);
    return parsed.isValid() ? parsed.toDate() : null;
  }

  const shortDateMatch = normalized.match(/^(\d{1,2})月(\d{1,2})日(\d{1,2})[时:](\d{1,2})分?$/);
  if (shortDateMatch) {
    const [, m, d, h, min] = shortDateMatch;
    const parsed = dayjs(`${now.getFullYear()}-${m}-${d} ${h}:${min}`);
    return parsed.isValid() ? parsed.toDate() : null;
  }

  const hmMatch = normalized.match(/^(\d{1,2})[时:](\d{1,2})分?$/);
  if (hmMatch) {
    const [, h, min] = hmMatch;
    const parsed = dayjs(now).hour(Number(h)).minute(Number(min)).second(0);
    return parsed.isValid() ? parsed.toDate() : null;
  }

  const fallback = dayjs(rawTime);
  if (fallback.isValid()) {
    return fallback.toDate();
  }

  return null;
}

function parseTaskLine(rawLine, index = 0) {
  const parts = splitCommaParts(rawLine, true);
  const dataParts = parts.filter((part) => !isPlatformHintToken(part));
  const compactDataParts = dataParts.filter(Boolean);
  if (compactDataParts.length < 2) {
    throw new Error(`第 ${index + 1} 行字段不足，至少需要“任务名, 视频链接”。`);
  }

  const urlIndex = dataParts.findIndex((part) => /^https?:\/\//i.test(part));
  if (urlIndex === -1) {
    throw new Error(`第 ${index + 1} 行缺少视频链接（http/https）。`);
  }

  const timeRangePart = dataParts.find((part) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(part.replace(/\s/g, '')));
  const isOriginal = resolveOriginalFlag(compactDataParts);
  const beforeUrlParts = dataParts.slice(0, urlIndex);
  const platforms = parseTaskPlatforms(rawLine);
  let publishTime = null;
  let taskName = '';
  let publishCopy = '';
  let publishTopics = [];

  if (looksLikeStructuredTaskBeforeUrl(beforeUrlParts)) {
    const structured = extractStructuredFields(beforeUrlParts, isOriginal ? '原创' : '普通');
    publishTime = structured.publishAt;
    taskName = structured.taskName;
    publishCopy = structured.publishCopy;
    publishTopics = structured.publishTopics;
  } else {
    publishTime = compactDataParts.length > 1 ? parsePublishTime(compactDataParts[0]) : null;
    const taskNameIndex = publishTime ? 1 : 0;
    taskName = compactDataParts[taskNameIndex];
    if (/^https?:\/\//i.test(taskName)) {
      taskName = '普通';
    }
  }

  const videoUrl = dataParts[urlIndex];
  const timeRange = timeRangePart || '';

  return {
    rawLine,
    publishAt: publishTime,
    taskName,
    isOriginal,
    videoUrl,
    timeRange,
    platforms,
    publishCopy,
    publishTopics
  };
}

function parseTaskInput(inputText) {
  const lines = inputText
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return [];
  }

  return lines.map((line, index) => ({
    id: `${Date.now()}-${index}`,
    ...parseTaskLine(line, index)
  }));
}

function parsePublishDebugLine(rawLine, fallbackTaskName = '调试发布') {
  const line = String(rawLine || '').trim();
  const parts = splitCommaParts(line, true);
  const platforms = parseTaskPlatforms(line);
  const dataParts = parts.filter((part) => !isPlatformHintToken(part));
  const compactParts = dataParts.filter(Boolean);
  const isOriginal = line ? resolveOriginalFlag(compactParts) : resolveOriginalFlag([], fallbackTaskName);
  const structured = looksLikeStructuredTaskBeforeUrl(dataParts)
    ? extractStructuredFields(dataParts, fallbackTaskName)
    : null;

  const useStructured = Boolean(structured);
  const publishAt = structured?.publishAt || (compactParts.length ? parsePublishTime(compactParts[0]) : null);
  const publishCopy = structured?.publishCopy || '';
  const publishTopics = structured?.publishTopics || [];

  const taskCandidates = compactParts.filter((part, index) => {
    if (isPlatformHintToken(part)) {
      return false;
    }
    if (/^https?:\/\//i.test(part)) {
      return false;
    }
    if (/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(part.replace(/\s/g, ''))) {
      return false;
    }
    if (publishAt && index === 0 && !useStructured) {
      return false;
    }
    return true;
  });

  let taskName = useStructured
    ? structured.taskName
    : (taskCandidates.find((part) => !/原创/.test(normalizeToken(part))) || taskCandidates[0] || fallbackTaskName);
  if (!taskName) {
    taskName = fallbackTaskName;
  }

  return {
    rawLine: line || taskName,
    publishAt,
    taskName,
    isOriginal,
    videoUrl: '',
    timeRange: '',
    platforms,
    publishCopy,
    publishTopics
  };
}

function parsePublishDebugInput(inputText, fallbackTaskName = '调试发布') {
  const lines = String(inputText || '')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  const base = parsePublishDebugLine(lines[0] || '', fallbackTaskName);
  return {
    id: `${Date.now()}-debug-publish`,
    ...base
  };
}

module.exports = {
  parseTaskInput,
  parseTaskLine,
  parsePublishDebugInput,
  parsePublishDebugLine,
  parsePublishTime,
  parseTaskPlatforms,
  PLATFORM_KEYS
};
