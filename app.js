const el = {
  input: document.querySelector('#task-input'),
  runBtn: document.querySelector('#run-btn'),
  stopBtn: document.querySelector('#stop-btn'),
  startupStatus: document.querySelector('#startup-status'),
  rightTitle: document.querySelector('#right-title'),
  progressView: document.querySelector('#progress-view'),
  historyView: document.querySelector('#history-view'),
  taskList: document.querySelector('#task-list'),
  historyList: document.querySelector('#history-list'),
  historyBtn: document.querySelector('#history-btn'),
  settingsBtn: document.querySelector('#settings-btn'),
  refreshStartupBtn: document.querySelector('#refresh-startup-btn'),
  settingsDialog: document.querySelector('#settings-dialog'),
  settingsForm: document.querySelector('#settings-form'),
  saveSettingsBtn: document.querySelector('#save-settings-btn'),
  closeSettingsBtn: document.querySelector('#close-settings-btn'),
  cloneVoiceBtn: document.querySelector('#clone-voice-btn'),
  pickSampleBtn: document.querySelector('#pick-sample-btn')
};

const state = {
  settings: null,
  history: [],
  progress: null,
  startup: null,
  runtimeHint: '',
  activeRightView: 'history'
};

const SERVICE_LABELS = {
  videoChannel: '视频号',
  douyin: '抖音',
  gemini: 'Gemini'
};

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
    return value;
  }

  const y = String(date.getFullYear()).slice(-2);
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm} - ${m}月${d}日${y}年`;
}

function statusText(status) {
  const map = {
    pending: '等待',
    running: '执行中',
    completed: '完成',
    failed: '错误',
    stopped: '取消'
  };
  return map[status] || status;
}

function setRunning(running) {
  el.runBtn.disabled = running;
  el.stopBtn.disabled = !running;
  if (running) {
    state.activeRightView = 'progress';
  }
  updateRightView();
}

function ensureStartupReady() {
  if (state.startup?.type !== 'result') {
    alert('请先完成启动检查。');
    return false;
  }

  const loginState = state.startup.result.loginState || {};
  const videoReady = Boolean(loginState.videoChannel?.loggedIn);
  const douyinReady = Boolean(loginState.douyin?.loggedIn);
  if (!videoReady && !douyinReady) {
    alert('请先登录抖音或视频号（任一即可）。');
    state.activeRightView = 'history';
    return false;
  }

  if (!state.startup.result.voiceCloneReady) {
    alert('语音克隆未完成，请先在设置中完成语音克隆或填写 voiceId。');
    return false;
  }

  return true;
}

function renderStartupStatus() {
  if (!state.startup) {
    el.startupStatus.textContent = '等待启动检查';
    return;
  }

  if (state.startup.type === 'log') {
    el.startupStatus.textContent = state.startup.message;
    return;
  }

  const result = state.startup.result;
  const loginState = result.loginState || {};
  const tags = [];

  const videoReady = Boolean(loginState.videoChannel?.loggedIn);
  const douyinReady = Boolean(loginState.douyin?.loggedIn);
  tags.push(`平台登录:${videoReady || douyinReady ? '已就绪' : '未就绪'}`);
  tags.push(`视频号:${videoReady ? '已登录' : '未登录'}`);
  tags.push(`抖音:${douyinReady ? '已登录' : '未登录'}`);

  if (loginState.gemini) {
    if (loginState.gemini.source === 'skipped') {
      tags.push('Gemini:已跳过检查');
    } else {
      tags.push(`Gemini:${loginState.gemini.loggedIn ? '已登录' : '未登录'}`);
    }
  }

  tags.push(`语音克隆:${result.voiceCloneReady ? '已就绪' : '未完成'}`);
  if (state.runtimeHint) {
    tags.push(state.runtimeHint);
  }
  el.startupStatus.textContent = tags.join(' | ');
}

function renderProgress() {
  const tasks = state.progress?.tasks || [];
  if (!tasks.length) {
    el.taskList.innerHTML = '<div class="task-card">暂无执行中的任务。</div>';
    return;
  }

  el.rightTitle.textContent = `任务列表 ${tasks.length}个`;

  el.taskList.innerHTML = tasks
    .map((task) => {
      const barClass = task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : '';
      return `
        <article class="task-card">
          <div class="task-title">任务${task.index}：${escapeHtml(task.taskName)}</div>
          <div class="task-meta">
            <span>${escapeHtml(task.step || '--')}</span>
            <span class="status ${task.status}">${statusText(task.status)}</span>
          </div>
          <div class="progress-track">
            <div class="progress-bar ${barClass}" style="width: ${task.progress || 0}%"></div>
          </div>
          <div class="task-meta" style="margin-top:8px; font-size:14px;">
            <span>${escapeHtml(task.message || '')}</span>
            <span>${task.progress || 0}%</span>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderHistory() {
  if (!state.history.length) {
    el.historyList.innerHTML = '<article class="history-card">暂无历史记录。</article>';
    return;
  }

  el.rightTitle.textContent = '任务历史';

  el.historyList.innerHTML = state.history
    .map((run) => {
      const items = (run.items || []).map((item) => {
        const cls = item.status === 'completed' ? 'done' : item.status === 'failed' ? 'error' : 'stopped';
        return `<div class="history-item"><span>${escapeHtml(item.taskName)}</span><strong class="${cls}">${statusText(item.status)}</strong></div>`;
      }).join('');

      return `
        <article class="history-card">
          <h4>${formatDate(run.startedAt)}</h4>
          <hr />
          ${items || '<div class="history-item"><span>无明细</span></div>'}
        </article>
      `;
    })
    .join('');
}

