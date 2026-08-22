let publishState = {
  isPublishing: false, videos: [], settings: {}, videoPath: '',
  currentIndex: 0, targetTabId: null, platform: null, commandSent: false,
  scheduledTime: null, expectedTimestamp: null, debuggerAttached: false,
  publishRecords: [], retryCounts: {}, timeoutTimer: null, nextVideoTimer: null,
  totalVideos: 0,
  bridgeCommandId: null,
  // 阶段机：内容脚本上报流程阶段，超时重试按阶段分流
  stage: 'idle', clickedPublish: false, verifyWaited: false,
};

let _doneLock = false;
let _finishCalled = false;
const SKIP_KEY = '_vpe_skip_names';
const ABORT_KEY = '_vpe_abort';
// 点击发布之后的阶段（安全区）：绝不自动重试，防止重复发布
const STAGE_CLICKED_OR_AFTER = ['clicked', 'verifying', 'done', 'failed'];
const BRIDGE_PORTS = [18321,18322,18323,18324,18325,18326,18327,18328,18329,18330,18331];
let cachedBridgeBaseUrl = 'http://127.0.0.1:18321';
let cachedBridgeAt = 0;
let bridgePollTimer = null;
let pollConsecutiveFailures = 0; // 连续失败计数：驱动轮询退避，避免代理/防火墙环境雪崩
// 登录检测状态缓存，避免轮询时重复创建 tab
let loginCheckTabs = { douyin: null, weixin: null };
let bridgeBusy = false;
let bridgeBusyTimer = null;
let debuggerTargets = new Map();

async function probeBridgeBase(base, timeoutMs = 600) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/api/bridge/status`, { signal: controller.signal });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    return j && j.ok ? base : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// 并行探测所有候选地址，返回最先存活的（比逐个串行快一个数量级，
// Windows 系统代理/防火墙拦截回环请求时不再出现 10-20 秒的串行超时）
async function discoverBridgeBase(timeoutMs = 600) {
  let storedBase = '';
  try {
    const d = await chrome.storage.local.get('bridgeBaseUrl');
    storedBase = String(d?.bridgeBaseUrl || '');
  } catch {}
  const candidates = [...new Set([
    storedBase,
    ...BRIDGE_PORTS.map(p => `http://127.0.0.1:${p}`),
    ...BRIDGE_PORTS.map(p => `http://localhost:${p}`),
  ])].filter(Boolean);
  const results = await Promise.all(candidates.map(b => probeBridgeBase(b, timeoutMs)));
  const found = results.find(Boolean) || '';
  if (found && found !== storedBase) {
    // 记忆本次可用地址，Service Worker 被回收重启后优先直连，免全量扫描
    chrome.storage.local.set({ bridgeBaseUrl: found }).catch(() => {});
  }
  return found;
}

async function resolveBridgeBaseUrl(force = false) {
  // 成功结果缓存 30s（此前仅 5s，MV3 SW 频繁重启时反复全量扫描）
  if (!force && cachedBridgeAt && Date.now() - cachedBridgeAt < 30000) return cachedBridgeBaseUrl;
  const found = await discoverBridgeBase(600);
  if (found) {
    cachedBridgeBaseUrl = found;
    cachedBridgeAt = Date.now();
    pollConsecutiveFailures = 0;
  } else {
    cachedBridgeAt = 0;
  }
  return found || cachedBridgeBaseUrl;
}

async function bridgeRequest(path, options = {}) {
  const base = await resolveBridgeBaseUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      signal: controller.signal,
    });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.message || data.error || `桥接请求失败：${response.status}`);
    // 成功后更新缓存
    cachedBridgeAt = Date.now();
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('桥接请求超时');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function bridgeEvent(commandId, event) {
  if (!commandId) return;
  try { await bridgeRequest(`/api/bridge/commands/${encodeURIComponent(commandId)}/events`, { method: 'POST', body: JSON.stringify(event) }); } catch (_) {}
}

async function bridgeResult(commandId, result) {
  if (!commandId) return;
  try { await bridgeRequest(`/api/bridge/commands/${encodeURIComponent(commandId)}/result`, { method: 'POST', body: JSON.stringify(result) }); } catch (_) {}
}

const PLATFORM_LOGIN_URLS = {
  douyin: 'https://creator.douyin.com/creator-micro/content/publish',
  weixin: 'https://channels.weixin.qq.com/platform/'
};

async function handleLoginCheck(platform, commandId) {
  const url = PLATFORM_LOGIN_URLS[platform];
  if (!url) throw new Error(`不支持的平台: ${platform}`);

  // 如果已有该平台的登录 tab 且仍然存在，复用它
  let tabId = loginCheckTabs[platform];
  let tabExists = false;
  if (tabId != null) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t) tabExists = true;
    } catch {}
  }

  if (!tabExists) {
    // M3: 后台创建标签页，不抢占用户焦点（debugger 截图不要求窗口可见）
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    loginCheckTabs[platform] = tabId;
    await waitForTabComplete(tabId, 15000);
  }

  try {
    // 先通过 content script 检测是否已登录（只发给主 frame，避免 iframe 抢答）
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { action: 'ping' }, { frameId: 0 });
      if (ping?.ready) {
        const loginResult = await chrome.tabs.sendMessage(tabId, { action: 'loginCheck' }, { frameId: 0 });
        if (loginResult?.loggedIn) {
          closeLoginTab(platform);
          return { loggedIn: true, platform };
        }
        // 检测到账号选择页面
        if (loginResult?.accountSelection && loginResult?.accounts?.length > 0) {
          if (commandId) {
            await bridgeEvent(commandId, { type: 'account-selection', platform, accounts: loginResult.accounts });
          }
          return { loggedIn: false, platform, accountSelection: true, accounts: loginResult.accounts };
        }
      }
    } catch (e) {
      console.log('[BG] content script 未就绪:', e.message);
    }

    // 检查 URL 是否已跳转到非登录页（说明已登录）
    try {
      const tabInfo = await chrome.tabs.get(tabId);
      if (tabInfo?.url && !/login/i.test(tabInfo.url) && /platform\/post/i.test(tabInfo.url)) {
        closeLoginTab(platform);
        return { loggedIn: true, platform };
      }
    } catch {}

    // 未登录：尝试在 iframe 内点击"使用其他头像、昵称或账号"
    if (platform === 'weixin') {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: () => {
            const btn = document.querySelector('.js_switchToNormal');
            if (btn) btn.click();
          }
        });
      } catch {}
      await sleep(2000);
    }

    // 截图获取二维码，设置固定 viewport 确保清晰度
    let qrDataUrl = null;
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      await sleep(500);
      // 设置固定视口大小，避免窗口最小化导致截图过小
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
        width: 1280, height: 800, deviceScaleFactor: 2, mobile: false
      });
      await sleep(1000);
      const screenshot = await chrome.debugger.sendCommand(
        { tabId }, 'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: false }
      );
      if (screenshot?.data) {
        qrDataUrl = 'data:image/png;base64,' + screenshot.data;
        console.log('[BG] 二维码截图成功, 大小:', Math.round((qrDataUrl?.length || 0) / 1024), 'KB');
      }
    } catch (e) {
      console.log('[BG] debugger 截图失败:', e.message);
      try {
        // fallback 需要窗口可见 + 标签页激活，仅在此时短暂激活
        await chrome.tabs.update(tabId, { active: true });
        await sleep(400);
        const tabInfo = await chrome.tabs.get(tabId);
        qrDataUrl = await chrome.tabs.captureVisibleTab(tabInfo.windowId, { format: 'png' });
      } catch {}
    } finally {
      try { await chrome.debugger.detach({ tabId }); } catch {}
    }

    if (commandId && qrDataUrl) {
      await bridgeEvent(commandId, { type: 'login-qr', platform, qrDataUrl });
    }
    return { loggedIn: false, platform, qrDataUrl };
  } catch (e) {
    closeLoginTab(platform);
    throw e;
  }
}

