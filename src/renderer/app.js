import { ICONS } from './icons.js';
import { createDownloadPage } from './app/download-page.js';
import { createPublishPage } from './app/publish-page.js';
import { createRemotePage } from './app/remote-page.js';
import { createUpdatePage } from './app/update-page.js';

/* ── DOM ── */
const $ = (s) => document.querySelector(s);
const el = {
  badge:$('#app-badge'), sidebar:$('#sidebar'), overlay:$('#sidebar-overlay'),
  sidebarToggle:$('#sidebar-toggle'), pageTitle:$('#page-title'),
  scroll:$('#chat-scroll'), stream:$('#chat-stream'),
  input:$('#task-input'), runBtn:$('#run-btn'), optBtn:$('#opt-btn'), previewBar:$('#preview-bar'),
  chips:$('#setting-chips'),
  editAddBtn:$('#edit-add-btn'), editStartBtn:$('#edit-start-btn'),
  resizeHandle:$('#resize-handle'), composer:$('#composer'), chatArea:$('#chat-area'),
  status:$('#startup-status'),
  openVideoBtn:$('#open-video-channel'), openDouyinBtn:$('#open-douyin'),
  statTotal:$('#stat-total'), statPeriod:$('#stat-period'),
  statPeriodLabel:$('#stat-period-label'),
};

/* ── State ── */
let settingsDirty = false;
let settingsDirtyTimer = null;
const S = {
  app:null, settings:null, history:[],
  progress:{running:false,tasks:[],queueTasks:[]},
  startup:null, deps:null, dataInfo:null, hint:'',
  preview:{count:0,items:[],warnings:[],source:'',defaults:null,error:'',empty:true,mode:'auto'},
  vc:{running:false,status:'idle',step:'等待',pct:0,logs:[]},
  pending:[], chatCount:20, sidebarOpen:window.innerWidth>720, statPeriod:'day',
  currentFeat:'main', selectedStyle:'', persistedTasks:[],
};
let previewTimer=null,previewSeq=0,setQueue=Promise.resolve(),startupSeq=0;

/* ── Utils ── */
const esc=(s)=>String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const compact=(s,n=160)=>String(s||'').replace(/\s+/g,' ').slice(0,n);
const fmtDate=(v)=>{if(!v)return'--';const d=new Date(v);if(isNaN(d))return String(v);const now=new Date();const pad=n=>String(n).padStart(2,'0');const time=`${pad(d.getHours())}:${pad(d.getMinutes())}`;if(d.toDateString()===now.toDateString())return time;const yesterday=new Date(now);yesterday.setDate(now.getDate()-1);if(d.toDateString()===yesterday.toDateString())return`昨天 ${time}`;if(d.getFullYear()===now.getFullYear())return`${d.getMonth()+1}月${d.getDate()}日 ${time}`;return`${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${time}`;};
const fmtDay=(v)=>{if(!v)return'';const d=new Date(v);if(+isNaN(d))return'';return`${d.getMonth()+1}月${d.getDate()}日`;};
const merge=(t,s)=>{if(!s||typeof s!=='object')return t;for(const[k,v] of Object.entries(s)){if(Array.isArray(v))t[k]=v.slice();else if(v&&typeof v==='object'){if(!t[k]||typeof t[k]!=='object')t[k]={};merge(t[k],v);}else t[k]=v;}return t;};
const statusMap={queued:'等待',pending:'等待',running:'执行中',cancelling:'取消中',completed:'成功',warning:'部分完成',failed:'失败',stopped:'已取消',partial_failed:'部分失败'};
const statusText=(s)=>statusMap[s]||s;

/* ── Icons ── */
function injectIcons(scope){const base=scope||document;base.querySelectorAll('[data-icon]').forEach(e=>{const n=e.dataset.icon;if(ICONS[n])e.innerHTML=ICONS[n];})}
function closeDlg(dlg){if(!dlg)return;dlg.classList.add('closing');setTimeout(()=>{dlg.close();dlg.classList.remove('closing');},180);}
function confirmDialog(message,{danger=true,okText='确定'}={}){
  return new Promise(resolve=>{
    const dlg=document.createElement('dialog');dlg.className='dlg dlg-confirm';
    dlg.innerHTML=`<div class="dlg-box"><div class="dlg-body confirm-body"><span class="icon confirm-icon${danger?' danger':''}" data-icon="${danger?'alertTriangle':'alertCircle'}"></span><span class="confirm-msg">${esc(message)}</span></div><div class="dlg-acts confirm-acts"><button type="button" class="btn btn-sm btn-ghost" data-confirm-no>取消</button><button type="button" class="btn btn-sm ${danger?'btn-danger':'btn-primary'}" data-confirm-yes>${esc(okText)}</button></div></div>`;
    document.body.appendChild(dlg);
    injectIcons();
    const done=v=>{closeDlg(dlg);setTimeout(()=>{dlg.remove();resolve(v)},200)};
    dlg.querySelector('[data-confirm-no]').addEventListener('click',()=>done(false));
    dlg.querySelector('[data-confirm-yes]').addEventListener('click',()=>done(true));
    dlg.addEventListener('cancel',e=>{e.preventDefault();done(false)});
    dlg.addEventListener('click',e=>{if(e.target===dlg)done(false)});
    dlg.showModal();
  });
}

/* ── Toast ── */
function toast(msg,type='info',ms=5000){const c=$('#toast-container');if(!c)return;const t=document.createElement('div');t.className=`toast ${type}`;const im={success:ICONS.check,error:ICONS.alertCircle,warning:ICONS.alertTriangle,info:ICONS.alertCircle};t.innerHTML=`<span class="icon">${im[type]||''}</span><span class="toast-msg">${esc(msg)}</span><button class="toast-close" type="button" title="关闭" aria-label="关闭"><span class="icon">${ICONS.x}</span></button>`;c.appendChild(t);const remove=()=>{t.classList.add('out');setTimeout(()=>t.remove(),200)};t.addEventListener('click',e=>{if(e.target.closest('.toast-close'))remove()});t.querySelector('.toast-close').addEventListener('click',remove);setTimeout(remove,ms);}

function showLoading(containerId){const el=document.getElementById(containerId);if(el)el.innerHTML='<div class="loading-box"><span class="spinner"></span><span>加载中...</span></div>';}

/* ── Feature modules ── */
const downloadPage = createDownloadPage({ state: S, toast, esc, injectIcons });
const publishPage = createPublishPage({ state: S, esc });
const remotePage = createRemotePage({ toast, injectIcons });
const updatePage = createUpdatePage({ toast });
const initDownloadPage = downloadPage.init;
const initRemotePage = remotePage.init;
const initUpdatePage = updatePage.init;
const handleDownloadTaskUpdate = downloadPage.handleTaskUpdate;

/* ── Persist UI state ── */
function saveUI(){
  const ui={
    selectedStyle:S.selectedStyle,
    editDefaults:{style:S.editDefaults.style, voice:S.editDefaults.voice, subtitle:S.editDefaults.subtitle},
    sidebarOpen:S.sidebarOpen,
    statPeriod:S.statPeriod,
  };
  window.antbot.saveUISettings(ui).catch(()=>{});
}

/* ── Sidebar ── */
function isMobile(){return window.innerWidth<=720;}
function openSidebar(){S.sidebarOpen=true;saveUI();if(isMobile()){el.sidebar?.classList.add('open');el.overlay?.classList.add('show')}else{el.sidebar?.classList.remove('collapsed')}}
function closeSidebar(){S.sidebarOpen=false;saveUI();if(isMobile()){el.sidebar?.classList.remove('open');el.overlay?.classList.remove('show')}else{el.sidebar?.classList.add('collapsed')}}
function syncSidebar(){if(isMobile()){el.sidebar?.classList.remove('collapsed');if(S.sidebarOpen){el.sidebar?.classList.add('open');el.overlay?.classList.add('show')}else{el.sidebar?.classList.remove('open');el.overlay?.classList.remove('show')}}else{el.sidebar?.classList.remove('open');el.overlay?.classList.remove('show');if(S.sidebarOpen)el.sidebar?.classList.remove('collapsed');else el.sidebar?.classList.add('collapsed')}}

/* ── Feature switching ── */
function switchFeature(feat){
  S.currentFeat=feat;
  document.querySelectorAll('.feat-view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.sb-feat').forEach(b=>b.classList.remove('active'));
  const view=$(`#view-${feat}`);
  const btn=$(`.sb-feat[data-feat="${feat}"]`);
  if(view)view.classList.add('active');
  if(btn)btn.classList.add('active');
  const titles={main:'主控',edit:'剪辑',publish:'发布',download:'下载',remote:'远程','style-ref':'风格参考','subtitle-voice':'字幕与音色',update:'更新',settings:'设置'};
  if(el.pageTitle)el.pageTitle.textContent=titles[feat]||feat;
  renderStatus();
  if(feat==='subtitle-voice') loadPresetVoices();
  if(feat==='download') initDownloadPage();
  if(feat==='remote') initRemotePage();
  if(feat==='update') initUpdatePage();
  if(feat==='settings') { fillForm(); checkDeps(); loadModels(); checkVoicebox(); loadApiUsage(); injectIcons(); }
  // 清理下载页定时器
  if(feat!=='download') downloadPage.stopAnimations();
  if(isMobile())closeSidebar();
}

/* ── Theme: auto-follow system ── */
function initTheme(){
  const mq=window.matchMedia('(prefers-color-scheme:dark)');
  const apply=(dark)=>{
    document.documentElement.classList.toggle('dark',dark);
  };
  apply(mq.matches);
  mq.addEventListener('change',e=>apply(e.matches));
}

/* ── Resize handle ── */
let resizing=false,startY=0,startH=0;
function initResize(){
  const h=el.resizeHandle;if(!h)return;
  h.addEventListener('mousedown',e=>{e.preventDefault();resizing=true;startY=e.clientY;startH=el.composer?.offsetHeight||120;h.classList.add('dragging');document.body.style.cursor='row-resize';document.body.style.userSelect='none'});
  document.addEventListener('mousemove',e=>{if(!resizing)return;const dy=startY-e.clientY;const newH=Math.max(50,Math.min(startH+dy,window.innerHeight*0.6));if(el.composer){el.composer.style.height=newH+'px';el.composer.style.flex='none'}});
  document.addEventListener('mouseup',()=>{if(!resizing)return;resizing=false;el.resizeHandle?.classList.remove('dragging');document.body.style.cursor='';document.body.style.userSelect=''});
}

/* ── Dialog close ── */
function initDialogClose(){document.querySelectorAll('dialog.dlg').forEach(dlg=>{dlg.addEventListener('click',e=>{if(e.target===dlg)closeDlg(dlg)})})}

const platformLabel={videoChannel:'视频号',douyin:'抖音'};
const shortUrl=(url)=>`…${url.replace(/[^\s,，。；;）)]+$/,'').slice(-8)}`;
function fmtDuration(sec){
  sec=Math.max(0,Math.round(Number(sec)||0));
  if(sec<60)return`${sec}秒`;
  const m=Math.floor(sec/60),s=sec%60;
  if(m<60)return s?`${m}分${s}秒`:`${m}分钟`;
  return`${Math.floor(m/60)}小时${m%60}分`;
}
/* 消息卡片：直接显示原文 + 复制按钮 + 规则面板 */
function makeMessageHtml(raw,rules){
  const escapedRaw=esc(raw).replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/\r/g,'\\r').replace(/`/g,'\\`').replace(/\$/g,'\\$');
  const rulesHtml=rules&&rules.length?makeRulesHtml(rules):'';
  return`<div class="msg-content">${esc(raw)}</div><div class="msg-actions"><button class="msg-act-btn" type="button" data-msg-copy data-copy="${escapedRaw}"><span class="icon" data-icon="copy"></span>复制</button></div>${rulesHtml}`;
}
/* 规则面板：解析出的完整规则（平台/原创/活动/定时/话题/标题） */
function makeRulesHtml(rules){
  const items=rules.map((t,i)=>{
    const fields=[];
    if(t.platforms&&t.platforms.length)fields.push(`<span class="rule-field"><b>${esc(t.platforms.map(p=>platformLabel[p]||p).join('、'))}</b></span>`);
    if(t.isOriginal)fields.push('<span class="rule-field"><b>原创</b></span>');
    if(t.campaignName)fields.push(`<span class="rule-field">活动 <b>${esc(t.campaignName)}</b></span>`);
    if(t.publishAt){const d=new Date(t.publishAt);if(!isNaN(d)){const pad=n=>String(n).padStart(2,'0');fields.push(`<span class="rule-field">定时 <b>${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}</b></span>`)}}
    if(t.publishTopics&&t.publishTopics.length)fields.push(`<span class="rule-field">话题 <b>${esc(t.publishTopics.join(' '))}</b></span>`);
    if(t.taskName&&t.taskName!=='普通')fields.push(`<span class="rule-field">标题 <b>${esc(t.taskName)}</b></span>`);
    const title=t.videoUrl?shortUrl(t.videoUrl):(t.rawLine||`任务${i+1}`);
    return`<div class="rule-item"><div class="rule-item-title">${i+1}. ${esc(title)}</div><div class="rule-item-fields">${fields.join('')}</div></div>`;
  });
  const origCount=rules.filter(t=>t.isOriginal).length;
  const platSet=new Set();rules.forEach(t=>(t.platforms||[]).forEach(p=>platSet.add(platformLabel[p]||p)));
  const summary=`已按规则解析 ${rules.length} 条任务 · 原创 ${origCount} · ${[...platSet].join('、')}`;
  return`<div class="msg-rules open"><button type="button" class="msg-rules-head" data-rule-toggle><span class="msg-rules-summary">${esc(summary)}</span><span class="icon msg-rules-arrow" data-icon="chevronRight"></span></button><div class="msg-rules-body">${items.join('')}</div></div>`;
}

/* ── Statistics ── */
function calcStats(){
  const all=(S.history||[]).flatMap(r=>(r.items||[]).map(i=>({...i,startedAt:r.startedAt||r.endedAt})));
  const total=all.filter(i=>i.status==='completed').length;
  const now=new Date();
  const today=all.filter(i=>{const d=new Date(i.startedAt||i.finishedAt);return d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()&&d.getDate()===now.getDate()&&i.status==='completed'}).length;
  const weekStart=new Date(now);weekStart.setDate(now.getDate()-now.getDay());
  const week=all.filter(i=>{const d=new Date(i.startedAt||i.finishedAt);return d>=weekStart&&i.status==='completed'}).length;
  const month=all.filter(i=>{const d=new Date(i.startedAt||i.finishedAt);return d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()&&i.status==='completed'}).length;
  return{total,today,week,month};
}
async function loadSidebarApiUsage() {
  const box = document.getElementById('sidebar-api-usage');
  if (!box) return;
  try {
    const usage = await window.antbot.apiUsage();
    if (!usage || !usage.length) { box.innerHTML = '<div class="api-usage-empty">未配置 API Key</div>'; return; }
    const totalRemaining = usage.reduce((s, u) => s + u.remaining, 0);
    const totalUsed = usage.reduce((s, u) => s + u.used, 0);
    const totalLimit = usage.reduce((s, u) => s + u.limit, 0);
    // 帧率设置：value 表示多少秒一帧，帧率 = 1/value 帧/秒
    const frameInterval = S.settings?.edit?.frameRate || 1; // 秒/帧
    const fps = 1 / frameInterval; // 帧/秒
    const requestsPerSecond = fps;
    const requestsPerMinute = requestsPerSecond * 60;
    const totalSeconds = totalRemaining > 0 ? Math.floor(totalRemaining / requestsPerSecond) : 0;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    let durationText;
    if (totalSeconds <= 0) {
      durationText = '已用尽';
    } else if (hours > 0) {
      durationText = `${hours}小时${minutes}分`;
    } else if (minutes > 0) {
      durationText = `${minutes}分${seconds}秒`;
    } else {
      durationText = `${seconds}秒`;
    }

    box.innerHTML = `
      <div class="sb-quota-total" id="sb-quota-toggle">
        <span class="sb-quota-label">可剪辑时长</span>
        <span class="sb-quota-val">${durationText}</span>
      </div>
      <div class="sb-quota-details hidden" id="sb-quota-details">
        ${usage.map(u => {
      const pct = u.limit > 0 ? Math.round((u.used / u.limit) * 100) : 0;
      const keySeconds = u.remaining > 0 ? Math.floor(u.remaining / requestsPerSecond) : 0;
      const kh = Math.floor(keySeconds / 3600);
      const km = Math.floor((keySeconds % 3600) / 60);
      const ks = keySeconds % 60;
      const keyDuration = keySeconds <= 0 ? '已用尽' : kh > 0 ? `${kh}时${km}分` : km > 0 ? `${km}分${ks}秒` : `${ks}秒`;
      return `<div class="sb-quota-key"><span class="sb-quota-key-name">${esc(u.keyMasked)}</span><span class="sb-quota-key-val">${keyDuration}</span></div><div class="sb-quota-bar"><div class="sb-quota-bar-fill" style="width:${pct}%"></div></div>`;
    }).join('')}
        <div class="sb-quota-summary">已用 ${totalUsed} · 失败 ${usage.reduce((s, u) => s + u.failed, 0)} · 限频 ${usage.reduce((s, u) => s + u.rateLimited, 0)}</div>
        <div class="sb-quota-frame-info">当前帧率: 每${frameInterval}秒1帧</div>
      </div>`;

    document.getElementById('sb-quota-toggle')?.addEventListener('click', () => {
      document.getElementById('sb-quota-details')?.classList.toggle('hidden');
    });
  } catch { box.innerHTML = '<div class="api-usage-empty">无法加载</div>'; }
}

function renderStats(){
  const s=calcStats();
  if(el.statTotal)el.statTotal.textContent=String(s.total);
  const map={day:['今日',s.today],week:['本周',s.week],month:['本月',s.month]};
  const[periodLabel,periodValue]=map[S.statPeriod]||map.day;
  if(el.statPeriodLabel)el.statPeriodLabel.textContent=periodLabel;
  if(el.statPeriod)el.statPeriod.textContent=String(periodValue);
  // Sync active button state
  document.querySelectorAll('.stat-sw').forEach(btn=>{
    btn.classList.toggle('active',btn.dataset.period===S.statPeriod);
  });
}

