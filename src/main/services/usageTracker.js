const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const USAGE_FILE = path.join(os.homedir(), 'AntBot', 'api-usage.json');
const DEFAULT_DAILY_LIMIT = 1500; // 免费计划默认每日限额

let _usageCache = null;
let _cacheDate = '';

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function maskKey(key) {
  if (!key || key.length < 8) return '***';
  return key.slice(0, 4) + '***' + key.slice(-4);
}

async function loadUsage() {
  const d = today();
  if (_usageCache && _cacheDate === d) return _usageCache;
  try {
    const raw = await fs.readFile(USAGE_FILE, 'utf-8');
    const data = JSON.parse(raw);
    // 自动清理超过 7 天的旧数据
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    for (const date of Object.keys(data)) {
      if (date < cutoffStr) delete data[date];
    }
    _usageCache = data;
    _cacheDate = d;
    return data;
  } catch {
    _usageCache = {};
    _cacheDate = d;
    return _usageCache;
  }
}

async function saveUsage(data) {
  try {
    await fs.mkdir(path.dirname(USAGE_FILE), { recursive: true });
    await fs.writeFile(USAGE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    _usageCache = data;
  } catch {}
}

async function recordUsage(apiKey, success, isRateLimit = false) {
  const data = await loadUsage();
  const d = today();
  if (!data[d]) data[d] = {};
  const masked = maskKey(apiKey);
  if (!data[d][masked]) data[d][masked] = { used: 0, failed: 0, rateLimited: 0 };
  if (success) data[d][masked].used++;
  else if (isRateLimit) data[d][masked].rateLimited++;
  else data[d][masked].failed++;
  await saveUsage(data);
}

async function getUsageSummary(apiKeys) {
  const data = await loadUsage();
  const d = today();
  const dayData = data[d] || {};
  const results = [];
  for (const key of (apiKeys || []).filter(Boolean)) {
    const masked = maskKey(key);
    const stats = dayData[masked] || { used: 0, failed: 0, rateLimited: 0 };
    const total = stats.used + stats.failed;
    results.push({
      keyMasked: masked,
      used: stats.used,
      failed: stats.failed,
      rateLimited: stats.rateLimited,
      remaining: Math.max(0, DEFAULT_DAILY_LIMIT - total),
      limit: DEFAULT_DAILY_LIMIT,
    });
  }
  return results;
}

module.exports = { recordUsage, getUsageSummary, maskKey };