function closeLoginTab(platform) {
  const tabId = loginCheckTabs[platform];
  loginCheckTabs[platform] = null;
  if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
}

async function handleSelectAccount(platform, accountIndex, commandId) {
  const tabId = loginCheckTabs[platform];
  if (tabId == null) throw new Error('未找到登录页面，请先执行登录检测');
  try {
    await chrome.tabs.get(tabId);
  } catch {
    loginCheckTabs[platform] = null;
    throw new Error('登录页面已关闭，请重新检测');
  }
  try {
    const result = await chrome.tabs.sendMessage(tabId, { action: 'selectAccount', index: accountIndex });
    if (!result?.success) throw new Error(result?.error || '选择失败');
    // 等待页面跳转
    await sleep(3000);
    // 检查是否登录成功
    try {
      const tabInfo = await chrome.tabs.get(tabId);
      if (tabInfo?.url && !/login/i.test(tabInfo.url)) {
        closeLoginTab(platform);
        return { success: true, loggedIn: true, platform };
      }
    } catch {}
    // 再检查一次 content script 状态
    try {
      const loginResult = await chrome.tabs.sendMessage(tabId, { action: 'loginCheck' });
      if (loginResult?.loggedIn) {
        closeLoginTab(platform);
        return { success: true, loggedIn: true, platform };
      }
    } catch {}
    return { success: true, loggedIn: false, platform, message: '已选择，请在电脑上确认' };
  } catch (e) {
    throw new Error('选择账号失败: ' + e.message);
  }
}

function waitForTabComplete(tabId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function compressImage(dataUrl, maxWidth = 600) {
  try {
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxWidth / bitmap.width);
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(out);
    });
  } catch (e) {
    console.log('[BG] 图片压缩失败，使用原图:', e.message);
    return dataUrl;
  }
}

async function handleBridgeCommand(command) {
  const action = command?.action;
  const payload = command?.payload || {};
  if (action === 'publish.start') {
    if (publishState.isPublishing) throw new Error('插件当前正在发布另一个任务');
    publishState.bridgeCommandId = command.id;
    await handleStartPublishFlow({ ...payload, bridgeCommandId: command.id });
    return;
  }
  if (action === 'publish.stop') {
    const activeCommandId = publishState.bridgeCommandId;
    stopPublishCompletely();
    await bridgeResult(activeCommandId, { success: false, status: 'cancelled', error: '已停止' });
    await bridgeResult(command.id, { success: true, status: 'completed', stoppedCommandId: activeCommandId });
    return;
  }
  if (action === 'publish.getState') {
    await bridgeResult(command.id, { success: true, state: publishState });
    return;
  }
  if (action === 'platform.loginCheck') {
    const result = await handleLoginCheck(payload.platform || 'douyin', command.id);
    await bridgeResult(command.id, { success: true, ...result });
    return;
  }
  if (action === 'platform.selectAccount') {
    const result = await handleSelectAccount(payload.platform || 'weixin', payload.accountIndex ?? 0, command.id);
    await bridgeResult(command.id, { success: true, ...result });
    return;
  }
  if (action === 'platform.logout') {
    const platform = payload.platform || 'douyin';
    try {
      const domains = platform === 'weixin'
        ? ['channels.weixin.qq.com', '.qq.com', 'open.weixin.qq.com']
        : platform === 'douyin' ? ['creator.douyin.com', '.douyin.com', '.bytedance.com'] : [];
      for (const domain of domains) {
        try {
          const cookies = await chrome.cookies.getAll({ domain });
          for (const c of cookies) {
            const url = (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./,'') + c.path;
            await chrome.cookies.remove({ url, name: c.name }).catch(()=>{});
          }
        } catch {}
      }
      // 关闭可能残留的登录检测 tab
      for (const k of Object.keys(loginCheckTabs)) {
        const tabId = loginCheckTabs[k];
        if (tabId) { chrome.tabs.remove(tabId).catch(()=>{}); loginCheckTabs[k]=null; }
      }
      await bridgeResult(command.id, { success: true, loggedOut: true });
    } catch (e) {
      await bridgeResult(command.id, { success: false, error: e.message });
    }
    return;
  }
  const result = await executeBrowserCommand(action, payload);
  await bridgeResult(command.id, { success: true, data: result });
}