/* ── Render: Chat ── */
function liveGroups(){
  const gs=new Map();
  [...(S.progress?.tasks||[]),...(S.progress?.queueTasks||[])].forEach(t=>{
    const g=String(t.batchRunId||t.id);
    if(!gs.has(g))gs.set(g,{id:g,at:t.enqueuedAt||t.updatedAt||new Date().toISOString(),txt:'',rules:null,tasks:[]});
    gs.get(g).tasks.push(t);
  });
  S.pending.forEach(b=>{if(!gs.has(b.runId))gs.set(b.runId,{id:b.runId,at:b.createdAt,txt:b.txt,rules:b.rules||null,tasks:[]});gs.get(b.runId).txt=b.txt;if(b.rules)gs.get(b.runId).rules=b.rules});
  return Array.from(gs.values()).map(g=>({...g,tasks:g.tasks.sort((a,b)=>(a.index||a.queueIndex||0)-(b.index||b.queueIndex||0)),txt:g.txt||g.tasks.map(t=>t.rawLine).filter(Boolean).join('\n')||g.tasks.map(t=>t.taskName).join('\n')})).sort((a,b)=>new Date(a.at)-new Date(b.at));
}
// 历史记录中同一任务多次尝试（重试）只保留最后一次（attempt 最大）
function dedupeHistoryItems(items){
  const map=new Map();
  (items||[]).forEach((it,i)=>{
    const key=String(it.taskId||it.id||'');
    if(!key){map.set(`__${i}`,it);return}
    const prev=map.get(key);
    if(!prev||Number(it.attempt||1)>=Number(prev.attempt||1))map.set(key,it);
  });
  return [...map.values()];
}
function taskCard(t,live=false){
  const st=t.status||'pending';const pg=Math.max(0,Math.min(100,Number(t.progress||0)));
  const snap=t.taskSnapshot||{};
  const platforms=t.platforms||snap.platforms||[];
  const isOriginal=t.isOriginal!==undefined?t.isOriginal:snap.isOriginal;
  const campaignName=t.campaignName||snap.campaignName;
  const publishAt=t.publishAt||snap.publishAt;
  const exec=t._exec||{};
  const idx=t.index||t.queueIndex||0;
  const title=idx?`任务${idx}`:(t.taskName&&t.taskName!=='普通'?t.taskName:(isOriginal?'原创':'任务'));
  const retrying=t.retryCount>0&&st==='running';
  const statusLabel=retrying?`重试中 (${t.retryCount})`:st==='cancelling'?'取消中':statusText(st);
  const canSkip=live&&['queued','pending'].includes(st);
  const canCancel=live&&['running'].includes(st);
  const canRetry=live&&['failed','stopped'].includes(st);
  const isCompleted=st==='completed'||st==='warning';
  const isCancelling=st==='cancelling';
  const msg=t.message?`<div class="task-msg">${esc(t.message)}</div>`:'';

  /* 元信息行：平台 · 原创 · 活动 · 定时（纯文字，无图标） */
  const meta=[];
  if(platforms.length)meta.push(`<span class="task-meta-item task-meta-platform">${esc(platforms.map(p=>platformLabel[p]||p).join('、'))}</span>`);
  if(isOriginal)meta.push('<span class="task-meta-item task-meta-original">原创</span>');
  if(campaignName)meta.push(`<span class="task-meta-item task-meta-campaign"><b>${esc(campaignName)}</b></span>`);
  if(publishAt){const d=new Date(publishAt);if(!isNaN(d)){const pad=n=>String(n).padStart(2,'0');const isExpired=d.getTime()<Date.now();if(isExpired&&!isCompleted&&st!=='running'&&st!=='queued'){meta.push(`<span class="task-meta-item danger">定时已过期 ${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}</span>`)}else{meta.push(`<span class="task-meta-item task-meta-time">定时 ${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}</span>`)}}}
  const metaHtml=meta.length?`<div class="task-meta">${meta.join('')}</div>`:'';

  /* 执行配置展开区：耗时 + 旁白/字幕/音色/风格 */
  const dur=t.duration||(t.startedAt&&t.completedAt?Math.round((new Date(t.completedAt)-new Date(t.startedAt))/1000):0);
  const detailItems=[];
  if(dur>0)detailItems.push(`<span class="task-detail-item">耗时 <b>${fmtDuration(dur)}</b></span>`);
  if(exec.styleName)detailItems.push(`<span class="task-detail-item">风格 <b>${esc(exec.styleName)}</b></span>`);
  if(exec.voiceName)detailItems.push(`<span class="task-detail-item">音色 <b>${esc(exec.voiceName)}</b></span>`);
  if(exec.voiceover!==undefined)detailItems.push(`<span class="task-detail-item">旁白 <b>${exec.voiceover?'开':'关'}</b></span>`);
  if(exec.subtitle!==undefined)detailItems.push(`<span class="task-detail-item">字幕 <b>${exec.subtitle?'开':'关'}</b></span>`);
  const detailHtml=detailItems.length?`<div class="task-detail"><button type="button" class="task-detail-toggle" data-task-detail>执行详情<span class="icon" data-icon="chevronRight"></span></button><div class="task-detail-body"><div class="task-detail-grid">${detailItems.join('')}</div></div></div>`:'';

  const showProgress=st==='running'||st==='preparing'||st==='pending'||st==='queued';
  const progressHtml=showProgress?`<div class="task-bar"><div class="task-bar-in" style="width:${pg}%"></div></div>`:'';

  const acts=[];
  if(canSkip)acts.push(`<button class="task-btn skip" data-skip="${esc(t.id)}">跳过</button>`);
  if(canCancel)acts.push(`<button class="task-btn cancel" data-stop="${esc(t.id)}">取消</button>`);
  if(canRetry)acts.push(`<button class="task-btn" data-retry-task="${esc(t.id)}">重试</button>`);
  if(isCompleted&&t.outputPath)acts.push(`<button class="task-btn" data-open-output="${esc(t.outputPath)}">打开目录</button>`);
  if((isCompleted||st==='failed')&&t.outputPath)acts.push(`<button class="task-btn" data-republish="${esc(t.id)}">重新发布</button>`);

  const inner=`<div class="task-inner"><div class="task-head"><div class="task-title">${esc(title)}</div><div class="task-badge">${esc(statusLabel)}</div></div>${metaHtml}${detailHtml}${progressHtml}${msg}${acts.length?`<div class="task-acts">${acts.join('')}</div>`:''}</div>`;
  const overlay=isCancelling?'<div class="task-cancelling">取消中...</div>':'';
  return`<div class="task ${esc(st)}">${inner}${overlay}</div>`;
}
/* 时间线增量渲染缓存：key=runId → {sig, html, el}，sig 不变时复用已有 DOM 节点 */
const _chatCache = new Map();
function chatGroupKey(g){return (g.persisted?'p:':g.live?'l:':'h:')+g.runId}
function chatGroupSig(g){
  const taskSig=g.tasks.map(t=>[t.id,t.status,t.progress,t.retryCount,t.message,t.taskName,t.outputPath,(t.platforms||[]).join(','),t.isOriginal?'1':'0',t.campaignName||'',t.publishAt||'',t.duration||0,t.startedAt||'',t.completedAt||'',t.index||0,t.queueIndex||0,t.attempt||1,JSON.stringify(t._exec||{})].join('¦')).join('§');
  return `${g.at}|${g.msgHtml||''}|${g.rulesHtml||''}|${taskSig}`;
}
function renderChat(opts={}){
  if(!el.stream)return;const stick=opts.stick,lg=liveGroups();
  const groups=[];let day='';
  /* 时间线组：消息（平铺）+ 规则（折叠）+ 任务栈；全部收集后按时间升序（旧上、新下） */
  const push=(at,runId,persisted,live,msgHtml,rulesHtml,tasksHtml)=>{
    groups.push({at:at?new Date(at).getTime():0,runId:String(runId||''),persisted,live,msgHtml,rulesHtml,tasksHtml});
  };
  for(const r of (S.history||[]).slice(-S.chatCount)){
    const txt=r.inputText||(r.items||[]).map(i=>i.rawLine||i.taskName).filter(Boolean).join('\n');
    push(r.startedAt||r.endedAt,r.id,false,false,txt?`<div class="msg-user">${makeMessageHtml(txt,null)}</div>`:'','',`<div class="task-stack">${dedupeHistoryItems(r.items).map(i=>taskCard(i)).join('')}</div>`);
  }
  // 持久化的主控任务（重新发布状态，重启后保留）
  const historyIds=new Set((S.history||[]).flatMap(r=>(r.items||[]).map(i=>i.taskId)));
  const persisted=(S.persistedTasks||[]).filter(t=>!historyIds.has(t.taskId)&&(t.status==='warning'||t.status==='completed'));
  if(persisted.length){
    const byRun={};
    for(const t of persisted){const key=t.batchRunId||'persisted';if(!byRun[key])byRun[key]={tasks:[],at:t.submittedAt||t.updatedAt,inputText:t.inputText||''};byRun[key].tasks.push(t);}
    for(const [,g] of Object.entries(byRun)){
      push(g.at,g.tasks[0]?.batchRunId||'',true,false,g.inputText?`<div class="msg-user">${makeMessageHtml(g.inputText,null)}</div>`:'','',`<div class="task-stack">${g.tasks.map(t=>taskCard(t)).join('')}</div>`);
    }
  }
  for(const g of lg){
    push(g.at,g.id,false,true,g.txt?`<div class="msg-user">${makeMessageHtml(g.txt,g.rules)}</div>`:'','',`<div class="task-stack">${g.tasks.map(t=>taskCard(t,true)).join('')}</div>`);
  }
  // 按时间升序：最早在上、最新（进行中的任务）在最下
  groups.sort((a,b)=>a.at-b.at);
  const used=new Set();
  const frag=document.createDocumentFragment();
  for(const g of groups){
    const at=g.at?new Date(g.at):null;
    const d=at?fmtDay(at):'';
    if(d&&d!==day){day=d;const dayEl=document.createElement('div');dayEl.className='chat-day';dayEl.textContent=esc(d);frag.appendChild(dayEl);}
    const key=chatGroupKey(g);
    const sig=chatGroupSig(g);
    let hit=_chatCache.get(key);
    if(!hit||hit.sig!==sig){
      hit={sig,html:`<div class="msg-time">${esc(at?fmtDate(at):'')}</div>${g.msgHtml}${g.rulesHtml||''}${g.tasksHtml}`,el:null};
      _chatCache.set(key,hit);
    }
    if(hit.el&&hit.el.isConnected){used.add(key);frag.appendChild(hit.el);continue;}
    const div=document.createElement('div');
    div.className='run-group';
    div.setAttribute('data-run-id',esc(g.runId));
    if(g.persisted)div.setAttribute('data-persisted','1');
    div.innerHTML=hit.html;
    hit.el=div;
    used.add(key);
    frag.appendChild(div);
  }
  // 移除已消失的组
  for(const [k,h] of _chatCache){if(!used.has(k)&&h.el&&h.el.isConnected){h.el.remove();}}
  if(!groups.length){
    el.stream.replaceChildren(frag);
    const empty=document.createElement('div');empty.className='chat-empty';empty.textContent='还没有任务。';
    el.stream.appendChild(empty);
    return;
  }
  el.stream.replaceChildren(frag);
  injectIcons();
  if(stick)requestAnimationFrame(()=>{el.scroll.scrollTop=el.scroll.scrollHeight});
}

/* ── Render: Chips ── */
function renderChips(){
  if(!el.chips||!S.settings)return;
  const vs=Number(S.settings.style?.voiceSpeed??1.1);
  const vp=S.settings.voiceClone?.profileName||S.settings.voiceClone?.voiceId||'';
  const st=S.editDefaults.style||S.selectedStyle||(S.styleRefs.length?'选择风格':'暂无风格');
  const rt=Math.max(0,Number(S.settings.retry?.failedTaskRetries??0));
  el.chips.innerHTML=`<button class="chip" data-act="voiceClone"><span class="vl">${vp?esc(vp):'音色设置'}</span></button><button class="chip" data-act="style-ref"><span class="vl">${esc(st)}</span></button><button class="chip" data-act="more-settings"><span class="vl">更多</span></button><span class="chip-spacer"></span><button class="chip" data-act="speed-slider"><span class="vl">语速${vs.toFixed(1)}x</span></button><button class="chip" data-act="retry-slider"><span class="vl">重试${rt}次</span></button>`;
}

/* ── Chip popups ── */
let activePopup=null;
let activeCtxDismiss=null;
function clearCtxDismiss(){if(activeCtxDismiss){document.removeEventListener('mousedown',activeCtxDismiss);activeCtxDismiss=null}}
function closeAllPopups(){clearCtxDismiss();if(activePopup){activePopup.remove();activePopup=null}}
function positionPopup(popup,anchor){
  document.body.appendChild(popup);
  const rect=anchor.getBoundingClientRect();
  const pw=popup.offsetWidth,ph=popup.offsetHeight;
  let left=rect.left+rect.width/2-pw/2;
  let top=rect.top-ph-8;
  if(left<8)left=8;if(left+pw>window.innerWidth-8)left=window.innerWidth-pw-8;
  if(top<8)top=rect.bottom+8;
  popup.style.left=left+'px';popup.style.top=top+'px';
}
function showSliderPopup(anchor,type){
  closeAllPopups();
  const popup=document.createElement('div');popup.className='chip-popup';
  if(type==='speed'){
    const cur=Number(S.settings?.style?.voiceSpeed??1.1);
    popup.innerHTML=`<div class="slider-row"><span class="slider-label">0.5x</span><input type="range" min="0.5" max="2" step="0.1" value="${cur}"><span class="slider-label">2x</span></div><div class="slider-value">${cur.toFixed(1)}x</div>`;
  }else{
    const cur=Math.max(0,Number(S.settings?.retry?.failedTaskRetries??0));
    popup.innerHTML=`<div class="slider-row"><span class="slider-label">0</span><input type="range" min="0" max="4" step="1" value="${cur}"><span class="slider-label">4</span></div><div class="slider-value">${cur===0?'不重试':cur+'次'}</div>`;
  }
  positionPopup(popup,anchor);activePopup=popup;
  const range=popup.querySelector('input[type="range"]');
  const val=popup.querySelector('.slider-value');
  range.addEventListener('input',()=>{
    if(type==='speed'){const v=Number(range.value);val.textContent=`${v.toFixed(1)}x`}
    else{const v=Number(range.value);val.textContent=v===0?'不重试':`${v}次`}
  });
  range.addEventListener('change',()=>{
    if(type==='speed'){const v=Number(range.value);if(S.settings?.style)S.settings.style.voiceSpeed=v;void qPatch({style:{voiceSpeed:v}},`语速 ${v.toFixed(1)}x`)}
    else{const v=Number(range.value);if(S.settings?.retry)S.settings.retry.failedTaskRetries=v;void qPatch({retry:{failedTaskRetries:v}},v===0?'不重试':`重试 ${v} 次`)}
  });
}
function showMorePopup(anchor){
  closeAllPopups();
  const vo=S.settings?.style?.voiceoverEnabled!==false;
  const sub=vo&&S.settings?.style?.subtitleEnabled!==false;
  const pub=S.settings?.publish?.enabled!==false;
  const popup=document.createElement('div');popup.className='chip-popup';
  popup.innerHTML=`<div class="toggle-row"><span>旁白</span><div class="toggle-switch ${vo?'on':''}" data-toggle-setting="voiceover"></div></div><div class="toggle-row"><span>字幕</span><div class="toggle-switch ${sub?'on':''}" data-toggle-setting="subtitle"${vo?'':' style="opacity:.4;pointer-events:none"'}></div></div><div class="toggle-row"><span>自动发布</span><div class="toggle-switch ${pub?'on':''}" data-toggle-setting="publish"></div></div>`;
  positionPopup(popup,anchor);activePopup=popup;
  popup.querySelectorAll('.toggle-switch').forEach(sw=>{
    sw.addEventListener('click',()=>{
      const k=sw.dataset.toggleSetting;toggleSetting(k);
      const vo2=S.settings?.style?.voiceoverEnabled!==false;
      const sub2=vo2&&S.settings?.style?.subtitleEnabled!==false;
      const pub2=S.settings?.publish?.enabled!==false;
      sw.classList.toggle('on',k==='voiceover'?vo2:k==='subtitle'?sub2:pub2);
      if(k==='voiceover'){const subSw=popup.querySelector('[data-toggle-setting="subtitle"]');if(subSw){subSw.style.opacity=vo2?'1':'.4';subSw.style.pointerEvents=vo2?'auto':'none'}}
    });
  });
}
function showStylePopup(anchor){
  closeAllPopups();
  const popup=document.createElement('div');popup.className='chip-popup';
  const learned=S.styleRefs.filter(s=>!s.learning&&s.prompt).map(s=>s.name);
  if(!learned.length){toast('请先在风格参考中学习风格','info');return;}
  const currentStyle=S.editDefaults.style||S.selectedStyle;
  popup.innerHTML=`<ul class="style-list">${learned.map(s=>`<li class="style-item${s===currentStyle?' active':''}" data-style="${esc(s)}">${esc(s)}</li>`).join('')}</ul>`;
  positionPopup(popup,anchor);activePopup=popup;
  popup.querySelectorAll('.style-item').forEach(item=>{
    item.addEventListener('click',()=>{
      const style=item.dataset.style;
      S.selectedStyle=style;
      S.editDefaults.style=style;
      renderChips();
      toast(`风格: ${style}`,'success');
      saveUI();
      closeAllPopups();
    });
  });
}

function showVoicePopup(anchor){
  closeAllPopups();
  const popup=document.createElement('div');popup.className='chip-popup';
  const voices=S.voices||[];
  if(!voices.length){toast('暂无可用音色','info');return;}
  const azure=voices.filter(v=>v.source==='azure'),clone=voices.filter(v=>v.source!=='azure');
  const activeId=S.activeVoiceId;
  const activeSource=activeId?voices.find(v=>v.id===activeId)?.source:null;
  const renderSection=(label,items)=>{
    if(!items.length)return '';
    const open=activeSource===(items[0].source||'')?' open':'';
    const collapsed=open?'':' style="display:none"';
    return `<div class="style-section" data-section="${esc(items[0].source||'')}"><span class="style-section-arrow${open}" data-arrow="1">▶</span>${esc(label)}</div><div class="style-section-items"${collapsed}>${items.map(v=>`<li class="style-item${v.id===activeId?' active':''}" data-voice-id="${esc(v.id)}">${esc(v.name)}</li>`).join('')}</div>`;
  };
  popup.innerHTML=`<ul class="style-list">${renderSection('内置音色（Azure TTS）',azure)}${renderSection('克隆音色',clone)}</ul>`;
  positionPopup(popup,anchor);activePopup=popup;
  popup.querySelectorAll('.style-section').forEach(section=>{
    section.addEventListener('click',(e)=>{
      e.stopPropagation();
      const items=section.nextElementSibling;
      if(!items||!items.classList.contains('style-section-items'))return;
      const arrow=section.querySelector('[data-arrow]');
      if(items.style.display==='none'){items.style.display='';arrow.classList.add('open');}else{items.style.display='none';arrow.classList.remove('open');}
    });
  });
  popup.querySelectorAll('.style-item').forEach(item=>{
    item.addEventListener('click',async()=>{
      const vid=item.dataset.voiceId;
      const voice=voices.find(v=>v.id===vid);
      if(voice){
        await window.antbot.updateSettings({voiceClone:{...S.settings?.voiceClone,voiceId:vid,profileName:voice.name}});
        S.activeVoiceId=vid;
        renderChips();
        toast(`音色: ${voice.name}`,'success');
      }
      closeAllPopups();
    });
  });
}

