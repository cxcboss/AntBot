import { FIGMA_ASSETS } from './figmaAssets.js';

const el = {
  appBadge: document.querySelector('#app-badge'),
  userList: document.querySelector('#user-list'),
  addUserBtn: document.querySelector('#add-user-btn'),
  geminiLoginBtn: document.querySelector('#gemini-login-btn'),
  settingsBtn: document.querySelector('#settings-btn'),
  voiceCloneBtn: document.querySelector('#voice-clone-btn'),
  remoteBtn: document.querySelector('#remote-btn'),
  videoLoginBtn: document.querySelector('#video-login-btn'),
  douyinLoginBtn: document.querySelector('#douyin-login-btn'),
  currentUserName: document.querySelector('#current-user-name'),
  startupStatus: document.querySelector('#startup-status'),
  taskSummary: document.querySelector('#task-summary'),
  taskInput: document.querySelector('#task-input'),
  runBtn: document.querySelector('#run-btn'),
  refreshStartupBtn: document.querySelector('#refresh-startup-btn'),
  settingChips: document.querySelector('#setting-chips'),
  chatScroll: document.querySelector('#chat-scroll'),
  chatStream: document.querySelector('#chat-stream'),
  accountBtn: document.querySelector('#account-btn'),
  accountDialog: document.querySelector('#account-dialog'),
  accountForm: document.querySelector('#account-form'),
  accountUserName: document.querySelector('#account-user-name'),
  accountGeminiProfile: document.querySelector('#account-gemini-profile'),
  accountSummary: document.querySelector('#account-summary'),
  accountSaveBtn: document.querySelector('#account-save-btn'),
  accountGeminiLoginBtn: document.querySelector('#account-gemini-login-btn'),
  accountCreateGeminiBtn: document.querySelector('#account-create-gemini-btn'),
  accountDeleteBtn: document.querySelector('#account-delete-btn'),
  accountCloseBtn: document.querySelector('#account-close-btn'),
  settingsDialog: document.querySelector('#settings-dialog'),
  settingsDialogTitle: document.querySelector('#settings-dialog-title'),
  settingsForm: document.querySelector('#settings-form'),
  saveSettingsBtn: document.querySelector('#save-settings-btn'),
  closeSettingsBtn: document.querySelector('#close-settings-btn'),
  dependencyStatusText: document.querySelector('#dependency-status-text'),
  dependencyStatusDetail: document.querySelector('#dependency-status-detail'),
  refreshDepsBtn: document.querySelector('#refresh-deps-btn'),
  repairDepsBtn: document.querySelector('#repair-deps-btn'),
  openPythonDownloadBtn: document.querySelector('#open-python-download-btn'),
  openGitBashDownloadBtn: document.querySelector('#open-gitbash-download-btn'),
  voiceCloneDialog: document.querySelector('#voice-clone-dialog'),
  voiceCloneDialogTitle: document.querySelector('#voice-clone-dialog-title'),
  voiceCloneForm: document.querySelector('#voice-clone-form'),
  voiceCloneRunBtn: document.querySelector('#voice-clone-run-btn'),
  voiceCloneCloseBtn: document.querySelector('#voice-clone-close-btn'),
  voiceClonePickSampleBtn: document.querySelector('#voice-clone-pick-sample-btn'),
  voiceCloneProgressStep: document.querySelector('#voice-clone-progress-step'),
  voiceCloneProgressPercent: document.querySelector('#voice-clone-progress-percent'),
  voiceCloneProgressBar: document.querySelector('#voice-clone-progress-bar'),
  voiceCloneProgressLog: document.querySelector('#voice-clone-progress-log'),
  remoteDialog: document.querySelector('#remote-dialog'),
  remoteStatusText: document.querySelector('#remote-status-text'),
  remoteUrlList: document.querySelector('#remote-url-list'),
  remotePublicUrl: document.querySelector('#remote-public-url'),
  copyRemoteLocalBtn: document.querySelector('#copy-remote-local-btn'),
  copyRemotePublicBtn: document.querySelector('#copy-remote-public-btn'),
  remoteQrImage: document.querySelector('#remote-qr-image'),
  remoteQrEmpty: document.querySelector('#remote-qr-empty'),
  toggleRemoteBtn: document.querySelector('#toggle-remote-btn'),
  refreshRemoteBtn: document.querySelector('#refresh-remote-btn'),
  closeRemoteBtn: document.querySelector('#close-remote-btn')
};

const state = {
  app: null,
  activeUser: null,
  users: [],
  geminiProfiles: [],
  settings: null,
  history: [],
  progress: {
    running: false,
    tasks: [],
    queueTasks: []
  },
  startup: null,
  dependencies: null,
  remote: null,
  runtimeHint: '',
  taskPreview: {
    count: 0,
    items: [],
    error: '',
    empty: true
  },
  voiceClone: {
    running: false,
    status: 'idle',
    step: '等待开始',
    percent: 0,
    logs: []
  },
  pendingBatches: [],
  chatVisibleCount: 20,
  remoteQrValue: '',
  remoteQrDataUrl: '',
  optimisticUserId: '',
  loadingUserId: '',
  userAction: null
};

const SERVICE_LABELS = {
  videoChannel: '视频号',
  douyin: '抖音',
  gemini: 'Gemini'
};

let taskPreviewTimer = null;
let taskPreviewSeq = 0;
let settingsUpdateQueue = Promise.resolve();
let switchUserDebounceTimer = null;
let switchUserSeq = 0;
let startupCheckSeq = 0;

function compactMessage(input, maxLength = 180) {
  return String(input || '')
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}

function clone(value) {
  return structuredClone(value);
}

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') {
    return target;
  }

  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      target[key] = value.slice();
      continue;
    }
    if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      deepMerge(target[key], value);
      continue;
    }
    target[key] = value;
  }

  return target;
}

function mergeStateSettings(patch = {}) {
  state.settings = deepMerge(clone(state.settings || {}), patch);
}