async function pollBridgeCommands() {
  if (bridgeBusy) return;
  bridgeBusy = true;
  // 10s 超时自解锁，防止 fetch 超时后 bridgeBusy 永久锁死
  bridgeBusyTimer = setTimeout(() => { bridgeBusy = false; }, 10000);
  try {
    const response = await bridgeRequest('/api/bridge/commands/next');
    pollConsecutiveFailures = 0;
    if (response?.command) {
      const command = response.command;
      await bridgeEvent(command.id, { type: 'progress', status: 'running', step: `执行 ${command.action}` });
      try {
        await handleBridgeCommand(command);
        if (command.action !== 'publish.start' && command.action !== 'publish.stop' && command.action !== 'publish.getState') {
          // executeBrowserCommand resolves its own command result; this branch is intentionally empty.
        }
      } catch (error) {
        await bridgeResult(command.id, { success: false, status: 'failed', error: error.message });
      }
    }
  } catch (e) {
    pollConsecutiveFailures += 1;
    // 仅在非超时情况下静默，超时需要打日志便于排查
    if (e && !/桥接请求超时/.test(e.message)) {
      // The desktop app may not have started its bridge server yet.
    } else if (e) {
      console.warn('[BG] 桥接轮询超时:', e.message);
    }
  } finally {
    clearTimeout(bridgeBusyTimer);
    bridgeBusy = false;
  }
}

async function executeBrowserCommand(action, payload) {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error('没有可控制的活动标签页');
  const tabId = tab.id;
  if (action === 'browser.getTabs') return chrome.tabs.query({}).then(items => items.map(item => ({ id: item.id, url: item.url, title: item.title, active: item.active })));
  if (action === 'browser.navigate') return chrome.tabs.create({ url: String(payload.url || '') });
  if (action === 'browser.screenshot') return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

  const code = ({ action: command, ...params }) => {
    const visible = node => { if (!node) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
    const nodes = [...document.querySelectorAll('button,input,textarea,select,[contenteditable="true"],[role="button"]')].filter(visible);
    const node = Number.isInteger(params.index) ? nodes[params.index] : null;
    if (command === 'getState') return { url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 12000) || '', elements: nodes.slice(0, 200).map((el, index) => ({ index, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 200) })) };
    if (!node && ['click', 'type', 'select'].includes(command)) throw new Error(`元素索引无效：${params.index}`);
    if (command === 'click') { node.click(); return { clicked: params.index }; }
    if (command === 'type') { node.focus(); if ('value' in node) node.value = String(params.text || ''); else node.textContent = String(params.text || ''); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return { typed: params.index }; }
    if (command === 'select') { node.value = String(params.option || ''); node.dispatchEvent(new Event('change', { bubbles: true })); return { selected: params.index }; }
    if (command === 'scroll') { window.scrollBy({ left: params.direction === 'left' ? -1 : params.direction === 'right' ? 1 : 0, top: params.direction === 'up' ? -Number(params.amount || 500) : params.direction === 'down' ? Number(params.amount || 500) : 0, behavior: 'smooth' }); return { scrolled: true }; }
    if (command === 'eval') return (0, eval)(String(params.code || ''));
    throw new Error(`不支持的浏览器命令：${command}`);
  };
  const result = await chrome.scripting.executeScript({ target: { tabId }, func: code, args: [{ action: action.replace(/^browser\./, ''), ...payload }] });
  return result?.[0]?.result;
}

function startBridgePolling() {
  if (bridgePollTimer) return;
  scheduleBridgePoll(0);
}

// 自适应轮询：服务正常时 800ms 快轮询；连续失败指数退避（1s→2s→4s→8s 封顶），
// 服务未启动/被代理拦截时不再每 800ms 空转一次全端口扫描
function scheduleBridgePoll(delayMs) {
  if (bridgePollTimer) clearTimeout(bridgePollTimer);
  bridgePollTimer = setTimeout(async () => {
    bridgePollTimer = null;
    await pollBridgeCommands().catch(() => {});
    const backoff = pollConsecutiveFailures === 0
      ? 800
      : Math.min(8000, 1000 * Math.pow(2, Math.min(pollConsecutiveFailures - 1, 3)));
    scheduleBridgePoll(backoff);
  }, delayMs);
}

// ════════════════════════════════════════════
// MV3 Service Worker 保活机制
// ════════════════════════════════════════════

// 1. 端口保活：每 25 秒自连一次，阻止 Chrome 30 秒超时终止
function startKeepAlive() {
  setInterval(() => {
    try { chrome.runtime.connect({ name: 'keepalive' }); } catch {}
  }, 25000);
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'keepalive') {
      // 长连接建立，Chrome 不会终止此 Worker
      port.onDisconnect.addListener(() => {});
    }
  });
}

// 1b. Offscreen 保活（更稳）：若支持则创建离屏文档，20s 心跳
async function startOffscreenKeepAlive() {
  try {
    if (!chrome.offscreen) return;
    const has = await chrome.offscreen.hasDocument?.();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Keep service worker alive for bridge polling'
      });
    }
  } catch (e) {
    console.log('[BG] Offscreen 创建失败:', e.message);
  }
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === 'offscreenHeartbeat') return false;
  });
}

// 2. Alarms 兜底：万一 Worker 还是被杀了，1 分钟内恢复轮询
// 注意：onAlarm 监听器必须在顶层同步注册——MV3 规定异步注册的监听器
// 收不到唤醒事件（SW 被回收后由 alarm 唤醒时会错过，导致断连后恢复慢）
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bridge-poll') {
    // 如果轮询已停止，重启
    if (!bridgePollTimer) {
      console.log('[BG] Alarm: restarting bridge polling');
      startBridgePolling();
    }
    // 强制刷新端口缓存后重试
    resolveBridgeBaseUrl(true).then(() => pollBridgeCommands().catch(() => {}));
  }
});

function startAlarmFallback() {
  chrome.alarms.create('bridge-poll', { periodInMinutes: 1 });
}

// ========== 跳过管理 ==========

async function getSkipNames() {
  try {
    const data = await chrome.storage.local.get(SKIP_KEY);
    return new Set(data[SKIP_KEY] || []);
  } catch (_) { return new Set(); }
}

async function clearSkipNames() {
  try { await chrome.storage.local.set({ [SKIP_KEY]: [] }); } catch (_) {}
}

// ========== 中止标志 ==========

async function setAbortFlag() {
  try { await chrome.storage.local.set({ [ABORT_KEY]: Date.now() }); } catch (_) {}
}