function updateRightView() {
  const showProgress = state.activeRightView === 'progress';
  el.progressView.classList.toggle('hidden', !showProgress);
  el.historyView.classList.toggle('hidden', showProgress);
  el.historyBtn.classList.toggle('active', !showProgress);
  renderProgress();
  renderHistory();
}

function fillSettingsForm() {
  const settings = state.settings;
  if (!settings) {
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
  form.editCmd.value = settings.commands.edit || '';
  form.publishCmd.value = settings.commands.publish || '';
  form.voiceCloneCmd.value = settings.commands.voiceClone || '';
  form.cloneSamplePath.value = settings.voiceClone.samplePath || '';
  form.cloneReferenceText.value = settings.voiceClone.referenceText || '';
  form.cloneProfileName.value = settings.voiceClone.profileName || '';

  form.voiceSpeed.value = settings.style.voiceSpeed ?? 1.1;
  form.subtitleTextColor.value = settings.style.subtitleTextColor || '#FFDD00';
  form.subtitleStrokeColor.value = settings.style.subtitleStrokeColor || '#FFFFFF';

  form.pauseBetweenTasksMs.value = settings.browser.pauseBetweenTasksMs ?? 2500;
  form.actionDelayMs.value = settings.browser.actionDelayMs ?? 1500;
  form.showAutomationWindow.value = String(Boolean(settings.browser.showAutomationWindow));

  form.voiceId.value = settings.voiceClone.voiceId || '';
  form.modelPath.value = settings.voiceClone.modelPath || '';
}

function readSettingsForm() {
  const form = el.settingsForm;
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
    style: {
      voiceSpeed: Number(form.voiceSpeed.value || 1.1),
      subtitleTextColor: form.subtitleTextColor.value.trim() || '#FFDD00',
      subtitleStrokeColor: form.subtitleStrokeColor.value.trim() || '#FFFFFF'
    },
    browser: {
      pauseBetweenTasksMs: Number(form.pauseBetweenTasksMs.value || 2500),
      actionDelayMs: Number(form.actionDelayMs.value || 1500),
      showAutomationWindow: form.showAutomationWindow.value === 'true'
    },
    voiceClone: {
      voiceId: form.voiceId.value.trim(),
      modelPath: form.modelPath.value.trim(),
      samplePath: form.cloneSamplePath.value.trim(),
      referenceText: form.cloneReferenceText.value.trim(),
      profileName: form.cloneProfileName.value.trim()
    }
  };
}

async function runStartupCheck() {
  state.runtimeHint = '';
  state.startup = { type: 'log', message: '正在进行启动检查...' };
  renderStartupStatus();
  try {
    const result = await window.antbot.checkStartup();
    state.startup = { type: 'result', result };
    renderStartupStatus();
  } catch (error) {
    state.startup = { type: 'log', message: `启动检查失败：${error.message}` };
    renderStartupStatus();
  }
}