/* ── Settings form ── */
function fillForm(){
  const s=S.settings;if(!s)return;
  const set=(id,v)=>{const e=document.getElementById(id);if(e&&document.activeElement!==e)e.value=v??'';};
  set('s-dataDir',s.dataDir||'');set('s-outputBaseDir',s.paths?.outputBaseDir);
  // Load subtitle settings into subtitle-voice page
  const subColor=document.getElementById('sub-color');if(subColor)subColor.value=s.style?.subtitleTextColor||'#FFA100';
  const subStroke=document.getElementById('sub-stroke');if(subStroke)subStroke.value=s.style?.subtitleStrokeColor||'#000000';
  const subPos=document.getElementById('sub-position');if(subPos)subPos.value=s.style?.subtitlePositionPercent??12;
  const fontPath=document.getElementById('font-current-path');if(fontPath)fontPath.value=s.fonts?.activeFont||'系统默认';
  // API keys — 每 key 独立 baseURL/模型/用量
  // 保留现有 DOM（避免设置保存推送重建时清掉刚添加/正在输入的 key），只补齐缺失行
  const keys=normalizeKeysForForm(s.api);
  const keysList=document.getElementById('api-keys-list');
  if(keysList){
    const existing=keysList.querySelectorAll('.api-key-item');
    for(let i=0;i<keys.length;i++){
      if(!existing[i]){
        const wrap=document.createElement('div');
        wrap.innerHTML=apiKeyItemHtml(keys[i],i);
        keysList.appendChild(wrap.firstElementChild);
      }
    }
  }
  const fr=document.getElementById('s-frameRate');if(fr)fr.value=String(s.edit?.frameRate??1);
  // 开机自动启动开关
  const al=document.getElementById('s-auto-launch');
  if(al)al.classList.toggle('on',S.settings?.system?.launchAtLogin!==false);
  const td=s.taskDefaults||{};
  set('s-task-platform',(td.platforms||[]).join(','));
  const to=document.getElementById('s-task-original');if(to)to.value=td.isOriginal?'true':'false';
  set('s-task-topics',(td.topics||[]).join(' '));
  const iv=td.intervalMinutes||[40,70];
  set('s-task-interval-min',iv[0]);set('s-task-interval-max',iv[1]);
}
/* 归一化 API 配置为表单结构 [{key,baseUrl,modelId,availableModels}]（兼容旧数据） */
function normalizeKeysForForm(api){
  if(api?.keys?.length)return api.keys.map(k=>({key:k.key||'',baseUrl:k.baseUrl||api.baseUrl||'',modelId:k.modelId||api.modelId||'',availableModels:k.availableModels||api.availableModels||[]}));
  const legacy=(api?.apiKeys||[]).filter(Boolean);
  if(legacy.length)return legacy.map(k=>({key:k,baseUrl:api.baseUrl||'',modelId:api.modelId||'',availableModels:api.availableModels||[]}));
  if(api?.apiKey)return[{key:api.apiKey,baseUrl:api.baseUrl||'',modelId:api.modelId||'',availableModels:api.availableModels||[]}];
  return[{key:'',baseUrl:api?.baseUrl||'https://apihub.agnes-ai.com/v1',modelId:'',availableModels:[]}];
}
/* 单个 key 区块 HTML：key + baseURL + 获取模型 + 模型下拉 + 用量占位 */
function apiKeyItemHtml(k,i){
  const key=k?.key||'',baseUrl=k?.baseUrl||'',modelId=k?.modelId||'';
  const models=k?.availableModels||[];
  const opts=models.length?models.map(m=>`<option value="${esc(m.id)}"${m.id===modelId?' selected':''}>${esc(m.name)}</option>`).join(''):'<option value="">请先获取模型</option>';
  return `<div class="api-key-item">
    <div class="s-input-row">
      <input name="apiKey" type="password" class="input" placeholder="API Key ${i+1}" value="${esc(key)}" />
      <button type="button" class="btn btn-sm btn-ghost s-key-vis" title="显示/隐藏"><span class="icon" data-icon="eye"></span></button>
      <button type="button" class="btn btn-sm btn-ghost s-key-del" title="删除"><span class="icon" data-icon="x"></span></button>
    </div>
    <div class="s-input-row api-key-sub">
      <input name="apiBaseUrl" type="text" class="input" placeholder="Base URL，如 https://apihub.agnes-ai.com/v1" value="${esc(baseUrl)}" />
      <button type="button" class="btn btn-sm btn-ghost s-key-models" title="获取该地址的模型列表">获取模型</button>
    </div>
    <select name="apiModelId" class="select w-full api-key-model" data-models="${esc(JSON.stringify(models))}">${opts}</select>
    <div class="api-key-usage"></div>
  </div>`;
}
function readForm(){
  const get=(id)=>{const e=document.getElementById(id);return e?.value?.trim()||'';};
  const apiItems=[...document.querySelectorAll('#api-keys-list .api-key-item')].map(el=>{
    const key=el.querySelector('input[name="apiKey"]')?.value.trim()||'';
    const baseUrl=el.querySelector('input[name="apiBaseUrl"]')?.value.trim()||'https://apihub.agnes-ai.com/v1';
    const modelId=el.querySelector('select[name="apiModelId"]')?.value||'';
    let availableModels=[];
    try{availableModels=JSON.parse(el.querySelector('select')?.dataset.models||'[]')}catch{}
    return {key,baseUrl,modelId,availableModels};
  }).filter(x=>x.key);
  const ivMin=Math.max(1,parseInt(get('s-task-interval-min'))||40);
  const ivMax=Math.max(ivMin,parseInt(get('s-task-interval-max'))||70);
  return{
    dataDir:get('s-dataDir'),
    paths:{outputBaseDir:get('s-outputBaseDir')},
    style:S.settings?.style||{},
    voiceClone:S.settings?.voiceClone||{},
    edit:{frameRate:parseFloat(get('s-frameRate'))||1},
    system:{
      launchAtLogin:document.getElementById('s-auto-launch')?.classList.contains('on')??true,
      preventSleepOnTasks:S.settings?.system?.preventSleepOnTasks!==false
    },
    taskDefaults:{
      platforms:get('s-task-platform')?get('s-task-platform').split(','):[],
      isOriginal:get('s-task-original')==='true',
      topics:get('s-task-topics').split(/[\s,，、]+/).filter(Boolean).map(x=>x.startsWith('#')?x:'#'+x),
      intervalMinutes:[ivMin,ivMax]
    },
    api:{
      keys:apiItems,
      baseUrl:apiItems[0]?.baseUrl||'https://apihub.agnes-ai.com/v1',
      apiKey:apiItems[0]?.key||'',
      apiKeys:apiItems.map(i=>i.key),
      modelId:apiItems[0]?.modelId||'',
      availableModels:apiItems[0]?.availableModels||[]
    }
  };
}

async function loadApiUsage() {
  const list = document.getElementById('api-keys-list');
  if (!list) return;
  try {
    const usage = await window.antbot.apiUsage();
    const map = new Map((usage || []).map(u => [u.keyMasked, u]));
    const items = list.querySelectorAll('.api-key-item');
    let filled = 0;
    items.forEach(item => {
      const key = item.querySelector('input[name="apiKey"]')?.value.trim() || '';
      const box = item.querySelector('.api-key-usage');
      if (!key || !box) return;
      const masked = key.length >= 8 ? key.slice(0, 4) + '***' + key.slice(-4) : '***';
      const u = map.get(masked);
      if (!u) { box.innerHTML = ''; return; }
      filled++;
      const pct = u.limit > 0 ? Math.round((u.used / u.limit) * 100) : 0;
      const exhausted = u.remaining <= 0 ? ' · <span class="api-usage-exhausted">额度已用尽，将自动切换下一个 Key</span>' : '';
      box.innerHTML = `<div class="api-usage-bar"><div class="api-usage-bar-fill" style="width:${pct}%"></div></div>
        <div class="api-usage-meta">今日已用 ${u.used}/${u.limit} · 失败 ${u.failed} · 限频 ${u.rateLimited}${exhausted}</div>`;
    });
    if (!filled) {
      const empty = list.querySelector('.api-usage-empty');
      if (!empty) {
        const hint = document.createElement('div');
        hint.className = 'api-usage-empty';
        hint.textContent = '填写 API Key 并保存后显示当日用量';
        list.appendChild(hint);
      }
    } else {
      list.querySelectorAll('.api-usage-empty').forEach(e => e.remove());
    }
  } catch {}
}

/* ── Render: Status ── */
function renderStatus(){
  if(!el.status)return;
  if(S.currentFeat==='style-ref'){
    const n=S.styleRefs.length;
    el.status.textContent=n?`${n}个风格`:'暂无风格';
    el.status.className='tb-status';
    return;
  }
  if(S.currentFeat==='edit'){
    const running=S.editVideos.filter(v=>v.status==='running').length;
    const pending=S.editVideos.filter(v=>v.status==='pending').length;
    const done=S.editVideos.filter(v=>v.status==='completed').length;
    if(running){el.status.textContent=`${running}个处理中`;el.status.className='tb-status active'}
    else if(pending){el.status.textContent=`${pending}个待处理`;el.status.className='tb-status'}
    else if(done){el.status.textContent=`已完成 ${done}个`;el.status.className='tb-status'}
    else{el.status.textContent='添加视频开始剪辑';el.status.className='tb-status'}
    return;
  }
  if(S.currentFeat==='publish'){
    el.status.textContent='配置发布参数后提交';el.status.className='tb-status';return;
  }
  if(S.currentFeat==='subtitle-voice'){
    el.status.textContent='管理音色和字幕样式';el.status.className='tb-status';return;
  }
  const live=(S.progress?.tasks||[]).filter(t=>['queued','pending','running'].includes(t.status));
  const running=live.filter(t=>t.status==='running').length;
  const pending=live.filter(t=>t.status!=='running').length;
  if(live.length>0){const p=[];if(running>0)p.push(`${running}个正在执行`);if(pending>0)p.push(`${pending}个等待中`);el.status.textContent=p.join('，');el.status.className='tb-status active'}
  else{el.status.textContent='没有任务';el.status.className='tb-status'}
}
function renderBtns(){if(el.badge&&S.app)el.badge.textContent=`v${S.app.version}`;toggleSendBtn()}
function toggleSendBtn(){if(!el.runBtn||!el.input)return;const has=el.input.value.trim().length>0;el.runBtn.classList.toggle('show',has);el.optBtn?.classList.toggle('show',has)}
function renderAll(opts={}){renderStatus();renderChips();fillForm();renderBtns();renderChat(opts);renderStats();injectIcons()}

/* ── State ── */
function reconcile(){const ids=new Set((S.history||[]).map(r=>r.id));S.pending=S.pending.filter(b=>!ids.has(b.runId))}
function appendPending(p){if(!p.runId||!p.inputText)return;S.pending.push({runId:p.runId,txt:p.inputText,rules:p.rules||null,createdAt:new Date().toISOString()});reconcile()}
function applySnap(s){
  if(s.app)S.app=s.app;
  if(s.settings&&!settingsDirty)S.settings=s.settings;
  if(s.history)S.history=s.history;
  if(s.progress)S.progress=s.progress;
  if(s.dependencies)S.deps=s.dependencies;
  reconcile();
}

async function loadUISettings(){
  try{
    const ui=await window.antbot.loadUISettings();
    if(ui.selectedStyle!==undefined) S.selectedStyle=ui.selectedStyle;
    if(ui.editDefaults?.style!==undefined) S.editDefaults.style=ui.editDefaults.style;
    else if(ui.selectedStyle!==undefined) S.editDefaults.style=ui.selectedStyle;
    if(ui.editDefaults?.voice!==undefined) S.editDefaults.voice=ui.editDefaults.voice;
    if(ui.editDefaults?.subtitle!==undefined) S.editDefaults.subtitle=ui.editDefaults.subtitle;
    if(typeof ui.sidebarOpen==='boolean') S.sidebarOpen=ui.sidebarOpen;
    if(ui.statPeriod) S.statPeriod=ui.statPeriod;
  }catch{}
  // 默认音色：无保存值则使用内置晓晓
  if(!S.editDefaults.voice) S.editDefaults.voice='晓晓（女·温柔）';
  // 默认风格：无保存值则使用通用风格
  if(!S.editDefaults.style) S.editDefaults.style='通用风格';
}

/* ── Preview ── */
function autoInput(){if(!el.input)return;el.input.style.height='auto';el.input.style.height=`${Math.max(28,Math.min(el.input.scrollHeight,200))}px`}
function fmtPvTime(v){const d=new Date(v);if(isNaN(d))return'';const now=new Date();const pad=n=>String(n).padStart(2,'0');const t=`${pad(d.getHours())}:${pad(d.getMinutes())}`;if(d.toDateString()===now.toDateString())return t;if(d.getTime()<now.getTime())return`${d.getMonth()+1}/${d.getDate()} ${t}`;const tm=new Date(now);tm.setDate(now.getDate()+1);if(d.toDateString()===tm.toDateString())return`明天 ${t}`;return`${d.getMonth()+1}/${d.getDate()} ${t}`}
function parsePvTimeText(text){
  const s=String(text||'').trim();
  if(!s)return null;
  if(/^(立刻|立即|马上|现在|now)$/i.test(s))return null;
  let m=s.match(/^明天\s*(\d{1,2})[:时](\d{1,2})分?$/);
  if(m){const d=new Date();d.setDate(d.getDate()+1);d.setHours(+m[1],+m[2],0,0);return d;}
  m=s.match(/^(\d{1,2})[:时](\d{1,2})分?$/);
  if(m){const d=new Date();d.setHours(+m[1],+m[2],0,0);if(d.getTime()<=Date.now())d.setDate(d.getDate()+1);return d;}
  const d=new Date(s);
  return isNaN(d.getTime())?null:d;
}
function renderPreview(){
  const bar=el.previewBar;if(!bar)return;
  const p=S.preview;
  if(p.empty||(!p.count&&!p.error)){bar.style.display='none';bar.innerHTML='';return}
  bar.style.display='block';
  const srcBadge=p.mode==='optimized'?'<span class="pv-badge pv-ai">AI 优化</span>':(p.source==='ai'?'<span class="pv-badge pv-ai">AI 识别</span>':(p.source==='regex'?'<span class="pv-badge">规则识别</span>':''));
  const d=p.defaults;
  const defTxt=d?`<span class="pv-def">默认：${(d.platforms||['视频号']).map(x=>x==='douyin'?'抖音':'视频号').join('+')} · ${d.isOriginal?'原创':'不原创'} · ${(d.topics||[]).length}个话题${d.intervalMinutes?` · 间隔${d.intervalMinutes[0]}-${d.intervalMinutes[1]}分`:''}</span>`:'';
  const items=(p.items||[]).slice(0,5).map((t,i)=>{
    const pf=(t.platforms||[]).map(x=>x==='douyin'?'抖音':'视频号').join('+');
    const tags=[`<span class="pv-tag">${esc(pf)}</span>`,`<span class="pv-tag${t.isOriginal?' pv-tag-accent':''}">${t.isOriginal?'原创':'不原创'}</span>`];
    if(t.publishAt)tags.push(`<span class="pv-tag">${esc(fmtPvTime(t.publishAt))}</span>`);else tags.push('<span class="pv-tag">立即发布</span>');
    if(t.campaignName)tags.push(`<span class="pv-tag pv-tag-accent">活动:${esc(t.campaignName)}</span>`);
    const title=t.taskName&&t.taskName!=='普通'?`<span class="pv-title">${esc(t.taskName)}</span>`:'';
    return`<div class="pv-row"><button class="pv-edit" type="button" data-edit-pv="${i}" title="修改此任务">${esc('✎')}</button>${tags.join('')}${title}</div>`;
  }).join('');
  const more=p.count>p.items.length?`<div class="pv-more">…共 ${p.count} 条</div>`:'';
  const warns=(p.warnings||[]).map(w=>`<div class="pv-warn">${esc(w)}</div>`).join('');
  const err=p.error?`<div class="pv-warn">${esc(p.error)}</div>`:'';
  const confirm=(p.items&&p.items.length)?`<div class="pv-acts"><button class="btn btn-sm btn-primary" type="button" data-pv-confirm>${p.mode==='optimized'?'确定发送':'发送'}</button></div>`:'';
  bar.innerHTML=`<div class="pv-head">${srcBadge}<span class="pv-count">${p.count} 条任务</span>${defTxt}</div>${items}${more}${warns}${err}${confirm}`;
}
function openPvEditor(index,anchor){
  const t=(S.preview.items||[])[index];if(!t)return;
  closeAllPopups();
  const popup=document.createElement('div');popup.className='chip-popup pv-popup';
  const pf=(t.platforms||[]).map(x=>x==='douyin'?'douyin':'videoChannel');
  const pfBtn=(v,label)=>`<button type="button" class="pv-pf-btn${pf.includes(v)?' on':''}" data-pv-pf="${v}">${label}</button>`;
  const origLabel=t.isOriginal?'原创':'不原创';
  const timeVal=t.publishAt?fmtPvTime(t.publishAt):'';
  popup.innerHTML=`<div class="pv-ed-row"><span class="pv-ed-label">平台</span><div class="pv-pf-group">${pfBtn('videoChannel','视频号')}${pfBtn('douyin','抖音')}${pfBtn('videoChannel,douyin','两者')}</div></div>
    <div class="pv-ed-row"><span class="pv-ed-label">原创</span><button type="button" class="pv-orig-btn" data-pv-orig="${t.isOriginal?'1':'0'}">${origLabel}（点击切换）</button></div>
    <div class="pv-ed-row"><span class="pv-ed-label">时间</span><input class="pv-input" data-pv-time value="${esc(timeVal)}" placeholder="立即 / 16:00 / 明天 10:00" /></div>
    <div class="pv-ed-row"><span class="pv-ed-label">标题</span><input class="pv-input" data-pv-title value="${esc(t.taskName&&t.taskName!=='普通'?t.taskName:'')}" placeholder="标题（空=普通）" /></div>
    <div class="pv-ed-row"><span class="pv-ed-label">话题</span><input class="pv-input" data-pv-topics value="${esc((t.publishTopics||[]).join(' '))}" placeholder="#话题1 #话题2（空格分隔）" /></div>
    <div class="pv-ed-row"><span class="pv-ed-label">活动</span><input class="pv-input" data-pv-campaign value="${esc(t.campaignName||'')}" placeholder="活动名（空=不参加）" /></div>
    <div class="pv-ed-acts"><button type="button" class="btn btn-sm btn-primary" data-pv-save>保存</button><button type="button" class="btn btn-sm btn-ghost" data-pv-del>删除此任务</button><button type="button" class="btn btn-sm btn-ghost" data-pv-cancel>取消</button></div>`;
  positionPopup(popup,anchor);activePopup=popup;
  popup.querySelector('[data-pv-orig]').addEventListener('click',(e)=>{
    const b=e.currentTarget;const next=b.dataset.pvOrig==='1';
    b.dataset.pvOrig=next?'0':'1';b.textContent=(next?'不原创':'原创')+'（点击切换）';
  });
  popup.querySelectorAll('[data-pv-pf]').forEach(b=>{
    b.addEventListener('click',()=>{
      popup.querySelectorAll('[data-pv-pf]').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
    });
  });
  popup.querySelector('[data-pv-save]').addEventListener('click',()=>{
    const pfSel=popup.querySelector('[data-pv-pf].on')?.dataset.pvPf;
    const topics=String(popup.querySelector('[data-pv-topics]').value||'').trim().split(/[\s,，、]+/).filter(Boolean).map(x=>x.startsWith('#')?x:'#'+x).slice(0,5);
    const newTime=parsePvTimeText(popup.querySelector('[data-pv-time]').value);
    t.platforms=pfSel?pfSel.split(','):t.platforms;
    t.isOriginal=popup.querySelector('[data-pv-orig]').dataset.pvOrig==='1';
    t.publishAt=newTime;
    t.taskName=String(popup.querySelector('[data-pv-title]').value||'').trim()||'普通';
    t.publishTopics=topics;
    t.campaignName=String(popup.querySelector('[data-pv-campaign]').value||'').trim();
    closeAllPopups();S.preview.edited=true;renderPreview();
  });
  popup.querySelector('[data-pv-del]').addEventListener('click',()=>{
    S.preview.items.splice(index,1);S.preview.count=S.preview.items.length;
    closeAllPopups();S.preview.edited=true;renderPreview();
  });
  popup.querySelector('[data-pv-cancel]').addEventListener('click',()=>closeAllPopups());
}
async function refreshPreview(opts){
  const raw=el.input?.value?.trim()||'',seq=++previewSeq;
  const smart=Boolean(opts?.smart);
  if(!raw){S.preview={count:0,items:[],warnings:[],source:'',defaults:null,error:'',empty:true,mode:'auto'};renderPreview();return}
  try{
    const p=await window.antbot.parseTasks(raw,{smart});
    if(seq!==previewSeq)return;
    S.preview={count:p.tasks?.length||0,items:p.tasks||[],warnings:p.warnings||[],source:p.source||'',defaults:p.defaults||null,error:'',empty:false,mode:smart?'optimized':'auto',edited:false};
    renderPreview();
  }catch(e){
    if(seq!==previewSeq)return;
    S.preview={count:0,items:[],warnings:[],source:'',defaults:null,error:compact(e?.message||'解析失败'),empty:false,mode:smart?'optimized':'auto'};
    renderPreview();
  }
}
function queuePreview(){if(previewTimer)clearTimeout(previewTimer);previewTimer=setTimeout(()=>refreshPreview().catch(()=>{}),160)}
async function optimizeInput(){
  const raw=el.input?.value?.trim();
  if(!raw){toast('请先输入任务','info');return}
  el.optBtn?.classList.add('busy');
  try{
    await refreshPreview({smart:true});
    if(S.preview.error)toast(`优化失败: ${S.preview.error}`,'error');
    else toast('已用 AI 优化，可编辑后确定发送','success');
  }catch(e){toast(`优化失败: ${e.message}`,'error')}
  finally{el.optBtn?.classList.remove('busy')}
}