async function clearAbortFlag() {
  try { await chrome.storage.local.set({ [ABORT_KEY]: 0 }); } catch (_) {}
}

// ========== 调试器 ==========

async function attachDebugger(tabId) {
  if (debuggerTargets.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    if (publishState.platform === 'weixin') {
      // 仅视频号需要 Fetch 拦截（改写定时发布的 effectiveTime）
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
        patterns: [{ urlPattern: '*channels.weixin.qq.com*/post_create*', requestStage: 'Request' }]
      });
    }
    // M5: 抖音不再拦截 /api、/upload 请求 —— 拦截无用途且会拖慢/卡住页面请求
    debuggerTargets.set(tabId, true);
    publishState.debuggerAttached = true;
    return true;
  } catch (_) { return false; }
}

async function detachDebugger(tabId) {
  if (!debuggerTargets.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); debuggerTargets.delete(tabId); } catch (_) {}
}

// M4: 改写发布请求中的定时时间 effectiveTime，支持 JSON 与 multipart/form-data 两种 body
function rewriteEffectiveTime(postData, effectiveTimeSeconds) {
  const ts = String(effectiveTimeSeconds);
  // JSON body：直接改写字段
  try {
    const bodyObj = JSON.parse(postData);
    if (bodyObj && typeof bodyObj === 'object') {
      bodyObj.effectiveTime = effectiveTimeSeconds;
      return btoa(unescape(encodeURIComponent(JSON.stringify(bodyObj))));
    }
  } catch (_) {}
  // multipart/form-data：替换 name="effectiveTime" 字段的值
  const m = /(name="effectiveTime"[\s\S]*?\r?\n\r?\n)[^\r\n]*/.exec(postData);
  if (m && m[1].length < m[0].length) {
    const replaced = postData.slice(0, m.index + m[1].length) + ts + postData.slice(m.index + m[0].length);
    return btoa(unescape(encodeURIComponent(replaced)));
  }
  return null;
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method === 'Fetch.requestPaused') {
    if (params.request.url.includes('post_create') && publishState.expectedTimestamp) {
      let modifiedBodyBase64 = null;
      if (params.request.postData) {
        modifiedBodyBase64 = rewriteEffectiveTime(params.request.postData, Math.floor(publishState.expectedTimestamp / 1000));
      }
      if (modifiedBodyBase64) {
        try {
          await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: params.requestId, postData: modifiedBodyBase64 });
          return;
        } catch (_) {}
      } else if (params.request.postData) {
        // M4: 无法注入定时时间 → 明确通知，不再静默继续
        sendProgress('定时时间注入失败（发布请求格式无法改写），定时发布可能失效', 'publishing', publishState.currentIndex, publishState.videos.length);
      }
    }
    try { await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: params.requestId }); } catch (_) {}
  }
});

chrome.debugger.onDetach.addListener((s) => { if (s.tabId) debuggerTargets.delete(s.tabId); });
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ========== 消息处理 ==========

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'startPublishFlow':
      handleStartPublishFlow(message)
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    case 'generateContent':
      generateAIContent(message.videoName, message.settings)
        .then(r => sendResponse(r)).catch(e => sendResponse({ topics: [], description: '', error: e.message }));
      return true;
    case 'getPublishState': sendResponse(publishState); break;
    case 'stopPublish': stopPublishCompletely(); sendResponse({ success: true }); break;
    case 'ping': sendResponse({ ready: true, state: publishState }); break;
    case 'clickIframeButton':
      if (sender.tab?.id) {
        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id, allFrames: true },
          func: (selector) => {
            const btn = document.querySelector(selector);
            if (btn) { btn.click(); return true; }
            return false;
          },
          args: [message.selector || '.js_switchToNormal']
        }).catch(() => {});
      }
      sendResponse({ sent: true });
      break;
    case 'getScheduledTime':
      sendResponse({ scheduledTime: calculateScheduledTime(message.videoIndex, message.firstVideoScheduled) });
      break;
    case 'setExpectedTimestamp':
      publishState.expectedTimestamp = message.timestamp;
      sendResponse({ success: true });
      break;
    case 'testAI':
      testAIConnection(message.provider, message.apiKey, message.model)
        .then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    case 'douyinPublishDone':
      handlePublishCompleted(message).catch(() => {});
      sendResponse({ success: true });
      break;
    case 'publishStage':
      handleStageUpdate(message);
      sendResponse({ success: true });
      break;
    // 内容脚本运行期进度：转发到桥接事件，喂饱 App 端活动超时检测（防 90s 无事件误杀）
    case 'progressUpdate':
    case 'publishProgress': {
      if (publishState.isPublishing && publishState.bridgeCommandId &&
          message.status !== 'done' && message.detail !== 'done' && message.step !== 'done') {
        bridgeEvent(publishState.bridgeCommandId, {
          type: 'progress',
          step: message.step || message.status || '',
          detail: message.detail || '',
          current: message.current,
          total: message.total,
        }).catch(() => {});
      }
      sendResponse({ ok: true });
      break;
    }
  }
  return true;
});

// ========== 阶段机（内容脚本上报 → 超时定时器按阶段分流） ==========

async function handleStageUpdate(message) {
  if (!publishState.isPublishing) return;
  if (message.videoIndex !== undefined && message.videoIndex !== publishState.currentIndex) return;
  const stage = message.stage;
  if (!stage) return;
  publishState.stage = stage;
  console.log('[BG] 阶段:', stage, '视频', publishState.currentIndex);

  // 阶段即心跳：转发桥接事件，防止 App 端"无事件超时"误杀正常流程
  if (publishState.bridgeCommandId) {
    bridgeEvent(publishState.bridgeCommandId, { type: 'progress', step: stage, detail: '', current: publishState.currentIndex + 1, total: publishState.totalVideos }).catch(() => {});
  }

  if (stage === 'uploading' && message.videoSize) {
    // 上传阶段超时按视频大小自适应：每 10MB 额外 5s，上限 30 分钟
    const extra = Math.min(Math.ceil(message.videoSize / (10 * 1024 * 1024)) * 5000, 30 * 60 * 1000);
    startPublishTimeout(getTimeoutMs() + extra);
    return;
  }

  if (stage === 'clicked') {
    // 已点击发布按钮：进入安全区。绝不自动重试，转为验证等待兜底
    publishState.clickedPublish = true;
    publishState.verifyWaited = false;
    startPublishTimeout();
    return;
  }

  // 其他阶段：流程存活，重置超时定时器
  if (stage !== 'done' && stage !== 'failed') startPublishTimeout();
}

