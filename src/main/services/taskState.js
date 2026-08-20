function asId(value) {
  const normalized = String(value == null ? '' : value).trim();
  return normalized || '';
}

function taskSnapshot(item) {
  return item && item.taskSnapshot && typeof item.taskSnapshot === 'object'
    ? item.taskSnapshot
    : {};
}

function getTaskIdentityParts(item) {
  const snapshot = taskSnapshot(item);
  return [...new Set([
    item?.logicalTaskId,
    item?.retryOf,
    snapshot.logicalTaskId,
    snapshot.retryOf,
    item?.taskId,
    item?.id,
    snapshot.taskId,
    snapshot.id,
  ].map(asId).filter(Boolean))];
}

function getLogicalTaskId(item) {
  const snapshot = taskSnapshot(item);
  return asId(
    item?.logicalTaskId
    || snapshot.logicalTaskId
    || item?.retryOf
    || snapshot.retryOf
    || item?.taskId
    || item?.id
    || snapshot.taskId
    || snapshot.id
  );
}

function getTaskId(item) {
  const snapshot = taskSnapshot(item);
  return asId(item?.taskId || item?.id || snapshot.taskId || snapshot.id);
}

function itemAttempt(item) {
  const values = [item?.attempt, item?.retryCount, taskSnapshot(item).retryCount];
  for (const value of values) {
    const attempt = Number(value);
    if (Number.isFinite(attempt) && attempt > 0) return attempt;
  }
  return 0;
}

function itemTimestamp(item) {
  const value = item?.finishedAt || item?.updatedAt || item?.endedAt || item?.createdAt;
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function shouldKeepTaskItem(candidate, current) {
  const attempt = itemAttempt(candidate);
  const currentAttempt = itemAttempt(current);
  if (attempt !== currentAttempt) return attempt > currentAttempt;

  const timestamp = itemTimestamp(candidate);
  const currentTimestamp = itemTimestamp(current);
  if (timestamp !== currentTimestamp) return timestamp >= currentTimestamp;

  return Boolean(candidate?.outputPath) || !Boolean(current?.outputPath);
}

function dedupeTaskItems(items) {
  const result = [];
  const indexes = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = getLogicalTaskId(item);
    if (!key) {
      result.push(item);
      continue;
    }

    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, result.length);
      result.push(item);
      continue;
    }

    if (shouldKeepTaskItem(item, result[existingIndex])) {
      result[existingIndex] = item;
    }
  }
  return result;
}

function buildRetryTask(source, newTaskId) {
  const snapshot = taskSnapshot(source);
  const originalTaskId = getTaskId(source);
  const logicalTaskId = getLogicalTaskId(source) || originalTaskId;
  return {
    ...snapshot,
    id: asId(newTaskId),
    logicalTaskId,
    retryOf: originalTaskId,
  };
}

function mergeHistoryTaskItem(item, taskId, patch = {}) {
  const targetId = asId(taskId);
  if (!targetId || !getTaskIdentityParts(item).includes(targetId)) return item;
  return { ...item, ...patch };
}

function reconcileHistoryRecords(records) {
  const seen = new Set();
  const result = [];
  for (const record of Array.isArray(records) ? records : []) {
    const items = dedupeTaskItems(record?.items || []);
    const visibleItems = items.filter((item) => {
      const key = getLogicalTaskId(item);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (visibleItems.length || !Array.isArray(record?.items)) {
      result.push({ ...record, items: visibleItems });
    }
  }
  return result;
}

module.exports = {
  buildRetryTask,
  dedupeTaskItems,
  getLogicalTaskId,
  getTaskId,
  getTaskIdentityParts,
  mergeHistoryTaskItem,
  reconcileHistoryRecords,
};
