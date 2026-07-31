export function createPublishPage({ state: S, esc }) {
function bindPublishPage(){
  const pick = document.getElementById('publish-pick-videos-btn');
  const platformBtns = document.querySelectorAll('.ps-platform-btn');
  const originalToggle = document.getElementById('publish-original-toggle');
  const scheduledToggle = document.getElementById('publish-scheduled-toggle');
  const scheduleWrapper = document.getElementById('publish-schedule-wrapper');
  const scheduleMonth = document.getElementById('publish-schedule-month');
  const scheduleDay = document.getElementById('publish-schedule-day');
  const scheduleTime = document.getElementById('publish-schedule-time');
  const mainBtn = document.getElementById('publish-main-btn');
  const publishView = document.getElementById('view-publish');
  const videoList = document.getElementById('publish-video-list');
  const historyList = document.getElementById('publish-history-list');
  const tabPending = document.getElementById('publish-tab-pending');
  const tabDone = document.getElementById('publish-tab-done');
  const pendingCount = document.getElementById('publish-pending-count');
  const doneCount = document.getElementById('publish-done-count');
  const bridgeToggleBtn = document.getElementById('publish-bridge-toggle-btn');
  let draggedItem = null;
  let draggedIndex = -1;
  let currentTab = 'pending';
  let publishProgress = {};
  let serviceRunning = false;

  S.publish = { videos: [], requestId: '', running: false, history: [] };
  const formatSize = bytes => { const n=Number(bytes||0); if(n===0) return ''; return n>1024*1024?`${(n/1024/1024).toFixed(1)}MB`:`${Math.round(n/1024)}KB`; };
  const formatTime = (d) => { const date=new Date(d); return `${date.getMonth()+1}/${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`; };
  const getFileName = (path) => path.split(/[\\/]/).pop();

  // 加载已发布的记录
  const loadPublishHistory = async () => {
    try {
      const records = await window.antbot.publishGetRecords();
      S.publish.history = records || [];
      render();
    } catch (e) {
      console.error('加载发布记录失败:', e);
    }
  };

  // 保存发布记录到本地
  const savePublishRecord = async (record) => {
    try {
      await window.antbot.publishSaveRecord(record);
    } catch (e) {
      console.error('保存发布记录失败:', e);
    }
  };

  const getDaysInMonth = (year, month) => new Date(year, month, 0).getDate();

  const isFutureDateTime = (month, day, time) => {
    const now = new Date();
    const year = now.getFullYear();
    const [hours, minutes] = (time || '10:30').split(':').map(Number);
    const selected = new Date(year, month - 1, day, hours, minutes);
    return selected > now;
  };

  const updateDaysSelect = () => {
    const month = parseInt(scheduleMonth.value);
    const now = new Date();
    const daysInMonth = getDaysInMonth(now.getFullYear(), month);
    const currentDay = parseInt(scheduleDay.value) || now.getDate();
    scheduleDay.innerHTML = '';
    for(let i = 1; i <= daysInMonth; i++) {
      const option = document.createElement('option');
      option.value = i;
      option.textContent = `${i}日`;
      if(i === Math.min(currentDay, daysInMonth)) option.selected = true;
      scheduleDay.appendChild(option);
    }
  };

  const setDefaultSchedule = () => {
    const now = new Date();
    scheduleMonth.value = now.getMonth() + 1;
    const nextHour = now.getHours() + 1;
    scheduleTime.value = `${String(nextHour >= 24 ? 0 : nextHour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    updateDaysSelect();
    scheduleDay.value = now.getDate();
  };

  const validateSchedule = () => {
    if (!scheduledToggle.classList.contains('on')) return true;
    const month = parseInt(scheduleMonth.value);
    const day = parseInt(scheduleDay.value);
    return isFutureDateTime(month, day, scheduleTime.value);
  };

  const addVideos = async (filePaths) => {
    const newVideos = filePaths.map(path => ({
      path, name: getFileName(path), size: 0, status: 'pending'
    }));
    S.publish.videos = [...S.publish.videos, ...newVideos];
    render();
    for(let i = S.publish.videos.length - newVideos.length; i < S.publish.videos.length; i++) {
      try {
        const info = await window.antbot.getVideoInfo(S.publish.videos[i].path);
        S.publish.videos[i].size = info.size || 0;
      } catch {}
    }
    render();
  };

  const render = () => {
    pendingCount.textContent = S.publish.videos.filter(v => v.status === 'pending' || v.status === 'publishing').length;
    doneCount.textContent = S.publish.history.length;

    if (currentTab === 'pending') {
      videoList.classList.remove('hidden');
      historyList.classList.add('hidden');
      renderPendingList();
    } else {
      videoList.classList.add('hidden');
      historyList.classList.remove('hidden');
      renderHistoryList();
    }

    if (S.publish.running) {
      mainBtn.textContent = '停止发布';
      mainBtn.className = 'btn btn-danger';
      mainBtn.disabled = false;
    } else if (S.publish.videos.some(v => v.status === 'pending')) {
      mainBtn.textContent = '通过浏览器发布';
      mainBtn.className = 'btn btn-primary';
      mainBtn.disabled = !validateSchedule() || !serviceRunning;
    } else {
      mainBtn.textContent = '通过浏览器发布';
      mainBtn.className = 'btn btn-primary';
      mainBtn.disabled = true;
    }
  };

  const renderPendingList = () => {
    const allVideos = S.publish.videos;
    const hasPublishing = allVideos.some(v => v.status === 'publishing');

    if (!allVideos.length) {
      videoList.innerHTML = '<div class="publish-empty">拖拽视频文件到此处，或点击"添加视频"</div>';
      return;
    }

    videoList.innerHTML = allVideos.map((v,i) => {
      const publishing = v.status === 'publishing';
      const statusText = publishProgress[v.path] || (publishing ? '发布中...' : '');
      return `<div class="publish-video-item ${publishing ? 'publishing' : ''}" draggable="${!publishing}" data-path="${esc(v.path)}">
        ${publishing ? '' : '<span class="publish-video-drag-handle">⋮⋮</span>'}
        <span class="publish-video-index">${publishing ? '<span class="icon" data-icon="loader"></span>' : i+1}</span>
        <span class="publish-video-name" title="${esc(v.path)}">${esc(v.name)}</span>
        ${statusText ? `<span class="publish-video-status">${esc(statusText)}</span>` : ''}
        <span class="publish-video-meta">${formatSize(v.size)}</span>
        ${publishing ? '' : `<button class="publish-video-remove" data-path="${esc(v.path)}" title="移除">×</button>`}
      </div>`;
    }).join('');
    setupDragAndDrop();
  };

  const renderHistoryList = () => {
    if (!S.publish.history.length) {
      historyList.innerHTML = '<div class="publish-empty">暂无发布记录</div>';
      return;
    }

    // 按日期分组
    const today = new Date(); today.setHours(0,0,0,0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const groups = {};
    for (const h of S.publish.history) {
      const d = h.time ? new Date(h.time) : new Date();
      const dayStart = new Date(d); dayStart.setHours(0,0,0,0);
      let label;
      if (dayStart.getTime() === today.getTime()) label = '今天';
      else if (dayStart.getTime() === yesterday.getTime()) label = '昨天';
      else label = `${d.getMonth()+1}月${d.getDate()}日`;
      if (!groups[label]) groups[label] = [];
      groups[label].push(h);
    }

    const groupKeys = Object.keys(groups);
    historyList.innerHTML = groupKeys.map((label, gi) => {
      const isToday = gi === 0;
      const items = groups[label];
      const rows = items.map(h => `
        <div class="publish-history-item">
          <span class="publish-history-icon ${h.success ? 'success' : 'failed'}"><span class="icon" data-icon="${h.success ? 'check' : 'alertCircle'}"></span></span>
          <span class="publish-history-name" title="${esc(h.path)}">${esc(h.name)}</span>
          <span class="publish-history-time">${formatTime(h.time)}</span>
          <button class="publish-history-open" data-path="${esc(h.path)}" title="在文件管理器中显示">打开</button>
        </div>`).join('');

      if (groupKeys.length === 1 && isToday) return rows;
      return `<div class="publish-history-group${isToday ? ' expanded' : ''}" data-group="${esc(label)}">
        <div class="publish-history-group-head" data-toggle-publish-group="${esc(label)}">
          <span class="publish-history-group-label">${esc(label)}</span>
          <span class="publish-history-group-count">${items.length}</span>
          <span class="publish-history-group-arrow">›</span>
        </div>
        <div class="publish-history-group-body">${rows}</div>
      </div>`;
    }).join('');

    // 折叠/展开
    historyList.querySelectorAll('[data-toggle-publish-group]').forEach(head => {
      head.addEventListener('click', () => {
        const group = head.closest('.publish-history-group');
        if (group) group.classList.toggle('expanded');
      });
    });

    historyList.querySelectorAll('.publish-history-open').forEach(btn => {
      btn.addEventListener('click', () => window.antbot.revealInFolder(btn.dataset.path));
    });
  };

  const setupDragAndDrop = () => {
    const items = videoList.querySelectorAll('.publish-video-item[draggable="true"]');
    items.forEach((item) => {
      item.addEventListener('dragstart', (e) => {
        draggedItem = item;
        draggedIndex = S.publish.videos.findIndex(v => v.path === item.dataset.path);
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        draggedItem = null;
        draggedIndex = -1;
        videoList.querySelectorAll('.publish-video-item').forEach(i => i.classList.remove('drag-over'));
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (item !== draggedItem) item.classList.add('drag-over');
      });

      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        const targetIndex = S.publish.videos.findIndex(v => v.path === item.dataset.path);
        if (draggedIndex !== -1 && draggedIndex !== targetIndex) {
          const draggedVideo = S.publish.videos[draggedIndex];
          S.publish.videos.splice(draggedIndex, 1);
          S.publish.videos.splice(targetIndex, 0, draggedVideo);
          render();
        }
      });
    });

    videoList.querySelectorAll('.publish-video-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        S.publish.videos = S.publish.videos.filter(v => v.path !== btn.dataset.path);
        render();
      });
    });
  };

  const setResult = (text, type='') => { const result=document.getElementById('publish-result'); result.textContent=text; result.className=`publish-result ${type}`; };

  const refreshBridge = async () => {
    const status = document.getElementById('publish-bridge-status');
    try {
      const r=await window.antbot.publishBridgeStatus();
      serviceRunning = r.status==='ready'||r.status==='busy';
      status.className=`publish-bridge-status ${serviceRunning?'ready':'offline'}`;
      status.querySelector('span:last-child').textContent=serviceRunning?'已连接':'未连接';
      bridgeToggleBtn.textContent = serviceRunning ? '停止服务' : '启动服务';
      bridgeToggleBtn.className = serviceRunning ? 'btn btn-ghost' : 'btn btn-ghost';
    } catch {
      serviceRunning = false;
      status.className='publish-bridge-status offline';
      status.querySelector('span:last-child').textContent='未连接';
      bridgeToggleBtn.textContent = '启动服务';
    }
    render();
  };

  bridgeToggleBtn?.addEventListener('click', async () => {
    bridgeToggleBtn.disabled = true;
    bridgeToggleBtn.textContent = '处理中...';
    try {
      if (serviceRunning) {
        await window.antbot.publishBridgeStop();
        setResult('服务已停止', 'success');
      } else {
        const result = await window.antbot.publishBridgeStart();
        if (result.ok) setResult('服务已启动', 'success');
        else setResult('启动失败: ' + (result.error || '未知错误'), 'error');
      }
      await refreshBridge();
    } catch(e) { setResult(e.message, 'error'); }
    finally { bridgeToggleBtn.disabled = false; }
  });

  pick?.addEventListener('click', async () => {
    try {
      const paths = await window.antbot.pickVideoFiles();
      if (paths && paths.length) await addVideos(paths);
    } catch(e) { setResult(e.message, 'error'); }
  });

  tabPending?.addEventListener('click', () => { currentTab = 'pending'; tabPending.classList.add('active'); tabDone.classList.remove('active'); render(); });
  tabDone?.addEventListener('click', () => { currentTab = 'done'; tabDone.classList.add('active'); tabPending.classList.remove('active'); render(); });

  publishView?.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); publishView.classList.add('drag-over'); });
  publishView?.addEventListener('dragleave', (e) => { if (!publishView.contains(e.relatedTarget)) publishView.classList.remove('drag-over'); });
  publishView?.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); publishView.classList.remove('drag-over');
    const filePaths = [];
    for (const f of e.dataTransfer?.files || []) {
      try {
        const p = window.antbot.getPathForFile(f);
        if (p && /\.(mp4|mov|m4v|webm|mkv|avi|flv|wmv|ts)$/i.test(f.name)) filePaths.push(p);
      } catch {}
    }
    if (filePaths.length) await addVideos(filePaths);
  });

  // 填充月份下拉
  scheduleMonth.innerHTML = '';
  for(let m=1;m<=12;m++){const o=document.createElement('option');o.value=m;o.textContent=m+'月';scheduleMonth.appendChild(o)}

  // 平台按钮
  let selectedPlatform = 'videoChannel';
  platformBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      platformBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedPlatform = btn.dataset.platform;
    });
  });

  // 开关切换
  function bindToggle(el, onChange){
    el.addEventListener('click', () => { el.classList.toggle('on'); onChange(el.classList.contains('on')); });
  }
  bindToggle(originalToggle, () => {});
  bindToggle(scheduledToggle, (on) => {
    scheduleWrapper.classList.toggle('hidden', !on);
    scheduleMonth.disabled = !on;
    scheduleDay.disabled = !on;
    scheduleTime.disabled = !on;
    if(on && !scheduleDay.value) setDefaultSchedule();
    render();
  });

  scheduleMonth?.addEventListener('change', () => { updateDaysSelect(); render(); });
  scheduleDay?.addEventListener('change', render);
  scheduleTime?.addEventListener('change', render);

  mainBtn?.addEventListener('click', async () => {
    if (S.publish.running) {
      // 立即更新状态
      S.publish.running = false;
      publishProgress = {};
      render();
      setResult('正在停止...', 'success');
      try {
        await window.antbot.publishStop(S.publish.requestId);
        setResult('已停止', 'success');
      } catch(e) {
        setResult(e.message, 'error');
      }
    } else {
      const pendingVideos = S.publish.videos.filter(v => v.status === 'pending');
      if (!pendingVideos.length) return;
      S.publish.running = true;
      S.publish.requestId = `antbot-${Date.now()}`;
      pendingVideos.forEach(v => { v.status = 'publishing'; publishProgress[v.path] = '等待中...'; });
      render();
      setResult('正在发布...');
      const topics = (document.getElementById('publish-topics').value || '').split(/[ ,，]+/).filter(Boolean);
      let scheduleTimeValue = '';
      if (scheduledToggle.classList.contains('on') && scheduleDay.value) {
        const year = new Date().getFullYear();
        const month = String(scheduleMonth.value).padStart(2, '0');
        const day = String(scheduleDay.value).padStart(2, '0');
        scheduleTimeValue = `${year}-${month}-${day}T${scheduleTime.value || '10:30'}`;
      }
      try {
        for (const video of pendingVideos) {
          if (!S.publish.running) break;
          publishProgress[video.path] = '发布中...';
          render();
          try {
            await window.antbot.publishStart({
              requestId: S.publish.requestId + '-' + Date.now(),
              videos: [video],
              videoPath: '',
              platform: selectedPlatform,
              settings: {
                publishCopy: document.getElementById('publish-copy').value,
                publishTopics: topics,
                isOriginal: originalToggle.classList.contains('on'),
                scheduledPublish: scheduledToggle.classList.contains('on'),
                scheduleTime: scheduleTimeValue
              }
            });
            const record = { path: video.path, name: video.name, success: true, time: new Date(), platform: selectedPlatform };
            S.publish.history.unshift(record);
            await savePublishRecord(record);
          } catch(e) {
            const record = { path: video.path, name: video.name, success: false, time: new Date(), platform: selectedPlatform, error: e.message };
            S.publish.history.unshift(record);
            await savePublishRecord(record);
          }
          delete publishProgress[video.path];
        }
        S.publish.videos = S.publish.videos.filter(v => v.status === 'pending');
        setResult(S.publish.running ? '发布完成' : '已停止', 'success');
      } catch(e) { setResult(e.message, 'error'); }
      finally { S.publish.running = false; publishProgress = {}; render(); refreshBridge(); }
    }
  });

  setDefaultSchedule();
  refreshBridge();
  if(!S._bridgeInterval)S._bridgeInterval=setInterval(refreshBridge, 3000);
  loadPublishHistory();
  render();
}


  return { bind: bindPublishPage };
}
