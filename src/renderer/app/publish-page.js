/* 发布页 v2：每视频 × 每平台独立参数（文案/话题/定时/原创/活动） */
export function createPublishPage({ state: S, esc }) {
  function bindPublishPage() {
    const pick = document.getElementById('publish-pick-videos-btn');
    const mainBtn = document.getElementById('publish-main-btn');
    const publishView = document.getElementById('view-publish');
    const videoList = document.getElementById('publish-video-list');
    const historyList = document.getElementById('publish-history-list');
    const tabPending = document.getElementById('publish-tab-pending');
    const tabDone = document.getElementById('publish-tab-done');
    const pendingCount = document.getElementById('publish-pending-count');
    const doneCount = document.getElementById('publish-done-count');
    const bridgeToggleBtn = document.getElementById('publish-bridge-toggle-btn');
    const bridgeStatus = document.getElementById('publish-bridge-status');
    let currentTab = 'pending';
    let serviceRunning = false;

    S.publish = { videos: [], defaults: { videoChannel: defaultParams(), douyin: defaultParams() }, history: S.publish?.history || [], running: false };

    const PLATFORM_LABEL = { videoChannel: '视频号', douyin: '抖音' };
    const formatSize = bytes => { const n = Number(bytes || 0); if (!n) return ''; return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`; };
    const getFileName = p => String(p || '').split(/[\\/]/).pop();
    const fmtTime = d => { const x = new Date(d); if (isNaN(x)) return ''; const p = n => String(n).padStart(2, '0'); return `${p(x.getHours())}:${p(x.getMinutes())}`; };

    function defaultParams() {
      return { isOriginal: false, publishAt: null, campaignName: '', publishCopy: '', publishTopics: [] };
    }
    const otherPlat = p => p === 'videoChannel' ? 'douyin' : 'videoChannel';
    const cloneParams = p => ({ ...p, publishTopics: Array.isArray(p.publishTopics) ? p.publishTopics.slice() : [] });

    /* 5 天窗口日期选项 */
    function dateOptions(selected) {
      const now = new Date();
      const opts = [];
      for (let i = 0; i < 5; i++) {
        const d = new Date(now); d.setDate(d.getDate() + i);
        const label = i === 0 ? '今天' : i === 1 ? '明天' : `${d.getMonth() + 1}/${d.getDate()}`;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        opts.push(`<option value="${key}"${key === selected ? ' selected' : ''}>${label}</option>`);
      }
      return opts.join('');
    }

    /* ── 持久化 ── */
    const saveTasks = () => { window.antbot.publishTasksSave(S.publish.videos).catch(() => {}); };
    const loadTasks = async () => {
      try {
        const tasks = await window.antbot.publishTasksLoad();
        if (Array.isArray(tasks) && tasks.length) {
          S.publish.videos = tasks.map(t => ({
            ...t,
            params: {
              videoChannel: { ...defaultParams(), ...(t.params?.videoChannel || {}) },
              douyin: { ...defaultParams(), ...(t.params?.douyin || {}) }
            },
            platforms: Array.isArray(t.platforms) && t.platforms.length ? t.platforms : ['videoChannel'],
            status: 'pending', message: ''
          }));
        }
      } catch (e) { console.error('加载发布任务失败:', e); }
    };
    const loadPublishHistory = async () => {
      try { S.publish.history = (await window.antbot.publishGetRecords()) || []; } catch {}
    };

    /* ── 视频添加 ── */
    const addVideos = (paths) => {
      const dflt = S.publish.defaults;
      for (const p of paths) {
        S.publish.videos.push({
          id: `pv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          path: p, name: getFileName(p), size: 0,
          platforms: ['videoChannel'],
          params: { videoChannel: cloneParams(dflt.videoChannel), douyin: cloneParams(dflt.douyin) },
          status: 'pending', message: ''
        });
      }
      saveTasks(); render();
    };

    /* ── 渲染 ── */
    function renderCard(v, i) {
      const st = v.status || 'pending';
      const badge = st === 'running' ? '发布中' : st === 'done' ? '成功' : st === 'failed' ? '失败' : '';
      const platChips = ['videoChannel', 'douyin'].map(p =>
        `<button class="pv2-plat-chip${v.platforms.includes(p) ? ' on' : ''}" data-card-plat="${i}:${p}" type="button">${PLATFORM_LABEL[p]}</button>`).join('');

      // 当前平台（优先第一个选中平台）
      const curPlat = v.platforms[0] || 'videoChannel';
      const paramsFor = (plat) => {
        const q = v.params[plat];
        const isD = plat === 'douyin';
        const hasCampaign = !!q.campaignName;
        const canSchedule = !(isD && hasCampaign);
        const campDisabled = isD && !!q.publishAt;
        const timeChip = q.publishAt
          ? `定时 ${new Date(q.publishAt).getMonth() + 1}/${new Date(q.publishAt).getDate()} ${fmtTime(q.publishAt)}`
          : '立即发布';
        const origChip = `<span class="pv2-chip${q.isOriginal ? ' pv2-chip-original' : ''}" data-card-orig="${i}:${plat}" title="点击切换">${q.isOriginal ? '原创' : '不原创'}</span>`;
        const timeSel = canSchedule
          ? `<span class="pv2-chip pv2-chip-time" data-card-time="${i}:${plat}" title="点击设置定时">${timeChip}</span>`
          : `<span class="pv2-chip pv2-chip-disabled" title="抖音参加活动后不可定时发布">立即发布</span>`;
        const campInp = `<input class="pv2-activity-input" data-card-campaign="${i}:${plat}" placeholder="活动名（留空=不参加）" value="${esc(q.campaignName || '')}"${campDisabled ? ' disabled title="已设定时，抖音定时与活动互斥"' : ''} />`;
        const copyInp = `<input class="pv2-copy-input" data-card-copy="${i}:${plat}" placeholder="发布文案（留空=默认）" value="${esc(q.publishCopy || '')}" />`;
        const topicsInp = `<input class="pv2-topics-input" data-card-topics="${i}:${plat}" placeholder="#话题1 #话题2" value="${esc((q.publishTopics || []).join(' '))}" />`;
        return { origChip, timeSel, campInp, copyInp, topicsInp, isD };
      };
      const pv = paramsFor(curPlat);
      const timePicker = `<div class="pv2-time-picker hidden" data-time-picker="${i}:${curPlat}">
        <select class="pv2-date" data-time-date>${dateOptions('')}</select>
        <input class="pv2-time" type="time" data-time-val />
        <button class="btn btn-xs btn-ghost" data-time-now type="button">立即</button>
      </div>`;

      return `<div class="pv2-card ${st === 'failed' ? 'failed' : ''}" data-vid="${esc(v.id)}">
        <div class="pv2-card-head">
          <span class="pv2-card-name" title="${esc(v.path)}">${esc(v.name)}</span>
          <span class="pv2-card-size">${formatSize(v.size)}</span>
          <span class="pv2-card-status">${esc(badge)}</span>
          <button class="btn btn-xs btn-ghost pv2-card-del" data-card-del="${i}" type="button"${S.publish.running ? ' disabled title="发布中不可移除"' : ''}>移除</button>
        </div>
        <div class="pv2-card-plats">${platChips}</div>
        <div class="pv2-card-params">
          <span class="pv2-plat-ind">${PLATFORM_LABEL[curPlat]}参数</span>
          <div class="pv2-param-row">
            ${pv.origChip}${pv.timeSel}${pv.campInp}
            <button class="btn btn-xs btn-ghost" data-card-copyplat="${i}:${curPlat}" type="button" title="复制该平台参数到另一平台">复制到${PLATFORM_LABEL[otherPlat(curPlat)]}</button>
          </div>
          ${timePicker}
          <div class="pv2-param-row">${pv.copyInp}${pv.topicsInp}</div>
        </div>
      </div>`;
    }

    function render() {
      if (!videoList) return;
      const videos = S.publish.videos || [];
      pendingCount.textContent = videos.length;
      videoList.innerHTML = videos.length
        ? videos.map((v, i) => renderCard(v, i)).join('')
        : '<div class="publish-empty">拖拽视频文件到此处，或点击下方"添加"按钮</div>';
      mainBtn.disabled = !videos.length || S.publish.running;
      mainBtn.textContent = S.publish.running ? '发布中...' : `批量发布 (${videos.length})`;
      renderHistory();
      renderDefaults();
      saveTasks();
    }

    /* 全局默认区 */
    function renderDefaults() {
      const d = S.publish.defaults;
      const active = document.querySelector('#pv2-default-tabs .pv2-plat-tab.active')?.dataset?.plat || 'videoChannel';
      const q = d[active];
      const o = document.getElementById('pv2-def-original');
      if (o) { o.textContent = q.isOriginal ? '原创' : '不原创'; o.classList.toggle('pv2-chip-original', !!q.isOriginal); }
      const t = document.getElementById('pv2-def-time');
      if (t) t.textContent = q.publishAt ? `定时 ${new Date(q.publishAt).getMonth() + 1}/${new Date(q.publishAt).getDate()} ${fmtTime(q.publishAt)}` : '立即发布';
      const cp = document.getElementById('pv2-def-copy'); if (cp) cp.value = q.publishCopy || '';
      const tp = document.getElementById('pv2-def-topics'); if (tp) tp.value = (q.publishTopics || []).join(' ');
      const act = document.getElementById('pv2-def-activity'); if (act) act.value = q.campaignName || '';
      const cpBtn = document.getElementById('pv2-copy-plat');
      if (cpBtn) cpBtn.textContent = `复制到${PLATFORM_LABEL[otherPlat(active)]}`;
    }

    function renderHistory() {
      if (!historyList) return;
      const h = S.publish.history || [];
      doneCount.textContent = h.length;
      historyList.innerHTML = h.length ? h.map(r => `
        <div class="pv2-history-item">
          <span class="pv2-history-name">${esc(r.videoName || '')}</span>
          <span class="pv2-history-meta">${PLATFORM_LABEL[r.platform === 'weixin' ? 'videoChannel' : 'douyin'] || r.platform || ''} · ${esc(r.status || '')}${r.scheduled ? ' · 定时' : ''}</span>
        </div>`).join('') : '<div class="publish-empty">暂无发布记录</div>';
    }

    /* ── 时间选择弹层 ── */
    function openTimePicker(key) {
      const [i, plat] = key.split(':');
      const v = S.publish.videos[Number(i)]; if (!v) return;
      const q = v.params[plat];
      const picker = document.querySelector(`[data-time-picker="${key}"]`);
      if (!picker) return;
      document.querySelectorAll('.pv2-time-picker').forEach(el => el.classList.add('hidden'));
      picker.classList.toggle('hidden');
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const sel = q.publishAt ? new Date(q.publishAt) : null;
      const dateKey = sel ? `${sel.getFullYear()}-${String(sel.getMonth() + 1).padStart(2, '0')}-${String(sel.getDate()).padStart(2, '0')}` : today;
      picker.querySelector('[data-time-date]').innerHTML = dateOptions(dateKey);
      picker.querySelector('[data-time-val]').value = sel ? fmtTime(sel) : fmtTime(now);
    }

    function setCardTime(key, dateKey, timeStr) {
      const [i, plat] = key.split(':');
      const v = S.publish.videos[Number(i)]; if (!v) return;
      const q = v.params[plat];
      const [y, m, d] = dateKey.split('-').map(Number);
      const [hh, mm] = String(timeStr || '10:30').split(':').map(Number);
      q.publishAt = new Date(y, m - 1, d, hh, mm);
      if (q.publishAt.getTime() <= Date.now()) {
        // 过期时间自动顺延一天（仍在 5 天窗口内）
        q.publishAt = new Date(q.publishAt.getTime() + 24 * 3600 * 1000);
      }
      // 抖音活动与定时互斥
      if (plat === 'douyin' && q.campaignName) q.publishAt = null;
      render();
    }

    /* ── 批量发布 ── */
    async function startPublish() {
      const videos = S.publish.videos || [];
      if (!videos.length || S.publish.running) return;
      S.publish.running = true;
      mainBtn.disabled = true;
      render();
      const resultEl = document.getElementById('publish-result');
      let done = 0, failed = 0;
      const snapshot = [...videos]; // 迭代快照，避免运行中数组被 splice 打乱索引
      const completedIds = new Set();
      for (let i = 0; i < snapshot.length; i++) {
        const v = snapshot[i];
        v.status = 'running'; v.message = ''; render();
        for (const plat of v.platforms) {
          const q = v.params[plat];
          const platformKey = plat === 'videoChannel' ? 'videoChannel' : 'douyin';
          const vs = {
            isOriginal: !!q.isOriginal,
            scheduledPublish: !!q.publishAt,
            scheduleTime: q.publishAt ? new Date(q.publishAt).toISOString() : '',
            exactTime: true,
            publishCopy: q.publishCopy || '',
            publishTopics: Array.isArray(q.publishTopics) ? q.publishTopics : [],
            campaignName: q.campaignName || '',
            autoGenerate: false, autoRetry: false, timeoutSeconds: 240
          };
          try {
            const r = await window.antbot.publishStart({
              platform: platformKey,
              videos: [{ name: v.name, path: v.path, size: v.size, settings: vs }],
              settings: vs,
              videoPath: v.path.split(/[\\/]/).slice(0, -1).join('/') || '.',
              requestId: v.id
            });
            const notices = r?.notices || [];
            const ok = r?.ok !== false;
            if (ok) done++;
            v.message = notices.length ? notices.join('; ') : '';
            await window.antbot.publishSaveRecord({
              videoName: v.name, videoPath: v.path, platform: platformKey === 'videoChannel' ? 'weixin' : 'douyin',
              publishTime: new Date().toISOString(), status: ok ? 'success' : 'failed',
              scheduled: !!q.publishAt, scheduledTime: q.publishAt ? new Date(q.publishAt).toISOString() : '',
              notice: v.message || ''
            });
            if (ok) { v.status = 'done'; } else { v.status = 'failed'; failed++; }
          } catch (e) {
            v.status = 'failed'; v.message = e.message || '发布失败'; failed++;
          }
          render();
        }
        if (v.status === 'done') completedIds.add(v.id);
      }
      // 统一移除已完成任务（避免循环内 splice 打乱索引）
      S.publish.videos = S.publish.videos.filter(v => !completedIds.has(v.id));
      S.publish.running = false;
      if (resultEl) resultEl.textContent = `完成：成功 ${done}，失败 ${failed}`;
      saveTasks();
      render();
      loadPublishHistory();
    }

    /* ── 事件绑定 ── */
    pick?.addEventListener('click', async () => {
      try {
        const paths = await window.antbot.pickVideoFiles();
        if (paths?.length) addVideos(paths);
      } catch (e) { console.error(e); }
    });

    publishView?.addEventListener('dragover', e => { e.preventDefault(); publishView.classList.add('drag-over'); });
    publishView?.addEventListener('dragleave', () => publishView.classList.remove('drag-over'));
    publishView?.addEventListener('drop', e => {
      e.preventDefault();
      publishView.classList.remove('drag-over');
      const paths = [];
      for (const f of e.dataTransfer?.files || []) {
        try { const p = window.antbot.getPathForFile(f); if (p) paths.push(p); } catch {}
      }
      if (paths.length) addVideos(paths);
    });

    videoList?.addEventListener('click', e => {
      const del = e.target.closest('[data-card-del]');
      if (del) { if (S.publish.running) return; S.publish.videos.splice(Number(del.dataset.cardDel), 1); render(); return; }
      const plat = e.target.closest('[data-card-plat]');
      if (plat) {
        const [i, p] = plat.dataset.cardPlat.split(':');
        const v = S.publish.videos[Number(i)];
        if (v.platforms.includes(p)) v.platforms = v.platforms.filter(x => x !== p);
        else v.platforms.push(p);
        if (!v.platforms.length) v.platforms = [p];
        render(); return;
      }
      const orig = e.target.closest('[data-card-orig]');
      if (orig) {
        const [i, p] = orig.dataset.cardOrig.split(':');
        const q = S.publish.videos[Number(i)].params[p];
        q.isOriginal = !q.isOriginal;
        render(); return;
      }
      const time = e.target.closest('[data-card-time]');
      if (time) { openTimePicker(time.dataset.cardTime); return; }
      const copyPlat = e.target.closest('[data-card-copyplat]');
      if (copyPlat) {
        const [i, p] = copyPlat.dataset.cardCopyplat.split(':');
        const v = S.publish.videos[Number(i)];
        v.params[otherPlat(p)] = cloneParams(v.params[p]);
        render(); return;
      }
    });

    videoList?.addEventListener('change', e => {
      const campaign = e.target.closest('[data-card-campaign]');
      if (campaign) {
        const [i, p] = campaign.dataset.cardCampaign.split(':');
        const q = S.publish.videos[Number(i)].params[p];
        q.campaignName = campaign.value.trim();
        if (p === 'douyin' && q.campaignName && q.publishAt) {
          q.publishAt = null; // 抖音活动与定时互斥：参加活动则立即发布
        }
        render(); return;
      }
      const copyInp = e.target.closest('[data-card-copy]');
      if (copyInp) {
        const [i, p] = copyInp.dataset.cardCopy.split(':');
        S.publish.videos[Number(i)].params[p].publishCopy = copyInp.value.trim();
        return;
      }
      const topicsInp = e.target.closest('[data-card-topics]');
      if (topicsInp) {
        const [i, p] = topicsInp.dataset.cardTopics.split(':');
        S.publish.videos[Number(i)].params[p].publishTopics = topicsInp.value.split(/[\s,，、]+/).filter(Boolean).map(x => x.startsWith('#') ? x : '#' + x).slice(0, 5);
        return;
      }
      const dateSel = e.target.closest('[data-time-date]');
      if (dateSel) {
        const picker = dateSel.closest('.pv2-time-picker');
        const key = picker?.dataset?.timePicker;
        if (key) setCardTime(key, dateSel.value, picker.querySelector('[data-time-val]').value || '10:30');
        return;
      }
      const timeVal = e.target.closest('[data-time-val]');
      if (timeVal) {
        const picker = timeVal.closest('.pv2-time-picker');
        const key = picker?.dataset?.timePicker;
        if (key) setCardTime(key, picker.querySelector('[data-time-date]').value, timeVal.value || '10:30');
      }
    });

    videoList?.addEventListener('click', e => {
      const timeNow = e.target.closest('[data-time-now]');
      if (timeNow) {
        const picker = timeNow.closest('.pv2-time-picker');
        const key = picker?.dataset?.timePicker;
        if (key) {
          const [i, plat] = key.split(':');
          S.publish.videos[Number(i)].params[plat].publishAt = null;
          picker.classList.add('hidden');
          render();
        }
      }
    });

    /* 全局默认区事件 */
    const defaultsEl = document.getElementById('pv2-defaults');
    defaultsEl?.addEventListener('click', e => {
      const tab = e.target.closest('.pv2-plat-tab');
      if (tab) {
        document.querySelectorAll('#pv2-default-tabs .pv2-plat-tab').forEach(b => b.classList.remove('active'));
        tab.classList.add('active');
        renderDefaults(); return;
      }
      const orig = e.target.closest('#pv2-def-original');
      if (orig) {
        const act = document.querySelector('#pv2-default-tabs .pv2-plat-tab.active')?.dataset?.plat || 'videoChannel';
        S.publish.defaults[act].isOriginal = !S.publish.defaults[act].isOriginal;
        renderDefaults(); return;
      }
      const timeBtn = e.target.closest('#pv2-def-time');
      if (timeBtn) {
        const act = document.querySelector('#pv2-default-tabs .pv2-plat-tab.active')?.dataset?.plat || 'videoChannel';
        const q = S.publish.defaults[act];
        if (q.publishAt) { q.publishAt = null; }
        else {
          const now = new Date();
          const t = new Date(now.getTime() + 3600 * 1000);
          q.publishAt = t;
        }
        renderDefaults(); return;
      }
      const copyPlat = e.target.closest('#pv2-copy-plat');
      if (copyPlat) {
        const act = document.querySelector('#pv2-default-tabs .pv2-plat-tab.active')?.dataset?.plat || 'videoChannel';
        S.publish.defaults[otherPlat(act)] = cloneParams(S.publish.defaults[act]);
        renderDefaults(); return;
      }
      const applyAll = e.target.closest('#pv2-apply-all');
      if (applyAll) {
        for (const v of S.publish.videos) {
          v.platforms = ['videoChannel', 'douyin'];
          v.params.videoChannel = cloneParams(S.publish.defaults.videoChannel);
          v.params.douyin = cloneParams(S.publish.defaults.douyin);
          // 抖音互斥兜底
          if (v.params.douyin.campaignName) v.params.douyin.publishAt = null;
        }
        render();
      }
    });
    defaultsEl?.addEventListener('change', e => {
      const act = () => document.querySelector('#pv2-default-tabs .pv2-plat-tab.active')?.dataset?.plat || 'videoChannel';
      const copyInp = e.target.closest('#pv2-def-copy');
      if (copyInp) { S.publish.defaults[act()].publishCopy = copyInp.value.trim(); return; }
      const topicsInp = e.target.closest('#pv2-def-topics');
      if (topicsInp) {
        S.publish.defaults[act()].publishTopics = topicsInp.value.split(/[\s,，、]+/).filter(Boolean).map(x => x.startsWith('#') ? x : '#' + x).slice(0, 5);
        return;
      }
      const actInp = e.target.closest('#pv2-def-activity');
      if (actInp) {
        const q = S.publish.defaults[act()];
        q.campaignName = actInp.value.trim();
        if (act() === 'douyin' && q.campaignName) q.publishAt = null;
        renderDefaults();
      }
    });

    tabPending?.addEventListener('click', () => { currentTab = 'pending'; tabPending.classList.add('active'); tabDone.classList.remove('active'); videoList.classList.remove('hidden'); historyList.classList.add('hidden'); });
    tabDone?.addEventListener('click', () => { currentTab = 'done'; tabDone.classList.add('active'); tabPending.classList.remove('active'); videoList.classList.add('hidden'); historyList.classList.remove('hidden'); });

    mainBtn?.addEventListener('click', () => { void startPublish(); });

    /* 桥接服务 */
    const refreshBridge = async () => {
      try {
        const r = await window.antbot.publishBridgeStatus();
        serviceRunning = r?.status === 'ready' || r?.status === 'busy' || !!r?.extensionConnected;
        const el = bridgeStatus;
        if (el) {
          el.className = `publish-bridge-status ${serviceRunning ? 'ready' : 'offline'}`;
          el.querySelector('span:last-child').textContent = r?.extensionConnected ? '浏览器已连接' : '未连接';
        }
        bridgeToggleBtn.textContent = serviceRunning ? '停止服务' : '启动服务';
      } catch {
        serviceRunning = false;
        bridgeToggleBtn.textContent = '启动服务';
      }
    };
    bridgeToggleBtn?.addEventListener('click', async () => {
      bridgeToggleBtn.disabled = true; bridgeToggleBtn.textContent = '处理中...';
      try {
        if (serviceRunning) await window.antbot.publishBridgeStop();
        else { const r = await window.antbot.publishBridgeStart(); if (!r?.ok) throw new Error(r?.error || '启动失败'); }
      } catch (e) { console.error(e); }
      bridgeToggleBtn.disabled = false;
      refreshBridge();
    });

    /* 初始化 */
    (async () => {
      await loadTasks();
      await loadPublishHistory();
      render();
      refreshBridge();
      window.antbot.onPublishProgress?.((p) => {
        const msg = document.getElementById('publish-result');
        if (msg && p?.message) msg.textContent = p.message;
      });
    })();
  }

  return { bind: bindPublishPage };
}
