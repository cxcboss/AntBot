export function createDownloadPage({ state: S, toast, esc, injectIcons }) {
/* ── Download page ── */
S.downloadTasks = [];

async function initDownloadPage() {
  const setup = document.getElementById('dl-setup');
  const ytLogin = document.getElementById('dl-yt-login');
  const list = document.getElementById('dl-list');
  if (!setup || !list) return;
  try {
    const [ytdlp, ffmpeg] = await Promise.all([
      window.antbot.downloadCheckYtdlp(),
      window.antbot.downloadCheckFfmpeg()
    ]);
    if (!ytdlp.available) {
      setup.classList.remove('hidden');
      list.style.display = 'none';
      if (ytLogin) ytLogin.classList.add('hidden');
    } else {
      setup.classList.add('hidden');
      list.style.display = '';
      if (!ffmpeg.available) {
        toast('未检测到 ffmpeg，请在设置页面安装依赖', 'warning');
      }
      // 检查 YouTube cookies，没有才显示登录提示
      try {
        const hasYtCookies = await window.antbot.downloadCheckYoutubeCookies();
        if (ytLogin && !hasYtCookies) ytLogin.classList.remove('hidden');
      } catch {}
      await loadDownloadTasks();
    }
  } catch {}
}

async function loadDownloadTasks() {
  try {
    S.downloadTasks = await window.antbot.downloadList() || [];
    renderDownloadCards();
  } catch {}
}

function handleDownloadTaskUpdate(task) {
  const idx = S.downloadTasks.findIndex(t => t.id === task.id);
  if (idx >= 0) S.downloadTasks[idx] = task;
  else S.downloadTasks.push(task);
  renderDownloadCards();
}

// 多选状态
S.selectedDlTasks = new Set();

function renderDownloadCards() {
  const cards = document.getElementById('dl-cards');
  const empty = document.getElementById('dl-empty');
  if (!cards) return;
  if (!S.downloadTasks.length) {
    cards.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  // 按创建时间排序，最旧在上，最新在下
  const sorted = [...S.downloadTasks].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const platformClass = { YouTube: 'yt', '抖音': 'dy', TikTok: 'tk', 'B站': 'b' };
  const hasSelected = S.selectedDlTasks.size > 0;

  cards.innerHTML = sorted.map(t => {
    const selected = S.selectedDlTasks.has(t.id) ? ' selected' : '';
    const time = t.createdAt ? new Date(t.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

    let statusHtml = '';
    if (t.status === 'pending') {
      statusHtml = '<span class="dl-status dl-status-pending"><span class="dl-dots">准备</span></span>';
    } else if (t.status === 'downloading' || t.status === 'merging') {
      statusHtml = `<span class="dl-status dl-status-active">${Math.round(t.progress || 0)}% ${t.speed ? esc(t.speed) : ''}</span>`;
    } else if (t.status === 'completed') {
      statusHtml = '<span class="dl-status dl-status-done">完成</span>';
    } else if (t.status === 'failed') {
      statusHtml = '<span class="dl-status dl-status-fail">下载失败</span>';
    } else if (t.status === 'cancelled') {
      statusHtml = '<span class="dl-status">已取消</span>';
    }

    const displayName = t.filename || t.url;
    const showOpen = t.status === 'completed' && t.outputPath;
    const showClean = t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled';

    return `<div class="dl-card${selected}" data-dl-id="${esc(t.id)}">
      <div class="dl-card-head">
        <span class="dl-card-platform">${esc(t.platform)}</span>
        <span class="dl-card-name">${esc(displayName)}</span>
        ${statusHtml}
        <span class="dl-card-actions">
          ${showOpen ? `<button class="dl-icon-btn" data-dl-open="${esc(t.id)}" title="打开文件"><span class="icon" data-icon="folderOpen"></span></button>` : ''}
          ${showClean ? `<button class="dl-icon-btn" data-dl-clean="${esc(t.id)}" title="清理记录"><span class="icon" data-icon="trash"></span></button>` : ''}
        </span>
      </div>
      <div class="dl-card-url">${esc(t.url)}</div>
      <div class="dl-card-time">${time}</div>
    </div>`;
  }).join('');

  injectIcons();

  // 按钮事件
  cards.querySelectorAll('[data-dl-open]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const task = S.downloadTasks.find(t => t.id === btn.dataset.dlOpen);
      if (task?.outputPath) window.antbot.revealInFolder(task.outputPath).catch(() => {});
    });
  });
  cards.querySelectorAll('[data-dl-clean]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.dlClean;
      await window.antbot.downloadCleanTask(id);
      S.downloadTasks = S.downloadTasks.filter(t => t.id !== id);
      S.selectedDlTasks.delete(id);
      renderDownloadCards();
    });
  });

  // 启动等待动画
  startDlDotsAnimation();

  // 点击选中（Shift 多选）
  cards.querySelectorAll('.dl-card').forEach(card => {
    card.addEventListener('click', (e) => {
      const id = card.dataset.dlId;
      if (e.shiftKey) {
        if (S.selectedDlTasks.has(id)) S.selectedDlTasks.delete(id);
        else S.selectedDlTasks.add(id);
      } else {
        S.selectedDlTasks.clear();
        S.selectedDlTasks.add(id);
      }
      renderDownloadCards();
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // 右键自动选中
      if (!S.selectedDlTasks.has(card.dataset.dlId)) {
        S.selectedDlTasks.clear();
        S.selectedDlTasks.add(card.dataset.dlId);
        renderDownloadCards();
      }
      showDownloadContextMenu(e);
    });
  });

  // 批量清理按钮
  const batchBtn = document.getElementById('dl-batch-clean');
  if (batchBtn) batchBtn.style.display = hasSelected ? '' : 'none';
}