/* ── Quick settings ── */
function stepSetting(k,d){if(!S.settings)return;if(!S.settings.style)S.settings.style={};if(!S.settings.retry)S.settings.retry={};if(k==='voiceSpeed'){const c=Number(S.settings.style.voiceSpeed??1.1),n=Math.max(0.5,Math.min(2,Math.round((c+d*0.1)*10)/10));if(n!==c&&!Number.isNaN(n)){S.settings.style.voiceSpeed=n;renderChips();void qPatch({style:{voiceSpeed:n}},`语速 ${n.toFixed(1)}`)}}else if(k==='retry'){const c=Math.max(0,Number(S.settings.retry.failedTaskRetries??0)),n=Math.max(0,Math.min(20,c+d));if(n!==c){S.settings.retry.failedTaskRetries=n;renderChips();void qPatch({retry:{failedTaskRetries:n}},`重试 ${n}`)}}}
function toggleSetting(k){if(!S.settings)return;if(!S.settings.style)S.settings.style={};if(!S.settings.publish)S.settings.publish={};if(k==='voiceover'){const next=!(S.settings.style.voiceoverEnabled!==false);S.settings.style.voiceoverEnabled=next;if(!next)S.settings.style.subtitleEnabled=false;renderChips();void qPatch({style:{voiceoverEnabled:next,subtitleEnabled:next?(S.settings.style.subtitleEnabled!==false):false}},`旁白${next?'开':'关'}`)}else if(k==='subtitle'){if(S.settings.style.voiceoverEnabled===false)return;const cur=S.settings.style.subtitleEnabled===true,next=!cur;S.settings.style.subtitleEnabled=next;renderChips();void qPatch({style:{subtitleEnabled:next}},`字幕${next?'开':'关'}`)}else if(k==='publish'){const next=!(S.settings.publish.enabled!==false);S.settings.publish.enabled=next;renderChips();void qPatch({publish:{enabled:next}},`发布${next?'开':'关'}`)}}
function qPatch(p,h){if(!p||!S.settings)return;if(p.style&&!S.settings.style)S.settings.style={};if(p.retry&&!S.settings.retry)S.settings.retry={};if(p.publish&&!S.settings.publish)S.settings.publish={};merge(S.settings,p);renderChips();settingsDirty=true;if(settingsDirtyTimer)clearTimeout(settingsDirtyTimer);setQueue=setQueue.then(async()=>{await window.antbot.updateSettings(p).catch(e=>console.error('[qPatch]',e));settingsDirtyTimer=setTimeout(()=>{settingsDirty=false},2000);if(h){S.hint=h;renderStatus()}return S.settings})}

/* ── Startup ── */
async function runStartup(){const seq=++startupSeq;S.hint='';S.startup={type:'log',message:'检查中...'};renderStatus();try{const r=await window.antbot.checkStartup();if(seq!==startupSeq)return;S.startup={type:'result',result:r}}catch(e){if(seq!==startupSeq)return;S.startup={type:'log',message:`失败: ${compact(e?.message)}`}}renderStatus()}
async function refreshAppState(opts={}){const s=await window.antbot.getInitialState();applySnap(s);renderAll(opts);return s}

/* ── Edit videos (scheduler-based) ── */
S.editVideos = [];
S.editDefaults = { style: '', voice: '', subtitle: '开启' };
S.editHistory = [];
S.editTab = 'queue';

async function addEditVideos(filePaths) {
  const apiCfg = S.settings?.api || {};
  const tasks = filePaths.map(fp => {
    const name = fp.split(/[/\\]/).pop() || fp;
    const styleRef = S.styleRefs.find(s => s.name === S.editDefaults.style);
    const voice = (S.voices || []).find(v => v.name === S.editDefaults.voice);
    return {
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      path: fp, name,
      style: S.editDefaults.style, voice: S.editDefaults.voice, subtitle: S.editDefaults.subtitle,
      voiceProfileId: voice?.id || '', voiceProfileName: voice?.name || '',
      apiConfig: apiCfg,
    };
  });
  try {
    const created = await window.antbot.editAddTasks(tasks);
    for (const t of created) { if (!S.editVideos.find(v => v.id === t.id)) S.editVideos.push(t); }
    renderEditCards(); renderEditStartBtn();
    // Extract thumbnails for preview
    for (const task of created) {
      if (task.path) {
        window.antbot.extractThumbnail(task.path).then(result => {
          if (result.ok && result.dataUrl) {
            const v = S.editVideos.find(x => x.id === task.id);
            if (v) {
              v.thumbnailUrl = result.dataUrl;
              renderEditCards();
            }
          }
        }).catch(() => {});
      }
    }
  } catch (e) { toast(e.message, 'error'); }
}

function renderEditStartBtn() {
  const btn = document.getElementById('edit-start-btn');
  if (!btn) return;
  const hasRunning = S.editVideos.some(v => ['preparing', 'composing'].includes(v.status));
  const pending = S.editVideos.filter(v => v.status === 'pending' || v.status === 'paused');
  const selected = S.editVideos.filter(v => v.selected);

  if (hasRunning) { btn.disabled = true; btn.textContent = '处理中...'; }
  else if (selected.length > 0) {
    btn.disabled = false;
    btn.textContent = `开始选中 ${selected.length} 个`;
    btn.onclick = () => startSelectedTasks();
  }
  else if (pending.length > 0) {
    btn.disabled = false;
    btn.textContent = `开始 ${pending.length} 个`;
    btn.onclick = async () => { try { await window.antbot.editStartAll(); } catch (e) { toast(e.message, 'error'); } };
  }
  else { btn.disabled = true; btn.textContent = '开始剪辑'; btn.onclick = null; }

  // 批量操作按钮
  const batchBtn = document.getElementById('edit-batch-btn');
  if (batchBtn) {
    const hasSelected = selected.length > 0;
    batchBtn.style.display = hasSelected ? 'inline-block' : 'none';
    batchBtn.textContent = `批量操作 (${selected.length})`;
  }

  document.querySelectorAll('.edit-default-btn').forEach(b => { b.disabled = hasRunning; b.style.opacity = hasRunning ? '0.4' : ''; b.style.pointerEvents = hasRunning ? 'none' : ''; });
  renderStatus();
}

async function startSelectedTasks() {
  const selected = S.editVideos.filter(v => v.selected);
  for (const v of selected) {
    if (v.status === 'pending' || v.status === 'paused' || v.status === 'failed') {
      await window.antbot.editStartTask(v.id).catch(() => {});
    }
  }
  // 清除选择
  S.editVideos.forEach(v => v.selected = false);
  renderEditCards(); renderEditStartBtn();
}

function showBatchActions() {
  const selected = S.editVideos.filter(v => v.selected);
  if (!selected.length) return;

  const popup = document.createElement('div');
  popup.className = 'chip-popup';
  popup.innerHTML = `<ul class="style-list">
    <li class="style-item" data-batch="start">开始选中 (${selected.length})</li>
    <li class="style-item" data-batch="cancel">取消选中</li>
    <li class="style-item" data-batch="remove">移除选中</li>
    <li class="style-item" data-batch="clear">清除选择</li>
  </ul>`;

  document.body.appendChild(popup);
  popup.style.position = 'fixed';
  popup.style.top = '50%';
  popup.style.left = '50%';
  popup.style.transform = 'translate(-50%, -50%)';
  popup.style.zIndex = '10000';

  popup.querySelectorAll('.style-item').forEach(item => {
    item.addEventListener('click', async () => {
      const action = item.dataset.batch;
      if (action === 'start') {
        await startSelectedTasks();
      } else if (action === 'cancel') {
        for (const v of selected) {
          await window.antbot.cancelEditTask(v.id).catch(() => {});
        }
      } else if (action === 'remove') {
        for (const v of selected) {
          await window.antbot.editRemoveTask(v.id).catch(() => {});
          S.editVideos = S.editVideos.filter(x => x.id !== v.id);
        }
      } else if (action === 'clear') {
        S.editVideos.forEach(v => v.selected = false);
      }
      popup.remove();
      renderEditCards(); renderEditStartBtn();
    });
  });
}

function fmtDur(sec) {
  if (!sec || sec < 1) return '';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

function renderEditCards() {
  const container = document.getElementById('edit-cards');
  const empty = document.getElementById('edit-empty');
  if (!container) return;
  document.querySelectorAll('.edit-tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === S.editTab));
  if (S.editTab === 'history') { renderEditHistory(container); if (empty) empty.classList.add('hidden'); return; }
  if (!S.editVideos.length) { container.innerHTML = ''; if (empty) empty.classList.remove('hidden'); return; }
  if (empty) empty.classList.add('hidden');

  container.innerHTML = S.editVideos.map(v => {
    const st = v.status || 'pending';
    const pct = Math.max(0, Math.min(100, v.progress || 0));
    const icons = { pending: 'clock', preparing: 'loader', ready: 'film', composing: 'scissors', paused: 'pause', completed: 'check', failed: 'alertCircle', cancelled: 'x', cancelling: 'loader' };
    const icon = `<span class="icon" data-icon="${icons[st] || 'clock'}"></span>`;
    const txt = st === 'preparing' ? `${v.step || '准备中'} ${pct}%` : st === 'ready' ? `待合成 · ${v.videoName || ''}` : st === 'composing' ? `合成中 ${pct}%` : st === 'completed' ? `完成 ${fmtDur(v.duration)}` : st === 'failed' ? `失败` : st === 'paused' ? '已暂停' : st === 'cancelled' ? '已取消' : st === 'cancelling' ? '取消中...' : '等待中';
    const selectedClass = v.selected ? ' selected' : '';
    let acts = '';
    if (st === 'pending') acts = `<button class="edit-act-btn" data-act="start" data-vid="${esc(v.id)}">开始</button><button class="edit-act-btn danger" data-act="remove" data-vid="${esc(v.id)}">移除</button>`;
    else if (st === 'preparing') acts = `<button class="edit-act-btn" data-act="pause" data-vid="${esc(v.id)}">暂停</button><button class="edit-act-btn danger" data-act="cancel" data-vid="${esc(v.id)}">取消</button>`;
    else if (st === 'ready') acts = `<button class="edit-act-btn" data-act="compose" data-vid="${esc(v.id)}">合成</button><button class="edit-act-btn danger" data-act="cancel" data-vid="${esc(v.id)}">取消</button>`;
    else if (st === 'composing') acts = `<button class="edit-act-btn danger" data-act="cancel" data-vid="${esc(v.id)}">取消</button>`;
    else if (st === 'cancelling') acts = `<button class="edit-act-btn" disabled style="opacity:.5">取消中...</button>`;
    else if (st === 'paused') acts = `<button class="edit-act-btn" data-act="resume" data-vid="${esc(v.id)}">继续</button><button class="edit-act-btn danger" data-act="cancel" data-vid="${esc(v.id)}">取消</button>`;
    else if (st === 'completed') acts = `<button class="edit-act-btn" data-act="open" data-vid="${esc(v.id)}">打开</button><button class="edit-act-btn danger" data-act="remove" data-vid="${esc(v.id)}">移除</button>`;
    else { const retryLabel = v.retryCount > 0 ? `重试 (${v.retryCount})` : '重试'; acts = `<button class="edit-act-btn" data-act="retry" data-vid="${esc(v.id)}">${retryLabel}</button><button class="edit-act-btn danger" data-act="remove" data-vid="${esc(v.id)}">移除</button>`; }

    const showProgress = ['preparing', 'composing', 'cancelling'].includes(st);
    const etaText = v.eta ? ` · 预计${v.eta}` : '';
    const errorDetail = st === 'failed' && v.error ? `<div class="edit-card-error" data-error-toggle="${esc(v.id)}"><span class="error-summary">${esc(v.error.slice(0, 50))}${v.error.length > 50 ? '...' : ''}</span><span class="error-expand">展开</span></div><div class="edit-card-error-full hidden" data-error-full="${esc(v.id)}">${esc(v.error)}</div>` : '';
    const optDisabled = ['completed', 'composing', 'cancelling'].includes(st) ? ' disabled' : '';
    const thumbnailHtml = v.thumbnailUrl ? `<img src="${v.thumbnailUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius-sm)" />` : `<span class="icon" data-icon="film"></span>`;
    return `<div class="edit-card ${st}${selectedClass}" data-video-id="${esc(v.id)}">
      <div class="edit-card-select"><input type="checkbox" ${v.selected ? 'checked' : ''} data-select="${esc(v.id)}"></div>
      <div class="edit-card-icon" data-vid="${esc(v.id)}">${thumbnailHtml}</div>
      <div class="edit-card-info">
        <div class="edit-card-name">${esc(v.name)} <span class="edit-card-status">${icon} ${esc(txt)}${etaText}</span></div>
        <div class="edit-card-opts">
          <button class="edit-opt-btn" data-edit-card-opt="style" data-vid="${esc(v.id)}" type="button"${optDisabled}>风格: <span class="val">${esc(v.style || '默认')}</span></button>
          <button class="edit-opt-btn" data-edit-card-opt="voice" data-vid="${esc(v.id)}" type="button"${optDisabled}>音色: <span class="val">${esc(v.voice || '默认')}</span></button>
          <button class="edit-opt-btn" data-edit-card-opt="subtitle" data-vid="${esc(v.id)}" type="button"${optDisabled}>字幕: <span class="val">${esc(v.subtitle || '开启')}</span></button>
        </div>
        ${showProgress ? `<div class="edit-card-progress"><div class="edit-card-progress-bar" style="width:${pct}%"></div></div>` : ''}
        ${v.message ? `<div class="edit-card-msg">${esc(v.message)}</div>` : ''}
        ${errorDetail}
      </div>
      <div class="edit-card-actions">${acts}</div>
    </div>`;
  }).join('');
  injectIcons(); bindEditCardEvents();
}

function bindEditCardEvents() {
  const c = document.getElementById('edit-cards'); if (!c) return;
  c.querySelectorAll('[data-edit-card-opt]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); showEditCardPopup(btn, btn.dataset.vid, btn.dataset.editCardOpt); }));
  c.querySelectorAll('.edit-card-icon').forEach(icon => { icon.addEventListener('click', () => { const vid = icon.dataset.vid; const v = S.editVideos.find(x => x.id === vid); if (v?.path) window.antbot.revealInFolder(v.path); }); });

  // 复选框选择
  c.querySelectorAll('[data-select]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const vid = cb.dataset.select;
      const v = S.editVideos.find(x => x.id === vid);
      if (v) {
        v.selected = cb.checked;
        renderEditStartBtn();
      }
    });
  });

  // 错误详情展开
  c.querySelectorAll('[data-error-toggle]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const vid = el.dataset.errorToggle;
      const fullEl = c.querySelector(`[data-error-full="${vid}"]`);
      if (fullEl) {
        fullEl.classList.toggle('hidden');
        const expandEl = el.querySelector('.error-expand');
        if (expandEl) expandEl.textContent = fullEl.classList.contains('hidden') ? '展开' : '收起';
      }
    });
  });

  c.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const vid = btn.dataset.vid, action = btn.dataset.act;
    if (action === 'start' || action === 'compose') await window.antbot.editStartTask(vid);
    else if (action === 'retry') await window.antbot.editRetryTask(vid);
    else if (action === 'pause') await window.antbot.editPauseTask(vid);
    else if (action === 'resume') await window.antbot.editStartTask(vid);
    else if (action === 'cancel') {
      const local = S.editVideos.find(v => v.id === vid);
      if (local && local.status !== 'cancelling') { local.status = 'cancelling'; local.message = '取消中...'; renderEditCards(); renderEditStartBtn(); }
      await window.antbot.cancelEditTask(vid);
    }
    else if (action === 'remove') {
      await window.antbot.editRemoveTask(vid);
      S.editVideos = S.editVideos.filter(v => v.id !== vid);
      renderEditCards(); renderEditStartBtn();
    }
    else if (action === 'open') { const v = S.editVideos.find(x => x.id === vid); if (v?.outputPath) window.antbot.revealInFolder(v.outputPath); }
  }));
}