// ========== 发布控制 ==========

function stopPublishCompletely() {
  publishState.isPublishing = false;
  _doneLock = false;
  _finishCalled = false;
  publishState.bridgeCommandId = null; // M2: 防止残留旧命令引用导致 stop 竞态
  clearPublishTimeout();
  if (publishState.nextVideoTimer) { clearTimeout(publishState.nextVideoTimer); publishState.nextVideoTimer = null; }
  if (publishState.targetTabId) {
    detachDebugger(publishState.targetTabId);
    chrome.tabs.remove(publishState.targetTabId).catch(() => {});
    publishState.targetTabId = null;
  }
  publishState.debuggerAttached = false;
  publishState.commandSent = false;
  publishState.stage = 'idle';
  publishState.clickedPublish = false;
  publishState.verifyWaited = false;
  clearSkipNames();
  clearAbortFlag();
}

async function handleStartPublishFlow(message) {
  let t = null;
  if (message.settings.scheduledPublish && message.settings.scheduleTime) {
    t = message.settings.scheduleTime.replace('T', ' ');
  }
  publishState = {
    isPublishing: true, videos: message.videos, settings: message.settings,
    videoPath: message.videoPath, currentIndex: 0, targetTabId: null,
    platform: message.platform, commandSent: false, scheduledTime: t,
    expectedTimestamp: null, debuggerAttached: false, publishRecords: [],
    retryCounts: {}, timeoutTimer: null, nextVideoTimer: null,
    bridgeCommandId: message.bridgeCommandId || null,
    totalVideos: message.videos.length,
    stage: 'idle', clickedPublish: false, verifyWaited: false,
  };
  _doneLock = false;
  _finishCalled = false;
  await clearSkipNames();
  await clearAbortFlag();
  console.log('[BG] 开始发布，共', message.videos.length, '个');
  await publishNextVideo();
}

// ★ 核心：不修改数组，只跳过被标记的视频
async function publishNextVideo() {
  if (!publishState.isPublishing) return;

  const skipNames = await getSkipNames();

  // 跳过所有被标记的视频（不修改数组，不调整 currentIndex 以外的状态）
  while (publishState.currentIndex < publishState.videos.length &&
         skipNames.has(publishState.videos[publishState.currentIndex].name)) {
    const skipped = publishState.videos[publishState.currentIndex];
    console.log('[BG] 跳过:', skipped.name, 'index:', publishState.currentIndex);
    // 通知 popup 该视频被跳过
    sendProgress(`跳过: ${skipped.name}`, 'skipped', publishState.currentIndex, publishState.videos.length);
    publishState.currentIndex++;
  }

  if (publishState.currentIndex >= publishState.videos.length) {
    await finishAllPublish();
    return;
  }

  _doneLock = false;
  publishState.publishStartTime = Date.now();
  publishState.stage = 'idle';
  publishState.clickedPublish = false;
  publishState.verifyWaited = false;
  await clearAbortFlag();
  const video = publishState.videos[publishState.currentIndex];
  // 每视频独立参数（发布页按视频×平台设置）；无则用全局 settings
  const vs = video.settings || publishState.settings;
  publishState.currentSettings = vs;
  if (vs.scheduleTime) publishState.scheduledTime = vs.scheduleTime;
  console.log('[BG] 发布:', publishState.currentIndex, video.name);
  sendProgress(`发布中: ${video.name}`, 'publishing', publishState.currentIndex, publishState.videos.length);

  clearPublishTimeout();

  const url = publishState.platform === 'douyin'
    ? 'https://creator.douyin.com/creator-micro/content/publish'
    : 'https://channels.weixin.qq.com/platform/post/create';

  publishState.commandSent = false;
  publishState.debuggerAttached = false;

  if (publishState.targetTabId) {
    detachDebugger(publishState.targetTabId);
    chrome.tabs.remove(publishState.targetTabId).catch(() => {});
    publishState.targetTabId = null;
  }

  const tab = await chrome.tabs.create({ url });
  publishState.targetTabId = tab.id;

  const needDbg = publishState.platform === 'douyin' || (publishState.platform === 'weixin' &&
    (publishState.currentSettings?.scheduledPublish || publishState.videos.length > 1));
  if (needDbg) await attachDebugger(tab.id);
  startPublishTimeout();
}

// ========== 超时重试 ==========

function getTimeoutMs() { return (parseInt(publishState.currentSettings?.timeoutSeconds || publishState.settings?.timeoutSeconds) || 120) * 1000; }

function startPublishTimeout(overrideMs) {
  clearPublishTimeout();
  const timeoutMs = overrideMs || getTimeoutMs();
  console.log(`[BG] 启动超时定时器: ${timeoutMs}ms (stage=${publishState.stage})`);
  const currentIdx = publishState.currentIndex;
  publishState.timeoutTimer = setTimeout(async () => {
    if (!publishState.isPublishing || !publishState.targetTabId) return;
    if (publishState.currentIndex !== currentIdx) return; // 已切换到下一个视频，忽略
    await handlePublishTimeout();
  }, timeoutMs);
}