// 等待动画：准备. 准备.. 准备...
let _dlDotsTimer = null;
function startDlDotsAnimation() {
  if (_dlDotsTimer) return;
  let dots = 0;
  _dlDotsTimer = setInterval(() => {
    dots = (dots + 1) % 4;
    document.querySelectorAll('.dl-dots').forEach(el => {
      el.textContent = '准备' + '.'.repeat(dots || 1);
    });
  }, 400);
}

function showDownloadContextMenu(e) {
  document.querySelectorAll('.dl-ctx-menu').forEach(m => m.remove());
  const selectedIds = [...S.selectedDlTasks];
  if (!selectedIds.length) return;

  const menu = document.createElement('div');
  menu.className = 'dl-ctx-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  const items = [];
  if (selectedIds.length === 1) {
    const task = S.downloadTasks.find(t => t.id === selectedIds[0]);
    if (task?.status === 'failed' || task?.status === 'cancelled') {
      items.push({ label: '重试下载', action: () => window.antbot.downloadRetry(selectedIds[0]) });
    }
    if (task?.status === 'downloading' || task?.status === 'merging') {
      items.push({ label: '取消下载', action: () => window.antbot.downloadCancel(selectedIds[0]) });
    }
    if (task?.outputPath) {
      items.push({ label: '打开文件', action: () => window.antbot.revealInFolder(task.outputPath).catch(() => {}) });
      items.push({ label: '删除文件', action: async () => {
        if (!window.confirm(`确认删除文件？`)) return;
        await window.antbot.downloadDeleteFile(selectedIds[0]);
        S.downloadTasks = S.downloadTasks.filter(t => t.id !== selectedIds[0]);
        S.selectedDlTasks.clear();
        renderDownloadCards();
      }});
    }
  }
  items.push({ label: `清理${selectedIds.length > 1 ? selectedIds.length + '条' : ''}记录`, action: async () => {
    for (const id of selectedIds) {
      await window.antbot.downloadCleanTask(id);
    }
    S.downloadTasks = S.downloadTasks.filter(t => !selectedIds.includes(t.id));
    S.selectedDlTasks.clear();
    renderDownloadCards();
  }});

  menu.innerHTML = items.map(i => `<button class="dl-ctx-item">${i.label}</button>`).join('');
  document.body.appendChild(menu);

  const btns = menu.querySelectorAll('.dl-ctx-item');
  items.forEach((item, idx) => {
    btns[idx]?.addEventListener('click', () => { item.action(); menu.remove(); });
  });
  const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function bindDownloadPage() {
  document.getElementById('dl-install-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('dl-install-btn');
    const hint = document.getElementById('dl-setup-hint');
    if (btn) { btn.disabled = true; btn.textContent = '安装中...'; }
    if (hint) hint.textContent = '';
    try {
      const r = await window.antbot.downloadInstallYtdlp();
      if (r.ok) {
        toast('yt-dlp 安装成功', 'success');
        document.getElementById('dl-setup')?.classList.add('hidden');
        document.getElementById('dl-list').style.display = '';
        await loadDownloadTasks();
      } else {
        if (hint) hint.textContent = '安装失败: ' + r.error;
      }
    } catch (e) {
      if (hint) hint.textContent = '安装失败: ' + e.message;
    }
    if (btn) { btn.disabled = false; btn.textContent = '一键安装'; }
  });

  // YouTube login
  document.getElementById('dl-yt-login-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('dl-yt-login-btn');
    if (btn) { btn.disabled = true; btn.textContent = '请在弹出窗口中登录...'; }
    try {
      const r = await window.antbot.downloadLoginYoutube();
      if (r.ok) {
        toast(`YouTube 登录成功，已保存 cookies`, 'success');
        document.getElementById('dl-yt-login')?.classList.add('hidden');
      } else {
        toast(r.error || '登录失败', 'error');
      }
    } catch (e) { toast('登录失败: ' + e.message, 'error'); }
    if (btn) { btn.disabled = false; btn.textContent = '登录 YouTube'; }
  });
  document.getElementById('dl-yt-skip-btn')?.addEventListener('click', () => {
    document.getElementById('dl-yt-login')?.classList.add('hidden');
  });

  // 全选 / 批量清理
  document.getElementById('dl-select-all')?.addEventListener('click', () => {
    if (S.selectedDlTasks.size === S.downloadTasks.length) {
      S.selectedDlTasks.clear();
    } else {
      S.downloadTasks.forEach(t => S.selectedDlTasks.add(t.id));
    }
    renderDownloadCards();
  });
  document.getElementById('dl-batch-clean')?.addEventListener('click', async () => {
    const ids = [...S.selectedDlTasks];
    if (!ids.length) return;
    if (!window.confirm(`确认清理 ${ids.length} 条记录？`)) return;
    for (const id of ids) {
      await window.antbot.downloadCleanTask(id);
    }
    S.downloadTasks = S.downloadTasks.filter(t => !ids.includes(t.id));
    S.selectedDlTasks.clear();
    renderDownloadCards();
  });

  const input = document.getElementById('dl-input');
  if (input) {
    // Auto-resize
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.disabled = true;
        try {
          const r = await window.antbot.downloadAdd(text);
          if (r.ok) {
            const count = r.tasks?.length || 0;
            toast(`已添加 ${count} 个下载任务`, 'success');
            input.value = '';
            input.style.height = 'auto';
          } else {
            toast(r.error || '添加失败', 'error');
          }
        } catch (err) { toast(err.message, 'error'); }
        input.disabled = false;
        input.focus();
      }
    });
  }
}


  function stopAnimations() {
    if (_dlDotsTimer) { clearInterval(_dlDotsTimer); _dlDotsTimer = null; }
  }

  return {
    init: initDownloadPage,
    bind: bindDownloadPage,
    handleTaskUpdate: handleDownloadTaskUpdate,
    stopAnimations,
  };
}
