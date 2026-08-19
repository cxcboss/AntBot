export function createMonitorPage({ state: S, esc, toast, injectIcons }) {
  let bound = false;
  function bindMonitorPage() {
    if (bound) return;
    bound = true;
    const list = document.getElementById('monitor-list');
    const emptyEl = document.getElementById('monitor-empty');
    const addBtn = document.getElementById('monitor-add-btn');
    const dialog = document.getElementById('monitor-dialog');
    const saveBtn = document.getElementById('monitor-save-btn');
    const checkAllBtn = document.getElementById('monitor-check-all-btn');

    let monitors = [];
    let editingId = null;
    let stylesCache = [];
    let voicesCache = [];
    let loading = false;
    let loadError = '';

    async function loadStylesVoices() {
      const [stylesResult, voicesResult] = await Promise.all([
        window.antbot.loadStyles().catch(() => []),
        window.antbot.listVoices().catch(() => []),
      ]);
      stylesCache = stylesResult;
      if (!Array.isArray(stylesCache)) stylesCache = [];
      voicesCache = Array.isArray(voicesResult) ? voicesResult : (voicesResult?.voices || []);
    }

    async function refresh() {
      loading = true;
      loadError = '';
      render();
      try {
        const result = await window.antbot.monitorList();
        monitors = Array.isArray(result) ? result : [];
      } catch (e) {
        toast(e.message, 'error');
        monitors = [];
        loadError = e.message || '监控列表加载失败';
      } finally {
        loading = false;
      }
      render();
    }

    function render() {
      if (!list) return;
      if (loading) {
        list.innerHTML = '<div class="monitor-loading"><span class="spinner spinner-xs"></span><span>正在加载监控...</span></div>';
        if (emptyEl) emptyEl.style.display = 'none';
        return;
      }
      if (loadError) {
        list.innerHTML = `<div class="monitor-load-error"><span>${esc(loadError)}</span><button class="btn btn-xs btn-ghost" type="button" data-act="refresh">重试</button></div>`;
        if (emptyEl) emptyEl.style.display = 'none';
        injectIcons?.();
        return;
      }
      if (!monitors.length) {
        list.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';
      list.innerHTML = monitors.map(m => {
        const enabledCls = m.enabled ? 'on' : '';
        const lastCheck = m.lastCheckAt ? new Date(m.lastCheckAt).toLocaleString() : '未检查';
        const stats = `已发现 ${m.stats?.totalFetched||0} · 已入队 ${m.stats?.totalQueued ?? m.stats?.totalPublished ?? 0}`;
        const freqLabel = m.checkIntervalMinutes >= 1440 ? `每天` : m.checkIntervalMinutes >= 60 ? `${Math.round(m.checkIntervalMinutes/60)}小时` : `${m.checkIntervalMinutes}分钟`;
        const plats = (m.overrides?.publishPlatforms || []).map(p => p==='douyin'?'抖音':'视频号').join('、') || '跟随全局';
        const styleLabel = m.overrides?.styleName || '跟随全局';
        const voiceLabel = m.overrides?.voiceProfileName || '跟随全局';
        return `
          <div class="monitor-card" data-mid="${esc(m.id)}">
            <div class="monitor-head">
              <div class="monitor-title" title="${esc(m.sourceUrl)}">${esc(m.name)}</div>
              <button class="monitor-toggle ${enabledCls}" type="button" data-toggle="${esc(m.id)}" title="启用/禁用" aria-label="${m.enabled ? '停用' : '启用'}监控" aria-pressed="${m.enabled}"></button>
            </div>
            <div class="monitor-url">${esc(m.sourceUrl)}</div>
            <div class="monitor-meta">
              <span class="monitor-tag">频率 ${esc(freqLabel)}</span>
              <span class="monitor-tag">${esc(plats)}</span>
              <span class="monitor-tag">风格 ${esc(styleLabel)}</span>
              <span class="monitor-tag">音色 ${esc(voiceLabel)}</span>
            </div>
            <div class="monitor-stats">${esc(stats)} · 上次 ${esc(lastCheck)}</div>
            ${m.stats?.lastError ? `<div class="monitor-error">${esc(m.stats.lastError)}</div>` : ''}
            <div class="monitor-actions">
              <button class="btn btn-xs btn-ghost" type="button" data-act="check" data-id="${esc(m.id)}" ${m.enabled ? '' : 'disabled'}>立即检查</button>
              <button class="btn btn-xs btn-ghost" type="button" data-act="edit" data-id="${esc(m.id)}">编辑</button>
              <button class="btn btn-xs btn-ghost btn-danger" type="button" data-act="del" data-id="${esc(m.id)}">删除</button>
            </div>
          </div>`;
      }).join('');
      injectIcons?.();
    }

    function openDialog(monitor) {
      editingId = monitor ? monitor.id : null;
      const title = document.getElementById('monitor-dialog-title');
      if (title) title.textContent = monitor ? '编辑监控' : '添加监控';
      const nameEl = document.getElementById('monitor-name');
      const urlEl = document.getElementById('monitor-url');
      if (nameEl) nameEl.value = monitor?.name || '';
      if (urlEl) urlEl.value = monitor?.sourceUrl || '';
      const freqSel = document.getElementById('monitor-freq');
      const v = monitor?.checkIntervalMinutes || 60;
      let selVal = '60';
      if (v >= 1440) selVal = '1440';
      else if (v === 30) selVal = '30';
      else if (v === 120) selVal = '120';
      else if (v === 360) selVal = '360';
      else selVal = String(v);
      if (freqSel) freqSel.value = selVal;

      const platformSel = document.getElementById('monitor-platforms');
      const plats = monitor?.overrides?.publishPlatforms;
      let platformValue = '';
      if (Array.isArray(plats) && plats.length) {
        platformValue = plats.includes('videoChannel') && plats.includes('douyin')
          ? 'both'
          : plats.includes('douyin') ? 'douyin' : 'videoChannel';
      }
      if (platformSel) platformSel.value = platformValue;

      const topicsEl = document.getElementById('monitor-topics');
      if (topicsEl) topicsEl.value = (monitor?.overrides?.topics || []).join(' ');
      const campaignEl = document.getElementById('monitor-campaign');
      if (campaignEl) campaignEl.value = monitor?.overrides?.campaignName || '';
      const isOrig = document.getElementById('monitor-original');
      if (isOrig) {
        const originalValue = monitor?.overrides?.isOriginal;
        isOrig.value = originalValue === null || originalValue === undefined ? '' : (originalValue ? 'true' : 'false');
      }

      const styleSel = document.getElementById('monitor-style');
      if (styleSel) {
        const curStyle = monitor?.overrides?.styleName || '';
        styleSel.innerHTML = '<option value="">跟随全局</option>' + stylesCache.filter(s=>s?.name&&!s.learning).map(s=>`<option value="${esc(s.name)}" ${s.name===curStyle?'selected':''}>${esc(s.name)}</option>`).join('');
      }
      const voiceSel = document.getElementById('monitor-voice');
      if (voiceSel) {
        const curVoice = monitor?.overrides?.voiceProfileName || monitor?.overrides?.voiceId || '';
        voiceSel.innerHTML = '<option value="">跟随全局</option>' + voicesCache.filter(v=>v?.name).map(v=>`<option value="${esc(v.name)}" ${v.name===curVoice?'selected':''}>${esc(v.name)}</option>`).join('');
      }

      if (dialog && typeof dialog.showModal === 'function' && !dialog.open) {
        dialog.showModal();
      }
    }

    function collectForm() {
      const name = document.getElementById('monitor-name')?.value?.trim();
      const url = document.getElementById('monitor-url')?.value?.trim();
      const freq = parseInt(document.getElementById('monitor-freq')?.value || '60', 10);
      const platformValue = document.getElementById('monitor-platforms')?.value || '';
      const platforms = platformValue === 'both'
        ? ['videoChannel', 'douyin']
        : platformValue ? [platformValue] : null;
      const topicsRaw = document.getElementById('monitor-topics')?.value?.trim() || '';
      const topics = topicsRaw ? topicsRaw.split(/[\s,，、]+/).filter(Boolean).map(t=>t.startsWith('#')?t:'#'+t).slice(0,5) : null;
      const styleName = document.getElementById('monitor-style')?.value?.trim() || '';
      const voiceName = document.getElementById('monitor-voice')?.value?.trim() || '';
      let voiceId = '', voiceProfileName = '';
      if (voiceName) {
        const found = voicesCache.find(v=>v.name===voiceName);
        if (found) { voiceId = found.id; voiceProfileName = found.name; }
        else { voiceProfileName = voiceName; }
      }
      return {
        name: name || url,
        sourceUrl: url,
        checkIntervalMinutes: Number.isFinite(freq) ? freq : 60,
        overrides: {
          publishPlatforms: platforms,
          topics,
          styleName: styleName || '',
          voiceId,
          voiceProfileName,
          isOriginal: document.getElementById('monitor-original')?.value === ''
            ? null
            : document.getElementById('monitor-original')?.value === 'true',
          campaignName: document.getElementById('monitor-campaign')?.value?.trim() || '',
        }
      };
    }

    async function save() {
      const data = collectForm();
      if (!data.sourceUrl) { toast('请填写博主主页链接', 'error'); return; }
      try {
        new URL(data.sourceUrl);
      } catch { toast('链接格式不正确', 'error'); return; }
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中...'; }
      try {
        if (editingId) {
          await window.antbot.monitorUpdate(editingId, data);
          toast('已更新', 'success');
        } else {
          await window.antbot.monitorAdd(data);
          toast('已添加', 'success');
        }
        if (dialog) dialog.close();
        await refresh();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
      }
    }

    // 事件绑定（只绑定一次）
    addBtn?.addEventListener('click', async () => {
      await loadStylesVoices();
      openDialog(null);
    });
    saveBtn?.addEventListener('click', save);
    document.querySelectorAll('[data-monitor-cancel]').forEach(button => {
      button.addEventListener('click', () => { if (dialog) dialog.close(); });
    });
    dialog?.addEventListener('click', e => { if (e.target === dialog && dialog.close) dialog.close(); });
    window.antbot.onMonitorUpdate?.((payload) => {
      if (payload?.removed && payload.id) {
        monitors = monitors.filter(m => m.id !== payload.id);
      } else if (payload?.monitor?.id) {
        const index = monitors.findIndex(m => m.id === payload.monitor.id);
        if (index >= 0) monitors[index] = payload.monitor;
        else monitors.unshift(payload.monitor);
      }
      render();
    });

    checkAllBtn?.addEventListener('click', async () => {
      if (checkAllBtn) { checkAllBtn.disabled = true; checkAllBtn.textContent = '检查中...'; }
      const enabledMonitors = monitors.filter(m => m.enabled);
      if (!enabledMonitors.length) {
        toast('没有启用中的监控', 'info');
        if (checkAllBtn) { checkAllBtn.disabled = false; checkAllBtn.textContent = '全部检查'; }
        return;
      }
      let failedCount = 0;
      let newVideoCount = 0;
      try {
        for (const m of enabledMonitors) {
          try {
            const result = await window.antbot.monitorCheckNow(m.id);
            newVideoCount += result?.result?.newVideos?.length || 0;
          } catch {
            failedCount += 1;
          }
        }
        await refresh();
        if (failedCount) {
          toast(`检查完成：${failedCount} 个失败，${newVideoCount} 个新视频入队`, 'warning');
        } else {
          toast(newVideoCount ? `检查完成：${newVideoCount} 个新视频入队` : '检查完成，暂无新视频', 'success');
        }
      } finally {
        if (checkAllBtn) { checkAllBtn.disabled = false; checkAllBtn.textContent = '全部检查'; }
      }
    });

    list?.addEventListener('click', async e => {
      const toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        const id = toggle.dataset.toggle;
        const m = monitors.find(x=>x.id===id);
        if (!m) return;
        const enabled = !m.enabled;
        toggle.classList.toggle('on', enabled);
        try {
          const result = await window.antbot.monitorToggle(id, enabled);
          Object.assign(m, result?.monitor || { enabled });
          render();
        } catch (err) { toast(err.message, 'error'); toggle.classList.toggle('on', !enabled); }
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === 'refresh') {
        await refresh();
      } else if (act === 'edit') {
        await loadStylesVoices();
        const m = monitors.find(x=>x.id===id);
        if (m) openDialog(m);
      } else if (act === 'del') {
        if (!confirm('确定删除该监控？')) return;
        try { await window.antbot.monitorRemove(id); toast('已删除', 'info'); await refresh(); } catch (err) { toast(err.message,'error'); }
      } else if (act === 'check') {
        const monitor = monitors.find(x => x.id === id);
        if (!monitor?.enabled) { toast('请先启用该监控', 'info'); return; }
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = '检查中...';
        try {
          const r = await window.antbot.monitorCheckNow(id);
          await refresh();
          if (r?.result?.skipped) {
            toast(r.result.reason || '检查已跳过', 'info');
            return;
          }
          const newCount = r?.result?.newVideos?.length || 0;
          if (r?.result?.firstRun) toast('首次记录已有视频，下次发现新视频时自动下载', 'info');
          else toast(newCount ? `发现 ${newCount} 个新视频，已入队` : '暂无新视频', newCount?'success':'info');
        } catch (err) { toast(err.message,'error'); }
        finally { btn.disabled=false; btn.textContent=old; }
      }
    });

    // 初始化加载
    (async () => {
      await loadStylesVoices();
      await refresh();
    })();
  }

  return { bind: bindMonitorPage };
}
