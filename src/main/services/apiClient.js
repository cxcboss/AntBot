const { recordUsage, getUsageSummary, maskKey } = require('./usageTracker');
const { proxyFetch } = require('./proxyFetch');

/**
 * 归一化 API 配置为统一结构 [{ key, baseUrl, modelId }]
 * 支持新结构 settings.api.keys = [{id, key, baseUrl, modelId, availableModels}]
 * 兼容旧结构 { baseUrl, apiKey, apiKeys, modelId }
 */
function normalizeApiKeys(api) {
  if (!api || typeof api !== 'object') return [];
  if (Array.isArray(api.keys) && api.keys.length) {
    return api.keys
      .filter(k => k && k.key)
      .map(k => ({
        key: k.key,
        baseUrl: k.baseUrl || api.baseUrl || '',
        modelId: k.modelId || api.modelId || ''
      }));
  }
  const legacyKeys = (api.apiKeys || []).filter(Boolean);
  if (legacyKeys.length) {
    return legacyKeys.map(k => ({ key: k, baseUrl: api.baseUrl || '', modelId: api.modelId || '' }));
  }
  if (api.apiKey) {
    return [{ key: api.apiKey, baseUrl: api.baseUrl || '', modelId: api.modelId || '' }];
  }
  return [];
}

function hasApiConfig(api) {
  return normalizeApiKeys(api).length > 0;
}

/**
 * 带轮值的 AI 调用。
 * 新签名：callApiWithKeyRotation(api, messages, maxTokens, abortSignal, log)
 *   api = settings.api 或 { keys: [{key, baseUrl, modelId}] } 或旧 { baseUrl, apiKey, apiKeys, modelId }
 * 旧签名（兼容）：callApiWithKeyRotation(baseUrl, apiKeys, modelId, messages, maxTokens, abortSignal, log)
 * 轮值规则：优先使用当日额度未用完的 key（按 api-usage.json）；网络错误重试 2 次；429 限频切换下一个 key。
 */
async function callApiWithKeyRotation(apiConfig, messages, maxTokens = 4000, abortSignal, log = () => {}) {
  // 兼容旧签名
  if (typeof apiConfig === 'string') {
    const baseUrl = apiConfig;
    const apiKeys = arguments[1];
    const modelId = arguments[2];
    const msgs = arguments[3];
    const mt = arguments[4] ?? 4000;
    const sig = arguments[5];
    const lg = arguments[6] || (() => {});
    apiConfig = { baseUrl, apiKeys, apiKey: Array.isArray(apiKeys) ? apiKeys[0] : apiKeys, modelId };
    messages = msgs; maxTokens = mt; abortSignal = sig; log = lg;
  }

  const keys = normalizeApiKeys(apiConfig);
  if (!keys.length) throw new Error('未配置 API Key');

  // 按当日使用量轮值：优先选剩余额度 > 0 的 key（一个限额用完自动切下一个）
  let usageMap = null;
  try {
    const usage = await getUsageSummary(keys.map(k => k.key));
    usageMap = new Map(usage.map(u => [u.keyMasked, u]));
  } catch {}
  const usable = usageMap ? keys.filter(k => (usageMap.get(maskKey(k.key))?.remaining ?? 1) > 0) : keys;
  const pool = usable.length ? usable : keys;

  let lastError = null;
  for (let i = 0; i < pool.length; i++) {
    const k = pool[i];
    for (let retry = 0; retry < 2; retry++) {
      try {
        const result = await callApi(k.baseUrl, k.key, k.modelId, messages, maxTokens, abortSignal);
        await recordUsage(k.key, true).catch(() => {});
        return result;
      } catch (err) {
        lastError = err;
        if (err.message === '已取消') throw err;
        const isRateLimit = err.message.includes('429');
        const isNetwork = err.message.includes('网络') || err.message.includes('ECONNRESET') || err.message.includes('ECONNREFUSED') || err.message.includes('UND_ERR') || err.message.includes('超时');
        await recordUsage(k.key, false, isRateLimit).catch(() => {});
        if (isRateLimit) {
          if (i < pool.length - 1) { log(`Key ${i + 1} 限频，切换到下一个 Key`); break; }
          throw err;
        }
        if (isNetwork && retry < 1) {
          log(`网络错误，${(retry + 1) * 3}秒后重试...`);
          await new Promise(r => setTimeout(r, (retry + 1) * 3000));
          continue;
        }
        throw err;
      }
    }
  }
  throw lastError;
}

async function callApi(baseUrl, apiKey, modelId, messages, maxTokens = 4000, abortSignal) {
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  const bodyStr = JSON.stringify({ model: modelId, messages, max_tokens: maxTokens });
  const bodySizeKB = Math.round(Buffer.byteLength(bodyStr, 'utf8') / 1024);
  const apiSignal = abortSignal || AbortSignal.timeout(120000);
  try {
    const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const response = await proxyFetch(url, { method: 'POST', headers, body: bodyStr, signal: apiSignal });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const status = response.status;
      const reason = {
        400: '请求格式错误',
        401: 'API Key 无效或已过期',
        403: '没有权限访问此模型',
        404: '模型不存在或 API 地址错误',
        413: '请求内容太大（图片过多）',
        429: 'API 调用频率超限，请稍后重试',
        500: 'API 服务器内部错误',
        502: 'API 服务不可用',
        503: 'API 服务过载',
      }[status] || `HTTP 错误`;
      throw new Error(`${reason} (${status})，${bodySizeKB}KB：${errText.slice(0, 200)}`);
    }
    const data = await response.json();
    const msg = data.choices?.[0]?.message;
    // 只取正式回答 content：reasoning 模型思考占满 maxTokens 时 content 为空，
    // 若 fallback 到 reasoning_content 会把思考过程（"用户要求我根据提..."）当结果，
    // 命名/字幕/识别全部被污染。content 为空时返回空串，由各调用方自行处理。
    return msg?.content || '';
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('已取消');
    if (err.message.includes('HTTP 错误') || err.message.includes('请求格式') || err.message.includes('API Key')) throw err;
    // 网络错误 - 详细记录
    const cause = err.cause?.code || err.cause?.message || '';
    const reason = {
      'ECONNREFUSED': 'API 服务未启动或地址错误',
      'ECONNRESET': '连接被重置（请求可能太大或网络不稳定）',
      'ENOTFOUND': 'API 域名无法解析，请检查网络',
      'ETIMEDOUT': '连接超时，请检查网络',
      'UND_ERR_SOCKET': '连接中断（请求内容可能太大）',
      'UND_ERR_HEADERS_TIMEOUT': '响应超时',
    }[cause] || `网络错误`;
    const detail = `${reason}（${cause || err.name}），请求 ${bodySizeKB}KB，URL: ${url}`;
    throw new Error(detail);
  }
}

module.exports = { callApi, callApiWithKeyRotation, normalizeApiKeys, hasApiConfig };
