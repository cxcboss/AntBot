const el = {
  authCard: document.querySelector('#auth-card'),
  workspace: document.querySelector('#workspace'),
  authAppTitle: document.querySelector('#auth-app-title'),
  workspaceAppTitle: document.querySelector('#workspace-app-title'),
  connectStatePill: document.querySelector('#connect-state-pill'),
  authUserSelect: document.querySelector('#auth-user-select'),
  connectBtn: document.querySelector('#connect-btn'),
  forgetBtn: document.querySelector('#forget-btn'),
  authStatus: document.querySelector('#auth-status'),
  workspaceSubtitle: document.querySelector('#workspace-subtitle'),
  activeUserPill: document.querySelector('#active-user-pill'),
  showHomeBtn: document.querySelector('#show-home-btn'),
  showTasksBtn: document.querySelector('#show-tasks-btn'),
  showSettingsBtn: document.querySelector('#show-settings-btn'),
  switchUserBtn: document.querySelector('#switch-user-btn'),
  homeView: document.querySelector('#home-view'),
  tasksView: document.querySelector('#tasks-view'),
  settingsView: document.querySelector('#settings-view'),
  refreshBtn: document.querySelector('#refresh-btn'),
  runState: document.querySelector('#run-state'),
  runOwner: document.querySelector('#run-owner'),
  taskCount: document.querySelector('#task-count'),
  queueCount: document.querySelector('#queue-count'),
  platformReady: document.querySelector('#platform-ready'),
  localUrlList: document.querySelector('#local-url-list'),
  publicUrlText: document.querySelector('#public-url-text'),
  copyLocalBtn: document.querySelector('#copy-local-btn'),
  copyPublicBtn: document.querySelector('#copy-public-btn'),
  taskInput: document.querySelector('#task-input'),
  queueHint: document.querySelector('#queue-hint'),
  queuePreview: document.querySelector('#queue-preview'),
  startBtn: document.querySelector('#start-btn'),
  stopBtn: document.querySelector('#stop-btn'),
  taskList: document.querySelector('#task-list'),
  logList: document.querySelector('#log-list'),
  currentUserName: document.querySelector('#current-user-name'),
  renameUserBtn: document.querySelector('#rename-user-btn'),
  backToLoginBtn: document.querySelector('#back-to-login-btn'),
  newUserName: document.querySelector('#new-user-name'),
  createUserBtn: document.querySelector('#create-user-btn'),
  userList: document.querySelector('#user-list'),
  loginVideoStatus: document.querySelector('#login-video-status'),
  loginDouyinStatus: document.querySelector('#login-douyin-status'),
  loginGeminiStatus: document.querySelector('#login-gemini-status'),
  loginVideoBtn: document.querySelector('#login-video-btn'),
  loginDouyinBtn: document.querySelector('#login-douyin-btn'),
  loginGeminiBtn: document.querySelector('#login-gemini-btn'),
  loginProgressBox: document.querySelector('#login-progress-box'),
  loginProgressLabel: document.querySelector('#login-progress-label'),
  loginProgressPercent: document.querySelector('#login-progress-percent'),
  loginProgressBar: document.querySelector('#login-progress-bar'),
  loginProgressDetail: document.querySelector('#login-progress-detail'),
  loginPreviewImage: document.querySelector('#login-preview-image'),
  loginPreviewEmpty: document.querySelector('#login-preview-empty'),
  loginConfirmBtn: document.querySelector('#login-confirm-btn'),
  loginCancelBtn: document.querySelector('#login-cancel-btn'),
  voiceCurrentId: document.querySelector('#voice-current-id'),
  voiceCurrentProfile: document.querySelector('#voice-current-profile'),
  voiceCloneFile: document.querySelector('#voice-clone-file'),
  voiceCloneFileName: document.querySelector('#voice-clone-file-name'),
  voiceCloneText: document.querySelector('#voice-clone-text'),
  voiceCloneName: document.querySelector('#voice-clone-name'),
  voiceCloneLang: document.querySelector('#voice-clone-lang'),
  voiceCloneRunBtn: document.querySelector('#voice-clone-run-btn'),
  voiceCloneProgressBox: document.querySelector('#voice-clone-progress-box'),
  voiceCloneProgressLabel: document.querySelector('#voice-clone-progress-label'),
  voiceCloneProgressPercent: document.querySelector('#voice-clone-progress-percent'),
  voiceCloneProgressBar: document.querySelector('#voice-clone-progress-bar'),
  voiceCloneProgressDetail: document.querySelector('#voice-clone-progress-detail'),
  voiceCloneLog: document.querySelector('#voice-clone-log'),
  settingsForm: document.querySelector('#settings-form'),
  reloadSettingsBtn: document.querySelector('#reload-settings-btn'),
  saveSettingsBtn: document.querySelector('#save-settings-btn'),
  actionProgressCard: document.querySelector('#action-progress-card'),
  actionProgressLabel: document.querySelector('#action-progress-label'),
  actionProgressPercent: document.querySelector('#action-progress-percent'),
  actionProgressBar: document.querySelector('#action-progress-bar'),
  actionProgressDetail: document.querySelector('#action-progress-detail')
};

const AUTH_USER_KEY = 'antbot-remote-user-id';
const TASK_DRAFT_PREFIX = 'antbot-remote-task-draft:';

const state = {
  userId: localStorage.getItem(AUTH_USER_KEY) || '',
  connected: false,
  screen: 'tasks',
  taskInputUserId: '',
  users: [],
  optimisticMessagesByUser: {},
  activeUser: null,
  pollTimer: null,
  loginService: '',
  loginPreview: '',
  selectedVoiceFile: null,
  app: {
    name: document.title.replace(/\s+远程控制$/, ''),
    version: '',
    displayName: document.title.replace(/\s+远程控制$/, '')
  },
  server: null,
  progress: {
    running: false,
    queueLength: 0,
    tasks: []
  },
  logs: [],
  history: [],
  settings: null,
  startup: null,
  loginState: {},
  voiceClone: {
    status: 'idle',
    step: '等待开始',
    percent: 0,
    message: '',
    running: false
  }
};