// 接收主进程任务状态更新
function handleEditTaskUpdate(t) {
  if (!t?.id) return;
  const idx = S.editVideos.findIndex(v => v.id === t.id);
  let merged;
  if (idx >= 0) {
    // 保留用户设置的 style/voice/subtitle，只更新状态相关字段
    const local = S.editVideos[idx];
    merged = {
      ...t,
      style: local.style || t.style || '',
      voice: local.voice || t.voice || '',
      subtitle: local.subtitle || t.subtitle || '开启',
    };
    S.editVideos[idx] = merged;
  } else {
    merged = t;
    S.editVideos.push(t);
  }
  renderEditCards(); renderEditStartBtn();
  // 使用合并后的数据保存历史记录，确保用户修改的风格/音色被正确记录
  if (merged.status === 'completed' && merged.outputPath) {
    window.antbot.saveEditHistory({ id: `hist-${Date.now()}`, name: merged.name, sourcePath: merged.path, outputPath: merged.outputPath, status: 'completed', style: merged.style, voice: merged.voice, error: '', duration: merged.duration || 0, fileSize: 0, createdAt: new Date().toISOString() }).catch(() => {});
    toast(`完成: ${merged.name} (${fmtDur(merged.duration)})`, 'success');
  } else if (merged.status === 'failed') {
    window.antbot.saveEditHistory({ id: `hist-${Date.now()}`, name: merged.name, sourcePath: merged.path, outputPath: '', status: 'failed', style: merged.style, voice: merged.voice, error: (merged.error || '').slice(0, 200), duration: merged.duration || 0, fileSize: 0, createdAt: new Date().toISOString() }).catch(() => {});
  }
}

// 初始化：从主进程加载已有任务
async function loadEditTasks() { try { S.editVideos = await window.antbot.editGetTasks(); renderEditCards(); renderEditStartBtn(); } catch {} }

/* ── Edit history ── */
async function loadEditHistory() { showLoading('edit-cards'); try { S.editHistory = await window.antbot.getEditHistory(); } catch { S.editHistory = []; } renderEditCards(); }

function renderEditHistory(container) {
  if (!container) return;
  if (!S.editHistory.length) { container.innerHTML = '<div class="edit-empty-hist">暂无历史记录</div>'; return; }

  // 按日期分组
  const today = new Date(); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const groups = {};
  for (const h of S.editHistory) {
    const d = h.createdAt ? new Date(h.createdAt) : new Date();
    const dayStart = new Date(d); dayStart.setHours(0,0,0,0);
    let label;
    if (dayStart.getTime() === today.getTime()) label = '今天';
    else if (dayStart.getTime() === yesterday.getTime()) label = '昨天';
    else label = `${d.getMonth()+1}月${d.getDate()}日`;
    if (!groups[label]) groups[label] = [];
    groups[label].push(h);
  }

  // 获取已添加到发布队列的视频路径
  const addedPaths = new Set((S.publish?.videos || []).map(v => v.path));

  const groupKeys = Object.keys(groups);
  container.innerHTML = groupKeys.map((label, gi) => {
    const isToday = gi === 0;
    const items = groups[label];
    const rows = items.map(h => {
      const ok = h.status === 'completed';
      const dur = ok ? `剪耗时:${fmtDur(h.duration)}` : `失败：${(h.error || '').slice(0, 60)}`;
      const style = h.style || '默认';
      const voice = h.voice || '默认';
      const detail = ok ? `${dur}，风格:${style}，音色:${voice}，有字幕` : dur;
      const time = h.createdAt ? new Date(h.createdAt).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'}) : '';
      // 显示输出文件名（而非原始文件名）
      const displayName = ok && h.outputPath ? h.outputPath.split(/[/\\]/).pop().replace(/\.[^.]+$/, '') : h.name;
      const isAdded = ok && h.outputPath && addedPaths.has(h.outputPath);
      return `<div class="edit-hist-item ${h.status}">
        <div class="edit-hist-info">
          <div class="edit-hist-name"><span class="icon" data-icon="${ok ? 'check' : 'alertCircle'}" style="color:var(--${ok ? 'success' : 'destructive'})"></span> ${esc(displayName)}</div>
          <div class="edit-hist-detail">${esc(detail)}</div>
          <div class="edit-hist-time">${esc(time)}</div>
        </div>
        <div class="edit-hist-acts">
          ${ok && h.outputPath ? `<button class="edit-act-btn" data-hact="publish" data-hid="${esc(h.id)}">${isAdded ? '已添加' : '添加发布'}</button>` : ''}
          ${ok ? `<button class="edit-act-btn" data-hact="open" data-hid="${esc(h.id)}">打开</button>` : ''}
          <button class="edit-act-btn" data-hact="clear" data-hid="${esc(h.id)}">清理</button>
        </div>
      </div>`;
    }).join('');

    if (groupKeys.length === 1 && isToday) return rows; // 只有一组且是今天，不加折叠
    return `<div class="edit-hist-group${isToday ? ' expanded' : ''}" data-group="${esc(label)}">
      <div class="edit-hist-group-head" data-toggle-group="${esc(label)}">
        <span class="edit-hist-group-label">${esc(label)}</span>
        <span class="edit-hist-group-count">${items.length} 个</span>
        <span class="edit-hist-group-arrow">›</span>
      </div>
      <div class="edit-hist-group-body">${rows}</div>
    </div>`;
  }).join('');

  injectIcons();
  // 折叠/展开
  container.querySelectorAll('[data-toggle-group]').forEach(head => {
    head.addEventListener('click', () => {
      const group = head.closest('.edit-hist-group');
      if (group) group.classList.toggle('expanded');
    });
  });
  // 操作按钮
  container.querySelectorAll('[data-hact]').forEach(btn => btn.addEventListener('click', async () => {
    const hid = btn.dataset.hid, act = btn.dataset.hact;
    if (act === 'open') { const h = S.editHistory.find(x => x.id === hid); if (h?.outputPath) window.antbot.revealInFolder(h.outputPath); }
    else if (act === 'clear') {
      const h = S.editHistory.find(x => x.id === hid);
      if (h) {
        const r = await window.antbot.deleteEditHistory({ id: hid, deleteFile: false });
        if (r.ok) { S.editHistory = r.history; renderEditCards(); }
      }
    }
    else if (act === 'publish') {
      const h = S.editHistory.find(x => x.id === hid);
      if (h?.outputPath && S.publish) {
        const existingIndex = S.publish.videos.findIndex(v => v.path === h.outputPath);
        if (existingIndex >= 0) {
          S.publish.videos.splice(existingIndex, 1);
          toast(`已从发布队列移除`, 'info');
        } else {
          const video = { path: h.outputPath, name: h.outputPath.split(/[/\\]/).pop(), size: 0, status: 'pending' };
          try {
            const info = await window.antbot.getVideoInfo(h.outputPath);
            video.size = info.size || 0;
          } catch {}
          S.publish.videos.push(video);
          toast(`已添加到发布队列`, 'success');
        }
        renderEditHistory(container);
      }
    }
  }));
}

function showEditCardPopup(anchor, vid, type) {
  closeAllPopups();
  const video = S.editVideos.find(v => v.id === vid);
  if (!video) return;
  const popup = document.createElement('div'); popup.className = 'chip-popup';
  const current = video[type] || '';
  if (type === 'style') {
    const options = S.styleRefs.filter(s => !s.learning && s.prompt).map(s => s.name); if (!options.length) options = ['暂无风格'];
    popup.innerHTML = `<ul class="style-list">${options.map(o => `<li class="style-item${o === current ? ' active' : ''}" data-val="${esc(o)}">${esc(o)}</li>`).join('')}</ul>`;
    positionPopup(popup, anchor); activePopup = popup;
    popup.querySelectorAll('.style-item').forEach(item => item.addEventListener('click', async () => {
      const val = item.dataset.val;
      video[type] = val;
      await window.antbot.editUpdateTask(vid, { style: val }).catch(() => {});
      renderEditCards(); closeAllPopups();
    }));
    return;
  }
  if (type === 'voice') {
    const voices = S.voices || [];
    if (!voices.length) { toast('暂无可用音色', 'info'); return; }
    const azure = voices.filter(v => v.source === 'azure');
    const clone = voices.filter(v => v.source !== 'azure');
    const activeName = current;
    const activeSource = activeName ? voices.find(v => v.name === activeName)?.source : null;
    const renderSection = (label, items) => {
      if (!items.length) return '';
      const open = activeSource === (items[0].source || '') ? ' open' : '';
      const collapsed = open ? '' : ' style="display:none"';
      return `<div class="style-section" data-section="${esc(items[0].source || '')}"><span class="style-section-arrow${open}" data-arrow="1">▶</span>${esc(label)}</div><div class="style-section-items"${collapsed}>${items.map(v => `<li class="style-item${v.name === activeName ? ' active' : ''}" data-val="${esc(v.name)}">${esc(v.name)}</li>`).join('')}</div>`;
    };
    popup.innerHTML = `<ul class="style-list">${renderSection('内置音色（Azure TTS）', azure)}${renderSection('克隆音色', clone)}</ul>`;
    positionPopup(popup, anchor); activePopup = popup;
    popup.querySelectorAll('.style-section').forEach(section => {
      section.addEventListener('click', (e) => {
        e.stopPropagation();
        const items = section.nextElementSibling;
        if (!items || !items.classList.contains('style-section-items')) return;
        const arrow = section.querySelector('[data-arrow]');
        if (items.style.display === 'none') { items.style.display = ''; arrow.classList.add('open'); } else { items.style.display = 'none'; arrow.classList.remove('open'); }
      });
    });
    popup.querySelectorAll('.style-item').forEach(item => item.addEventListener('click', async () => {
      const val = item.dataset.val;
      video[type] = val;
      const voice = voices.find(v => v.name === val);
      const updateData = {};
      if (voice) {
        updateData.voiceProfileId = voice.id;
        updateData.voiceProfileName = voice.name;
      }
      await window.antbot.editUpdateTask(vid, updateData).catch(() => {});
      renderEditCards(); closeAllPopups();
    }));
    return;
  }
  const options = ['开启', '关闭'];
  popup.innerHTML = `<ul class="style-list">${options.map(o => `<li class="style-item${o === current ? ' active' : ''}" data-val="${esc(o)}">${esc(o)}</li>`).join('')}</ul>`;
  positionPopup(popup, anchor); activePopup = popup;
  popup.querySelectorAll('.style-item').forEach(item => item.addEventListener('click', async () => {
    const val = item.dataset.val;
    video[type] = val;
    renderEditCards(); closeAllPopups();
  }));
}

function showEditDefaultPopup(anchor, type) {
  closeAllPopups();
  const current = S.editDefaults[type] || '';
  const popup = document.createElement('div'); popup.className = 'chip-popup';
  if (type === 'style') {
    const options = S.styleRefs.filter(s => !s.learning && s.prompt).map(s => s.name); if (!options.length) options = ['暂无风格'];
    popup.innerHTML = `<ul class="style-list">${options.map(o => `<li class="style-item${o === current ? ' active' : ''}" data-val="${esc(o)}">${esc(o)}</li>`).join('')}</ul>`;
    positionPopup(popup, anchor); activePopup = popup;
    popup.querySelectorAll('.style-item').forEach(item => item.addEventListener('click', () => {
      const val = item.dataset.val;
      S.editDefaults[type] = val;
      S.selectedStyle = val;
      renderChips();
      S.editVideos.forEach(v => { if (v.status === 'pending' || v.status === 'failed' || v.status === 'cancelled') v[type] = val; });
      const valEl = document.getElementById(`default-${type}-val`);
      if (valEl) valEl.textContent = val || '默认';
      renderEditCards(); closeAllPopups();
      saveUI();
      toast(`默认风格: ${val || '默认'}`, 'info');
    }));
    return;
  }
  if (type === 'voice') {
    const voices = S.voices || [];
    if (!voices.length) { toast('暂无可用音色', 'info'); return; }
    const azure = voices.filter(v => v.source === 'azure');
    const clone = voices.filter(v => v.source !== 'azure');
    const activeName = current;
    const activeSource = activeName ? voices.find(v => v.name === activeName)?.source : null;
    const renderSection = (label, items) => {
      if (!items.length) return '';
      const open = activeSource === (items[0].source || '') ? ' open' : '';
      const collapsed = open ? '' : ' style="display:none"';
      return `<div class="style-section" data-section="${esc(items[0].source || '')}"><span class="style-section-arrow${open}" data-arrow="1">▶</span>${esc(label)}</div><div class="style-section-items"${collapsed}>${items.map(v => `<li class="style-item${v.name === activeName ? ' active' : ''}" data-val="${esc(v.name)}">${esc(v.name)}</li>`).join('')}</div>`;
    };
    popup.innerHTML = `<ul class="style-list">${renderSection('内置音色（Azure TTS）', azure)}${renderSection('克隆音色', clone)}</ul>`;
    positionPopup(popup, anchor); activePopup = popup;
    popup.querySelectorAll('.style-section').forEach(section => {
      section.addEventListener('click', (e) => {
        e.stopPropagation();
        const items = section.nextElementSibling;
        if (!items || !items.classList.contains('style-section-items')) return;
        const arrow = section.querySelector('[data-arrow]');
        if (items.style.display === 'none') { items.style.display = ''; arrow.classList.add('open'); } else { items.style.display = 'none'; arrow.classList.remove('open'); }
      });
    });
    popup.querySelectorAll('.style-item').forEach(item => item.addEventListener('click', () => {
      const val = item.dataset.val;
      S.editDefaults[type] = val;
      S.editVideos.forEach(v => { if (v.status === 'pending' || v.status === 'failed' || v.status === 'cancelled') v[type] = val; });
      const valEl = document.getElementById(`default-${type}-val`);
      if (valEl) valEl.textContent = val || '默认';
      renderEditCards(); closeAllPopups();
      saveUI();
      toast(`默认音色: ${val || '默认'}`, 'info');
    }));
    return;
  }
  const options = ['开启', '关闭'];
  popup.innerHTML = `<ul class="style-list">${options.map(o => `<li class="style-item${o === current ? ' active' : ''}" data-val="${esc(o)}">${esc(o)}</li>`).join('')}</ul>`;
  positionPopup(popup, anchor); activePopup = popup;
  popup.querySelectorAll('.style-item').forEach(item => item.addEventListener('click', () => {
    const val = item.dataset.val;
    S.editDefaults[type] = val;
    S.editVideos.forEach(v => { if (v.status === 'pending' || v.status === 'failed' || v.status === 'cancelled') v[type] = val; });
    const valEl = document.getElementById(`default-${type}-val`);
    if (valEl) valEl.textContent = val || '默认';
    renderEditCards(); closeAllPopups();
    toast(`默认${type === 'style' ? '风格' : type === 'voice' ? '音色' : '字幕'}: ${val || '默认'}`, 'info');
  }));
}

/* ── Style reference ── */
S.styleRefs = [];
let styleIdSeq = 0;

async function loadStyles() {
  showLoading('style-cards');
  try {
    const styles = await window.antbot.loadStyles();
    if (Array.isArray(styles) && styles.length) {
      S.styleRefs = styles.filter(s => s && s.id && s.name);
      for (const s of S.styleRefs) {
        const num = parseInt(String(s.id).replace('sty-', ''), 10);
        if (num > styleIdSeq) styleIdSeq = num;
      }
    }
  } catch {}
  renderStyleCards();
}

function addStyleRef({ name, prompt, type, videoPaths }) {
  const ref = { id: `sty-${++styleIdSeq}`, name: name || '未命名风格', prompt: prompt || '', type: type || 'text', videoPaths: videoPaths || [], createdAt: new Date().toISOString() };
  S.styleRefs.push(ref);
  renderStyleCards();
  // Persist
  window.antbot.saveOneStyle(ref).catch(() => {});
}

function removeStyleRef(id) {
  S.styleRefs = S.styleRefs.filter(s => s.id !== id);
  renderStyleCards();
  // Persist
  window.antbot.deleteStyle(id).catch(() => {});
}

function renderStyleCards() {
  const container = document.getElementById('style-cards');
  const empty = document.getElementById('style-empty');
  if (!container) return;
  if (!S.styleRefs.length) {
    container.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  container.innerHTML = S.styleRefs.map(s => {
    const expanded = s.expanded ? ' expanded' : '';
    const typeLabel = s.learning ? '学习中...' : (s.type === 'video' ? '视频' : '文本');
    let body = '';
    if (s.learning) {
      body = `<div class="progress-box"><div class="prog-info"><span>正在学习</span></div><div class="prog-track"><div class="prog-bar" style="width:60%;animation:pulse 1.5s ease infinite"></div></div></div>`;
    } else {
      body = `<div class="style-card-edit">
        <label class="style-card-label">风格名称</label>
        <input class="style-card-name-input" data-style-name="${esc(s.id)}" type="text" value="${esc(s.name)}" />
        <label class="style-card-label">提示词</label>
        <textarea class="style-card-prompt" data-style-prompt="${esc(s.id)}" placeholder="输入风格提示词...">${esc(s.prompt)}</textarea>
        <div class="style-card-actions">
          <button class="btn btn-sm btn-ghost" data-style-delete="${esc(s.id)}" type="button"><span class="icon" data-icon="trash"></span>删除</button>
          <button class="btn btn-sm btn-primary" data-style-save="${esc(s.id)}" type="button"><span class="icon" data-icon="check"></span>保存</button>
        </div>
      </div>`;
    }
    return `<div class="style-card${expanded}" data-style-id="${esc(s.id)}">
      <div class="style-card-head" data-toggle-style="${esc(s.id)}">
        <span class="style-card-name">${esc(s.name)}</span>
        <span class="style-card-type">${typeLabel}</span>
      </div>
      <div class="style-card-body">${body}</div>
    </div>`;
  }).join('');
  injectIcons();
}

function showStyleTextDialog() {
  const dlg = document.getElementById('style-text-dialog');
  if (dlg) { document.getElementById('style-text-name').value = ''; document.getElementById('style-text-prompt').value = ''; dlg.showModal(); }
}
function showStyleVideoDialog() {
  const dlg = document.getElementById('style-video-dialog');
  S._styleVideoFiles = [];
  if (dlg) { document.getElementById('style-video-name').value = ''; document.getElementById('style-video-files').textContent = '未选择'; dlg.showModal(); }
}

function bindStyleRefEvents() {
  // Style card expand/collapse
  document.addEventListener('click', e => {
    const head = e.target.closest('[data-toggle-style]');
    if (head) {
      const card = head.closest('.style-card');
      if (card) card.classList.toggle('expanded');
    }
  });
  // Save prompt + name
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-style-save]');
    if (btn) {
      const id = btn.dataset.styleSave;
      const textarea = document.querySelector(`[data-style-prompt="${id}"]`);
      const nameInput = document.querySelector(`[data-style-name="${id}"]`);
      const style = S.styleRefs.find(s => s.id === id);
      if (style) {
        if (textarea) style.prompt = textarea.value;
        if (nameInput && nameInput.value.trim()) style.name = nameInput.value.trim();
        renderStyleCards();
        toast('已保存', 'success');
        // Persist
        window.antbot.saveOneStyle(style).catch(() => {});
      }
    }
  });
  // Delete style
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-style-delete]');
    if (btn) { removeStyleRef(btn.dataset.styleDelete); toast('已删除', 'info'); }
  });
  // Add text button
  document.getElementById('style-add-text-btn')?.addEventListener('click', showStyleTextDialog);
  // Add video button
  document.getElementById('style-add-video-btn')?.addEventListener('click', showStyleVideoDialog);
  // Text dialog save
  document.getElementById('style-text-save-btn')?.addEventListener('click', () => {
    const name = document.getElementById('style-text-name')?.value?.trim();
    const prompt = document.getElementById('style-text-prompt')?.value?.trim();
    if (!name) { toast('请输入风格名称', 'error'); return; }
    addStyleRef({ name, prompt, type: 'text' });
    document.getElementById('style-text-dialog')?.close();
    toast(`已添加: ${name}`, 'success');
  });
  document.getElementById('close-style-text-btn')?.addEventListener('click', () => document.getElementById('style-text-dialog')?.close());
  // Video dialog pick
  document.getElementById('style-video-pick-btn')?.addEventListener('click', async () => {
    try {
      const files = await window.antbot.pickVideoFiles();
      if (files && files.length) {
        S._styleVideoFiles = files;
        document.getElementById('style-video-files').textContent = files.map(f => f.split(/[/\\]/).pop()).join(', ');
      }
    } catch (e) { toast(e.message, 'error'); }
  });
  // Video dialog start - actual learning
  document.getElementById('style-video-start-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('style-video-name')?.value?.trim();
    if (!name) { toast('请输入风格名称', 'error'); return; }
    if (!S._styleVideoFiles?.length) { toast('请先选择视频', 'error'); return; }
    document.getElementById('style-video-dialog')?.close();
    // Add a learning card
    const id = `sty-${++styleIdSeq}`;
    S.styleRefs.push({ id, name, prompt: '', type: 'video', videoPaths: S._styleVideoFiles, learning: true });
    renderStyleCards();
    // Start learning for each video
    const texts = [];
    for (const vp of S._styleVideoFiles) {
      try {
        const r = await window.antbot.styleLearnFromVideo({ videoPath: vp, name });
        if (r.ok && r.text) texts.push(r.text);
      } catch (e) { toast(`学习失败: ${e.message}`, 'error'); }
    }
    // Update style ref with result
    const ref = S.styleRefs.find(s => s.id === id);
    if (ref) {
      ref.learning = false;
      ref.prompt = texts.join('\n\n');
      if (!ref.prompt) { removeStyleRef(id); toast('学习失败，未识别到文字', 'error'); }
      else {
        toast(`学习完成: ${name}`, 'success');
        // Persist the completed style
        window.antbot.saveOneStyle(ref).catch(() => {});
      }
    }
    renderStyleCards();
  });
  document.getElementById('close-style-video-btn')?.addEventListener('click', () => document.getElementById('style-video-dialog')?.close());
}