function bindEvents() {
  el.historyBtn.addEventListener('click', () => {
    state.activeRightView = 'history';
    updateRightView();
  });

  el.settingsBtn.addEventListener('click', () => {
    fillSettingsForm();
    el.settingsDialog.showModal();
  });

  el.closeSettingsBtn.addEventListener('click', () => {
    el.settingsDialog.close();
  });

  el.saveSettingsBtn.addEventListener('click', async () => {
    try {
      const partial = readSettingsForm();
      const updated = await window.antbot.updateSettings(partial);
      state.settings = updated;
      el.settingsDialog.close();
      state.runtimeHint = '设置已保存。';
      renderStartupStatus();
    } catch (error) {
      alert(`保存失败：${error.message}`);
    }
  });

  el.refreshStartupBtn.addEventListener('click', runStartupCheck);

  el.runBtn.addEventListener('click', async () => {
    const raw = el.input.value.trim();
    if (!raw) {
      alert('请输入任务内容。');
      return;
    }

    if (!ensureStartupReady()) {
      return;
    }

    try {
      const parsed = await window.antbot.parseTasks(raw);
      if (!parsed.length) {
        alert('未识别到有效任务。');
        return;
      }

      setRunning(true);
      await window.antbot.startTasks(raw);
    } catch (error) {
      setRunning(false);
      alert(`启动任务失败：${error.message}`);
    }
  });

  el.stopBtn.addEventListener('click', async () => {
    await window.antbot.stopTasks();
  });

  el.cloneVoiceBtn.addEventListener('click', async () => {
    const samplePath = el.settingsForm.cloneSamplePath.value.trim();
    const referenceText = el.settingsForm.cloneReferenceText.value.trim();
    const profileName = el.settingsForm.cloneProfileName.value.trim();

    if (!samplePath) {
      alert('请先填写或选择样本音频路径。');
      return;
    }

    if (!referenceText) {
      alert('请先填写样本参考文本。');
      return;
    }

    try {
      const voiceClone = await window.antbot.runVoiceClone({
        samplePath,
        referenceText,
        profileName,
        language: 'zh'
      });
      state.settings.voiceClone = voiceClone;
      fillSettingsForm();
      state.runtimeHint = `语音克隆完成：${voiceClone.voiceId}`;
      renderStartupStatus();
      await runStartupCheck();
    } catch (error) {
      alert(`语音克隆失败：${error.message}`);
    }
  });

  el.pickSampleBtn.addEventListener('click', async () => {
    try {
      const selected = await window.antbot.pickAudioFile();
      if (!selected) {
        return;
      }
      el.settingsForm.cloneSamplePath.value = selected;
    } catch (error) {
      alert(`选择样本失败：${error.message}`);
    }
  });

  document.querySelectorAll('[data-login-service]').forEach((button) => {
    button.addEventListener('click', async () => {
      const service = button.getAttribute('data-login-service');
      const serviceLabel = SERVICE_LABELS[service] || service;
      try {
        await window.antbot.openLoginWindow(service);
        const confirmed = window.confirm(`已打开${serviceLabel}登录窗口。完成登录后点击“确定”标记为已登录。`);
        if (confirmed) {
          await window.antbot.markLoginDone(service);
          await runStartupCheck();
        }
      } catch (error) {
        alert(`打开登录窗口失败：${error.message}`);
      }
    });
  });

  window.antbot.onProgress((payload) => {
    state.progress = payload;
    setRunning(Boolean(payload.running));
    renderProgress();

    if (!payload.running) {
      state.activeRightView = 'history';
      updateRightView();
    }
  });

  window.antbot.onLog((payload) => {
    if (!payload?.message) {
      return;
    }
    state.runtimeHint = payload.message;
    renderStartupStatus();
  });

  window.antbot.onStartupStatus((payload) => {
    state.startup = payload;
    renderStartupStatus();
  });

  window.antbot.onHistoryChanged((history) => {
    state.history = history || [];
    renderHistory();
  });
}

async function init() {
  bindEvents();

  const initial = await window.antbot.getInitialState();
  state.settings = initial.settings;
  state.history = initial.history || [];
  state.progress = { running: initial.running, tasks: [] };

  fillSettingsForm();
  updateRightView();
  renderHistory();
  renderProgress();
  renderStartupStatus();

  setRunning(Boolean(initial.running));
  await runStartupCheck();
}

init();