function compact(text, max = 240) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function escapeHtml(input = '') {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function statusText(input) {
  const status = typeof input === 'string' ? input : input?.status;
  const map = {
    queued: '等待',
    pending: '等待',
    running: '执行中',
    completed: '完成',
    failed: '错误',
    partial_failed: '失败',
    stopped: '停止',
    sending: '发送中'
  };
  return map[status] || '空闲';
}

function setStoredUserId(userId) {
  state.userId = String(userId || '').trim();
  if (state.userId) {
    localStorage.setItem(AUTH_USER_KEY, state.userId);
  } else {
    localStorage.removeItem(AUTH_USER_KEY);
  }
}

function getTaskDraftKey(userId) {
  return `${TASK_DRAFT_PREFIX}${String(userId || '').trim() || 'default'}`;
}

function readTaskDraft(userId) {
  return localStorage.getItem(getTaskDraftKey(userId)) || '';
}

function writeTaskDraft(userId, value) {
  const key = getTaskDraftKey(userId);
  const nextValue = String(value || '');
  if (nextValue) {
    localStorage.setItem(key, nextValue);
  } else {
    localStorage.removeItem(key);
  }
}

function syncTaskDraftForActiveUser() {
  if (!el.taskInput) {
    return;
  }
  const userId = String(state.activeUser?.id || '').trim();
  if (state.taskInputUserId === userId) {
    return;
  }
  state.taskInputUserId = userId;
  el.taskInput.value = userId ? readTaskDraft(userId) : '';
}

function currentUserId() {
  return String(state.activeUser?.id || state.userId || '').trim();
}

function listOfMaps(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function firstNonEmpty(values = []) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function readTimestamp(input) {
  const ms = Date.parse(String(input || '').trim());
  return Number.isFinite(ms) ? ms : 0;
}

function formatBubbleTime(input) {
  const value = String(input || '').trim();
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const now = new Date();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (
    date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  ) {
    return `${hh}:${mm}`;
  }
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${hh}:${mm}`;
}

function splitTaskLinesForUi(inputText) {
  const lines = String(inputText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines : [String(inputText || '').trim()].filter(Boolean);
}

function getOptimisticMessages(userId = currentUserId()) {
  const key = String(userId || '').trim();
  return key ? [...(state.optimisticMessagesByUser[key] || [])] : [];
}

function setOptimisticMessages(userId, nextMessages) {
  const key = String(userId || '').trim();
  if (!key) {
    return;
  }
  if (Array.isArray(nextMessages) && nextMessages.length) {
    state.optimisticMessagesByUser[key] = nextMessages;
  } else {
    delete state.optimisticMessagesByUser[key];
  }
}

function pushOptimisticMessages(userId, inputText) {
  const lines = splitTaskLinesForUi(inputText);
  if (!lines.length) {
    return [];
  }
  const timestamp = new Date().toISOString();
  const base = getOptimisticMessages(userId);
  const created = lines.map((line, index) => ({
    localId: `local-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    inputText: line,
    createdAt: timestamp,
    status: 'sending',
    message: '正在发送到桌面端...'
  }));
  setOptimisticMessages(userId, [...base, ...created]);
  return created;
}

function patchOptimisticMessages(userId, localIds, patcher) {
  const idSet = new Set((Array.isArray(localIds) ? localIds : []).map((item) => String(item || '').trim()).filter(Boolean));
  if (!idSet.size) {
    return;
  }
  const nextList = getOptimisticMessages(userId).map((item, index) => {
    if (!idSet.has(String(item.localId || '').trim())) {
      return item;
    }
    const patch = typeof patcher === 'function' ? patcher(item, index) : patcher;
    return { ...item, ...(patch || {}) };
  });
  setOptimisticMessages(userId, nextList);
}

function canStopRemoteRun() {
  const running = Boolean(state.progress?.running);
  const queue = Array.isArray(state.progress?.queue) ? state.progress.queue : [];
  if (!running) {
    if (!queue.length) {
      return false;
    }
    return queue.every((item) => !item.userId || item.userId === state.activeUser?.id);
  }
  const ownerUserId = String(state.progress?.ownerUserId || '').trim();
  if (!ownerUserId) {
    return true;
  }
  return ownerUserId === state.activeUser?.id;
}

function createProgressController({ box, label, percent, bar, detail }) {
  let timer = null;
  let value = 0;

  const render = (nextValue, nextLabel, nextDetail) => {
    if (typeof nextValue === 'number' && Number.isFinite(nextValue)) {
      value = Math.max(0, Math.min(100, Math.round(nextValue)));
      if (percent) {
        percent.textContent = `${value}%`;
      }
      if (bar) {
        bar.style.width = `${value}%`;
      }
    }
    if (label && nextLabel) {
      label.textContent = nextLabel;
    }
    if (detail && typeof nextDetail === 'string') {
      detail.textContent = nextDetail;
    }
  };

  const start = (nextLabel, nextDetail) => {
    clear();
    if (box) {
      box.classList.remove('hidden');
    }
    render(5, nextLabel || '处理中', nextDetail || '请稍候...');
    timer = setInterval(() => {
      value = Math.min(90, value + Math.round(Math.random() * 5) + 4);
      render(value);
    }, 360);
  };

  const finish = (nextLabel, nextDetail) => {
    clear();
    render(100, nextLabel || '已完成', nextDetail || '');
    setTimeout(() => {
      box?.classList.add('hidden');
    }, 900);
  };

  const fail = (nextLabel, nextDetail) => {
    clear();
    render(Math.min(100, value + 8), nextLabel || '失败', nextDetail || '');
    setTimeout(() => {
      box?.classList.add('hidden');
    }, 1400);
  };

  const update = (nextValue, nextLabel, nextDetail) => {
    if (box) {
      box.classList.remove('hidden');
    }
    render(nextValue, nextLabel, nextDetail);
  };

  const clear = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { start, finish, fail, update };
}

const actionProgress = createProgressController({
  box: el.actionProgressCard,
  label: el.actionProgressLabel,
  percent: el.actionProgressPercent,
  bar: el.actionProgressBar,
  detail: el.actionProgressDetail
});

const loginProgress = createProgressController({
  box: el.loginProgressBox,
  label: el.loginProgressLabel,
  percent: el.loginProgressPercent,
  bar: el.loginProgressBar,
  detail: el.loginProgressDetail
});

function getSettingsField(name) {
  return el.settingsForm?.elements?.namedItem(name) || null;
}

function setFieldIfIdle(name, value) {
  const field = getSettingsField(name);
  if (!field || document.activeElement === field) {
    return;
  }
  field.value = value;
}

function syncNarrationToggles() {
  const voiceoverEnabled = getSettingsField('voiceoverEnabled');
  const subtitleEnabled = getSettingsField('subtitleEnabled');
  if (!voiceoverEnabled || !subtitleEnabled) {
    return;
  }
  const enabled = voiceoverEnabled.value === 'true';
  subtitleEnabled.disabled = !enabled;
  if (!enabled) {
    subtitleEnabled.value = 'false';
  }
}