async function handlePublishTimeout() {
  if (!publishState.isPublishing || !publishState.targetTabId) return;

  // ★ 立即锁定，防止 done 处理器并发执行导致重复发布
  if (_doneLock) return;
  _doneLock = true;

  const idx = publishState.currentIndex;
  const retries = publishState.retryCounts[idx] || 0;
  const max = publishState.currentSettings?.maxRetries || publishState.settings.maxRetries || 1;
  const stage = publishState.stage;
  const autoRetry = publishState.currentSettings?.autoRetry ?? publishState.settings.autoRetry;

  // ── 分支 A：已点击发布（clicked/verifying）→ 绝不自动重试，延长验证等待一次 ──
  if (STAGE_CLICKED_OR_AFTER.includes(stage) || publishState.clickedPublish) {
    if (!publishState.verifyWaited) {
      publishState.verifyWaited = true;
      _doneLock = false;
      console.log('[BG] 已点击发布，延长验证等待（不重试，防止重复发布）');
      sendProgress('等待发布确认（视频可能已提交）...', 'publishing', idx, publishState.videos.length);
      startPublishTimeout();
      return;
    }
    // 验证等待已延长一次仍无结果 → 记录"结果未知"，继续下一个视频
    console.log('[BG] 发布结果未知（已点击发布但未检测到结果）');
    const unknownVideo = publishState.videos[idx];
    if (unknownVideo) {
      publishState.publishRecords.push({
        videoName: unknownVideo.name, videoPath: publishState.videoPath || '',
        platform: publishState.platform, publishTime: new Date().toISOString(),
        status: 'unknown', error: '已点击发布但未检测到发布结果，请人工确认',
        scheduled: false, scheduledTime: null
      });
    }
    publishState.currentIndex++;
    publishState.stage = 'idle';
    publishState.clickedPublish = false;
    publishState.verifyWaited = false;
    await sleep(2000);
    _doneLock = false;
    if (publishState.isPublishing) await publishNextVideo();
    return;
  }

  // ── 分支 B：安全阶段（idle/loading/uploading/filling）→ 竞态确认 → abort → 重试 ──
  console.log(`[BG] 阶段停滞超时 (stage=${stage}, retries=${retries}, max=${max}, commandSent=${publishState.commandSent})`);

  // ★ 竞态防护：abort 前 ping 内容脚本，确认它还没点击发布
  // （clicked 阶段消息可能尚在途中，此时 abort 会导致重复发布）
  const tabId = publishState.targetTabId;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    if (r?.clicked) {
      console.log('[BG] 内容脚本已点击发布（消息竞态），放弃 abort，转入验证等待');
      publishState.stage = 'clicked';
      publishState.clickedPublish = true;
      _doneLock = false;
      startPublishTimeout();
      return;
    }
  } catch (_) {}

  // 立即中止内容脚本 + 设置 storage 标志
  try { await chrome.tabs.sendMessage(tabId, { action: 'abortPublish' }); } catch (_) {}
  await setAbortFlag();

  // 等待一小段时间让内容脚本处理 abort
  await sleep(300);

  // 关闭标签页并清理
  if (tabId) { try { await chrome.tabs.remove(tabId); } catch (_) {} }
  detachDebugger(tabId);
  // 确认标签页真正关闭，防止残留内容脚本继续执行旧流程
  for (let i = 0; i < 10; i++) {
    try { await chrome.tabs.get(tabId); break; } catch (_) { break; }
  }
  publishState.targetTabId = null;
  publishState.debuggerAttached = false;
  publishState.commandSent = false;
  publishState.stage = 'idle';

  if (autoRetry && retries < max) {
    publishState.retryCounts[idx] = retries + 1;
    sendProgress(`超时重试 (${retries + 1}/${max})`, 'publishing', idx, publishState.videos.length);
    await sleep(1000);
    _doneLock = false;
    if (publishState.isPublishing) await publishNextVideo();
  } else {
    sendProgress(`重试${max}次仍超时，跳过`, 'error', idx, publishState.videos.length);
    // 记录失败
    const failedVideo = publishState.videos[idx];
    if (failedVideo) {
      publishState.publishRecords.push({
        videoName: failedVideo.name, videoPath: publishState.videoPath || '',
        platform: publishState.platform, publishTime: new Date().toISOString(),
        status: 'failed', error: `阶段停滞(${stage})超时，重试${max}次后失败`,
        scheduled: false, scheduledTime: null
      });
    }
    publishState.currentIndex++;
    await sleep(2000);
    _doneLock = false;
    if (publishState.isPublishing) await publishNextVideo();
  }
}

function clearPublishTimeout() { if (publishState.timeoutTimer) { clearTimeout(publishState.timeoutTimer); publishState.timeoutTimer = null; } }

// ========== 完成 ==========

async function finishAllPublish() {
  if (_finishCalled) return;
  _finishCalled = true;
  console.log('[BG] 全部完成');
  sendProgress('全部完成', 'done', 1, 1, true);
  publishState.isPublishing = false;
  clearSkipNames();
  clearAbortFlag();
  if (publishState.targetTabId) {
    detachDebugger(publishState.targetTabId);
    await sleep(3000);
    chrome.tabs.remove(publishState.targetTabId).catch(() => {});
    publishState.targetTabId = null;
  }
  for (const r of publishState.publishRecords) await savePublishRecord(r);
  if (publishState.bridgeCommandId) {
    const records = publishState.publishRecords.slice();
    const succeeded = records.some(record => record.status === 'success');
    const failed = records.some(record => record.status !== 'success');
    // H3: 部分成功（有成功也有失败）→ partialSuccess，App 端不再整体判失败
    await bridgeResult(publishState.bridgeCommandId, {
      success: records.every(record => record.status === 'success'),
      status: failed ? (succeeded ? 'completed' : 'failed') : 'completed',
      partialSuccess: succeeded && failed,
      records,
      platforms: [...new Set(records.map(record => record.platform))]
    });
    publishState.bridgeCommandId = null;
  }
}

// ========== 标签页监听 ==========

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!publishState.isPublishing || publishState.targetTabId !== tabId) return;
  const needDbg = publishState.platform === 'douyin' || (publishState.platform === 'weixin' &&
    (publishState.currentSettings?.scheduledPublish || publishState.videos.length > 1));
  if (needDbg && !publishState.debuggerAttached && (changeInfo.status === 'loading' || changeInfo.status === 'complete')) {
    await attachDebugger(tabId);
  }
  if (changeInfo.status === 'complete') {
    if (publishState.platform === 'weixin') {
      if (tab.url && tab.url.includes('/platform/post/list')) { await handleVideoPublishDone(); return; }
      if (tab.url && tab.url.includes('/platform/post/create') && !publishState.commandSent) await sendPublishCommand(tabId);
    } else {
      await sendPublishCommand(tabId);
    }
  }
});