function escapeHtml(input = '') {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(value) {
  if (!value) {
    return '--';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${m}月${d}日 ${hh}:${mm}`;
}

function formatDay(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${month}月${day}日`;
}

function statusText(status) {
  const map = {
    queued: '等待',
    pending: '等待',
    running: '执行中',
    completed: '完成',
    failed: '失败',
    stopped: '已停止',
    partial_failed: '部分失败'
  };
  return map[status] || status;
}

function getGeminiProfileLabel() {
  const profile = (state.geminiProfiles || []).find((item) => item.id === state.activeUser?.geminiProfileId);
  return profile?.name || '默认 Gemini';
}

function getLoginReady(serviceKey) {
  return Boolean(state.startup?.type === 'result' && state.startup.result?.loginState?.[serviceKey]?.loggedIn);
}

function renderIconButtonMarkup(src, label) {
  return `<img src="${escapeHtml(src)}" alt="" /><span class="sr-only">${escapeHtml(label)}</span>`;
}

function normalizeHexColor(value, fallback) {
  const input = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(input) ? input.toUpperCase() : fallback;
}

function getDisplayedActiveUser() {
  if (!state.optimisticUserId) {
    return state.activeUser;
  }
  return state.users.find((user) => user.id === state.optimisticUserId) || state.activeUser;
}

function applyAppState(snapshot = {}) {
  state.app = snapshot.app || state.app;
  state.activeUser = snapshot.activeUser || state.activeUser;
  state.users = snapshot.users || state.users;
  state.geminiProfiles = snapshot.geminiProfiles || state.geminiProfiles;
  state.settings = snapshot.settings || state.settings;
  state.history = snapshot.history || state.history;
  state.progress = snapshot.progress || state.progress;
  state.remote = snapshot.remote || state.remote;
  state.dependencies = snapshot.dependencies || state.dependencies;
  reconcilePendingBatches();
}

function reconcilePendingBatches() {
  const completedRunIds = new Set((state.history || []).map((run) => run.id));
  state.pendingBatches = state.pendingBatches.filter((item) => !completedRunIds.has(item.runId));
}

function appendPendingBatch(payload = {}) {
  const runId = String(payload.runId || '').trim();
  const inputText = String(payload.inputText || '').trim();
  if (!runId || !inputText || !state.activeUser?.id) {
    return;
  }
  state.pendingBatches.push({
    runId,
    userId: state.activeUser.id,
    userName: state.activeUser.name,
    inputText,
    createdAt: new Date().toISOString()
  });
  reconcilePendingBatches();
}

function renderAppInfo() {
  const app = state.app;
  if (!app) {
    return;
  }
  const platform = /mac/i.test(navigator.platform || navigator.userAgent)
    ? 'darwin'
    : (/win/i.test(navigator.platform || navigator.userAgent) ? 'win32' : 'other');
  document.body.dataset.platform = platform;
  document.title = app.displayName || app.name || '搬运蚁';
  if (el.appBadge) {
    el.appBadge.textContent = `${app.name || 'antbot'} v${app.version || '0.0.0'}`;
  }
  if (el.settingsDialogTitle) {
    el.settingsDialogTitle.textContent = `${app.displayName || app.name || '搬运蚁'} 设置`;
  }
  if (el.voiceCloneDialogTitle) {
    el.voiceCloneDialogTitle.textContent = `${app.displayName || app.name || '搬运蚁'} 语音克隆`;
  }
  if (el.settingsBtn) {
    el.settingsBtn.innerHTML = renderIconButtonMarkup(FIGMA_ASSETS.icons.settings, '设置');
  }
  if (el.remoteBtn) {
    el.remoteBtn.innerHTML = renderIconButtonMarkup(FIGMA_ASSETS.icons.remote, '远程控制');
    el.remoteBtn.classList.toggle('is-active', Boolean(state.remote?.server?.enabled));
  }
  if (el.runBtn) {
    el.runBtn.innerHTML = renderIconButtonMarkup(FIGMA_ASSETS.icons.send, '发送任务');
  }
}

function renderStartupStatus() {
  if (!el.startupStatus) {
    return;
  }

  if (!state.startup) {
    el.startupStatus.textContent = state.runtimeHint || '等待启动检查';
    return;
  }

  if (state.startup.type === 'log') {
    el.startupStatus.textContent = compactMessage(state.startup.message || state.runtimeHint || '等待启动检查', 220);
    return;
  }

  const result = state.startup.result || {};
  const loginState = result.loginState || {};
  const parts = [];
  parts.push(`平台:${loginState.videoChannel?.loggedIn || loginState.douyin?.loggedIn ? '已就绪' : '未就绪'}`);
  parts.push(`视频号:${loginState.videoChannel?.loggedIn ? '已登录' : '未登录'}`);
  parts.push(`抖音:${loginState.douyin?.loggedIn ? '已登录' : '未登录'}`);
  parts.push(`语音克隆:${result.voiceCloneReady ? '已完成' : '未完成'}`);
  parts.push(`Gemini:${getGeminiProfileLabel()}`);
  if (state.runtimeHint) {
    parts.push(state.runtimeHint);
  }
  el.startupStatus.textContent = parts.join(' | ');

  if (el.videoLoginBtn) {
    const ready = getLoginReady('videoChannel');
    el.videoLoginBtn.innerHTML = renderIconButtonMarkup(
      ready ? FIGMA_ASSETS.icons.videoOn : FIGMA_ASSETS.icons.videoOff,
      `视频号${ready ? '已登录' : '未登录'}`
    );
    el.videoLoginBtn.classList.toggle('is-connected', ready);
    el.videoLoginBtn.title = ready ? '视频号已登录，点击重新登录' : '登录视频号';
  }

  if (el.douyinLoginBtn) {
    const ready = getLoginReady('douyin');
    el.douyinLoginBtn.innerHTML = renderIconButtonMarkup(
      ready ? FIGMA_ASSETS.icons.douyinOn : FIGMA_ASSETS.icons.douyinOff,
      `抖音${ready ? '已登录' : '未登录'}`
    );
    el.douyinLoginBtn.classList.toggle('is-connected', ready);
    el.douyinLoginBtn.title = ready ? '抖音已登录，点击重新登录' : '登录抖音';
  }

  if (el.accountBtn) {
    el.accountBtn.innerHTML = renderIconButtonMarkup(FIGMA_ASSETS.icons.more, '当前用户设置');
    el.accountBtn.title = '当前用户设置';
  }

  if (el.geminiLoginBtn) {
    const label = compactMessage(getGeminiProfileLabel(), 18);
    el.geminiLoginBtn.textContent = `Gemini · ${label}`;
  }

  if (el.voiceCloneBtn) {
    const profileLabel = compactMessage(state.settings?.voiceClone?.profileName || state.settings?.voiceClone?.voiceId || '点击配置', 12);
    el.voiceCloneBtn.textContent = `音色 · ${profileLabel}`;
  }
}

function getLiveTaskCounts() {
  const counts = new Map();
  const items = [
    ...(Array.isArray(state.progress?.tasks) ? state.progress.tasks : []),
    ...(Array.isArray(state.progress?.queueTasks) ? state.progress.queueTasks : [])
  ];
  for (const item of items) {
    const userId = String(item.userId || '').trim();
    if (!userId) {
      continue;
    }
    counts.set(userId, (counts.get(userId) || 0) + (item.status === 'completed' || item.status === 'failed' ? 0 : 1));
  }
  return counts;
}

function renderUserList() {
  if (!el.userList) {
    return;
  }

  const users = Array.isArray(state.users) ? state.users : [];
  const liveCounts = getLiveTaskCounts();
  const displayedActiveId = state.optimisticUserId || state.activeUser?.id || '';
  const loadingUserId = state.loadingUserId;
  el.userList.innerHTML = users.map((user) => {
    const liveCount = liveCounts.get(user.id) || 0;
    const isActive = user.id === displayedActiveId;
    const isPending = user.id === loadingUserId;
    const summary = isPending
      ? '切换中...'
      : (liveCount ? `当前：${liveCount}` : '无任务');
    const avatarSrc = FIGMA_ASSETS.avatars[Number(user.avatarId || 1)] || FIGMA_ASSETS.avatars[1];
    return `
      <button
        class="user-card ${isActive ? 'active' : ''} ${isPending ? 'pending' : ''}"
        type="button"
        data-user-switch="${escapeHtml(user.id)}"
        aria-pressed="${isActive ? 'true' : 'false'}"
        aria-busy="${isPending ? 'true' : 'false'}"
      >
        <div class="user-avatar-frame">
          <img class="user-avatar-image" src="${escapeHtml(avatarSrc)}" alt="" />
        </div>
        <div class="user-card-main">
          <div class="user-card-head">
            <span class="user-card-name">${escapeHtml(user.name)}</span>
            <span class="user-card-count">${escapeHtml(summary)}</span>
          </div>
          <div class="user-card-meta">历史任务：${user.historyCount || 0}</div>
        </div>
      </button>
    `;
  }).join('');

  if (el.addUserBtn) {
    el.addUserBtn.disabled = users.length >= 5 || Boolean(state.userAction);
    el.addUserBtn.textContent = users.length >= 5 ? '已达 5 个用户上限' : '添加用户';
  }
}

function renderSettingChips() {
  if (!el.settingChips || !state.settings) {
    return;
  }

  const voiceSpeed = Number(state.settings.style?.voiceSpeed ?? 1.1).toFixed(1);
  const voiceProfile = compactMessage(state.settings.voiceClone?.profileName || state.settings.voiceClone?.voiceId || '点击配置', 12);
  const retries = Math.max(0, Number(state.settings.retry?.failedTaskRetries ?? 0));
  const voiceoverEnabled = state.settings.style?.voiceoverEnabled !== false;
  const subtitleEnabled = voiceoverEnabled && state.settings.style?.subtitleEnabled !== false;
  const publishEnabled = state.settings.publish?.enabled !== false;
  const subtitleColor = normalizeHexColor(state.settings.style?.subtitleTextColor, '#FFA100');
  const strokeColor = normalizeHexColor(state.settings.style?.subtitleStrokeColor, '#000000');

  el.settingChips.innerHTML = `
    <div class="quick-control theme-blue quick-stepper">
      <span class="quick-control-label">语速</span>
      <div class="quick-stepper-controls">
        <button class="quick-step-btn" type="button" data-setting-step="voiceSpeed" data-direction="-1">-</button>
        <span class="quick-control-value">${escapeHtml(voiceSpeed)}</span>
        <button class="quick-step-btn" type="button" data-setting-step="voiceSpeed" data-direction="1">+</button>
      </div>
    </div>
    <button class="quick-control theme-amber quick-action" type="button" data-setting-action="voiceClone">
      <span class="quick-control-label">音色</span>
      <span class="quick-control-value">${escapeHtml(voiceProfile)}</span>
    </button>
    <div class="quick-control theme-red quick-stepper">
      <span class="quick-control-label">重试次数</span>
      <div class="quick-stepper-controls">
        <button class="quick-step-btn" type="button" data-setting-step="retryCount" data-direction="-1">-</button>
        <span class="quick-control-value">${escapeHtml(String(retries))}</span>
        <button class="quick-step-btn" type="button" data-setting-step="retryCount" data-direction="1">+</button>
      </div>
    </div>
    <button class="quick-control theme-green quick-toggle" type="button" data-setting-toggle="voiceoverEnabled">
      <span class="quick-control-label">旁白语音</span>
      <strong>${voiceoverEnabled ? '开' : '关'}</strong>
    </button>
    <button class="quick-control theme-slate quick-toggle ${voiceoverEnabled ? '' : 'is-disabled'}" type="button" data-setting-toggle="subtitleEnabled"${voiceoverEnabled ? '' : ' disabled'}>
      <span class="quick-control-label">字幕</span>
      <strong>${subtitleEnabled ? '开' : '关'}</strong>
    </button>
    <button class="quick-control theme-orange quick-toggle" type="button" data-setting-toggle="publishEnabled">
      <span class="quick-control-label">自动发布</span>
      <strong>${publishEnabled ? '开' : '关'}</strong>
    </button>
    <label class="quick-control theme-white quick-color">
      <span class="quick-control-label">字幕颜色</span>
      <input class="quick-color-input" type="color" value="${escapeHtml(subtitleColor)}" data-setting-color="subtitleTextColor" />
    </label>
    <label class="quick-control theme-white quick-color">
      <span class="quick-control-label">描边颜色</span>
      <input class="quick-color-input" type="color" value="${escapeHtml(strokeColor)}" data-setting-color="subtitleStrokeColor" />
    </label>
  `;
}

function renderTaskSummary() {
  if (!el.taskSummary) {
    return;
  }
  const preview = state.taskPreview;
  el.taskSummary.classList.toggle('error', Boolean(preview.error));

  if (preview.error) {
    el.taskSummary.textContent = preview.error;
    return;
  }

  if (preview.empty) {
    el.taskSummary.textContent = state.runtimeHint || '等待输入任务';
    return;
  }

  const head = `已识别 ${preview.count} 条任务`;
  const detail = preview.items.map((item) => {
    const tags = [];
    if (item.publishAt) {
      tags.push(formatDate(item.publishAt));
    }
    if (item.platforms?.length) {
      tags.push(item.platforms.join('/'));
    }
    if (item.isOriginal) {
      tags.push('原创');
    }
    return `${item.taskName}${tags.length ? ` · ${tags.join(' · ')}` : ''}`;
  }).join(' | ');

  el.taskSummary.textContent = detail ? `${head}。${detail}` : head;
}

async function refreshTaskPreview() {
  const raw = el.taskInput?.value?.trim() || '';
  const seq = ++taskPreviewSeq;
  if (!raw) {
    state.taskPreview = {
      count: 0,
      items: [],
      error: '',
      empty: true
    };
    renderTaskSummary();
    return;
  }

  try {
    const parsed = await window.antbot.parseTasks(raw);
    if (seq !== taskPreviewSeq) {
      return;
    }
    state.taskPreview = {
      count: parsed.length,
      items: parsed.slice(0, 3),
      error: parsed.length ? '' : '未识别到有效任务，请检查输入格式。',
      empty: false
    };
  } catch (error) {
    if (seq !== taskPreviewSeq) {
      return;
    }
    state.taskPreview = {
      count: 0,
      items: [],
      error: compactMessage(error?.message || '任务解析失败，请检查输入。', 120),
      empty: false
    };
  }

  renderTaskSummary();
}

function queueTaskPreview() {
  if (taskPreviewTimer) {
    clearTimeout(taskPreviewTimer);
  }
  taskPreviewTimer = setTimeout(() => {
    refreshTaskPreview().catch(() => {});
  }, 160);
}

function autosizeTaskInput() {
  if (!el.taskInput) {
    return;
  }
  el.taskInput.style.height = 'auto';
  const nextHeight = Math.max(92, Math.min(el.taskInput.scrollHeight, 190));
  el.taskInput.style.height = `${nextHeight}px`;
}

function queueSettingsPatch(patch, successHint = '') {
  if (!patch || typeof patch !== 'object') {
    return settingsUpdateQueue;
  }

  mergeStateSettings(patch);
  renderSettingChips();

  settingsUpdateQueue = settingsUpdateQueue
    .then(async () => {
      state.settings = await window.antbot.updateSettings(patch);
      if (successHint) {
        state.runtimeHint = successHint;
        renderStartupStatus();
      }
      renderSettingChips();
      fillSettingsForm();
      return state.settings;
    })
    .catch((error) => {
      alert(`更新参数失败：${error.message}`);
      return refreshAppState();
    });

  return settingsUpdateQueue;
}

function updateQuickStep(settingKey, direction) {
  if (!state.settings) {
    return;
  }

  if (settingKey === 'voiceSpeed') {
    const current = Number(state.settings.style?.voiceSpeed ?? 1.1);
    const next = Math.max(0.5, Math.min(2, Math.round((current + direction * 0.1) * 10) / 10));
    if (next !== current) {
      void queueSettingsPatch({ style: { voiceSpeed: next } }, `语速已调整为 ${next.toFixed(1)}`);
    }
    return;
  }

  if (settingKey === 'retryCount') {
    const current = Math.max(0, Number(state.settings.retry?.failedTaskRetries ?? 0));
    const next = Math.max(0, Math.min(20, current + direction));
    if (next !== current) {
      void queueSettingsPatch({ retry: { failedTaskRetries: next } }, `失败重试次数已调整为 ${next}`);
    }
  }
}

function toggleQuickSetting(settingKey) {
  if (!state.settings) {
    return;
  }

  if (settingKey === 'voiceoverEnabled') {
    const next = !(state.settings.style?.voiceoverEnabled !== false);
    void queueSettingsPatch({
      style: {
        voiceoverEnabled: next,
        subtitleEnabled: next ? (state.settings.style?.subtitleEnabled !== false) : false
      }
    }, `旁白语音已${next ? '开启' : '关闭'}`);
    return;
  }

  if (settingKey === 'subtitleEnabled') {
    if (state.settings.style?.voiceoverEnabled === false) {
      return;
    }
    const next = !(state.settings.style?.subtitleEnabled !== false);
    void queueSettingsPatch({ style: { subtitleEnabled: next } }, `字幕已${next ? '开启' : '关闭'}`);
    return;
  }

  if (settingKey === 'publishEnabled') {
    const next = !(state.settings.publish?.enabled !== false);
    void queueSettingsPatch({ publish: { enabled: next } }, `自动发布已${next ? '开启' : '关闭'}`);
  }
}

function updateQuickColor(settingKey, value) {
  const next = normalizeHexColor(value, settingKey === 'subtitleTextColor' ? '#FFA100' : '#000000');
  if (!next || !state.settings) {
    return;
  }
  void queueSettingsPatch({
    style: {
      [settingKey]: next
    }
  }, `${settingKey === 'subtitleTextColor' ? '字幕颜色' : '描边颜色'}已更新`);
}

function updateVoiceCloneProgress(payload = {}) {
  if (typeof payload.percent === 'number' && Number.isFinite(payload.percent)) {
    state.voiceClone.percent = Math.max(0, Math.min(100, Math.round(payload.percent)));
  }
  if (typeof payload.step === 'string' && payload.step.trim()) {
    state.voiceClone.step = payload.step.trim();
  }
  if (typeof payload.status === 'string' && payload.status.trim()) {
    state.voiceClone.status = payload.status.trim();
  }
  if (typeof payload.running === 'boolean') {
    state.voiceClone.running = payload.running;
  }
  if (typeof payload.message === 'string' && payload.message.trim()) {
    state.voiceClone.logs.push(payload.message.trim());
    state.voiceClone.logs = state.voiceClone.logs.slice(-16);
  }
  renderVoiceCloneProgress();
}

function renderVoiceCloneProgress() {
  if (!el.voiceCloneProgressStep) {
    return;
  }
  const percent = state.voiceClone.percent || 0;
  el.voiceCloneProgressStep.textContent = state.voiceClone.step || '等待开始';
  el.voiceCloneProgressPercent.textContent = `${percent}%`;
  el.voiceCloneProgressBar.style.width = `${percent}%`;
  el.voiceCloneProgressLog.textContent = state.voiceClone.logs.length
    ? state.voiceClone.logs.join('\n')
    : '暂无日志';
  el.voiceCloneRunBtn.disabled = Boolean(state.voiceClone.running);
}

function fillSettingsForm() {
  const settings = state.settings;
  if (!settings || !el.settingsForm) {
    return;
  }

  const form = el.settingsForm;
  form.tempDir.value = settings.paths.tempDir || '';
  form.outputBaseDir.value = settings.paths.outputBaseDir || '';
  form.youtubeProjectPath.value = settings.paths.youtubeProjectPath || '';
  form.editProjectPath.value = settings.paths.editProjectPath || '';
  form.publishProjectPath.value = settings.paths.publishProjectPath || '';
  form.downloadCmd.value = settings.commands.download || '';
  form.geminiCmd.value = settings.commands.gemini || '';
  form.geminiSubtitleUrl.value = settings.subtitle?.geminiUrl || '';
  form.editCmd.value = settings.commands.edit || '';
  form.publishCmd.value = settings.commands.publish || '';
  form.voiceCloneCmd.value = settings.commands.voiceClone || '';
  form.voiceSpeed.value = settings.style.voiceSpeed ?? 1.1;
  form.voiceoverEnabled.value = String(settings.style.voiceoverEnabled !== false);
  form.subtitleEnabled.value = String(settings.style.subtitleEnabled !== false);
  form.subtitleTextColor.value = settings.style.subtitleTextColor || '#FFA100';
  form.subtitleStrokeColor.value = settings.style.subtitleStrokeColor || '#000000';
  form.subtitlePositionPercent.value = settings.style.subtitlePositionPercent ?? 12;
  form.pauseBetweenTasksMs.value = settings.browser.pauseBetweenTasksMs ?? 2500;
  form.actionDelayMs.value = settings.browser.actionDelayMs ?? 1500;
  form.showAutomationWindow.value = String(Boolean(settings.browser.showAutomationWindow));
  form.publishEnabled.value = String(settings.publish?.enabled !== false);
  form.failedRetryCount.value = settings.retry?.failedTaskRetries ?? 0;
  form.voiceId.value = settings.voiceClone.voiceId || '';
  form.modelPath.value = settings.voiceClone.modelPath || '';
  syncNarrationToggles();
}

function readSettingsForm() {
  const form = el.settingsForm;
  const voiceoverEnabled = form.voiceoverEnabled.value === 'true';
  return {
    paths: {
      tempDir: form.tempDir.value.trim(),
      outputBaseDir: form.outputBaseDir.value.trim(),
      youtubeProjectPath: form.youtubeProjectPath.value.trim(),
      editProjectPath: form.editProjectPath.value.trim(),
      publishProjectPath: form.publishProjectPath.value.trim()
    },
    commands: {
      download: form.downloadCmd.value.trim(),
      gemini: form.geminiCmd.value.trim(),
      edit: form.editCmd.value.trim(),
      publish: form.publishCmd.value.trim(),
      voiceClone: form.voiceCloneCmd.value.trim()
    },
    subtitle: {
      geminiUrl: form.geminiSubtitleUrl.value.trim()
    },
    style: {
      voiceSpeed: Number(form.voiceSpeed.value || 1.1),
      voiceoverEnabled,
      subtitleEnabled: voiceoverEnabled && form.subtitleEnabled.value === 'true',
      subtitleTextColor: form.subtitleTextColor.value.trim() || '#FFA100',
      subtitleStrokeColor: form.subtitleStrokeColor.value.trim() || '#000000',
      subtitlePositionPercent: Math.max(0, Math.min(100, Number(form.subtitlePositionPercent.value || 12)))
    },
    browser: {
      pauseBetweenTasksMs: Number(form.pauseBetweenTasksMs.value || 2500),
      actionDelayMs: Number(form.actionDelayMs.value || 1500),
      showAutomationWindow: form.showAutomationWindow.value === 'true'
    },
    publish: {
      platform: state.settings?.publish?.platform || '视频号',
      enabled: form.publishEnabled.value === 'true'
    },
    retry: {
      failedTaskRetries: Math.max(0, Number(form.failedRetryCount.value || 0))
    },
    voiceClone: {
      voiceId: form.voiceId.value.trim(),
      modelPath: form.modelPath.value.trim(),
      samplePath: state.settings?.voiceClone?.samplePath || '',
      referenceText: state.settings?.voiceClone?.referenceText || '',
      profileName: state.settings?.voiceClone?.profileName || '',
      language: state.settings?.voiceClone?.language || 'zh'
    }
  };
}

function syncNarrationToggles() {
  const form = el.settingsForm;
  if (!form?.voiceoverEnabled || !form?.subtitleEnabled) {
    return;
  }
  const voiceoverOn = form.voiceoverEnabled.value === 'true';
  form.subtitleEnabled.disabled = !voiceoverOn;
  if (!voiceoverOn) {
    form.subtitleEnabled.value = 'false';
  }
}

function fillVoiceCloneForm() {
  if (!state.settings || !el.voiceCloneForm) {
    return;
  }
  const voice = state.settings.voiceClone || {};
  el.voiceCloneForm.samplePath.value = voice.samplePath || '';
  el.voiceCloneForm.referenceText.value = voice.referenceText || '';
  el.voiceCloneForm.profileName.value = voice.profileName || '';
  el.voiceCloneForm.language.value = voice.language || 'zh';
}

function readVoiceCloneForm() {
  const form = el.voiceCloneForm;
  return {
    samplePath: form.samplePath.value.trim(),
    referenceText: form.referenceText.value.trim(),
    profileName: form.profileName.value.trim(),
    language: form.language.value.trim() || 'zh'
  };
}

function renderAccountDialog() {
  if (!state.activeUser || !el.accountForm) {
    return;
  }
  el.accountUserName.value = state.activeUser.name || '';
  el.accountGeminiProfile.innerHTML = (state.geminiProfiles || [])
    .map((profile) => `
      <option value="${escapeHtml(profile.id)}"${profile.id === state.activeUser?.geminiProfileId ? ' selected' : ''}>
        ${escapeHtml(profile.name)}${profile.id === 'default' ? '（默认）' : ''}
      </option>
    `)
    .join('');
  el.accountGeminiProfile.value = state.activeUser?.geminiProfileId || 'default';
  updateAccountSummary();
  el.accountDeleteBtn.disabled = (state.users || []).length <= 1 || Boolean(state.progress?.running);
}

function updateAccountSummary() {
  const selectedProfile = (state.geminiProfiles || []).find((item) => item.id === el.accountGeminiProfile.value)
    || state.geminiProfiles[0];
  el.accountSummary.textContent = selectedProfile
    ? `当前用户引用：${selectedProfile.name}`
    : '当前用户默认引用默认 Gemini。';
}

function getPrimaryLocalRemoteUrl() {
  const urls = Array.isArray(state.remote?.server?.urls) ? state.remote.server.urls : [];
  return urls.find((url) => !/127\.0\.0\.1|localhost/.test(url)) || urls[0] || '';
}

async function renderRemoteQr(text) {
  const value = String(text || '').trim();
  if (!value) {
    state.remoteQrValue = '';
    state.remoteQrDataUrl = '';
    el.remoteQrImage.classList.add('hidden');
    el.remoteQrImage.removeAttribute('src');
    el.remoteQrEmpty.classList.remove('hidden');
    el.remoteQrEmpty.textContent = '开启远程后显示二维码';
    return;
  }

  if (state.remoteQrValue !== value) {
    state.remoteQrValue = value;
    state.remoteQrDataUrl = await window.antbot.makeQrDataUrl(value);
  }

  if (!state.remoteQrDataUrl) {
    el.remoteQrImage.classList.add('hidden');
    el.remoteQrEmpty.classList.remove('hidden');
    el.remoteQrEmpty.textContent = '二维码生成失败';
    return;
  }

  el.remoteQrImage.src = state.remoteQrDataUrl;
  el.remoteQrImage.classList.remove('hidden');
  el.remoteQrEmpty.classList.add('hidden');
}

function renderRemoteStatus() {
  if (!el.remoteStatusText) {
    return;
  }

  const server = state.remote?.server;
  if (!server) {
    el.remoteStatusText.textContent = '未加载';
    el.remoteUrlList.textContent = '保存后显示';
    el.remotePublicUrl.textContent = '未开启';
    el.toggleRemoteBtn.textContent = '开启公网 + 内网';
    el.remoteBtn?.classList.remove('is-active');
    void renderRemoteQr('');
    return;
  }

  if (server.enabled && server.online) {
    el.remoteStatusText.textContent = `已开启 · 端口 ${server.port}`;
  } else if (server.enabled && server.lastError) {
    el.remoteStatusText.textContent = server.lastError;
  } else {
    el.remoteStatusText.textContent = '未开启';
  }

  const urls = Array.isArray(server.urls) ? server.urls : [];
  el.remoteUrlList.innerHTML = urls.length
    ? urls.map((url) => `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`).join('')
    : '未开启';

  const publicInfo = server.public || {};
  if (publicInfo.online && publicInfo.url) {
    el.remotePublicUrl.innerHTML = `<a href="${escapeHtml(publicInfo.url)}" target="_blank" rel="noreferrer">${escapeHtml(publicInfo.url)}</a>`;
  } else {
    el.remotePublicUrl.textContent = publicInfo.lastError || '未开启';
  }

  el.copyRemoteLocalBtn.disabled = !urls.length;
  el.copyRemotePublicBtn.disabled = !(publicInfo.online && publicInfo.url);
  el.toggleRemoteBtn.textContent = server.enabled ? '关闭远程' : '开启公网 + 内网';
  el.remoteBtn?.classList.toggle('is-active', Boolean(server.enabled));

  const qrValue = publicInfo.online && publicInfo.url ? publicInfo.url : getPrimaryLocalRemoteUrl();
  void renderRemoteQr(qrValue);
}

function renderDependencyStatus() {
  if (!el.dependencyStatusText || !el.dependencyStatusDetail) {
    return;
  }
  const dependencies = state.dependencies;
  if (!dependencies?.items) {
    el.dependencyStatusText.textContent = '未检查';
    el.dependencyStatusDetail.textContent = '点击“检查环境”查看当前依赖状态。';
    return;
  }

  const items = Object.values(dependencies.items);
  const missingRequired = items.filter((item) => item.required && !item.found);
  const missingOptional = items.filter((item) => !item.required && !item.found);
  const managed = items.filter((item) => item.managed).map((item) => item.label);

  el.dependencyStatusText.textContent = missingRequired.length ? `缺少 ${missingRequired.length} 项核心依赖` : '核心依赖已就绪';
  el.dependencyStatusDetail.textContent = [
    items.map((item) => `${item.label}:${item.found ? '已就绪' : (item.autoInstallSupported ? '缺失，可自动下载' : '未检测到')}`).join(' | '),
    managed.length ? `受管目录已提供：${managed.join('、')}` : '',
    missingOptional.length ? `可选依赖未检测到：${missingOptional.map((item) => item.label).join('、')}` : ''
  ].filter(Boolean).join('。');
}

function isChatNearBottom() {
  if (!el.chatScroll) {
    return true;
  }
  return el.chatScroll.scrollHeight - el.chatScroll.scrollTop - el.chatScroll.clientHeight < 80;
}

function scrollChatToBottom() {
  if (!el.chatScroll) {
    return;
  }
  requestAnimationFrame(() => {
    el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
  });
}

function renderTaskCard(task, options = {}) {
  const status = task.status || 'pending';
  const live = Boolean(options.live);
  const canStop = live && ['queued', 'pending', 'running'].includes(status);
  const canResume = status === 'stopped';
  const progress = Math.max(0, Math.min(100, Number(task.progress || 0)));
  const titlePrefix = typeof task.index === 'number' ? `任务${task.index}：` : '任务：';
  const statusIcon = status === 'failed'
    ? `<img class="task-status-icon" src="${escapeHtml(FIGMA_ASSETS.icons.taskFailed)}" alt="" />`
    : status === 'stopped'
      ? `<img class="task-status-icon" src="${escapeHtml(FIGMA_ASSETS.icons.taskStopped)}" alt="" />`
      : '';
  return `
    <div class="task-row ${escapeHtml(status)}">
      <div class="task-top">
        <div class="task-title-block">
          <div class="task-title">${escapeHtml(titlePrefix)}${escapeHtml(task.taskName || '未命名任务')}</div>
          <div class="task-status-note">${escapeHtml(task.message || task.step || '等待执行')}</div>
        </div>
        <div class="task-top-meta">
          <div class="task-status">${escapeHtml(statusText(status))}</div>
          ${statusIcon}
        </div>
      </div>
      <div class="task-progress">
        <div class="task-progress-bar" style="width:${progress}%"></div>
      </div>
      <div class="task-detail">
        <span>${escapeHtml(task.platforms?.join(' / ') || task.publishMode || '任务状态')}</span>
        <span>${escapeHtml(task.retryCount ? `重试${task.retryCount}次` : statusText(status))}</span>
      </div>
      ${(canStop || canResume) ? `
        <div class="task-actions">
          ${canStop ? `<button class="task-mini-btn stop" type="button" data-task-stop="${escapeHtml(task.id)}">停止</button>` : ''}
          ${canResume ? `<button class="task-mini-btn resume" type="button" data-task-resume="${escapeHtml(task.id)}">恢复</button>` : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function buildHistoryInput(run) {
  if (String(run.inputText || '').trim()) {
    return run.inputText;
  }
  const lines = (run.items || [])
    .map((item) => item.rawLine || item.taskName)
    .filter(Boolean);
  return lines.join('\n');
}

function renderHistoryRun(run) {
  const inputText = buildHistoryInput(run);
  const items = Array.isArray(run.items) ? run.items : [];
  const taskCards = items.length
    ? items.map((item) => renderTaskCard({
      ...item,
      taskName: item.taskName,
      status: item.status,
      progress: item.status === 'completed' ? 100 : 0,
      message: item.message || item.publishMode || statusText(item.status)
    }, { live: false })).join('')
    : '<div class="task-row completed"><div class="task-top"><div class="task-title">任务</div><div class="task-status">完成</div></div></div>';
  return `
    <div class="bubble-time">${escapeHtml(formatDate(run.startedAt))}</div>
    ${inputText ? `<div class="bubble user"><div class="bubble-content">${escapeHtml(inputText)}</div></div>` : ''}
    <div class="bubble system"><div class="task-stack">${taskCards}</div></div>
  `;
}

function buildLiveGroups() {
  const groups = new Map();
  const activeUserId = state.activeUser?.id;
  if (!activeUserId) {
    return [];
  }

  const liveTasks = [
    ...(Array.isArray(state.progress?.tasks) ? state.progress.tasks : []),
    ...(Array.isArray(state.progress?.queueTasks) ? state.progress.queueTasks : [])
  ].filter((task) => task.userId === activeUserId);

  for (const task of liveTasks) {
    const groupId = String(task.batchRunId || task.runId || task.id);
    if (!groups.has(groupId)) {
      groups.set(groupId, {
        id: groupId,
        createdAt: task.enqueuedAt || task.updatedAt || new Date().toISOString(),
        inputText: '',
        tasks: []
      });
    }
    groups.get(groupId).tasks.push(task);
  }

  for (const batch of state.pendingBatches.filter((item) => item.userId === activeUserId)) {
    if (!groups.has(batch.runId)) {
      groups.set(batch.runId, {
        id: batch.runId,
        createdAt: batch.createdAt,
        inputText: batch.inputText,
        tasks: []
      });
    }
    groups.get(batch.runId).inputText = batch.inputText;
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      tasks: group.tasks.sort((a, b) => (a.index || a.queueIndex || 0) - (b.index || b.queueIndex || 0)),
      inputText: group.inputText || group.tasks.map((task) => task.rawLine).filter(Boolean).join('\n') || group.tasks.map((task) => task.taskName).join('\n')
    }))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function renderLiveGroup(group) {
  const cards = group.tasks.length
    ? group.tasks.map((task) => renderTaskCard(task, { live: true })).join('')
    : '';
  return `
    <div class="bubble-time">${escapeHtml(formatDate(group.createdAt))}</div>
    ${group.inputText ? `<div class="bubble user"><div class="bubble-content">${escapeHtml(group.inputText)}</div></div>` : ''}
    ${cards ? `<div class="bubble system"><div class="task-stack">${cards}</div></div>` : ''}
  `;
}

function findHistoryTask(taskId) {
  const targetId = String(taskId || '').trim();
  for (const run of state.history || []) {
    for (const item of run.items || []) {
      if (String(item.taskId || '') === targetId) {
        return item;
      }
    }
  }
  return null;
}

function renderChat(options = {}) {
  if (!el.chatStream) {
    return;
  }

  const shouldStickBottom = Boolean(options.stickBottom);
  const visibleHistory = (state.history || []).slice(0, state.chatVisibleCount).reverse();
  const liveGroups = buildLiveGroups();
  const parts = [];
  let currentDay = '';

  for (const run of visibleHistory) {
    const day = formatDay(run.startedAt);
    if (day && day !== currentDay) {
      currentDay = day;
      parts.push(`<div class="chat-day">${escapeHtml(day)}</div>`);
    }
    parts.push(renderHistoryRun(run));
  }

  for (const group of liveGroups) {
    const day = formatDay(group.createdAt);
    if (day && day !== currentDay) {
      currentDay = day;
      parts.push(`<div class="chat-day">${escapeHtml(day)}</div>`);
    }
    parts.push(renderLiveGroup(group));
  }

  if (!parts.length) {
    el.chatStream.innerHTML = '<div class="empty-chat">当前用户还没有历史任务。输入内容后直接发送，历史会自动滚动保留。</div>';
  } else {
    el.chatStream.innerHTML = parts.join('');
  }

  if (shouldStickBottom) {
    scrollChatToBottom();
  }
}

async function copyTextToClipboard(text, successMessage) {
  const value = String(text || '').trim();
  if (!value) {
    alert('当前没有可复制的地址。');
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    state.runtimeHint = successMessage;
    renderStartupStatus();
  } catch {
    window.prompt('复制以下内容：', value);
  }
}

async function ensureStartupReady(options = {}) {
  const requireVoiceClone = options.requireVoiceClone !== false;
  if (state.startup?.type !== 'result') {
    await runStartupCheck();
    if (state.startup?.type !== 'result') {
      alert('请先完成启动检查。');
      return false;
    }
  }

  const loginState = state.startup.result.loginState || {};
  const videoReady = Boolean(loginState.videoChannel?.loggedIn);
  const douyinReady = Boolean(loginState.douyin?.loggedIn);
  if (!videoReady && !douyinReady) {
    alert('请先登录抖音或视频号（任一即可）。');
    return false;
  }

  if (requireVoiceClone && !state.startup.result.voiceCloneReady) {
    alert('语音克隆未完成，请先完成语音克隆或填写 voiceId。');
    return false;
  }

  return true;
}

async function runStartupCheck() {
  const seq = ++startupCheckSeq;
  state.runtimeHint = '';
  state.startup = {
    type: 'log',
    message: '正在进行启动检查...'
  };
  renderStartupStatus();
  try {
    const result = await window.antbot.checkStartup();
    if (seq !== startupCheckSeq) {
      return;
    }
    state.startup = {
      type: 'result',
      result
    };
  } catch (error) {
    if (seq !== startupCheckSeq) {
      return;
    }
    state.startup = {
      type: 'log',
      message: `启动检查失败：${compactMessage(error?.message, 160)}`
    };
  }
  renderStartupStatus();
}

async function refreshAppState(options = {}) {
  const snapshot = await window.antbot.getInitialState();
  applyAppState(snapshot);
  renderAll(options);
  return snapshot;
}

function renderAll(options = {}) {
  renderAppInfo();
  renderStartupStatus();
  renderUserList();
  renderSettingChips();
  renderTaskSummary();
  renderRemoteStatus();
  renderDependencyStatus();
  renderVoiceCloneProgress();
  fillSettingsForm();
  fillVoiceCloneForm();
  renderAccountDialog();
  if (el.currentUserName) {
    el.currentUserName.textContent = getDisplayedActiveUser()?.name || '蚂蚁1';
  }
  autosizeTaskInput();
  renderChat(options);
}

async function switchUser(userId) {
  if (!userId || userId === state.optimisticUserId || (userId === state.activeUser?.id && !state.loadingUserId)) {
    return;
  }
  const nextUser = (state.users || []).find((user) => user.id === userId);
  const seq = ++switchUserSeq;
  if (switchUserDebounceTimer) {
    clearTimeout(switchUserDebounceTimer);
  }

  state.optimisticUserId = userId;
  state.loadingUserId = userId;
  state.chatVisibleCount = 20;
  state.runtimeHint = nextUser ? `正在切换到 ${nextUser.name}...` : '正在切换用户...';
  renderUserList();
  renderStartupStatus();
  renderTaskSummary();
  if (el.currentUserName) {
    el.currentUserName.textContent = getDisplayedActiveUser()?.name || '蚂蚁1';
  }

  switchUserDebounceTimer = setTimeout(async () => {
    try {
      const snapshot = await window.antbot.switchUser(userId);
      if (seq !== switchUserSeq) {
        return;
      }
      state.optimisticUserId = '';
      state.loadingUserId = '';
      applyAppState(snapshot);
      renderAll({ stickBottom: true });
      queueTaskPreview();
      void runStartupCheck();
    } catch (error) {
      if (seq !== switchUserSeq) {
        return;
      }
      state.optimisticUserId = '';
      state.loadingUserId = '';
      state.runtimeHint = `切换用户失败：${compactMessage(error?.message, 120)}`;
      renderAll({ stickBottom: true });
      alert(`切换用户失败：${error.message}`);
    }
  }, 180);
}

async function createUser() {
  if ((state.users || []).length >= 5) {
    alert('最多只支持 5 个用户。');
    return;
  }
  const name = window.prompt('请输入新用户名，可留空自动命名：', '') ?? null;
  if (name === null) {
    return;
  }
  state.userAction = { type: 'create' };
  renderUserList();
  try {
    const created = await window.antbot.createUser(name.trim());
    const snapshot = await window.antbot.switchUser(created.id);
    applyAppState(snapshot);
    state.chatVisibleCount = 20;
    renderAll({ stickBottom: true });
    await runStartupCheck();
    state.runtimeHint = `已新增并切换到用户：${created.name}`;
    renderStartupStatus();
  } catch (error) {
    alert(`新增用户失败：${error.message}`);
  } finally {
    state.userAction = null;
    renderUserList();
  }
}

async function deleteCurrentUser() {
  if (!state.activeUser?.id) {
    return;
  }
  if ((state.users || []).length <= 1) {
    alert('至少保留一个用户。');
    return;
  }
  const confirmed = window.confirm(`确认删除当前用户“${state.activeUser.name}”？`);
  if (!confirmed) {
    return;
  }
  try {
    await window.antbot.deleteUser(state.activeUser.id);
    el.accountDialog.close();
    await refreshAppState({ stickBottom: true });
    await runStartupCheck();
  } catch (error) {
    alert(`删除用户失败：${error.message}`);
  }
}

async function saveAccountSettings() {
  if (!state.activeUser?.id) {
    return;
  }
  const nextName = el.accountUserName.value.trim();
  const nextGeminiProfileId = el.accountGeminiProfile.value;

  try {
    if (nextName && nextName !== state.activeUser.name) {
      await window.antbot.renameUser(nextName);
    }
    if (nextGeminiProfileId && nextGeminiProfileId !== state.settings?.geminiProfileId) {
      state.settings = await window.antbot.updateSettings({
        geminiProfileId: nextGeminiProfileId
      });
    }
    await refreshAppState();
    state.runtimeHint = '当前用户设置已保存。';
    renderStartupStatus();
    renderAccountDialog();
  } catch (error) {
    alert(`保存用户设置失败：${error.message}`);
  }
}

async function createGeminiProfile() {
  const name = window.prompt('请输入新的 Gemini 名称：', '') ?? null;
  if (name === null) {
    return;
  }
  try {
    const created = await window.antbot.createGeminiProfile(name.trim());
    state.geminiProfiles = await window.antbot.listGeminiProfiles();
    renderAccountDialog();
    el.accountGeminiProfile.value = created.id;
    updateAccountSummary();
  } catch (error) {
    alert(`新增 Gemini 失败：${error.message}`);
  }
}

async function openLoginAction(serviceKey, options = {}) {
  try {
    if (serviceKey === 'gemini' && options.profileId && options.profileId !== state.settings?.geminiProfileId) {
      state.settings = await window.antbot.updateSettings({
        geminiProfileId: options.profileId
      });
      renderAccountDialog();
    }
    await window.antbot.openLoginWindow(serviceKey);
    const label = SERVICE_LABELS[serviceKey] || serviceKey;
    const confirmed = window.confirm(`已打开 ${label} 登录窗口。完成登录后点击“确定”标记为已登录。`);
    if (confirmed) {
      await window.antbot.markLoginDone(serviceKey);
      await refreshAppState();
      await runStartupCheck();
    }
  } catch (error) {
    alert(`打开登录窗口失败：${error.message}`);
  }
}

async function startTasks() {
  const raw = el.taskInput.value.trim();
  if (!raw) {
    alert('请输入任务内容。');
    return;
  }
  if (!(await ensureStartupReady())) {
    return;
  }

  try {
    const parsed = await window.antbot.parseTasks(raw);
    if (!parsed.length) {
      alert('未识别到有效任务。');
      return;
    }
    const scheduled = await window.antbot.startTasks(raw);
    appendPendingBatch({
      runId: scheduled.runId,
      inputText: raw
    });
    el.taskInput.value = '';
    queueTaskPreview();
    state.runtimeHint = scheduled.queued
      ? `任务已排队，前方还有 ${Math.max(0, (scheduled.queuePosition || 1) - 1)} 条。`
      : `已发送 ${scheduled.taskCount || parsed.length} 条任务。`;
    renderTaskSummary();
    renderStartupStatus();
    renderChat({ stickBottom: true });
  } catch (error) {
    alert(`启动任务失败：${error.message}`);
  }
}

async function handleTaskControl(action, taskId) {
  try {
    if (action === 'stop') {
      await window.antbot.stopTask(taskId);
      state.runtimeHint = '任务已停止。';
    } else {
      const historyItem = findHistoryTask(taskId);
      await window.antbot.resumeTask({
        taskId,
        task: historyItem?.taskSnapshot || null
      });
      state.runtimeHint = '任务已恢复。';
    }
    renderStartupStatus();
  } catch (error) {
    alert(`${action === 'stop' ? '停止' : '恢复'}任务失败：${error.message}`);
  }
}

async function toggleRemote() {
  try {
    const enabling = !(state.settings?.remote?.enabled);
    state.settings = await window.antbot.updateSettings({
      remote: {
        enabled: enabling,
        publicMode: enabling ? 'cloudflare-quick' : 'off'
      }
    });
    state.runtimeHint = enabling
      ? '远程已开启，正在准备内网和公网访问地址...'
      : '远程访问已关闭。';
    state.remote = await window.antbot.getRemoteState();
    renderStartupStatus();
    renderRemoteStatus();
  } catch (error) {
    alert(`切换远程状态失败：${error.message}`);
  }
}

function handleChatScroll() {
  if (!el.chatScroll || el.chatScroll.scrollTop > 80 || state.chatVisibleCount >= state.history.length) {
    return;
  }
  const previousHeight = el.chatScroll.scrollHeight;
  const previousTop = el.chatScroll.scrollTop;
  state.chatVisibleCount = Math.min(state.chatVisibleCount + 20, state.history.length);
  renderChat();
  requestAnimationFrame(() => {
    const nextHeight = el.chatScroll.scrollHeight;
    el.chatScroll.scrollTop = nextHeight - previousHeight + previousTop;
  });
}

async function saveSettings() {
  try {
    state.settings = await window.antbot.updateSettings(readSettingsForm());
    el.settingsDialog.close();
    renderAll();
  } catch (error) {
    alert(`保存设置失败：${error.message}`);
  }
}

async function runVoiceClone() {
  const payload = readVoiceCloneForm();
  if (!payload.samplePath) {
    alert('请先选择样本音频。');
    return;
  }
  if (!payload.referenceText) {
    alert('请先填写样本参考文本。');
    return;
  }

  updateVoiceCloneProgress({
    running: true,
    status: 'running',
    step: '准备中',
    percent: 8,
    message: '正在保存语音克隆参数...'
  });

  try {
    state.settings = await window.antbot.updateSettings({
      voiceClone: {
        ...state.settings.voiceClone,
        samplePath: payload.samplePath,
        referenceText: payload.referenceText,
        profileName: payload.profileName,
        language: payload.language
      }
    });

    const voiceClone = await window.antbot.runVoiceClone(payload);
    state.settings.voiceClone = {
      ...state.settings.voiceClone,
      ...voiceClone,
      samplePath: payload.samplePath,
      referenceText: payload.referenceText,
      profileName: payload.profileName || voiceClone.profileName || ''
    };

    updateVoiceCloneProgress({
      running: false,
      status: 'completed',
      step: '克隆完成',
      percent: 100,
      message: `语音克隆完成：${voiceClone.voiceId}`
    });
    renderAll();
    await runStartupCheck();
  } catch (error) {
    updateVoiceCloneProgress({
      running: false,
      status: 'failed',
      step: '克隆失败',
      message: compactMessage(error?.message, 220)
    });
    alert(`语音克隆失败：${error.message}`);
  }
}

function bindEvents() {
  el.userList?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest('[data-user-switch]');
    if (!(button instanceof HTMLElement)) {
      return;
    }
    void switchUser(button.dataset.userSwitch);
  });

  el.addUserBtn?.addEventListener('click', createUser);
  el.geminiLoginBtn?.addEventListener('click', () => {
    void openLoginAction('gemini', {
      profileId: state.settings?.geminiProfileId || 'default'
    });
  });

  el.settingsBtn?.addEventListener('click', () => {
    fillSettingsForm();
    el.settingsDialog.showModal();
  });
  el.voiceCloneBtn?.addEventListener('click', () => {
    fillVoiceCloneForm();
    state.voiceClone = {
      running: false,
      status: 'idle',
      step: '等待开始',
      percent: 0,
      logs: []
    };
    renderVoiceCloneProgress();
    el.voiceCloneDialog.showModal();
  });
  el.remoteBtn?.addEventListener('click', async () => {
    state.remote = await window.antbot.getRemoteState();
    renderRemoteStatus();
    el.remoteDialog.showModal();
  });
  el.accountBtn?.addEventListener('click', () => {
    renderAccountDialog();
    el.accountDialog.showModal();
  });

  el.accountGeminiProfile?.addEventListener('change', updateAccountSummary);
  el.accountSaveBtn?.addEventListener('click', () => { void saveAccountSettings(); });
  el.accountGeminiLoginBtn?.addEventListener('click', () => {
    void openLoginAction('gemini', {
      profileId: el.accountGeminiProfile.value
    });
  });
  el.accountCreateGeminiBtn?.addEventListener('click', () => { void createGeminiProfile(); });
  el.accountDeleteBtn?.addEventListener('click', () => { void deleteCurrentUser(); });
  el.accountCloseBtn?.addEventListener('click', () => el.accountDialog.close());

  el.closeSettingsBtn?.addEventListener('click', () => el.settingsDialog.close());
  el.saveSettingsBtn?.addEventListener('click', () => { void saveSettings(); });
  el.settingsForm?.voiceoverEnabled?.addEventListener('change', syncNarrationToggles);

  el.refreshDepsBtn?.addEventListener('click', async () => {
    state.dependencies = await window.antbot.getDependencyState();
    renderDependencyStatus();
  });
  el.repairDepsBtn?.addEventListener('click', async () => {
    try {
      el.repairDepsBtn.disabled = true;
      state.dependencies = await window.antbot.repairDependencies();
      renderDependencyStatus();
      state.remote = await window.antbot.getRemoteState();
      renderRemoteStatus();
    } catch (error) {
      alert(`下载依赖失败：${error.message}`);
    } finally {
      el.repairDepsBtn.disabled = false;
    }
  });
  el.openPythonDownloadBtn?.addEventListener('click', () => {
    void window.antbot.openExternal('https://www.python.org/downloads/windows/');
  });
  el.openGitBashDownloadBtn?.addEventListener('click', () => {
    void window.antbot.openExternal('https://git-scm.com/download/win');
  });

  el.voiceCloneCloseBtn?.addEventListener('click', () => el.voiceCloneDialog.close());
  el.voiceClonePickSampleBtn?.addEventListener('click', async () => {
    try {
      const selected = await window.antbot.pickAudioFile();
      if (selected) {
        el.voiceCloneForm.samplePath.value = selected;
      }
    } catch (error) {
      alert(`选择样本失败：${error.message}`);
    }
  });
  el.voiceCloneRunBtn?.addEventListener('click', () => { void runVoiceClone(); });

  el.toggleRemoteBtn?.addEventListener('click', () => { void toggleRemote(); });
  el.refreshRemoteBtn?.addEventListener('click', async () => {
    state.remote = await window.antbot.getRemoteState();
    renderRemoteStatus();
  });
  el.closeRemoteBtn?.addEventListener('click', () => el.remoteDialog.close());
  el.copyRemoteLocalBtn?.addEventListener('click', () => {
    void copyTextToClipboard(getPrimaryLocalRemoteUrl(), '局域网地址已复制。');
  });
  el.copyRemotePublicBtn?.addEventListener('click', () => {
    void copyTextToClipboard(state.remote?.server?.public?.url || '', '公网地址已复制。');
  });

  el.settingChips?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const stepButton = target.closest('[data-setting-step]');
    if (stepButton instanceof HTMLElement) {
      updateQuickStep(stepButton.dataset.settingStep, Number(stepButton.dataset.direction || 0));
      return;
    }
    const toggleButton = target.closest('[data-setting-toggle]');
    if (toggleButton instanceof HTMLButtonElement && !toggleButton.disabled) {
      toggleQuickSetting(toggleButton.dataset.settingToggle);
      return;
    }
    const actionButton = target.closest('[data-setting-action]');
    if (actionButton instanceof HTMLElement && actionButton.dataset.settingAction === 'voiceClone') {
      fillVoiceCloneForm();
      state.voiceClone = {
        running: false,
        status: 'idle',
        step: '等待开始',
        percent: 0,
        logs: []
      };
      renderVoiceCloneProgress();
      el.voiceCloneDialog.showModal();
    }
  });
  el.settingChips?.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    if (target.dataset.settingColor) {
      updateQuickColor(target.dataset.settingColor, target.value);
    }
  });

  el.taskInput?.addEventListener('input', () => {
    autosizeTaskInput();
    queueTaskPreview();
  });
  el.taskInput?.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void startTasks();
    }
  });
  el.runBtn?.addEventListener('click', () => { void startTasks(); });
  el.refreshStartupBtn?.addEventListener('click', () => { void runStartupCheck(); });
  el.chatScroll?.addEventListener('scroll', handleChatScroll);
  el.chatStream?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const stopButton = target.closest('[data-task-stop]');
    if (stopButton instanceof HTMLElement) {
      void handleTaskControl('stop', stopButton.dataset.taskStop);
      return;
    }
    const resumeButton = target.closest('[data-task-resume]');
    if (resumeButton instanceof HTMLElement) {
      void handleTaskControl('resume', resumeButton.dataset.taskResume);
    }
  });

  document.querySelectorAll('[data-login-service]').forEach((button) => {
    button.addEventListener('click', () => {
      const serviceKey = button.getAttribute('data-login-service');
      if (!serviceKey) {
        return;
      }
      void openLoginAction(serviceKey);
    });
  });

  window.antbot.onProgress((payload) => {
    const keepPinned = isChatNearBottom();
    state.progress = payload || state.progress;
    renderUserList();
    renderChat({ stickBottom: keepPinned });
  });

  window.antbot.onLog((payload) => {
    if (payload?.message?.startsWith('[语音克隆]')) {
      updateVoiceCloneProgress({
        running: state.voiceClone.running,
        status: state.voiceClone.status,
        step: state.voiceClone.step,
        percent: state.voiceClone.percent,
        message: payload.message.replace('[语音克隆] ', '')
      });
    }
    if (payload?.message) {
      state.runtimeHint = payload.message;
      renderStartupStatus();
    }
  });

  window.antbot.onVoiceCloneProgress((payload) => {
    updateVoiceCloneProgress({
      running: payload?.status === 'running',
      status: payload?.status,
      step: payload?.step,
      percent: payload?.percent,
      message: payload?.message || ''
    });
  });

  window.antbot.onStartupStatus((payload) => {
    state.startup = payload;
    renderStartupStatus();
  });

  window.antbot.onHistoryChanged((history) => {
    const keepPinned = isChatNearBottom();
    state.history = history || [];
    if (state.activeUser) {
      state.activeUser.historyCount = state.history.length;
      state.users = (state.users || []).map((user) => user.id === state.activeUser.id
        ? { ...user, historyCount: state.history.length }
        : user);
    }
    reconcilePendingBatches();
    renderChat({ stickBottom: keepPinned });
    renderUserList();
  });

  window.antbot.onRemoteStatus((payload) => {
    state.remote = payload;
    renderRemoteStatus();
  });

  window.antbot.onAppState((payload) => {
    const keepPinned = isChatNearBottom();
    if (payload?.activeUser?.id && payload.activeUser.id === state.loadingUserId) {
      state.optimisticUserId = '';
      state.loadingUserId = '';
    }
    applyAppState(payload || {});
    renderAll({ stickBottom: keepPinned });
  });
}

async function init() {
  bindEvents();
  const initial = await window.antbot.getInitialState();
  applyAppState(initial);
  renderAll({ stickBottom: true });
  queueTaskPreview();
  await runStartupCheck();
}

init();