function applyRemoteState(remoteState = {}) {
  const previousActiveUserId = state.activeUser?.id || '';
  state.app = remoteState.app || state.app;
  state.server = remoteState.server || state.server;
  state.progress = remoteState.progress || state.progress;
  state.logs = Array.isArray(remoteState.logs)
    ? remoteState.logs.map((item) => `[${item.timestamp}] ${item.message}`).slice(-20)
    : state.logs;
  state.history = remoteState.history || state.history;
  state.loginState = remoteState.loginState || state.loginState;
  state.voiceClone = remoteState.voiceClone || state.voiceClone;
  state.startup = remoteState.startup || state.startup;
  state.users = remoteState.users || state.users;
  state.activeUser = remoteState.activeUser || state.activeUser;
  if (state.activeUser?.id) {
    setStoredUserId(state.activeUser.id);
  }
  if ((state.activeUser?.id || '') !== previousActiveUserId) {
    syncTaskDraftForActiveUser();
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

async function copyTextToClipboard(text, emptyMessage) {
  const value = String(text || '').trim();
  if (!value) {
    alert(emptyMessage || '当前没有可复制的内容。');
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
  } catch {
    window.prompt('复制以下内容：', value);
  }
}

function resolvePrimaryLocalUrl() {
  const urls = Array.isArray(state.server?.urls) ? state.server.urls : [];
  return urls.find((url) => !/127\.0\.0\.1|localhost/.test(url)) || urls[0] || '';
}

function renderUsers() {
  const users = Array.isArray(state.users) ? state.users : [];
  if (el.authUserSelect) {
    el.authUserSelect.innerHTML = users.length
      ? users.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)}</option>`).join('')
      : '<option value="">暂无用户</option>';

    const preferred = users.find((user) => user.id === state.userId) || users.find((user) => user.isActive) || users[0];
    if (preferred) {
      el.authUserSelect.value = preferred.id;
      if (!state.userId) {
        setStoredUserId(preferred.id);
      }
    }
  }

  if (el.userList) {
    el.userList.innerHTML = users.length
      ? users.map((user) => `
          <article class="user-item ${user.id === state.activeUser?.id ? 'selected' : ''}" data-user-id="${escapeHtml(user.id)}">
            <div class="user-row"><strong>${escapeHtml(user.name)}</strong><span>${user.isActive ? '当前' : '可切换'}</span></div>
            <div class="user-row task-meta"><span>远程服务</span><span>${user.remoteEnabled ? '已启用' : '未启用'}</span></div>
            <div class="user-row task-meta"><span>聊天窗口</span><span>${user.id === state.activeUser?.id ? '已打开' : '独立会话'}</span></div>
            <div class="actions inline-actions">
              <button class="btn btn-ghost btn-small" type="button" data-action="switch-user" data-user-id="${escapeHtml(user.id)}" ${user.id === state.activeUser?.id ? 'disabled' : ''}>${user.id === state.activeUser?.id ? '当前用户' : '切换到此用户'}</button>
            </div>
          </article>
        `).join('')
      : '<div class="helper-text">暂无用户。</div>';
  }
}

function renderAppInfo() {
  const app = state.app || {};
  const displayName = String(app.displayName || app.name || '__APP_NAME__').trim();
  document.title = `${displayName} 远程控制`;
  if (el.authAppTitle) {
    el.authAppTitle.textContent = displayName;
  }
  if (el.workspaceAppTitle) {
    el.workspaceAppTitle.textContent = displayName;
  }
}

function renderHeader() {
  if (el.connectStatePill) {
    el.connectStatePill.textContent = state.connected ? '已连接' : '未连接';
  }

  if (el.activeUserPill) {
    el.activeUserPill.textContent = state.activeUser?.name || '未选择用户';
  }

  if (el.workspaceSubtitle) {
    const publicInfo = state.server?.public || {};
    const userName = state.activeUser?.name || '未选择用户';
    const runningOwner = state.progress?.ownerUserName;
    const runHint = state.progress?.running && runningOwner
      ? ` · 当前执行：${runningOwner}`
      : '';
    const status = publicInfo.online
      ? `当前用户：${userName} · 公网在线${runHint}`
      : (state.server?.online ? `当前用户：${userName} · 远程服务在线${runHint}` : `当前用户：${userName}${runHint}`);
    el.workspaceSubtitle.textContent = status;
  }
}

function renderStatusSummary() {
  const loginState = state.loginState || {};
  const videoReady = Boolean(loginState.videoChannel?.loggedIn);
  const douyinReady = Boolean(loginState.douyin?.loggedIn);

  if (el.runState) {
    el.runState.textContent = state.progress?.running ? '执行中' : '空闲';
  }
  if (el.runOwner) {
    el.runOwner.textContent = state.progress?.ownerUserName || '无';
  }
  if (el.taskCount) {
    el.taskCount.textContent = String(state.progress?.tasks?.length || 0);
  }
  if (el.queueCount) {
    el.queueCount.textContent = String(state.progress?.queueLength || 0);
  }
  if (el.platformReady) {
    el.platformReady.textContent = videoReady || douyinReady ? '已就绪' : '未登录';
  }

  const urls = Array.isArray(state.server?.urls) ? state.server.urls : [];
  if (el.localUrlList) {
    el.localUrlList.innerHTML = urls.length
      ? urls.map((url) => `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`).join('')
      : '连接后显示';
  }

  const publicInfo = state.server?.public || {};
  if (el.publicUrlText) {
    if (publicInfo.online && publicInfo.url) {
      el.publicUrlText.innerHTML = `<a href="${escapeHtml(publicInfo.url)}" target="_blank" rel="noreferrer">${escapeHtml(publicInfo.url)}</a>`;
    } else {
      el.publicUrlText.textContent = publicInfo.lastError || (publicInfo.mode === 'cloudflare-quick' ? '正在建立公网地址...' : '未开启');
    }
  }
}

function renderQueuePreview() {
  if (!el.queuePreview || !el.queueHint) {
    return;
  }

  const queue = Array.isArray(state.progress?.queue) ? state.progress.queue : [];
  const runningOwner = state.progress?.ownerUserName || '';
  if (el.queueHint) {
    if (state.progress?.running && runningOwner && state.activeUser?.id !== state.progress?.ownerUserId) {
      el.queueHint.textContent = `当前正在执行的是 ${runningOwner} 的任务。你可以继续为 ${state.activeUser?.name || '当前用户'} 提交任务，系统会自动排队；但当前用户不能停止别人的任务。`;
    } else if (queue.length) {
      el.queueHint.textContent = `当前共有 ${queue.length} 个排队批次。再次提交会继续排到队尾。`;
    } else {
      el.queueHint.textContent = '每行一条任务。平台关键词：微信=视频号；抖音=抖音；都写=双平台；都不写=默认视频号。运行中再次提交会自动排队。';
    }
  }

  el.queuePreview.innerHTML = queue.length
    ? queue.map((item, index) => `
        <article class="user-item">
          <div class="user-row"><strong>队列 ${index + 1}</strong><span>${escapeHtml(item.userName || '未知用户')}</span></div>
          <div class="user-row task-meta"><span>任务数</span><span>${item.taskCount || 0} 条</span></div>
          <div class="user-row task-meta"><span>提交时间</span><span>${escapeHtml(formatBubbleTime(item.enqueuedAt)) || '--'}</span></div>
        </article>
      `).join('')
    : '<div class="helper-text">当前没有排队批次。</div>';
}

function conversationTaskKey({ taskId = '', runId = '', localId = '', rawLine = '' }) {
  if (taskId) {
    return `task:${taskId}`;
  }
  if (localId) {
    return `local:${localId}`;
  }
  if (runId && rawLine) {
    return `run:${runId}:${rawLine}`;
  }
  if (runId) {
    return `run:${runId}`;
  }
  return `line:${rawLine}`;
}

function resolveConversationInputText(task = {}) {
  const snapshot = task.taskSnapshot && typeof task.taskSnapshot === 'object' ? task.taskSnapshot : {};
  const direct = firstNonEmpty([task.rawLine, snapshot.rawLine, task.inputText]);
  if (direct) {
    return direct;
  }
  const title = firstNonEmpty([task.taskName, snapshot.taskName]);
  const url = firstNonEmpty([task.videoUrl, snapshot.videoUrl, task.sourceUrl, snapshot.sourceUrl, task.url]);
  if (title && url) {
    return `${title}，${url}`;
  }
  return title || url;
}

function buildConversationStatusTitle(task = {}) {
  const status = String(task.status || '').trim();
  const taskName = firstNonEmpty([task.taskName, task.taskSnapshot?.taskName, '任务']);
  if (status === 'running') {
    return firstNonEmpty([task.step, taskName]);
  }
  if (status === 'queued' || status === 'pending') {
    return '等待执行';
  }
  if (status === 'failed' || status === 'partial_failed') {
    return '执行失败';
  }
  if (status === 'stopped') {
    return '任务已取消';
  }
  if (status === 'completed') {
    return '任务完成';
  }
  if (status === 'sending') {
    return '正在发送';
  }
  return taskName;
}

function buildConversationStatusDetail(task = {}) {
  const taskName = firstNonEmpty([task.taskName, task.taskSnapshot?.taskName]);
  const step = String(task.step || '').trim();
  const message = String(task.message || '').trim();
  const pieces = [];
  if (taskName) {
    pieces.push(taskName);
  }
  if (message && message !== step) {
    pieces.push(message);
  } else if (step) {
    pieces.push(step);
  }
  return pieces.join(' · ');
}

function isCancellableConversationStatus(status) {
  return status === 'queued' || status === 'pending' || status === 'running';
}

function buildConversationEntries() {
  const items = new Map();

  const mergeItem = (key, patch) => {
    const current = items.get(key) || { key, progress: 0, sequence: 0 };
    const next = { ...current };
    Object.entries(patch || {}).forEach(([field, value]) => {
      if (value === null || value === undefined) {
        return;
      }
      if (typeof value === 'string' && !value.trim()) {
        return;
      }
      next[field] = value;
    });

    if (patch?.sentAt) {
      const nextSentAt = String(patch.sentAt || '').trim();
      const prevSentAt = String(current.sentAt || '').trim();
      if (!prevSentAt || readTimestamp(nextSentAt) < readTimestamp(prevSentAt)) {
        next.sentAt = nextSentAt;
      }
    }

    if (patch?.statusAt) {
      const nextStatusAt = String(patch.statusAt || '').trim();
      const prevStatusAt = String(current.statusAt || '').trim();
      if (!prevStatusAt || readTimestamp(nextStatusAt) >= readTimestamp(prevStatusAt)) {
        next.statusAt = nextStatusAt;
      }
    }

    items.set(key, next);
  };

  getOptimisticMessages()
    .sort((a, b) => readTimestamp(a.createdAt) - readTimestamp(b.createdAt))
    .forEach((item, index) => {
      const status = String(item.status || 'sending').trim() || 'sending';
      mergeItem(
        conversationTaskKey({
          taskId: String(item.taskId || '').trim(),
          runId: String(item.runId || '').trim(),
          localId: String(item.localId || '').trim(),
          rawLine: String(item.inputText || '').trim()
        }),
        {
          taskId: item.taskId,
          runId: item.runId,
          inputText: item.inputText,
          sentAt: item.createdAt,
          statusAt: item.createdAt,
          sequence: index,
          status,
          statusTitle: buildConversationStatusTitle({ status }),
          statusDetail: String(item.message || '').trim(),
          progress: status === 'running' ? 0.18 : status === 'sending' ? 0.08 : 0,
          cancellable: false
        }
      );
    });

  [...listOfMaps(state.progress?.queueTasks), ...listOfMaps(state.progress?.tasks)]
    .sort((a, b) => readTimestamp(firstNonEmpty([a.submittedAt, a.enqueuedAt, a.updatedAt])) - readTimestamp(firstNonEmpty([b.submittedAt, b.enqueuedAt, b.updatedAt])))
    .forEach((task) => {
      const status = String(task.status || 'queued').trim() || 'queued';
      mergeItem(
        conversationTaskKey({
          taskId: String(task.id || '').trim(),
          runId: String(task.batchRunId || '').trim(),
          rawLine: String(task.rawLine || '').trim()
        }),
        {
          taskId: task.id,
          runId: task.batchRunId,
          inputText: resolveConversationInputText(task),
          sentAt: firstNonEmpty([task.submittedAt, task.enqueuedAt, task.updatedAt]),
          statusAt: firstNonEmpty([task.updatedAt, task.enqueuedAt, task.submittedAt]),
          sequence: Number(task.index ?? task.queueIndex ?? 0),
          status,
          statusTitle: buildConversationStatusTitle(task),
          statusDetail: buildConversationStatusDetail(task),
          progress: Math.max(0, Math.min(1, Number(task.progress || 0) / 100)),
          cancellable: isCancellableConversationStatus(status)
        }
      );
    });

  listOfMaps(state.history)
    .sort((a, b) => readTimestamp(firstNonEmpty([a.submittedAt, a.startedAt, a.endedAt])) - readTimestamp(firstNonEmpty([b.submittedAt, b.startedAt, b.endedAt])))
    .forEach((run) => {
      listOfMaps(run.items).forEach((item, index) => {
        mergeItem(
          conversationTaskKey({
            taskId: String(item.taskId || '').trim(),
            runId: String(run.id || '').trim(),
            rawLine: resolveConversationInputText(item)
          }),
          {
            taskId: item.taskId,
            runId: run.id,
            inputText: resolveConversationInputText(item),
            sentAt: firstNonEmpty([run.submittedAt, run.startedAt, run.endedAt]),
            statusAt: firstNonEmpty([item.finishedAt, run.endedAt, run.startedAt]),
            sequence: index,
            status: String(item.status || 'completed').trim() || 'completed',
            statusTitle: buildConversationStatusTitle(item),
            statusDetail: buildConversationStatusDetail(item),
            progress: item.status === 'completed' ? 1 : Math.max(0, Math.min(1, Number(item.progress || 0) / 100)),
            cancellable: false
          }
        );
      });
    });

  const ordered = [...items.values()].sort((left, right) => {
    const leftTime = readTimestamp(left.sentAt);
    const rightTime = readTimestamp(right.sentAt);
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return Number(left.sequence || 0) - Number(right.sequence || 0);
  });

  return ordered.flatMap((item) => {
    const sentAt = firstNonEmpty([item.sentAt, item.statusAt]);
    const statusAt = firstNonEmpty([item.statusAt, sentAt]);
    const entries = [];
    if (String(item.inputText || '').trim()) {
      entries.push({
        kind: 'sent',
        time: sentAt,
        text: item.inputText
      });
    }
    if (String(item.statusTitle || '').trim() || String(item.statusDetail || '').trim()) {
      entries.push({
        kind: 'status',
        time: statusAt,
        title: item.statusTitle,
        detail: item.statusDetail,
        status: item.status,
        progress: item.progress || 0,
        taskId: item.taskId,
        cancellable: Boolean(item.cancellable)
      });
    }
    return entries;
  });
}

function renderTasks() {
  if (!el.taskList) {
    return;
  }

  const entries = buildConversationEntries();
  if (!entries.length) {
    el.taskList.innerHTML = `
      <div class="chat-empty">
        <strong>当前用户还没有任务记录。</strong>
        <span>底部输入区会固定停靠在窗口底部，发送后会立即生成聊天气泡和状态卡片。</span>
      </div>
    `;
    return;
  }

  el.taskList.innerHTML = entries.map((entry) => {
    if (entry.kind === 'sent') {
      return `
        <article class="chat-row chat-row-sent">
          <div class="bubble-time">${escapeHtml(formatBubbleTime(entry.time))}</div>
          <div class="chat-bubble chat-bubble-sent">${escapeHtml(entry.text)}</div>
        </article>
      `;
    }

    const progress = Math.max(0, Math.min(100, Math.round(Number(entry.progress || 0) * 100)));
    const status = String(entry.status || '').trim();
    const barClass = status === 'completed'
      ? 'completed'
      : (status === 'failed' || status === 'partial_failed' ? 'failed' : '');
    const cancelButton = entry.cancellable && entry.taskId
      ? `<button class="status-action" type="button" data-action="cancel-task" data-task-id="${escapeHtml(entry.taskId)}">取消</button>`
      : '';
    return `
      <article class="chat-row chat-row-status">
        <div class="chat-status-card status-${escapeHtml(status || 'queued')}">
          <div class="chat-status-head">
            <span class="status-badge">${escapeHtml(statusText(status || 'pending'))}</span>
            ${cancelButton}
          </div>
          ${entry.title ? `<div class="chat-status-title">${escapeHtml(entry.title)}</div>` : ''}
          ${entry.detail ? `<div class="chat-status-detail">${escapeHtml(entry.detail)}</div>` : ''}
          ${(status === 'running' && progress > 0) ? `<div class="progress-track compact"><div class="progress-bar ${barClass}" style="width:${progress}%"></div></div>` : ''}
        </div>
        <div class="bubble-time">${escapeHtml(formatBubbleTime(entry.time))}</div>
      </article>
    `;
  }).join('');
}

function renderLogs() {
  if (el.logList) {
    el.logList.textContent = state.logs.length ? state.logs.join('\n') : '暂无日志';
  }
}

function renderLoginStatus() {
  const loginState = state.loginState || {};
  if (el.loginVideoStatus) {
    el.loginVideoStatus.textContent = loginState.videoChannel?.loggedIn ? '已登录' : '未登录';
  }
  if (el.loginDouyinStatus) {
    el.loginDouyinStatus.textContent = loginState.douyin?.loggedIn ? '已登录' : '未登录';
  }
  if (el.loginGeminiStatus) {
    const gemini = loginState.gemini;
    el.loginGeminiStatus.textContent = gemini?.loggedIn ? '已登录' : (gemini?.source === 'skipped' ? '已跳过' : '未登录');
  }
}

function renderLoginPreview() {
  const hasPreview = Boolean(state.loginPreview);
  if (el.loginPreviewImage && el.loginPreviewEmpty) {
    if (hasPreview) {
      el.loginPreviewImage.src = state.loginPreview;
      el.loginPreviewImage.classList.remove('hidden');
      el.loginPreviewEmpty.classList.add('hidden');
    } else {
      el.loginPreviewImage.removeAttribute('src');
      el.loginPreviewImage.classList.add('hidden');
      el.loginPreviewEmpty.classList.remove('hidden');
    }
  }
  if (el.loginConfirmBtn) {
    el.loginConfirmBtn.disabled = !state.connected || !state.loginService || !hasPreview;
  }
  if (el.loginCancelBtn) {
    el.loginCancelBtn.disabled = !state.connected || !state.loginService;
  }
}

function renderVoiceClone() {
  const voice = state.settings?.voiceClone || {};
  const remoteVoice = state.voiceClone || {};
  if (el.voiceCurrentId) {
    el.voiceCurrentId.textContent = voice.voiceId || '未配置';
  }
  if (el.voiceCurrentProfile) {
    el.voiceCurrentProfile.textContent = voice.profileName || '未配置';
  }
  if (el.voiceCloneText && document.activeElement !== el.voiceCloneText) {
    el.voiceCloneText.value = voice.referenceText || '';
  }
  if (el.voiceCloneName && document.activeElement !== el.voiceCloneName) {
    el.voiceCloneName.value = voice.profileName || '';
  }
  if (el.voiceCloneLang && document.activeElement !== el.voiceCloneLang) {
    el.voiceCloneLang.value = voice.language || 'zh';
  }
  if (el.voiceCloneProgressBox) {
    const visible = remoteVoice.status !== 'idle' || Boolean(remoteVoice.message);
    el.voiceCloneProgressBox.classList.toggle('hidden', !visible);
  }
  if (el.voiceCloneProgressLabel) {
    el.voiceCloneProgressLabel.textContent = remoteVoice.step || '等待开始';
  }
  if (el.voiceCloneProgressPercent) {
    el.voiceCloneProgressPercent.textContent = `${remoteVoice.percent || 0}%`;
  }
  if (el.voiceCloneProgressBar) {
    el.voiceCloneProgressBar.style.width = `${remoteVoice.percent || 0}%`;
  }
  if (el.voiceCloneProgressDetail) {
    el.voiceCloneProgressDetail.textContent = remoteVoice.message || '准备中...';
  }
  if (el.voiceCloneLog) {
    el.voiceCloneLog.textContent = remoteVoice.message || '暂无日志';
  }
}

function renderSettingsForm() {
  if (!state.settings) {
    return;
  }

  const settings = state.settings;
  setFieldIfIdle('tempDir', settings.paths?.tempDir || '');
  setFieldIfIdle('outputBaseDir', settings.paths?.outputBaseDir || '');
  setFieldIfIdle('youtubeProjectPath', settings.paths?.youtubeProjectPath || '');
  setFieldIfIdle('editProjectPath', settings.paths?.editProjectPath || '');
  setFieldIfIdle('publishProjectPath', settings.paths?.publishProjectPath || '');
  setFieldIfIdle('downloadCmd', settings.commands?.download || '');
  setFieldIfIdle('geminiCmd', settings.commands?.gemini || '');
  setFieldIfIdle('editCmd', settings.commands?.edit || '');
  setFieldIfIdle('publishCmd', settings.commands?.publish || '');
  setFieldIfIdle('voiceCloneCmd', settings.commands?.voiceClone || '');
  setFieldIfIdle('geminiSubtitleUrl', settings.subtitle?.geminiUrl || '');
  setFieldIfIdle('publishEnabled', String(settings.publish?.enabled !== false));
  setFieldIfIdle('failedRetryCount', settings.retry?.failedTaskRetries ?? 0);
  setFieldIfIdle('pauseBetweenTasksMs', settings.browser?.pauseBetweenTasksMs ?? 2500);
  setFieldIfIdle('actionDelayMs', settings.browser?.actionDelayMs ?? 1500);
  setFieldIfIdle('showAutomationWindow', String(Boolean(settings.browser?.showAutomationWindow)));
  setFieldIfIdle('voiceSpeed', settings.style?.voiceSpeed ?? 1.1);
  setFieldIfIdle('voiceoverEnabled', String(settings.style?.voiceoverEnabled !== false));
  setFieldIfIdle('subtitleEnabled', String(settings.style?.subtitleEnabled !== false));
  setFieldIfIdle('subtitleTextColor', settings.style?.subtitleTextColor || '#FFA100');
  setFieldIfIdle('subtitleStrokeColor', settings.style?.subtitleStrokeColor || '#000000');
  setFieldIfIdle('subtitlePositionPercent', settings.style?.subtitlePositionPercent ?? 12);
  setFieldIfIdle('voiceId', settings.voiceClone?.voiceId || '');
  setFieldIfIdle('modelPath', settings.voiceClone?.modelPath || '');
  setFieldIfIdle('remoteEnabled', String(Boolean(settings.remote?.enabled)));
  setFieldIfIdle('remotePort', settings.remote?.port ?? 17888);
  setFieldIfIdle('remotePublicMode', settings.remote?.publicMode || 'off');

  if (el.currentUserName && document.activeElement !== el.currentUserName) {
    el.currentUserName.value = state.activeUser?.name || '';
  }

  syncNarrationToggles();
}

function readSettingsForm() {
  const voiceoverEnabled = getSettingsField('voiceoverEnabled')?.value === 'true';
  const subtitleEnabled = voiceoverEnabled && getSettingsField('subtitleEnabled')?.value === 'true';
  return {
    paths: {
      tempDir: getSettingsField('tempDir')?.value?.trim() || '',
      outputBaseDir: getSettingsField('outputBaseDir')?.value?.trim() || '',
      youtubeProjectPath: getSettingsField('youtubeProjectPath')?.value?.trim() || '',
      editProjectPath: getSettingsField('editProjectPath')?.value?.trim() || '',
      publishProjectPath: getSettingsField('publishProjectPath')?.value?.trim() || ''
    },
    commands: {
      download: getSettingsField('downloadCmd')?.value?.trim() || '',
      gemini: getSettingsField('geminiCmd')?.value?.trim() || '',
      edit: getSettingsField('editCmd')?.value?.trim() || '',
      publish: getSettingsField('publishCmd')?.value?.trim() || '',
      voiceClone: getSettingsField('voiceCloneCmd')?.value?.trim() || ''
    },
    subtitle: {
      geminiUrl: getSettingsField('geminiSubtitleUrl')?.value?.trim() || ''
    },
    publish: {
      enabled: getSettingsField('publishEnabled')?.value === 'true'
    },
    retry: {
      failedTaskRetries: Math.max(0, Number(getSettingsField('failedRetryCount')?.value || 0))
    },
    browser: {
      pauseBetweenTasksMs: Number(getSettingsField('pauseBetweenTasksMs')?.value || 2500),
      actionDelayMs: Number(getSettingsField('actionDelayMs')?.value || 1500),
      showAutomationWindow: getSettingsField('showAutomationWindow')?.value === 'true'
    },
    style: {
      voiceSpeed: Number(getSettingsField('voiceSpeed')?.value || 1.1),
      voiceoverEnabled,
      subtitleEnabled,
      subtitleTextColor: getSettingsField('subtitleTextColor')?.value?.trim() || '#FFA100',
      subtitleStrokeColor: getSettingsField('subtitleStrokeColor')?.value?.trim() || '#000000',
      subtitlePositionPercent: Math.max(0, Math.min(100, Number(getSettingsField('subtitlePositionPercent')?.value || 12)))
    },
    voiceClone: {
      voiceId: getSettingsField('voiceId')?.value?.trim() || '',
      modelPath: getSettingsField('modelPath')?.value?.trim() || ''
    },
    remote: {
      enabled: getSettingsField('remoteEnabled')?.value === 'true',
      port: Number(getSettingsField('remotePort')?.value || 17888),
      publicMode: getSettingsField('remotePublicMode')?.value === 'cloudflare-quick' ? 'cloudflare-quick' : 'off'
    }
  };
}

function renderButtons() {
  const connected = state.connected;
  const running = Boolean(state.progress?.running);
  if (el.startBtn) {
    el.startBtn.disabled = !connected || !el.taskInput?.value?.trim();
    el.startBtn.textContent = running ? '发送并排队' : '发送';
  }
  if (el.stopBtn) {
    el.stopBtn.disabled = !connected || !canStopRemoteRun();
    el.stopBtn.textContent = running && !canStopRemoteRun() ? '其他用户执行中' : '停止并清空队列';
  }
  if (el.refreshBtn) {
    el.refreshBtn.disabled = !connected;
  }
  if (el.showHomeBtn) {
    el.showHomeBtn.disabled = !connected;
    el.showHomeBtn.classList.toggle('active', state.screen === 'home');
  }
  if (el.showTasksBtn) {
    el.showTasksBtn.disabled = !connected;
    el.showTasksBtn.classList.toggle('active', state.screen === 'tasks');
  }
  if (el.showSettingsBtn) {
    el.showSettingsBtn.disabled = !connected;
    el.showSettingsBtn.classList.toggle('active', state.screen === 'settings');
  }
  if (el.switchUserBtn) {
    el.switchUserBtn.disabled = !connected;
  }
  if (el.renameUserBtn) {
    el.renameUserBtn.disabled = !connected;
  }
  if (el.createUserBtn) {
    el.createUserBtn.disabled = !connected;
  }
  if (el.loginVideoBtn) {
    el.loginVideoBtn.disabled = !connected;
    el.loginDouyinBtn.disabled = !connected;
    el.loginGeminiBtn.disabled = !connected;
  }
  if (el.voiceCloneRunBtn) {
    el.voiceCloneRunBtn.disabled = !connected || state.voiceClone?.running;
  }
  if (el.reloadSettingsBtn) {
    el.reloadSettingsBtn.disabled = !connected;
  }
  if (el.saveSettingsBtn) {
    el.saveSettingsBtn.disabled = !connected;
  }
  if (el.copyLocalBtn) {
    el.copyLocalBtn.disabled = !connected || !(state.server?.urls || []).length;
  }
  if (el.copyPublicBtn) {
    el.copyPublicBtn.disabled = !connected || !(state.server?.public?.online && state.server?.public?.url);
  }
}

function renderVisibility() {
  el.authCard?.classList.toggle('hidden', state.connected);
  el.workspace?.classList.toggle('hidden', !state.connected);
  el.homeView?.classList.toggle('hidden', state.screen !== 'home');
  el.tasksView?.classList.toggle('hidden', state.screen !== 'tasks');
  el.settingsView?.classList.toggle('hidden', state.screen !== 'settings');
}

function renderAuthState() {
  if (!state.connected && el.authStatus) {
    if (!state.users.length) {
      el.authStatus.textContent = '桌面端暂时没有可用用户，请先在桌面端打开应用。';
    } else {
      el.authStatus.textContent = '已读取桌面端用户，点击即可直接进入控制台。';
    }
  }
}

function render() {
  syncTaskDraftForActiveUser();
  renderVisibility();
  renderUsers();
  renderAppInfo();
  renderHeader();
  renderAuthState();
  renderStatusSummary();
  renderQueuePreview();
  renderTasks();
  renderLogs();
  renderLoginStatus();
  renderLoginPreview();
  renderVoiceClone();
  renderSettingsForm();
  renderButtons();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-AntBot-User': state.userId,
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || `请求失败 (${response.status})`);
  }
  return payload;
}

async function fetchUsers() {
  const response = await fetch('/api/users');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || '加载用户列表失败。');
  }
  state.users = payload.users || [];
  state.activeUser = payload.activeUser || state.activeUser;
  render();
}

async function refreshState() {
  if (!state.connected) {
    return;
  }
  const payload = await api('/api/state');
  applyRemoteState(payload.state || {});
  render();
}

async function loadSettings() {
  if (!state.connected) {
    return;
  }
  const payload = await api('/api/settings');
  state.settings = payload.settings || state.settings;
  render();
}

async function switchUser(userId) {
  const targetUserId = String(userId || '').trim();
  if (!targetUserId || targetUserId === state.activeUser?.id) {
    return;
  }
  await connect(targetUserId, { progressLabel: '切换用户', successLabel: '切换完成' });
}

function startPolling() {
  stopPolling();
  refreshState().catch(() => {});
  state.pollTimer = setInterval(() => {
    refreshState().catch((error) => {
      if (el.workspaceSubtitle) {
        el.workspaceSubtitle.textContent = compact(error.message || '连接已断开', 120);
      }
    });
  }, 2000);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function connect(nextUserId = '', options = {}) {
  const userId = String(nextUserId || el.authUserSelect?.value || state.userId || '').trim();

  if (!userId) {
    el.authStatus.textContent = '请先选择用户。';
    return;
  }

  try {
    if (options.showProgress !== false) {
      actionProgress.start(options.progressLabel || '连接中', '正在同步远程状态...');
    }
    setStoredUserId(userId);
    const payload = await api('/api/login', {
      method: 'POST',
      body: { userId }
    });
    state.connected = true;
    state.users = payload.users || state.users;
    state.activeUser = payload.activeUser || state.activeUser;
    applyRemoteState(payload.state || {});
    await loadSettings().catch(() => {});
    startPolling();
    render();
    if (options.showProgress !== false) {
      actionProgress.finish(options.successLabel || '连接成功', `已进入 ${state.activeUser?.name || '当前用户'} 控制台。`);
    }
  } catch (error) {
    if (options.showProgress !== false) {
      actionProgress.fail(options.failLabel || '连接失败', error.message);
    }
    el.authStatus.textContent = error.message;
    throw error;
  }
}

async function disconnect(options = {}) {
  stopPolling();
  state.connected = false;
  state.screen = 'tasks';
  state.taskInputUserId = '';
  state.loginService = '';
  state.loginPreview = '';
  if (options.clearUser) setStoredUserId('');
  await fetchUsers().catch(() => {});
  render();
  if (options.message && el.authStatus) {
    el.authStatus.textContent = options.message;
  }
}

async function saveSettings() {
  if (!state.connected) {
    return;
  }

  const nextSettings = readSettingsForm();
  const previousRemote = state.settings?.remote || {};
  actionProgress.start('保存设置', '正在同步桌面端配置...');

  try {
    const payload = await api('/api/settings', {
      method: 'POST',
      body: { settings: nextSettings }
    });
    state.settings = payload.settings || state.settings;
    const savedRemote = state.settings?.remote || {};
    const portChanged = previousRemote.port !== savedRemote.port;
    const disabledRemote = previousRemote.enabled && !savedRemote.enabled;

    render();
    actionProgress.finish('保存成功', '桌面端设置已更新。');

    if (disabledRemote) {
      setTimeout(() => {
        disconnect({ message: '当前用户已关闭远程控制，请重新选择用户。' }).catch(() => {});
      }, 1000);
      return;
    }

    if (portChanged && /^(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)$/.test(window.location.hostname)) {
      const targetUrl = new URL(window.location.href);
      targetUrl.port = String(savedRemote.port);
      targetUrl.pathname = '/remote/';
      setTimeout(() => {
        window.location.href = targetUrl.toString();
      }, 900);
      return;
    }

    await refreshState().catch(() => {});
  } catch (error) {
    actionProgress.fail('保存失败', error.message);
    alert(error.message);
  }
}

async function renameCurrentUser() {
  const nextName = String(el.currentUserName?.value || '').trim();
  if (!nextName) {
    alert('请输入当前用户名。');
    return;
  }

  try {
    actionProgress.start('保存用户', '正在更新当前用户名...');
    const payload = await api('/api/users/rename', {
      method: 'POST',
      body: { name: nextName }
    });
    state.users = payload.users || state.users;
    state.activeUser = payload.activeUser || state.activeUser;
    render();
    actionProgress.finish('已保存', `当前用户名已更新为 ${nextName}。`);
  } catch (error) {
    actionProgress.fail('保存失败', error.message);
    alert(error.message);
  }
}

async function createUser() {
  const name = String(el.newUserName?.value || '').trim();

  try {
    actionProgress.start('新增用户', '正在复制当前设置并创建新用户...');
    const payload = await api('/api/users/create', {
      method: 'POST',
      body: { name }
    });
    state.users = payload.users || state.users;
    state.activeUser = payload.activeUser || state.activeUser;
    if (el.newUserName) {
      el.newUserName.value = '';
    }
    render();
    actionProgress.finish('新增成功', `已创建用户 ${payload.user?.name || '新用户'}。`);
  } catch (error) {
    actionProgress.fail('新增失败', error.message);
    alert(error.message);
  }
}

async function startRemoteLogin(serviceKey) {
  if (!state.connected) {
    return;
  }
  state.loginService = serviceKey;
  state.loginPreview = '';
  renderLoginPreview();
  loginProgress.start('打开登录页', '正在等待网页加载...');

  try {
    const payload = await api('/api/remote-login/start', {
      method: 'POST',
      body: { service: serviceKey }
    });
    state.loginPreview = payload.screenshot || '';
    renderLoginPreview();
    loginProgress.update(72, '等待扫码登录', '扫码完成后点击确认。');
  } catch (error) {
    loginProgress.fail('打开失败', error.message);
    state.loginService = '';
    renderLoginPreview();
    alert(error.message);
  }
}

async function confirmRemoteLogin() {
  if (!state.connected || !state.loginService) {
    return;
  }
  actionProgress.start('确认登录', '正在标记登录状态...');

  try {
    await api('/api/remote-login/confirm', {
      method: 'POST',
      body: { service: state.loginService }
    });
    state.loginService = '';
    state.loginPreview = '';
    renderLoginPreview();
    await refreshState();
    actionProgress.finish('确认完成', '已标记为登录成功。');
  } catch (error) {
    actionProgress.fail('确认失败', error.message);
    alert(error.message);
  }
}

async function cancelRemoteLogin() {
  if (!state.connected || !state.loginService) {
    return;
  }
  actionProgress.start('取消登录', '正在关闭登录页...');

  try {
    await api('/api/remote-login/cancel', {
      method: 'POST',
      body: { service: state.loginService }
    });
    state.loginService = '';
    state.loginPreview = '';
    renderLoginPreview();
    actionProgress.finish('已取消', '登录窗口已关闭。');
  } catch (error) {
    actionProgress.fail('取消失败', error.message);
    alert(error.message);
  }
}

async function runRemoteVoiceClone() {
  if (!state.connected) {
    return;
  }
  if (!state.selectedVoiceFile) {
    alert('请先选择语音样本文件。');
    return;
  }

  const referenceText = String(el.voiceCloneText?.value || '').trim();
  if (!referenceText) {
    alert('请填写样本文案。');
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(state.selectedVoiceFile);
    actionProgress.start('上传样本', '正在上传并启动语音克隆...');
    await api('/api/voice-clone/start', {
      method: 'POST',
      body: {
        sampleData: dataUrl,
        sampleName: state.selectedVoiceFile.name || 'voice-sample',
        referenceText,
        profileName: String(el.voiceCloneName?.value || '').trim(),
        language: String(el.voiceCloneLang?.value || 'zh').trim() || 'zh'
      }
    });
    actionProgress.finish('已提交', '语音克隆已开始执行。');
  } catch (error) {
    actionProgress.fail('提交失败', error.message);
    alert(error.message);
  }
}

async function startTasks() {
  if (!state.connected) {
    return;
  }
  const inputText = String(el.taskInput?.value || '').trim();
  if (!inputText) {
    alert('请输入任务内容。');
    return;
  }

  const userId = currentUserId();
  const optimistic = pushOptimisticMessages(userId, inputText);
  if (el.taskInput) {
    el.taskInput.value = '';
    writeTaskDraft(userId, '');
  }
  render();

  try {
    actionProgress.start('提交任务', '正在发送到桌面端...');
    const payload = await api('/api/start', {
      method: 'POST',
      body: { inputText }
    });
    const localIds = optimistic.map((item) => item.localId);
    patchOptimisticMessages(userId, localIds, (item, index) => ({
      runId: payload.runId || item.runId || '',
      taskId: Array.isArray(payload.taskIds) ? payload.taskIds[index] || item.taskId || '' : item.taskId || '',
      status: payload.queued ? 'queued' : 'running',
      message: payload.queued
        ? `等待执行，前方还有 ${Math.max(0, (payload.queuePosition || 1) - 1)} 个批次。`
        : '任务已提交到桌面端。'
    }));
    render();
    actionProgress.finish(
      payload.queued ? '已加入队列' : '已启动',
      payload.queued
        ? `任务已排队，前方还有 ${Math.max(0, (payload.queuePosition || 1) - 1)} 个批次。`
        : `已启动 ${payload.taskCount || 0} 条任务。`
    );
    await refreshState().catch(() => {});
  } catch (error) {
    patchOptimisticMessages(
      userId,
      optimistic.map((item) => item.localId),
      { status: 'failed', message: error.message }
    );
    render();
    actionProgress.fail('提交失败', error.message);
    alert(error.message);
  }
}

async function stopTasks() {
  if (!state.connected) {
    return;
  }

  try {
    actionProgress.start('停止任务', '正在停止执行并清空队列...');
    await api('/api/stop', {
      method: 'POST',
      body: {}
    });
    actionProgress.finish('已停止', '当前执行与排队批次都已停止。');
    await refreshState().catch(() => {});
  } catch (error) {
    actionProgress.fail('停止失败', error.message);
    alert(error.message);
  }
}

async function stopSingleTask(taskId) {
  if (!state.connected) {
    return;
  }
  try {
    await api('/api/task/stop-one', {
      method: 'POST',
      body: { taskId }
    });
    await refreshState().catch(() => {});
  } catch (error) {
    alert(error.message);
  }
}

function bindEvents() {
  el.connectBtn?.addEventListener('click', () => {
    connect().catch((error) => {
      el.authStatus.textContent = error.message;
    });
  });

  el.forgetBtn?.addEventListener('click', () => {
    setStoredUserId('');
    render();
  });

  el.authUserSelect?.addEventListener('change', () => {
    setStoredUserId(el.authUserSelect.value);
  });

  el.showHomeBtn?.addEventListener('click', () => {
    state.screen = 'home';
    render();
  });

  el.showTasksBtn?.addEventListener('click', () => {
    state.screen = 'tasks';
    render();
  });

  el.showSettingsBtn?.addEventListener('click', () => {
    state.screen = 'settings';
    render();
  });

  el.switchUserBtn?.addEventListener('click', () => {
    disconnect({
      clearUser: false,
      message: '请选择目标用户重新进入控制台。'
    }).catch(() => {});
  });

  el.backToLoginBtn?.addEventListener('click', () => {
    disconnect({
      clearUser: false,
      message: '请选择目标用户重新进入控制台。'
    }).catch(() => {});
  });

  el.refreshBtn?.addEventListener('click', () => {
    refreshState().catch((error) => alert(error.message));
  });

  el.reloadSettingsBtn?.addEventListener('click', () => {
    loadSettings().catch((error) => alert(error.message));
  });

  el.copyLocalBtn?.addEventListener('click', () => {
    copyTextToClipboard(resolvePrimaryLocalUrl(), '当前没有局域网地址。');
  });

  el.copyPublicBtn?.addEventListener('click', () => {
    copyTextToClipboard(state.server?.public?.url || '', '当前没有公网地址。');
  });

  el.startBtn?.addEventListener('click', () => {
    startTasks().catch((error) => alert(error.message));
  });

  el.stopBtn?.addEventListener('click', () => {
    stopTasks().catch((error) => alert(error.message));
  });

  el.renameUserBtn?.addEventListener('click', () => {
    renameCurrentUser().catch((error) => alert(error.message));
  });

  el.createUserBtn?.addEventListener('click', () => {
    createUser().catch((error) => alert(error.message));
  });

  el.userList?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="switch-user"]');
    if (!button) {
      return;
    }
    switchUser(button.dataset.userId).catch((error) => alert(error.message));
  });

  el.loginVideoBtn?.addEventListener('click', () => {
    startRemoteLogin('videoChannel').catch((error) => alert(error.message));
  });

  el.loginDouyinBtn?.addEventListener('click', () => {
    startRemoteLogin('douyin').catch((error) => alert(error.message));
  });

  el.loginGeminiBtn?.addEventListener('click', () => {
    startRemoteLogin('gemini').catch((error) => alert(error.message));
  });

  el.loginConfirmBtn?.addEventListener('click', () => {
    confirmRemoteLogin().catch((error) => alert(error.message));
  });

  el.loginCancelBtn?.addEventListener('click', () => {
    cancelRemoteLogin().catch((error) => alert(error.message));
  });

  el.voiceCloneFile?.addEventListener('change', () => {
    const file = el.voiceCloneFile.files?.[0] || null;
    state.selectedVoiceFile = file;
    if (el.voiceCloneFileName) {
      el.voiceCloneFileName.textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB` : '尚未选择文件';
    }
  });

  el.voiceCloneRunBtn?.addEventListener('click', () => {
    runRemoteVoiceClone().catch((error) => alert(error.message));
  });

  el.saveSettingsBtn?.addEventListener('click', () => {
    saveSettings().catch((error) => alert(error.message));
  });

  if (getSettingsField('voiceoverEnabled')) {
    getSettingsField('voiceoverEnabled').addEventListener('change', syncNarrationToggles);
  }

  el.taskInput?.addEventListener('input', () => {
    writeTaskDraft(state.activeUser?.id, el.taskInput.value);
    renderButtons();
  });

  el.taskList?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="cancel-task"]');
    if (!button) {
      return;
    }
    stopSingleTask(button.dataset.taskId).catch((error) => alert(error.message));
  });
}

async function init() {
  bindEvents();
  await fetchUsers().catch((error) => {
    if (el.authStatus) {
      el.authStatus.textContent = error.message;
    }
  });
  if (state.users.length) {
    await connect(
      state.userId
      || state.activeUser?.id
      || state.users.find((user) => user.isActive)?.id
      || state.users[0]?.id,
      { showProgress: false }
    ).catch(() => {});
  }
  render();
}

init();