// ★ 统一完成判定器（抖音/视频号/阶段上报共用）
// 校验完成信号属于当前视频（防止残留/延迟消息误判完成）
async function handlePublishCompleted(message) {
  if (!publishState.isPublishing || _doneLock) return;
  if (message.videoIndex !== undefined && message.videoIndex !== publishState.currentIndex) {
    console.log('[BG] 忽略过期发布完成信号:', message.videoIndex, '当前:', publishState.currentIndex);
    return;
  }
  _doneLock = true;
  clearPublishTimeout();
  const idx = publishState.currentIndex;
  const status = message.status || (message.success === false ? 'failed' : 'success');
  const videoName = message.videoName || publishState.videos[idx]?.name || '未知视频';

  // ★ 失败自动重试：未点击发布（安全阶段，clicked=false）的明确失败 → 自动重试
  // （已点击发布后的失败/未知 → 不重试，防止重复发布，直接记录）
  if (status === 'failed' && !message.clicked) {
    const retries = publishState.retryCounts[idx] || 0;
    const max = publishState.currentSettings?.maxRetries || publishState.settings.maxRetries || 1;
    const autoRetry = publishState.currentSettings?.autoRetry ?? publishState.settings.autoRetry;
    if (autoRetry && retries < max) {
      publishState.retryCounts[idx] = retries + 1;
      console.log(`[BG] 发布失败，自动重试 (${retries + 1}/${max}): ${message.error || '未知原因'}`);
      sendProgress(`发布失败，自动重试 (${retries + 1}/${max})`, 'publishing', idx + 1, publishState.videos.length);
      // 失败时内容脚本已退出，残留标签页由 publishNextVideo 清理并重开
      await sleep(1500);
      _doneLock = false;
      if (publishState.isPublishing) await publishNextVideo();
      return;
    }
  }

  const detail = status === 'success' ? 'done' : 'error';
  const statusText = status === 'success' ? '完成' : (status === 'unknown' ? '结果未知' : '失败');
  sendProgress(`${statusText}: ${videoName}`, detail, idx + 1, publishState.videos.length);
  publishState.publishRecords.push({
    videoName, videoPath: message.videoPath || publishState.videoPath || '',
    platform: publishState.platform, publishTime: new Date().toISOString(),
    status, error: status === 'success' ? '' : (message.error || '发布失败'),
    scheduled: message.scheduled || false, scheduledTime: publishState.scheduledTime
  });
  publishState.stage = 'idle';
  publishState.clickedPublish = false;
  publishState.verifyWaited = false;
  if (publishState.targetTabId) detachDebugger(publishState.targetTabId);
  publishState.currentIndex++; publishState.debuggerAttached = false; publishState.commandSent = false;
  if (publishState.currentIndex < publishState.videos.length) {
    const old = publishState.targetTabId; publishState.targetTabId = null;
    if (old) setTimeout(() => chrome.tabs.remove(old).catch(() => {}), 3000);
    publishState.nextVideoTimer = setTimeout(() => publishNextVideo(), 8000);
  } else { await finishAllPublish(); }
}

async function handleVideoPublishDone() {
  const video = publishState.videos[publishState.currentIndex];
  await handlePublishCompleted({
    videoName: video?.name,
    videoIndex: publishState.currentIndex,
    status: 'success',
    scheduled: publishState.currentSettings?.scheduledPublish || false
  });
}

// ========== 发布命令 ==========

async function sendPublishCommand(tabId, resendAttempt = 0) {
  if (publishState.commandSent || !publishState.isPublishing) return;
  let best = null, max = 0;
  for (let i = 0; i < 15; i++) {
    if (!publishState.isPublishing) return;
    try {
      const r = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      if (r?.ready) { const c = r.elementCount || 0; if (c > max) { max = c; best = r; } if (c > 50) break; }
    } catch (_) {}
    await sleep(1000);
  }
  if (!best || max < 10 || !publishState.isPublishing) {
    // 内容脚本未就绪：不再干等超时，安排一次延迟重发（SPA 渲染慢/注入延迟时自愈）
    const MAX_RESEND = 2;
    if (resendAttempt < MAX_RESEND && publishState.targetTabId === tabId) {
      console.log(`[BG] 内容脚本未就绪，${10}s 后重发发布命令 (${resendAttempt + 1}/${MAX_RESEND})`);
      setTimeout(() => {
        if (publishState.isPublishing && publishState.targetTabId === tabId && !publishState.commandSent) {
          sendPublishCommand(tabId, resendAttempt + 1).catch(() => {});
        }
      }, 10000);
    } else {
      console.log('[BG] 内容脚本持续未就绪，等待超时重试...');
    }
    publishState.commandSent = false;
    return;
  }
  // App 端发布前已通过独立登录检测确认登录态，此处不再做 loginCheck 门禁
  // （页面常驻隐藏登录组件曾导致已登录被误判为未登录而直接终止）
  publishState.commandSent = true;
  publishState.stage = 'loading';
  const videoIndexForCommand = publishState.currentIndex;
  const video = publishState.videos[videoIndexForCommand];
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'startPublish', videos: [video], settings: publishState.currentSettings || publishState.settings,
      videoPath: publishState.videoPath, videoIndex: videoIndexForCommand, totalVideos: publishState.totalVideos,
      bridgeBaseUrl: cachedBridgeBaseUrl
    });
    // 内容脚本明确报告失败 → 走统一判定器（未点击发布时自动重试），不再挂等超时
    if (response && response.success === false && publishState.isPublishing && publishState.currentIndex === videoIndexForCommand) {
      console.error('[BG] 内容脚本发布失败:', response.error);
      await handlePublishCompleted({
        videoName: video.name, videoPath: publishState.videoPath || '',
        videoIndex: videoIndexForCommand, status: 'failed',
        error: response.error || '内容脚本执行失败', clicked: response.clicked || false
      });
    }
  } catch (e) {
    console.error('[BG] 发送发布命令失败:', e.message, '等待超时重试...');
    publishState.commandSent = false;
  }
}

// ========== 进度通知 ==========