/* ── Model management ── */
S.models = {};
S.modelsDir = '';

/* ── Dependency check ── */
async function checkDeps() {
  const list = document.getElementById('deps-check-list');
  if (!list) return;
  const deps = [
    { key: 'ffmpeg', name: 'FFmpeg', desc: '音视频转换' },
    { key: 'python', name: 'Python', desc: '运行环境' },
    { key: 'whisper', name: 'Whisper', desc: '语音识别' },
  ];
  list.innerHTML = `<table class="deps-table"><thead><tr><th>工具</th><th>用途</th><th>状态</th><th></th></tr></thead><tbody>` +
    deps.map(d => `<tr data-dep-key="${d.key}"><td class="font-semibold">${d.name}</td><td class="text-muted">${d.desc}</td><td><span class="flex items-center gap-1"><span class="spinner spinner-xs"></span>检查中...</span></td><td></td></tr>`).join('') +
    '</tbody></table>';
  for (const d of deps) {
    try {
      const r = await window.antbot.checkDep(d.key);
      const row = list.querySelector(`[data-dep-key="${d.key}"]`);
      if (row) {
        const cells = row.querySelectorAll('td');
        cells[2].innerHTML = r.ok
          ? `<span class="flex items-center gap-1"><span class="icon" data-icon="check" style="color:var(--success)"></span>${r.version || '已安装'}</span>`
          : '<span class="text-muted">未安装</span>';
        cells[3].innerHTML = r.ok
          ? ''
          : '<button class="btn btn-xs btn-primary" data-dep-install="' + d.key + '" type="button">安装</button>';
      }
    } catch {}
  }
  list.querySelectorAll('[data-dep-install]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tool = btn.dataset.depInstall;
      const row = btn.closest('tr');
      const origHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner spinner-xs"></span> 安装中...';
      try {
        const r = await window.antbot.installDep(tool);
        if (r.ok) {
          if (row) { const cells = row.querySelectorAll('td'); cells[2].innerHTML = '<span class="flex items-center gap-1"><span class="icon" data-icon="check" style="color:var(--success)"></span>已安装</span>'; cells[3].innerHTML = ''; }
          toast(tool + ' 安装完成', 'success');
        } else {
          toast(r.message || '安装失败', 'error');
          btn.disabled = false; btn.innerHTML = origHtml;
        }
      } catch (e) {
        toast(e.message, 'error');
        btn.disabled = false; btn.innerHTML = origHtml;
      }
    });
  });
}

async function loadModels() {
  showLoading('models-list');
  try {
    const result = await window.antbot.modelsList();
    S.models = result.models || {};
    S.modelsDir = result.modelsDir || '';
    renderModels();
  } catch {}
}

function renderModels() {
  const list = document.getElementById('models-list');
  const pathEl = document.getElementById('models-dir-path');
  if (pathEl) pathEl.textContent = S.modelsDir || '-';
  if (!list) return;
  const entries = Object.entries(S.models);
  if (!entries.length) { list.innerHTML = '<div class="helper-text">暂无可用模型</div>'; return; }
  list.innerHTML = `<table class="deps-table"><thead><tr><th>模型</th><th>大小</th><th>状态</th><th></th></tr></thead><tbody>` +
    entries.map(([key, m]) => {
    const isHf = !!m.hfDownload;
    const useMirror = S.settings?.models?.useHfMirror;
    return `<tr data-model-key="${esc(key)}">
      <td><div class="font-semibold text-sm">${esc(m.name)}</div><div class="model-progress" id="model-progress-${esc(key)}"></div></td>
      <td class="text-muted">${esc(m.size)}</td>
      <td>${m.downloaded ? '<span class="flex items-center gap-1"><span class="icon" data-icon="check" style="color:var(--success)"></span>已下载</span>' : '<span class="text-muted">未下载</span>'}</td>
      <td><div class="flex items-center gap-1">
        ${m.downloaded
          ? `<button class="btn btn-xs btn-ghost" data-model-delete="${esc(key)}" type="button">删除</button>`
          : `<button class="btn btn-xs btn-primary" data-model-download="${esc(key)}" type="button">下载</button>
             <button class="btn btn-xs btn-ghost" data-model-browser="${esc(key)}" type="button">浏览器</button>
             <button class="btn btn-xs btn-ghost" data-model-import="${esc(key)}" data-hf="${isHf ? '1' : ''}" type="button">导入</button>
             ${isHf ? `<label class="flex items-center gap-1 text-xs cursor-pointer"><input type="checkbox" class="checkbox" data-model-mirror ${useMirror ? 'checked' : ''} /> 国内镜像</label>` : ''}
             `
        }
      </div></td>
    </tr>`;
  }).join('') + '</tbody></table>';
  injectIcons();
}

/* ── Voicebox dependency check ── */
async function checkVoicebox() {
  const container = document.getElementById('voicebox-items');
  const pathEl = document.getElementById('voicebox-path');
  if (!container) return;
  container.innerHTML = '<div class="voicebox-item flex items-center gap-2"><span class="spinner"></span><span class="voicebox-name">检测中...</span></div>';
  try {
    const result = await window.antbot.voiceboxCheck();
    if (pathEl) pathEl.textContent = result.venvPath || '-';
    if (!result.items?.length) {
      container.innerHTML = '<div class="voicebox-item"><span class="voicebox-name">未找到语音克隆环境</span></div>';
      return;
    }
    container.innerHTML = result.items.map(item => `
      <div class="voicebox-item ${item.ok ? 'ok' : 'fail'}">
        <span class="voicebox-name">${esc(item.name)}</span>
        <span class="voicebox-ver">${item.ok ? (item.version || '<span class="icon" data-icon="check"></span>') : '缺失'}</span>
      </div>
    `).join('');
  } catch {
    container.innerHTML = '<div class="voicebox-item fail"><span class="voicebox-name">检测失败</span></div>';
  }
}

/* ── Actions ── */
async function startTasks(forceItems){window.antbot.cancelTaskParse?.();const raw=el.input?.value?.trim();const pv=S.preview;if(!raw&&!(pv.items&&pv.items.length)){toast('请输入任务','error');return}if(!S.editDefaults?.style&&!S.selectedStyle){toast('建议先在底部菜单选择风格，否则剪辑将无风格指导','info')}try{let payload=raw;const useItems=forceItems||((pv.items&&pv.items.length&&!pv.empty)&&(pv.mode==='optimized'||pv.edited));if(useItems){payload=pv.items.map(t=>({id:t.id,rawLine:t.rawLine,taskName:t.taskName,isOriginal:!!t.isOriginal,videoUrl:t.videoUrl,timeRange:t.timeRange||'',platforms:t.platforms||[],publishCopy:t.publishCopy||'',publishTopics:t.publishTopics||[],campaignName:t.campaignName||'',publishAt:t.publishAt?new Date(t.publishAt):null}))}const r=await window.antbot.startTasks(payload);appendPending({runId:r.runId,inputText:raw||'',rules:useItems&&pv.items&&pv.items.length?pv.items:null});el.input.value='';autoInput();queuePreview();if(r.warnings?.length)toast(r.warnings[0],'info');toast(r.queued?`已排队 (${r.queuePosition})`:`已启动 ${r.taskCount} 条`,'success');renderChat({stick:true})}catch(e){toast(`失败: ${e.message}`,'error')}}
async function stopTasks(){const ok=await confirmDialog('确认停止所有任务？');if(!ok)return;try{await window.antbot.stopTasks();toast('已停止','success');await refreshAppState().catch(()=>{})}catch(e){toast(`失败: ${e.message}`,'error')}}
async function saveSettings(){
  try{
    const form=readForm();
    S.settings=await window.antbot.updateSettings(form);
    loadApiUsage().catch(()=>{});
  }catch(e){console.error('[saveSettings]',e)}
}
function findTask(tid){for(const r of S.history||[])for(const i of r.items||[])if(String(i.taskId)===String(tid))return i;return null}

/* ── Voice list (cloned voices) ── */
S.voices = [];
S.activeVoiceId = '';

async function loadVoices() {
  showLoading('voice-list');
  try {
    const result = await window.antbot.listVoices();
    S.voices = result.voices || [];
    S.activeVoiceId = result.activeVoiceId || '';
    renderVoiceList();
  } catch {}
}

function renderVoiceList() {
  const list = document.getElementById('voice-list');
  if (!list) return;
  if (!S.voices.length) {
    list.innerHTML = '<div class="sv-note">暂无可用音色</div>';
    return;
  }
  const azureVoices = S.voices.filter(v => v.source === 'azure');
  const cloneVoices = S.voices.filter(v => v.source !== 'azure');
  const renderItem = (v) => `
    <div class="voice-item" data-voice-id="${esc(v.id)}">
      <div class="voice-item-info">
        <div class="voice-item-name">${esc(v.name)}</div>
        <div class="voice-item-id">${esc(v.id)}</div>
      </div>
      <div class="voice-item-actions">
        ${v.source === 'azure'
          ? '<span class="sv-tag">内置</span>'
          : `<button class="btn btn-sm btn-ghost" data-voice-rename="${esc(v.id)}" type="button">重命名</button>
             <button class="btn btn-sm btn-ghost" data-voice-delete="${esc(v.id)}" type="button" style="color:var(--destructive)">删除</button>`}
      </div>
    </div>
  `;
  const sections = [];
  if (azureVoices.length) {
    sections.push(`<div class="sv-section-title">内置音色（Azure TTS，无需克隆模型）</div>${azureVoices.map(renderItem).join('')}`);
  }
  if (cloneVoices.length) {
    sections.push(`<div class="sv-section-title">克隆音色</div>${cloneVoices.map(renderItem).join('')}`);
  }
  list.innerHTML = sections.join('');
  // Rename handlers - inline edit
  list.querySelectorAll('[data-voice-rename]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.voiceRename;
      const voice = S.voices.find(v => v.id === id);
      if (!voice) return;
      const item = btn.closest('.voice-item');
      const nameEl = item?.querySelector('.voice-item-name');
      if (!nameEl) return;
      const oldName = voice.name;
      nameEl.innerHTML = `<input type="text" value="${esc(oldName)}" class="voice-rename-input" />`;
      const input = nameEl.querySelector('input');
      input?.focus();
      input?.select();
      const finish = () => {
        const newName = input?.value?.trim() || oldName;
        if (newName && newName !== oldName) {
          voice.name = newName;
          window.antbot.saveVoices(S.voices).catch(() => {});
          toast(`已重命名: ${newName}`, 'success');
        }
        renderVoiceList();
      };
      input?.addEventListener('blur', finish);
      input?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') finish(); if (ev.key === 'Escape') renderVoiceList(); });
    });
  });
  // Delete handlers
  list.querySelectorAll('[data-voice-delete]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.voiceDelete;
      const voice = S.voices.find(v => v.id === id);
      if (!voice) return;
      if (window.confirm(`确认删除音色 "${voice.name}"？`)) {
        S.voices = S.voices.filter(v => v.id !== id);
        window.antbot.saveVoices(S.voices).catch(() => {});
        renderVoiceList();
        renderPresetVoices();
        toast('已删除', 'info');
      }
    });
  });
}

/* ── Preset Voices ── */
const PRESET_MANIFEST_URL = 'https://github.com/cxcboss/antbot-voice-models/releases/download/v1.0/manifest.json';
const PRESET_BASE_URL = 'https://github.com/cxcboss/antbot-voice-models/releases/download/v1.0/';

async function loadPresetVoices() {
  const box = document.getElementById('preset-voice-list');
  if (!box) return;
  box.innerHTML = '<div class="sv-note">加载中...</div>';
  try {
    const res = await fetch(PRESET_MANIFEST_URL);
    if (!res.ok) throw new Error('fetch failed');
    const manifest = await res.json();
    S.presetVoices = manifest;
    renderPresetVoices();
  } catch {
    box.innerHTML = '<div class="sv-note" style="color:var(--destructive)">无法加载预置音色列表</div>';
  }
}