function sendProgress(step, detail, current, total, done) {
  const platformName = publishState.platform === 'douyin' ? '抖音' : '视频号';
  const event = {
    type: 'progress', step, detail, current, total, done: !!done,
    videoIndex: publishState.currentIndex,
    platformName, totalVideos: publishState.totalVideos,
    publishStartTime: publishState.publishStartTime || Date.now(),
    retryCount: publishState.retryCounts[publishState.currentIndex] || 0,
    timeoutSeconds: parseInt(publishState.currentSettings?.timeoutSeconds || publishState.settings?.timeoutSeconds) || 120,
    status: detail === 'done' ? 'done' : (detail === 'error' ? 'error' : (detail === 'publishing' ? 'publishing' : (detail === 'skipped' ? 'skipped' : 'pending')))
  };
  chrome.runtime.sendMessage({ action: 'progressUpdate', ...event }).catch(() => {});
  bridgeEvent(publishState.bridgeCommandId, event).catch(() => {});
}

// ========== AI ==========

function getAIProviderConfig(provider, apiKey, model, prompt) {
  const c = {
    mimo: { url: 'https://api.xiaomimimo.com/v1/chat/completions', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: { model: model || 'mimo-v2.5', messages: [{ role: 'user', content: prompt }], temperature: 0.7 }, extract: d => d.choices?.[0]?.message?.content || d.choices?.[0]?.message?.reasoning_content || '' },
    openai: { url: 'https://api.openai.com/v1/chat/completions', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: { model: model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.7 }, extract: d => d.choices?.[0]?.message?.content || '' },
    gemini: { url: `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:generateContent?key=${apiKey}`, headers: { 'Content-Type': 'application/json' }, body: { contents: [{ parts: [{ text: prompt }] }] }, extract: d => d.candidates?.[0]?.content?.parts?.[0]?.text || '' },
    doubao: { url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: { model: model || 'doubao-seed-2-0-mini-260215', messages: [{ role: 'user', content: prompt }], temperature: 0.7 }, extract: d => d.choices?.[0]?.message?.content || '' },
    deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: { model: model || 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.7 }, extract: d => d.choices?.[0]?.message?.content || '' }
  };
  return c[provider] || null;
}

async function callAIApi(provider, apiKey, model, prompt) {
  const config = getAIProviderConfig(provider, apiKey, model, prompt);
  if (!config) throw new Error(`Unknown provider: ${provider}`);
  const response = await fetch(config.url, { method: 'POST', headers: config.headers, body: JSON.stringify(config.body) });
  if (!response.ok) { const e = await response.text().catch(() => ''); throw new Error(`HTTP ${response.status}: ${e.substring(0, 200)}`); }
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return config.extract(data);
}

async function testAIConnection(provider, apiKey, model) {
  try { const r = await callAIApi(provider, apiKey, model, '回复"OK"两个字即可。'); return r ? { success: true, reply: r.trim() } : { success: false, error: 'AI 返回为空' }; } catch (e) { return { success: false, error: e.message }; }
}

async function generateAIContent(videoName, settings) {
  const prompt = `你是短视频文案专家。根据以下视频内容生成发布内容。\n\n视频内容：${settings.videoContent || videoName}\n\n严格按以下JSON格式返回：\n{"description":"30字以内吸引人的文案","topics":["#话题1","#话题2","#话题3"]}\n\n注意：topics 最多5个，每个以#开头。`;
  try {
    const text = await callAIApi(settings.aiProvider, settings.aiKey, settings.aiModel, prompt);
    if (text) { try { const m = text.match(/\{[\s\S]*\}/); if (m) { const p = JSON.parse(m[0]); return { topics: (p.topics || p.tags || []).slice(0, 5), description: p.description || p.desc || '' }; } } catch (_) {} return { topics: (text.match(/#[一-龥\w]+/g) || []).slice(0, 5), description: text.split('\n').map(l => l.trim()).filter(l => l && !l.includes('#') && l.length > 10).slice(0, 3).join(' ').substring(0, 200) }; }
    return { topics: [], description: '', error: 'AI返回为空' };
  } catch (error) { return { topics: [], description: '', error: error.message }; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function calculateScheduledTime(videoIndex, firstVideoScheduled = false) {
  const vs = publishState.currentSettings || {};
  // 精确时间（发布页每视频独立定时）：直接用该视频的时间，不叠加间隔
  if (vs.exactTime && vs.scheduleTime) {
    const d = new Date(vs.scheduleTime);
    if (!isNaN(d.getTime())) {
      const p = v => String(v).padStart(2, '0');
      const timeStr = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      publishState.scheduledTime = d.toISOString();
      return timeStr;
    }
  }
  let baseTime;
  if (videoIndex === 0 && publishState.scheduledTime) baseTime = new Date(publishState.scheduledTime);
  else if (publishState.scheduledTime) { baseTime = new Date(publishState.scheduledTime); baseTime.setMinutes(baseTime.getMinutes() + 40 + Math.floor(Math.random() * 49)); }
  else { baseTime = new Date(); if (firstVideoScheduled) baseTime.setMinutes(baseTime.getMinutes() + 5 + Math.floor(Math.random() * 10)); if (videoIndex > 0) baseTime.setMinutes(baseTime.getMinutes() + 40 + Math.floor(Math.random() * 49)); }
  const p = v => String(v).padStart(2, '0');
  const timeStr = `${baseTime.getFullYear()}-${p(baseTime.getMonth()+1)}-${p(baseTime.getDate())} ${p(baseTime.getHours())}:${p(baseTime.getMinutes())}`;
  publishState.scheduledTime = baseTime.toISOString();
  return timeStr;
}

async function savePublishRecord(record) {
  try {
    const base = await resolveBridgeBaseUrl();
    await fetch(`${base}/api/publish-record`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
  } catch (_) {}
}

// 持久化 publishState 到 sessionStorage（SW 重启恢复）
async function persistPublishState() {
  try { await chrome.storage.session.set({ _persistPublishState: { ...publishState, timeoutTimer: null, nextVideoTimer: null } }); } catch {}
}
async function restorePublishState() {
  try {
    const data = await chrome.storage.session.get('_persistPublishState');
    const s = data._persistPublishState;
    if (s && s.isPublishing) {
      // 恢复关键字段，不恢复定时器
      publishState = { ...publishState, ...s, timeoutTimer: null, nextVideoTimer: null };
      console.log('[BG] 已恢复未完成的发布任务');
    }
  } catch {}
}

console.log('[BG] Service Worker started');
startKeepAlive();
startOffscreenKeepAlive();
restorePublishState().then(() => {
  startBridgePolling();
  startAlarmFallback();
});