function renderPresetVoices() {
  const box = document.getElementById('preset-voice-list');
  if (!box || !S.presetVoices?.length) return;
  const installedIds = new Set((S.voices || []).map(v => v.id));
  box.innerHTML = S.presetVoices.map(v => {
    const installed = installedIds.has(v.id);
    const sizeKB = Math.round(v.size / 1024);
    return `<div class="voice-item" data-preset-id="${esc(v.id)}">
      <div class="voice-item-info">
        <div class="voice-item-name">${esc(v.name)}</div>
        <div class="voice-item-id">${sizeKB}KB</div>
      </div>
      <div class="voice-item-actions">
        ${installed
          ? '<span class="icon" data-icon="check" style="color:var(--success);width:14px;height:14px"></span> 已安装'
          : `<button class="btn btn-sm btn-primary" data-preset-download="${esc(v.id)}" type="button">下载</button>`}
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-preset-download]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.presetDownload;
      const preset = S.presetVoices.find(p => p.id === id);
      if (!preset) return;
      btn.disabled = true;
      btn.textContent = '下载中...';
      try {
        const result = await window.antbot.downloadPresetVoice({
          voiceId: preset.id,
          voiceName: preset.name,
          downloadUrl: PRESET_BASE_URL + preset.file
        });
        if (result.ok) {
          toast(`${preset.name} 下载成功`, 'success');
          await loadVoices();
          renderPresetVoices();
        } else {
          toast(`下载失败: ${result.error}`, 'error');
          btn.disabled = false;
          btn.textContent = '下载';
        }
      } catch (e) {
        toast(`下载失败: ${e.message}`, 'error');
        btn.disabled = false;
        btn.textContent = '下载';
      }
    });
  });
}

/* ── Subtitle & Voice events ── */
function bindSubtitleVoiceEvents() {
  // Font picker
  document.getElementById('pick-font-btn')?.addEventListener('click', async () => {
    try {
      const result = await window.antbot.pickFontFile();
      if (result) {
        const name = result.split(/[/\\]/).pop() || 'font';
        await window.antbot.addFont({ name, path: result });
        await window.antbot.setActiveFont(name);
        const pathEl = document.getElementById('font-current-path');
        if (pathEl) pathEl.value = name;
        toast(`已切换字体: ${name}`, 'success');
      }
    } catch (e) { toast(e.message, 'error'); }
  });

  // Subtitle settings auto-save on change
  ['sub-color', 'sub-stroke', 'sub-position'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      const color = document.getElementById('sub-color')?.value || '#FFA100';
      const stroke = document.getElementById('sub-stroke')?.value || '#000000';
      const pos = Number(document.getElementById('sub-position')?.value || 12);
      window.antbot.updateSettings({
        style: { subtitleTextColor: color, subtitleStrokeColor: stroke, subtitlePositionPercent: pos }
      }).catch(() => {});
      toast('字幕样式已保存', 'success');
    });
  });

  // Voice dropzone - click to pick via IPC, drag to drop
  S._voiceFilePath = '';
  const dropzone = document.getElementById('voice-dropzone');
  const dropText = document.getElementById('voice-drop-text');

  dropzone?.addEventListener('click', async () => {
    try {
      const f = await window.antbot.pickAudioFile();
      if (f) {
        S._voiceFilePath = f;
        const name = f.split(/[/\\]/).pop();
        if (dropText) dropText.textContent = name;
        dropzone.classList.add('has-file');
      }
    } catch (e) { toast(e.message, 'error'); }
  });
  dropzone?.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone?.addEventListener('dragleave', () => { dropzone.classList.remove('dragover'); });
  dropzone?.addEventListener('drop', (e) => {
    e.preventDefault(); dropzone.classList.remove('dragover');
    const f = e.dataTransfer?.files?.[0];
    if (f && /\.(mp3|wav|m4a|aac|flac|ogg|wma)$/i.test(f.name)) {
      try { S._voiceFilePath = window.antbot.getPathForFile(f); } catch { S._voiceFilePath = ''; }
      if (dropText) dropText.textContent = f.name;
      dropzone.classList.add('has-file');
    } else {
      toast('请选择音频文件', 'error');
    }
  });

    
  // Voice clone - check button state
  function updateCloneBtn() {
    const btn = document.getElementById('voice-start-btn');
    if (!btn) return;
    btn.disabled = !(S._voiceFilePath && document.getElementById('voice-ref-text')?.value?.trim() && document.getElementById('voice-profile-name')?.value?.trim());
  }
  document.getElementById('voice-ref-text')?.addEventListener('input', updateCloneBtn);
  document.getElementById('voice-profile-name')?.addEventListener('input', updateCloneBtn);

  // Voice clone start
  document.getElementById('voice-start-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('voice-start-btn');
    const samplePath = S._voiceFilePath || '';
    const refText = document.getElementById('voice-ref-text')?.value?.trim();
    const profileName = document.getElementById('voice-profile-name')?.value?.trim();
    if (!samplePath || !refText || !profileName) return;
    if (btn) { btn.disabled = true; btn.textContent = '克隆中...'; }
    const anim = document.getElementById('voice-clone-anim');
    const animText = document.getElementById('voice-anim-text');
    if (anim) anim.classList.remove('hidden');
    let unsub = null;
    try {
      unsub = window.antbot.onVoiceCloneProgress((p) => {
        if (animText && (p?.step || p?.message)) animText.textContent = p.message || p.step || '';
      });
      const result = await window.antbot.runVoiceClone({ samplePath, referenceText: refText, profileName, language: 'zh' });
      if (result?.voiceId) {
        S.voices.push({ id: result.voiceId, name: profileName, source: 'clone' });
        await window.antbot.saveVoices(S.voices);
        renderVoiceList();
        toast(`\u514B\u9686\u5B8C\u6210: ${profileName}`, 'success');
        S._voiceFilePath = '';
        const dt = document.getElementById('voice-drop-text');
        const dz = document.getElementById('voice-dropzone');
        if (dt) dt.textContent = '\u62D6\u5165\u97F3\u9891\u6216\u70B9\u51FB\u9009\u62E9';
        if (dz) dz.classList.remove('has-file');
        const ri = document.getElementById('voice-ref-text');
        const ni = document.getElementById('voice-profile-name');
        if (ri) ri.value = '';
        if (ni) ni.value = '';
        updateCloneBtn();
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      unsub?.();
    }
    if (anim) anim.classList.add('hidden');
    if (btn) { btn.disabled = false; btn.textContent = '\u5F00\u59CB\u514B\u9686'; updateCloneBtn(); }
  });
}

function bind(){
  el.sidebarToggle?.addEventListener('click',()=>{S.sidebarOpen?closeSidebar():openSidebar()});
  el.overlay?.addEventListener('click',closeSidebar);
  window.addEventListener('resize',syncSidebar);
  // Feature switching
  document.querySelectorAll('.sb-feat').forEach(btn=>{btn.addEventListener('click',()=>switchFeature(btn.dataset.feat))});
  // Sidebar tab switching (功能/历史)
  document.querySelectorAll('.sb-tab').forEach(tab=>{tab.addEventListener('click',()=>{
    document.querySelectorAll('.sb-tab').forEach(t=>t.classList.remove('active'));tab.classList.add('active');
    document.querySelectorAll('.sb-panel').forEach(p=>p.classList.add('hidden'));
    const panel=$(`#sbpanel-${tab.dataset.sbtab}`);if(panel)panel.classList.remove('hidden');
    if(tab.dataset.sbtab==='history') loadSidebarApiUsage();
  })});
  // Edit page - drag and drop
  const editView = document.getElementById('view-edit');
  if (editView) {
    editView.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); editView.classList.add('drag-over'); });
    editView.addEventListener('dragleave', e => { if (!editView.contains(e.relatedTarget)) editView.classList.remove('drag-over'); });
    editView.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation(); editView.classList.remove('drag-over');
      const filePaths = [];
      for (const f of e.dataTransfer?.files || []) {
        try {
          const p = window.antbot.getPathForFile(f);
          if (p && /\.(mp4|mov|m4v|webm|mkv|avi|flv|wmv|ts)$/i.test(f.name)) filePaths.push(p);
        } catch {}
      }
      if (filePaths.length) {
        addEditVideos(filePaths);
        switchFeature('edit');
        toast(`已添加 ${filePaths.length} 个视频`, 'success');
      } else {
        toast('请拖入视频文件（mp4/mov/mkv 等）', 'info');
      }
    });
  }
  el.editAddBtn?.addEventListener('click',async()=>{try{const files=await window.antbot.pickVideoFiles();if(files&&files.length)addEditVideos(files)}catch(e){toast(e.message,'error')}});
  document.getElementById('edit-batch-btn')?.addEventListener('click', () => showBatchActions());

  // Edit tab switching
  document.querySelectorAll('.edit-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      S.editTab = btn.dataset.tab || 'queue';
      if (S.editTab === 'history') loadEditHistory();
      renderEditCards();
    });
  });

  // 接收主进程任务状态更新（实时）
  window.antbot.onEditTaskUpdate?.((t) => { handleEditTaskUpdate(t); });
  window.antbot.onDownloadTaskUpdate?.((t) => { handleDownloadTaskUpdate(t); });
  // Edit default buttons
  document.querySelectorAll('[data-edit-default]').forEach(btn=>{
    btn.addEventListener('click',()=>showEditDefaultPopup(btn,btn.dataset.editDefault));
  });
  // Stat period
  document.querySelectorAll('.stat-sw').forEach(btn=>{btn.addEventListener('click',()=>{document.querySelectorAll('.stat-sw').forEach(b=>b.classList.remove('active'));btn.classList.add('active');S.statPeriod=btn.dataset.period;saveUI();renderStats()})});
  // Platform buttons
  el.openVideoBtn?.addEventListener('click',()=>void window.antbot.openExternal('https://channels.weixin.qq.com/platform').catch(e=>toast(e.message,'error')));
  el.openDouyinBtn?.addEventListener('click',()=>void window.antbot.openExternal('https://creator.douyin.com/creator-micro/home').catch(e=>toast(e.message,'error')));
  // Auto-save on settings input change (settings page)
  document.getElementById('view-settings')?.addEventListener('change',()=>{void saveSettings();});
  document.getElementById('view-settings')?.addEventListener('input',(e)=>{if(e.target.matches('input[type=password],input[type=text],input[type=number]')){clearTimeout(S._settingsSaveTimer);S._settingsSaveTimer=setTimeout(()=>void saveSettings(),800);}});
  // 开机自动启动开关（保存后主进程自动同步 app.setLoginItemSettings）
  document.getElementById('s-auto-launch')?.addEventListener('click',()=>{
    const el=document.getElementById('s-auto-launch');
    if(!el)return;
    el.classList.toggle('on');
    void saveSettings();
  });
  // Add/remove/fetch API key buttons（每 key 独立配置）
  document.getElementById('add-api-key-btn')?.addEventListener('click',()=>{
    const list=document.getElementById('api-keys-list');if(!list)return;
    const count=list.querySelectorAll('.api-key-item').length+1;
    const last=normalizeKeysForForm(S.settings?.api).pop()||{};
    const item=document.createElement('div');
    item.innerHTML=apiKeyItemHtml({key:'',baseUrl:last.baseUrl||S.settings?.api?.baseUrl||'',modelId:'',availableModels:last.availableModels||[]},count);
    list.appendChild(item.firstElementChild);
    
    injectIcons();
    item.querySelector('input[name="apiKey"]')?.focus();
    void saveSettings();
  });
  document.getElementById('api-keys-list')?.addEventListener('click',async(e)=>{
    const del=e.target.closest('.s-key-del');
    if(del){del.closest('.api-key-item')?.remove();await saveSettings();loadApiUsage();return;}
    const vis=e.target.closest('.s-key-vis');
    if(vis){const inp=vis.closest('.s-input-row')?.querySelector('input[name="apiKey"]');if(inp)inp.type=inp.type==='password'?'text':'password';return;}
    const fetchBtn=e.target.closest('.s-key-models');
    if(fetchBtn){
      const item=fetchBtn.closest('.api-key-item');
      const apiKey=item?.querySelector('input[name="apiKey"]')?.value?.trim()||'';
      const baseUrl=item?.querySelector('input[name="apiBaseUrl"]')?.value?.trim()||'https://apihub.agnes-ai.com/v1';
      if(!apiKey){toast('请先填写 API Key','error');return;}
      fetchBtn.disabled=true;fetchBtn.textContent='获取中...';
      try{
        const result=await window.antbot.fetchModels({baseUrl,apiKey});
        if(result.ok&&result.models.length){
          const sel=item.querySelector('select');
          if(sel){sel.dataset.models=JSON.stringify(result.models);sel.innerHTML=result.models.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');}
          await saveSettings();
          toast(`发现 ${result.models.length} 个模型，请选择一个`,'info');
        }else{toast(result.message||'获取模型失败','error');}
      }catch(err){toast(err.message,'error')}
      fetchBtn.disabled=false;fetchBtn.textContent='获取模型';
    }
  });
  // 模型选择变化 → 保存（change 冒泡到 view-settings）
  publishPage.bind();
  downloadPage.bind();
  // Task input
  el.input?.addEventListener('input',()=>{window.antbot.cancelTaskParse?.();autoInput();queuePreview();renderBtns();toggleSendBtn()});
  el.input?.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();void startTasks()}});
  el.runBtn?.addEventListener('click',()=>void startTasks());
  el.optBtn?.addEventListener('click',()=>void optimizeInput());
  // Preview edit
  el.previewBar?.addEventListener('click',e=>{
    const editBtn=e.target.closest('[data-edit-pv]');
    if(editBtn)openPvEditor(Number(editBtn.dataset.editPv),editBtn);
    const confirmBtn=e.target.closest('[data-pv-confirm]');
    if(confirmBtn)void startTasks(true);
  });
  // Chat actions
  el.stream?.addEventListener('click',e=>{
    const copyBtn=e.target.closest('[data-msg-copy]');
    if(copyBtn){
      navigator.clipboard.writeText(copyBtn.dataset.copy||'').then(()=>{copyBtn.textContent='已复制';setTimeout(()=>copyBtn.textContent='复制',1500)});
      return;
    }
    const ruleToggle=e.target.closest('[data-rule-toggle]');
    if(ruleToggle){ruleToggle.closest('.msg-rules')?.classList.toggle('open');return}
    const detailToggle=e.target.closest('[data-task-detail]');
    if(detailToggle){detailToggle.closest('.task-detail')?.classList.toggle('open');return}
    const stopBtn=e.target.closest('[data-stop]');
    const skipBtn=e.target.closest('[data-skip]');
    const retryTaskBtn=e.target.closest('[data-retry-task]');
    const openOutputBtn=e.target.closest('[data-open-output]');
    if(stopBtn){
      const tid=stopBtn.dataset.stop;
      // 立即设置取消中状态（即时响应）
      const task=S.progress?.tasks?.find(t=>t.id===tid);
      if(task){task.status='cancelling';renderChat();}
      void window.antbot.stopTask(tid).then(()=>{
        toast('已停止','success');
      }).catch(err=>{
        toast(err.message,'error');
        // 恢复状态
        if(task){task.status='running';renderChat();}
      });
    }
    if(skipBtn){void window.antbot.stopTask(skipBtn.dataset.skip).then(()=>toast('已跳过','success')).catch(err=>toast(err.message,'error'))}
    if(retryTaskBtn){
      const taskId=retryTaskBtn.dataset.retryTask;
      const task=S.progress?.tasks?.find(t=>t.id===taskId)||S.history?.flatMap(h=>h.items||[]).find(t=>t.id===taskId);
      const rawLine=task?.rawLine||'';
      if(rawLine){void window.antbot.startTasks(rawLine).then(r=>{toast('已重新提交','success');appendPending({runId:r.runId,inputText:rawLine});renderChat({stick:true})}).catch(err=>toast(err.message,'error'))}
      else{toast('无法重试：缺少原始输入','error')}
    }
    if(openOutputBtn){
      const outputPath=openOutputBtn.dataset.openOutput;
      if(outputPath){void window.antbot.revealInFolder(outputPath).catch(()=>{})}
    }
    const republishBtn=e.target.closest('[data-republish]');
    if(republishBtn){
      const tid=republishBtn.dataset.republish;
      republishBtn.disabled=true;republishBtn.textContent='发布中...';
      window.antbot.republishTask(tid).then(r=>{
        if(r?.ok){
          toast('已重新发布','success');
          S.persistedTasks=(S.persistedTasks||[]).filter(t=>t.taskId!==tid&&t.id!==tid);
          renderChat();
        }
        else if(r?.error==='FILE_DELETED'){
          const rawLine=r.rawLine||'';
          if(window.confirm(`视频文件已被删除：\n${r.outputPath||''}\n\n是否需要重新执行这个任务（下载→剪辑→发布）？`)){
            if(rawLine){
              republishBtn.textContent='重新执行中...';
              window.antbot.reexecuteTask(rawLine).then(r2=>{
                if(r2?.ok)toast('已重新提交任务','success');
                else toast(r2?.error||'重新执行失败','error');
              }).catch(err=>toast(err.message,'error')).finally(()=>{
                republishBtn.disabled=false;republishBtn.textContent='重新发布';
              });
              return;
            }
          }
          republishBtn.disabled=false;republishBtn.textContent='重新发布';
        }
        else toast(r?.error||'发布失败','error');
      }).catch(err=>toast(err.message,'error')).finally(()=>{
        republishBtn.disabled=false;republishBtn.textContent='重新发布';
      });
    }
  });
  // Context menu: remove record (history / live / persisted) on run groups
  el.stream?.addEventListener('contextmenu',e=>{
    const holder=e.target.closest('.run-group');
    if(!holder){closeAllPopups();return}
    const runId=holder.dataset.runId;
    const isPersisted=holder.dataset.persisted==='1';
    e.preventDefault();
    clearCtxDismiss();
    closeAllPopups();
    const menu=document.createElement('div');menu.className='ctx-menu';
    menu.innerHTML=`<div class="ctx-head">历史记录</div><button type="button" class="ctx-item ctx-danger" data-ctx-remove-history><span class="icon" data-icon="trash"></span>删除此条记录（消息+任务）</button>`;
    injectIcons();
    document.body.appendChild(menu);
    let left=e.clientX,top=e.clientY;
    requestAnimationFrame(()=>{
      if(left+menu.offsetWidth>window.innerWidth-8)left=window.innerWidth-menu.offsetWidth-8;
      if(top+menu.offsetHeight>window.innerHeight-8)top=window.innerHeight-menu.offsetHeight-8;
      menu.style.left=left+'px';menu.style.top=top+'px';
    });
    menu.style.left=left+'px';menu.style.top=top+'px';
    activePopup=menu;
    menu.querySelector('[data-ctx-remove-history]')?.addEventListener('click',async()=>{
      closeAllPopups();
      try{
        // 1. 停止运行中的任务
        const liveTasks=[...(S.progress?.tasks||[]),...(S.progress?.queueTasks||[])].filter(t=>String(t.batchRunId||t.id)===String(runId));
        for(const t of liveTasks){await window.antbot.stopTask(t.id).catch(()=>{})}
        // 2. 删除持久化记录
        if(isPersisted){await window.antbot.removePersistedByRun(runId).catch(()=>{})}
        // 3. 删除历史记录
        const r=await window.antbot.removeHistory(runId);
        if(r?.ok===false&&!liveTasks.length&&!isPersisted){
          toast(r?.message||'删除失败：记录不存在或已删除','error');
          renderChat();
          return;
        }
        // 4. 前端同步移除
        S.history=(S.history||[]).filter(h=>String(h.id)!==String(runId));
        S.progress.tasks=(S.progress.tasks||[]).filter(t=>String(t.batchRunId||t.id)!==String(runId));
        S.progress.queueTasks=(S.progress.queueTasks||[]).filter(t=>String(t.batchRunId||t.id)!==String(runId));
        S.pending=(S.pending||[]).filter(p=>String(p.runId)!==String(runId));
        S.persistedTasks=(S.persistedTasks||[]).filter(t=>String(t.batchRunId||t.id)!==String(runId));
        renderChat();renderStats();toast('记录已删除','success');
      }catch(err){toast(err.message,'error')}
    });
    const dismiss=e2=>{
      if(!menu.contains(e2.target)){closeAllPopups();clearCtxDismiss()}
    };
    activeCtxDismiss=dismiss;
    setTimeout(()=>document.addEventListener('mousedown',dismiss),0);
  });
  // Chips
  el.chips?.addEventListener('click',e=>{
    const tgt=e.target.closest('[data-act]');if(!tgt)return;
    closeAllPopups();
    const act=tgt.dataset.act;
    if(act==='voiceClone'){showVoicePopup(tgt);return}
    if(act==='speed-slider'){showSliderPopup(tgt,'speed');return}
    if(act==='retry-slider'){showSliderPopup(tgt,'retry');return}
    if(act==='more-settings'){showMorePopup(tgt);return}
    if(act==='style-ref'){showStylePopup(tgt);return}
  });
  // Close popups on outside click
  document.addEventListener('mousedown',e=>{if(activePopup&&!e.target.closest('.chip-popup')&&!e.target.closest('.ctx-menu')&&!e.target.closest('[data-act]'))closeAllPopups()});
  // Chat scroll
  el.scroll?.addEventListener('scroll',()=>{if(!el.scroll||el.scroll.scrollTop>80||S.chatCount>=S.history.length)return;const ph=el.scroll.scrollHeight,pt=el.scroll.scrollTop;S.chatCount=Math.min(S.chatCount+20,S.history.length);renderChat();requestAnimationFrame(()=>{el.scroll.scrollTop=el.scroll.scrollHeight-ph+pt})});
  // IPC
  let progressTimer=null,progressPending=null;
  window.antbot.onProgress(p=>{
    progressPending=p||S.progress;
    if(progressTimer)return;
    progressTimer=setTimeout(()=>{
      progressTimer=null;
      const p2=progressPending;progressPending=null;
      if(!p2)return;
      const pin=el.scroll&&(el.scroll.scrollHeight-el.scroll.scrollTop-el.scroll.clientHeight<80);
      const oldTasks=S.progress?.tasks||[];S.progress=p2;if(p2?.tasks){const cancelIds=new Set(oldTasks.filter(t=>t.status==='cancelling').map(t=>t.id));p2.tasks.forEach(t=>{if(cancelIds.has(t.id)&&t.status!=='stopped'&&t.status!=='failed'&&t.status!=='completed')t.status='cancelling'})}
      renderChat({stick:pin});renderBtns();renderStats();renderStatus();
    },100);
  });
  window.antbot.onToast?.((msg, type) => { if (msg) toast(msg, type || 'info'); });
  window.antbot.onVoiceCloneProgress(p=>{
    // Update animation text
    const animText=document.getElementById('voice-anim-text')||document.querySelector('.voice-anim-text');
    if(animText&&(p?.step||p?.message)) animText.textContent=p.message||p.step||'';
  });
  window.antbot.onHistoryChanged(h=>{const pin=el.scroll&&(el.scroll.scrollHeight-el.scroll.scrollTop-el.scroll.clientHeight<80);S.history=h||[];reconcile();renderChat({stick:pin});renderStats();window.antbot.getPersistedTasks().then(t=>{S.persistedTasks=t||[]}).catch(()=>{})});
  window.antbot.onAppState(p=>{const pin=el.scroll&&(el.scroll.scrollHeight-el.scroll.scrollTop-el.scroll.clientHeight<80);applySnap(p||{});renderAll({stick:pin})});
  window.antbot.onDepProgress(p=>{toast(p?.message||'',p?.status==='failed'?'error':'info')});
  // Model management events
  document.getElementById('models-open-dir-btn')?.addEventListener('click', async () => {
    try { const r = await window.antbot.modelsOpenDir(); toast(`已打开: ${r.path}`, 'info'); } catch (e) { toast(e.message, 'error'); }
  });
  document.getElementById('open-data-dir-setting-btn')?.addEventListener('click', async () => {
    try { const r = await window.antbot.openDataDir(); toast(`已打开: ${r.path}`, 'info'); } catch (e) { toast(e.message, 'error'); }
  });
  document.getElementById('open-output-dir-btn')?.addEventListener('click', async () => {
    try {
      const dir = await window.antbot.pickDirectory('选择视频输出目录');
      if (dir) {
        const input = document.getElementById('s-outputBaseDir');
        if (input) input.value = dir;
        void saveSettings();
        toast(`输出目录已设置: ${dir}`, 'success');
      }
    } catch (e) { toast(e.message, 'error'); }
  });
  document.getElementById('models-list')?.addEventListener('click', async (e) => {
    const dlBtn = e.target.closest('[data-model-download]');
    if (dlBtn) {
      const key = dlBtn.dataset.modelDownload;
      // Replace download button with cancel button
      const td = dlBtn.closest('td');
      dlBtn.outerHTML = `<button class="btn btn-xs btn-danger" data-model-cancel="${esc(key)}" type="button">取消</button>`;
      // Hide other action buttons in same cell
      td?.querySelectorAll('[data-model-browser],[data-model-import],[data-model-mirror]')?.forEach(el => el.style.display = 'none');
      td?.querySelector('label')?.querySelector('input[data-model-mirror]')?.closest('label')?.style.setProperty('display', 'none');
      try {
        const r = await window.antbot.modelsDownload(key);
        if (r.ok) { toast('下载完成', 'success'); }
        else if (r.message !== '已取消') toast(r.message || '下载失败', 'error');
      } catch (err) { toast(err.message, 'error'); }
      await loadModels();
      return;
    }
    const browserBtn = e.target.closest('[data-model-browser]');
    if (browserBtn) {
      const key = browserBtn.dataset.modelBrowser;
      try {
        const r = await window.antbot.modelsGetUrl(key);
        if (r.ok) { await window.antbot.openExternal(r.url); toast('已在浏览器中打开下载页面', 'info'); }
        else toast(r.message, 'error');
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    const importBtn = e.target.closest('[data-model-import]');
    if (importBtn) {
      const key = importBtn.dataset.modelImport;
      const isHf = importBtn.dataset.hf === '1';
      try {
        let sourcePath;
        if (isHf) {
          sourcePath = await window.antbot.pickDirectory('选择下载后的模型文件夹');
        } else {
          sourcePath = await window.antbot.pickFile('选择模型文件', [{ name: 'Model', extensions: ['pt', 'bin', 'safetensors', 'gguf', 'onnx'] }]);
        }
        if (!sourcePath) return;
        toast('正在导入...', 'info');
        const r = await window.antbot.modelsImport({ modelKey: key, sourcePath });
        if (r.ok) { toast('导入成功', 'success'); await loadModels(); }
        else toast(r.error || r.message || '导入失败', 'error');
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    const delBtn = e.target.closest('[data-model-delete]');
    if (delBtn) {
      const key = delBtn.dataset.modelDelete;
      try {
        const r = await window.antbot.modelsDelete(key);
        if (r.ok) { toast('已删除', 'info'); await loadModels(); }
        else toast(r.message || '删除失败', 'error');
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    const cancelBtn = e.target.closest('[data-model-cancel]');
    if (cancelBtn) {
      const key = cancelBtn.dataset.modelCancel;
      try {
        const r = await window.antbot.modelsCancel(key);
        if (r.ok) toast('已取消', 'info');
        else toast(r.message || '取消失败', 'error');
      } catch (err) { toast(err.message, 'error'); }
    }
  });
  // Mirror toggle
  document.getElementById('models-list')?.addEventListener('change', async (e) => {
    if (e.target.matches('[data-model-mirror]')) {
      const useMirror = e.target.checked;
      S.settings = S.settings || {};
      S.settings.models = S.settings.models || {};
      S.settings.models.useHfMirror = useMirror;
      try { await window.antbot.updateSettings({ models: { useHfMirror: useMirror } }); } catch {}
      toast(useMirror ? '已启用国内镜像 (hf-mirror.com)' : '已关闭国内镜像', 'info');
    }
  });
  // Listen for download progress
  window.antbot.onModelsProgress?.((p) => {
    const el = document.getElementById(`model-progress-${p.model}`);
    if (!el) return;
    if (p.status === 'downloading') {
      el.innerHTML = `<div class="prog-track"><div class="prog-bar" style="width:${p.percent||0}%"></div></div><div class="prog-info"><span>${p.message||''}</span><span>${p.percent||0}%</span></div>`;
    } else if (p.status === 'completed') {
      el.innerHTML = '';
      setTimeout(() => loadModels(), 500);
    } else if (p.status === 'cancelled') {
      el.innerHTML = '';
      loadModels();
    } else if (p.status === 'failed') {
      el.innerHTML = `<div class="prog-info"><span class="icon" data-icon="alertCircle" style="color:var(--destructive)"></span> ${esc(p.message||'失败')}</div>`;
    }
    injectIcons();
  });

  // ── Per-dependency progress tracking ──
  const voiceboxDepsState = { packages: new Map(), order: [] };

  function renderVoiceboxDepsList() {
    const container = document.getElementById('voicebox-deps-list');
    if (!container) return;
    if (!voiceboxDepsState.order.length) { container.innerHTML = ''; return; }
    container.innerHTML = voiceboxDepsState.order.map((key) => {
      const pkg = voiceboxDepsState.packages.get(key);
      if (!pkg) return '';
      const s = pkg.status || 'queued';
      const pct = Math.max(0, Math.min(100, pkg.percent || 0));
      const st = s === 'done' ? '完成' : s === 'error' ? '失败' : s === 'cancelled' ? '已取消' : s === 'downloading' ? `${pct}%` : '等待';
      const canCancel = s === 'downloading' || s === 'queued';
      return `<div class="dep-item dep-${esc(s)}">
        <div class="dep-item-head"><span class="dep-item-name">${esc(pkg.name)}</span><span class="dep-item-status">${esc(st)}</span>
          ${canCancel ? `<button class="dep-item-cancel" data-dep-cancel="${esc(key)}">✕</button>` : ''}</div>
        <div class="dep-item-track"><div class="dep-item-bar" style="width:${pct}%"></div></div>
        <div class="dep-item-meta"><span class="dep-item-speed">${esc(pkg.speed || '')}</span><span class="dep-item-msg">${esc(pkg.message || '')}</span></div>
      </div>`;
    }).join('');
    container.querySelectorAll('[data-dep-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.antbot.voiceboxInstallCancel(btn.dataset.depCancel);
        const pkg = voiceboxDepsState.packages.get(btn.dataset.depCancel);
        if (pkg && (pkg.status === 'downloading' || pkg.status === 'queued')) {
          pkg.status = 'cancelled'; pkg.speed = ''; pkg.message = '已取消';
          renderVoiceboxDepsList();
        }
      });
    });
  }

  // Voicebox dependency handlers
  document.getElementById('voicebox-install-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('voicebox-install-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="icon">${ICONS.loader}</span>安装中...`; }
    voiceboxDepsState.packages = new Map();
    voiceboxDepsState.order = [];
    renderVoiceboxDepsList();
    try {
      const r = await window.antbot.voiceboxInstall();
      if (r.ok && r.needsRestart) {
        toast(`安装完成，以下模块需重启生效：${r.restartPackages.join(', ')}`, 'warning');
        if (window.confirm(`以下模块需要重启 App 才能生效：\n${r.restartPackages.join(', ')}\n\n是否现在重启？`)) {
          location.reload();
        }
      } else if (r.ok) {
        toast('语音克隆依赖安装完成', 'success');
      } else if (r.failedPackages?.length) {
        toast(`部分依赖失败：${r.failedPackages.join(', ')}，可点击重试`, 'error');
      } else {
        toast(r.message || '安装失败', 'error');
      }
      await checkVoicebox();
    } catch (e) { toast(e.message, 'error'); }
    if (btn) { btn.disabled = false; btn.innerHTML = `<span class="icon" data-icon="download"></span>安装依赖`; injectIcons(); }
  });
  document.getElementById('voicebox-reset-btn')?.addEventListener('click', async () => {
    if (!window.confirm('确认重置语音克隆环境？将删除虚拟环境和安装标记。')) return;
    try { await window.antbot.voiceboxReset(); toast('环境已重置', 'info'); await checkVoicebox(); }
    catch (e) { toast(e.message, 'error'); }
  });
  // Windows GPU 按钮：仅在 Windows 上显示
  const gpuBtn = document.getElementById('voicebox-gpu-btn');
  if (gpuBtn && navigator.platform?.includes('Win')) {
    gpuBtn.style.display = '';
    gpuBtn.addEventListener('click', async () => {
      gpuBtn.disabled = true;
      gpuBtn.innerHTML = `<span class="icon">${ICONS.loader}</span>安装中...`;
      try {
        const r = await window.antbot.voiceboxInstallGpu();
        toast(r.message || (r.ok ? 'GPU 加速安装成功' : '安装失败'), r.ok ? 'success' : 'error');
        if (r.ok) await checkVoicebox();
      } catch (e) { toast(e.message, 'error'); }
      gpuBtn.disabled = false;
      gpuBtn.innerHTML = `<span class="icon" data-icon="download"></span>安装 GPU 加速`;
      injectIcons();
    });
  }
  document.getElementById('voicebox-open-btn')?.addEventListener('click', async () => {
    try { const r = await window.antbot.voiceboxOpenDir(); if (r.path) toast(`已打开: ${r.path}`, 'info'); }
    catch (e) { toast(e.message, 'error'); }
  });

  // Windows GPU/CPU 模式选择
  const gpuModeRow = document.getElementById('voicebox-gpu-mode-row');
  const gpuModeSelect = document.getElementById('voicebox-gpu-mode');
  if (gpuModeRow && gpuModeSelect && navigator.platform?.includes('Win')) {
    gpuModeRow.style.display = '';
    // 加载已保存的设置
    const savedMode = S.settings?.voiceClone?.gpuMode || 'auto';
    gpuModeSelect.value = savedMode;
    gpuModeSelect.addEventListener('change', async () => {
      try {
        await window.antbot.updateSettings({ voiceClone: { ...(S.settings?.voiceClone || {}), gpuMode: gpuModeSelect.value } });
        toast(`运行设备已切换为：${gpuModeSelect.options[gpuModeSelect.selectedIndex].text}，重启后生效`, 'info');
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  // Listen for voicebox install progress
  window.antbot.onVoiceboxProgress?.((p) => {
    const btn = document.getElementById('voicebox-install-btn');
    if (!btn) return;
    if (p.status === 'installing') {
      btn.disabled = true;
      btn.innerHTML = `<span class="icon">${ICONS.loader}</span>${p.message?.slice(0, 30) || '安装中...'}`;
    } else if (p.status === 'completed') {
      btn.disabled = false;
      btn.innerHTML = `<span class="icon" data-icon="download"></span>安装依赖`;
      injectIcons();
      checkVoicebox();
    } else if (p.status === 'failed') {
      btn.disabled = false;
      btn.innerHTML = `<span class="icon" data-icon="refresh"></span>重试安装`;
      injectIcons();
      toast(p.message || '安装失败', 'error');
    }
  });

  // Listen for per-dependency progress
  window.antbot.onVoiceboxDepsProgress?.((event) => {
    if (!event || !event.name) return;
    const key = event.normalizedName || event.name;
    const pkg = voiceboxDepsState.packages.get(key) || { name: event.name, constraint: event.constraint || '', status: 'queued', percent: 0, speed: '', size: '', message: '' };
    if (event.type === 'package-start') { pkg.status = 'downloading'; pkg.percent = 0; pkg.message = event.message || '准备安装...'; }
    else if (event.type === 'package-progress') { pkg.status = 'downloading'; if (event.percent >= 0) pkg.percent = event.percent; if (event.speed) pkg.speed = event.speed; if (event.message) pkg.message = event.message; }
    else if (event.type === 'package-done') { pkg.status = 'done'; pkg.percent = 100; pkg.speed = ''; pkg.message = event.message || '安装完成'; }
    else if (event.type === 'package-error') { pkg.status = 'error'; pkg.speed = ''; pkg.message = event.message || '安装失败'; }
    else if (event.type === 'package-cancelled') { pkg.status = 'cancelled'; pkg.speed = ''; pkg.message = '已取消'; }
    else return;
    voiceboxDepsState.packages.set(key, pkg);
    if (!voiceboxDepsState.order.includes(key)) voiceboxDepsState.order.push(key);
    renderVoiceboxDepsList();
  });

  // Style reference events
  bindStyleRefEvents();
  // Subtitle & Voice events
  bindSubtitleVoiceEvents();
}

/* ── 启动动画：物理弹跳 + 圆形遮罩展开 ── */
const SPLASH_COLORS=['#808ABC','#1CE544','#1BD9E0','#0366F2','#7D41D7','#E632A7','#F55829','#F0C91B'];
const _splash={raf:0,timer:null,loadDone:false,expanding:false,removed:false};

/* 物理弹跳：重力 + 恢复系数衰减（REST 0.95 弹跳力大，首次反弹约到窗口中间偏上一颗球）；
   加载完成且触底反弹两次后，在反弹最高点启动展开——物理继续跑，mask 圆心跟随弹跳 */
function initSplash(){
  const splash=document.getElementById('splash');
  const ball=document.getElementById('splash-ball');
  if(!splash||!ball){_splash.removed=true;return;}
  ball.style.background=SPLASH_COLORS[Math.floor(Math.random()*SPLASH_COLORS.length)];
  const G=4000,REST=0.707,R=20;
  const reset=()=>({y:-(window.innerHeight/2+60),vy:0,bounces:0,justBounced:false});
  _splash.phys=reset();
  let last=performance.now(),prevVy=0;
  const cx=()=>window.innerWidth/2;
  const groundY=()=>window.innerHeight/2-R;
  ball.style.transform=`translateY(${_splash.phys.y}px)`;

  const frame=(now)=>{
    if(_splash.removed)return;
    const dt=Math.min((now-last)/1000,0.032);last=now;
    const st=_splash.phys;
    st.vy+=G*dt;st.y+=st.vy*dt;
    const gy=groundY();
    st.justBounced=false;
    if(st.y>=gy){st.y=gy;st.vy=-st.vy*REST;st.bounces++;st.justBounced=true;}
    if(!_splash.expanding)ball.style.transform=`translateY(${st.y}px)`;
    // 展开时机：已反弹两次，且在反弹最高点（上升转下降，vy 负转正，非触底帧）
    const apex=!st.justBounced&&prevVy<0&&st.vy>=0;
    if(_splash.loadDone&&st.bounces>=2&&apex&&!_splash.expanding){
      startSplashExpand(window.innerWidth/2,window.innerHeight/2+st.y,ball); // 启动展开，物理停止
      return;
    }
    prevVy=st.vy;
    _splash.raf=requestAnimationFrame(frame);
  };
  _splash.raf=requestAnimationFrame(frame);

  // 10s 超时：未加载完成则当前球淡出，新球重新掉落
  _splash.timer=setInterval(()=>{
    if(_splash.loadDone||_splash.expanding||_splash.removed){clearInterval(_splash.timer);return;}
    _splash.phys=reset();last=performance.now();prevVy=0;
    ball.style.transition='opacity 300ms';ball.style.opacity='0';
    setTimeout(()=>{
      ball.style.transition='';ball.style.opacity='1';
      ball.style.transform=`translateY(${_splash.phys.y}px)`;
      last=performance.now();
    },320);
  },10000);
}
function finishSplash(){_splash.loadDone=true;}

/* 圆形遮罩展开：mask 圆孔（孔内=界面，孔外=背景色）与球同步放大（圆心固定，不再弹跳），
   球放大到自身 1.5x 时渐变消失，圆孔继续放大覆盖全窗。
   曲线 easeOutQuint（结尾非常缓和），总时长 900ms */
function startSplashExpand(cx,cy,ball){
  if(_splash.expanding||_splash.removed)return;
  _splash.expanding=true;
  clearInterval(_splash.timer);
  const splash=document.getElementById('splash');
  const bg=document.getElementById('splash-bg');
  // 覆盖整个窗口：按球心到四角的最远距离 + 余量（底部放大也能完全覆盖）
  const maxR=Math.sqrt(Math.max(cx,window.innerWidth-cx)**2+Math.max(cy,window.innerHeight-cy)**2)+50;
  const dur=1300,t0=performance.now();
  const ease=p=>1-Math.pow(1-p,5); // easeOutQuint：结尾非常缓和
  const frame=(now)=>{
    const p=Math.min((now-t0)/dur,1);
    const r=20+(maxR-20)*ease(p);
    // 圆心固定为展开时刻的球心（物理已停止）
    if(bg)bg.style.mask=`radial-gradient(circle ${r}px at ${cx}px ${cy}px, transparent ${r-0.5}px, black ${r}px)`;
    if(ball){
      const d=Math.round(r*2);
      ball.style.width=d+'px';
      ball.style.height=d+'px';
      ball.style.left=(cx-r)+'px';
      ball.style.top=(cy-r)+'px';
      ball.style.transform='translate(-50%,-50%)'; // 覆盖 CSS 初始位移，中心对齐像素定位
      ball.style.background=getComputedStyle(ball).backgroundColor;
      // 球渐变消失：放大到自身 1.5x（半径 r 20→30）时完全消失，界面接管
      ball.style.opacity=r<=20?1:(r>=30?0:String(Math.max(0,1-(r-20)/10)));
    }
    if(p<1){_splash.raf=requestAnimationFrame(frame);return;}
    // 展开完成：移除 splash（mask 随元素释放），动画全部停止
    _splash.removed=true;
    if(splash)splash.remove();
  };
  _splash.raf=requestAnimationFrame(frame);
}

/* ── Init ── */
async function init(){
  initSplash();
  try{
    // 数据加载与启动动画并行；渲染发生在 splash 遮罩之下，对用户不可见
    initTheme();injectIcons();bind();initResize();initDialogClose();syncSidebar();
    await loadUISettings();
    // 先加载风格和音色（本地文件读取很快），再渲染，避免空状态闪烁
    await Promise.all([loadStyles(), loadVoices()]);
    const initState=await window.antbot.getInitialState();
    applySnap(initState);renderAll({stick:true});queuePreview();
    await runStartup();
    await loadModels();
    loadEditTasks();

    // 加载持久化的主控任务（重新发布状态）
    try { S.persistedTasks = await window.antbot.getPersistedTasks() || []; } catch { S.persistedTasks = []; }
    renderChat();
  }finally{
    // 无论成功失败都放行 splash 展开，防止卡死在加载动画
    finishSplash();
  }
}
init();
