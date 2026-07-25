import { ICONS } from './icons.js';

/* ── DOM ── */
const $ = (s) => document.querySelector(s);
const el = {
  badge:$('#app-badge'), sidebar:$('#sidebar'), overlay:$('#sidebar-overlay'),
  sidebarToggle:$('#sidebar-toggle'), pageTitle:$('#page-title'),
  scroll:$('#chat-scroll'), stream:$('#chat-stream'),
  input:$('#task-input'), runBtn:$('#run-btn'), pickVideoBtn:$('#pick-video-btn'),
  chips:$('#setting-chips'),
  editAddBtn:$('#edit-add-btn'), editStartBtn:$('#edit-start-btn'),
  resizeHandle:$('#resize-handle'), composer:$('#composer'), chatArea:$('#chat-area'),
  status:$('#startup-status'),
  openSettingsBtn:$('#open-settings-btn'),
  openVideoBtn:$('#open-video-channel'), openDouyinBtn:$('#open-douyin'),
  setDlg:$('#settings-dialog'), setForm:$('#settings-form'),
  setSave:$('#save-settings-btn'), setClose:$('#close-settings-btn'),
  vcDlg:$('#voice-clone-dialog'), vcForm:$('#voice-clone-form'),
  vcRun:$('#voice-clone-run-btn'), vcClose:$('#voice-clone-close-btn'),
  vcPick:$('#voice-clone-pick-sample-btn'),
  vcStep:$('#voice-clone-progress-step'), vcPct:$('#voice-clone-progress-percent'),
  vcBar:$('#voice-clone-progress-bar'), vcLog:$('#voice-clone-progress-log'),
  dataDlg:$('#data-dialog'), dataVer:$('#data-version'),
  dataPath:$('#data-path'), dataLog:$('#data-log-path'),
  dataOpen:$('#open-data-dir-btn'), dataOpenLog:$('#open-log-dir-btn'),
  dataOpenMain:$('#open-data-dir-main-btn'), dataMigrate:$('#migrate-data-btn'),
  dataClose:$('#close-data-btn'),
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
  preview:{count:0,items:[],error:'',empty:true},
  vc:{running:false,status:'idle',step:'等待',pct:0,logs:[]},
  pending:[], chatCount:20, sidebarOpen:window.innerWidth>720, statPeriod:'day',
  currentFeat:'main', selectedStyle:'',
};
let previewTimer=null,previewSeq=0,setQueue=Promise.resolve(),startupSeq=0;

/* ── Utils ── */
const esc=(s)=>String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const compact=(s,n=160)=>String(s||'').replace(/\s+/g,' ').slice(0,n);
const fmtDate=(v)=>{if(!v)return'--';const d=new Date(v);if(+isNaN(d))return String(v);return`${d.getMonth()+1}月${d.getDate()}日 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};
const fmtDay=(v)=>{if(!v)return'';const d=new Date(v);if(+isNaN(d))return'';return`${d.getMonth()+1}月${d.getDate()}日`;};
const merge=(t,s)=>{if(!s||typeof s!=='object')return t;for(const[k,v] of Object.entries(s)){if(Array.isArray(v))t[k]=v.slice();else if(v&&typeof v==='object'){if(!t[k]||typeof t[k]!=='object')t[k]={};merge(t[k],v);}else t[k]=v;}return t;};
const statusMap={queued:'等待',pending:'等待',running:'执行中',completed:'成功',warning:'部分完成',failed:'失败',stopped:'已停止',partial_failed:'部分失败'};
const statusText=(s)=>statusMap[s]||s;

/* ── Icons ── */
function injectIcons(){document.querySelectorAll('[data-icon]').forEach(e=>{const n=e.dataset.icon;if(ICONS[n])e.innerHTML=ICONS[n];})}
function closeDlg(dlg){if(!dlg)return;dlg.classList.add('closing');setTimeout(()=>{dlg.close();dlg.classList.remove('closing');},180);}

/* ── Toast ── */
function toast(msg,type='info',ms=3000){const c=$('#toast-container');if(!c)return;const t=document.createElement('div');t.className=`toast ${type}`;const im={success:ICONS.check,error:ICONS.alertCircle,info:ICONS.alertCircle};t.innerHTML=`<span class="icon">${im[type]||''}</span><span>${esc(msg)}</span>`;c.appendChild(t);setTimeout(()=>{t.classList.add('out');setTimeout(()=>t.remove(),200);},ms);}

function showLoading(containerId){const el=document.getElementById(containerId);if(el)el.innerHTML='<div class="loading-box"><div class="spinner"></div><span>加载中...</span></div>';}
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
  const titles={main:'主控',edit:'剪辑',publish:'发布',download:'下载','style-ref':'风格参考','subtitle-voice':'字幕与音色'};
  if(el.pageTitle)el.pageTitle.textContent=titles[feat]||feat;
  renderStatus();
  if(feat==='subtitle-voice') loadPresetVoices();
  if(feat==='download') initDownloadPage();
  if(isMobile())closeSidebar();
}

/* ── Theme: auto-follow system ── */
function initTheme(){
  const mq=window.matchMedia('(prefers-color-scheme:dark)');
  document.documentElement.classList.toggle('dark',mq.matches);
  mq.addEventListener('change',e=>{document.documentElement.classList.toggle('dark',e.matches)});
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

/* ── Format bubble text ── */
function formatBubbleText(raw){
  if(!raw)return'';const lines=raw.split(/\r?\n/).filter(l=>l.trim());
  return lines.map((line,i)=>{const num=`${i+1}、`;const f=line.replace(/https?:\/\/[^\s,，]+/g,url=>{try{const u=new URL(url);const path=u.pathname.length>15?u.pathname.slice(0,15)+'...':'';return u.hostname+path}catch{return url.slice(0,30)+'...'}});return num+esc(f)}).join('\n');
}
function makeBubbleHtml(raw){
  const formatted=formatBubbleText(raw);
  const rawLines=raw.split(/\r?\n/).filter(l=>l.trim());
  const numbered=rawLines.map((l,i)=>`${i+1}、${l}`).join('\n');
  return`<div class="msg-content">${formatted}</div><button class="msg-raw-toggle" type="button" onclick="this.nextElementSibling.classList.toggle('show');this.textContent=this.nextElementSibling.classList.contains('show')?'隐藏原文':'显示原文'">显示原文</button><div class="msg-raw">${esc(numbered)}</div>`;
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
    if(!gs.has(g))gs.set(g,{id:g,at:t.enqueuedAt||t.updatedAt||new Date().toISOString(),txt:'',tasks:[]});
    gs.get(g).tasks.push(t);
  });
  S.pending.forEach(b=>{if(!gs.has(b.runId))gs.set(b.runId,{id:b.runId,at:b.createdAt,txt:b.txt,tasks:[]});gs.get(b.runId).txt=b.txt});
  return Array.from(gs.values()).map(g=>({...g,tasks:g.tasks.sort((a,b)=>(a.index||a.queueIndex||0)-(b.index||b.queueIndex||0)),txt:g.txt||g.tasks.map(t=>t.rawLine).filter(Boolean).join('\n')||g.tasks.map(t=>t.taskName).join('\n')})).sort((a,b)=>new Date(a.at)-new Date(b.at));
}
function taskCard(t,live=false){
  const st=t.status||'pending';const pg=Math.max(0,Math.min(100,Number(t.progress||0)));
  const idx=t.index||t.queueIndex||0;const title=idx?`任务${idx}`:(t.isOriginal?'原创':(t.taskName||'任务'));
  const retrying=t.retryCount>0&&st==='running';
  const statusLabel=retrying?`重试中 (${t.retryCount})`:statusText(st);
  const canSkip=live&&['queued','pending'].includes(st);
  const canCancel=live&&['queued','pending','running'].includes(st);
  const canRetry=live&&['failed'].includes(st);
  const msg=t.message?`<div class="task-msg">${esc(t.message)}</div>`:'';
  const acts=[];
  if(canSkip)acts.push(`<button class="task-btn skip" data-skip="${esc(t.id)}">跳过</button>`);
  if(canCancel)acts.push(`<button class="task-btn cancel" data-stop="${esc(t.id)}">取消</button>`);
  if(canRetry)acts.push(`<button class="task-btn skip" data-retry="${esc(t.id)}">重试</button>`);
  return`<div class="task ${esc(st)}"><div class="task-head"><div class="task-title">${esc(title)}</div><div class="task-badge">${esc(statusLabel)}</div></div><div class="task-bar"><div class="task-bar-in" style="width:${pg}%"></div></div>${msg}${acts.length?`<div class="task-acts">${acts.join('')}</div>`:''}</div>`;
}
function renderChat(opts={}){
  if(!el.stream)return;const stick=opts.stick,vis=(S.history||[]).slice(0,S.chatCount).reverse(),lg=liveGroups();
  const parts=[];let day='';
  for(const r of vis){const d=fmtDay(r.startedAt);if(d&&d!==day){day=d;parts.push(`<div class="chat-day">${esc(d)}</div>`)}const txt=r.inputText||(r.items||[]).map(i=>i.rawLine||i.taskName).filter(Boolean).join('\n');parts.push(`<div class="msg-time">${esc(fmtDate(r.startedAt))}</div>`);if(txt)parts.push(`<div class="msg msg-user">${makeBubbleHtml(txt)}</div>`);parts.push(`<div class="msg-sys"><div class="task-stack">${(r.items||[]).map(i=>taskCard(i)).join('')}</div></div>`)}
  for(const g of lg){const d=fmtDay(g.at);if(d&&d!==day){day=d;parts.push(`<div class="chat-day">${esc(d)}</div>`)}parts.push(`<div class="msg-time">${esc(fmtDate(g.at))}</div>`);if(g.txt)parts.push(`<div class="msg msg-user">${makeBubbleHtml(g.txt)}</div>`);parts.push(`<div class="msg-sys"><div class="task-stack">${g.tasks.map(t=>taskCard(t,true)).join('')}</div></div>`)}
  el.stream.innerHTML=parts.length?parts.join(''):'<div class="chat-empty">还没有任务。</div>';
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
function closeAllPopups(){if(activePopup){activePopup.remove();activePopup=null}}
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
    if(type==='speed'){const v=Number(range.value);S.settings.style.voiceSpeed=v;void qPatch({style:{voiceSpeed:v}},`语速 ${v.toFixed(1)}x`)}
    else{const v=Number(range.value);S.settings.retry.failedTaskRetries=v;void qPatch({retry:{failedTaskRetries:v}},v===0?'不重试':`重试 ${v} 次`)}
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
  if(!voices.length){toast('请先在字幕与音色中克隆音色','info');return;}
  popup.innerHTML=`<ul class="style-list">${voices.map(v=>`<li class="style-item${v.id===S.activeVoiceId?' active':''}" data-voice-id="${esc(v.id)}">${esc(v.name)}</li>`).join('')}</ul>`;
  positionPopup(popup,anchor);activePopup=popup;
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
  set('s-apiBaseUrl',s.api?.baseUrl||'https://apihub.agnes-ai.com/v1');
  // API keys — 多 key 支持
  const keys = s.api?.apiKeys || (s.api?.apiKey ? [s.api.apiKey] : []);
  const keysList = document.getElementById('api-keys-list');
  if (keysList) {
    keysList.innerHTML = keys.length ? keys.map((k, i) => `<div class="s-input-row"><input name="apiKey" type="password" value="${esc(k)}" placeholder="Key ${i + 1}" /><button type="button" class="btn btn-sm btn-ghost s-key-vis" title="显示/隐藏">👁</button><button type="button" class="btn btn-sm btn-ghost s-key-del" title="删除">✕</button></div>`).join('') : `<div class="s-input-row"><input name="apiKey" type="password" placeholder="Key 1" /><button type="button" class="btn btn-sm btn-ghost s-key-vis" title="显示/隐藏">👁</button><button type="button" class="btn btn-sm btn-ghost s-key-del" title="删除">✕</button></div>`;
  }
  const fr=document.getElementById('s-frameRate');if(fr)fr.value=String(s.edit?.frameRate??1);
  const ms=document.getElementById('s-apiModelId');
  if(ms){const m=s.api?.availableModels||[],c=s.api?.modelId||'';ms.innerHTML=m.length?m.map(x=>`<option value="${esc(x.id)}"${x.id===c?' selected':''}>${esc(x.name)}</option>`).join(''):'<option value="">请先获取模型</option>';}
}
function readForm(){
  const get=(id)=>{const e=document.getElementById(id);return e?.value?.trim()||'';};
  const apiKeys=[...document.querySelectorAll('#api-keys-list input[name="apiKey"]')].map(e=>e.value.trim()).filter(Boolean);
  return{dataDir:get('s-dataDir'),paths:{outputBaseDir:get('s-outputBaseDir')},style:S.settings?.style||{},voiceClone:S.settings?.voiceClone||{},commands:S.settings?.commands||{},edit:{frameRate:parseFloat(get('s-frameRate'))||1},api:{baseUrl:get('s-apiBaseUrl')||'https://apihub.agnes-ai.com/v1',apiKeys,apiKey:apiKeys[0]||'',modelId:get('s-apiModelId'),availableModels:S.settings?.api?.availableModels||[]}};
}

async function loadApiUsage() {
  const box = document.getElementById('api-usage-box');
  if (!box) return;
  try {
    const usage = await window.antbot.apiUsage();
    if (!usage || !usage.length) { box.innerHTML = '<div class="api-usage-empty">输入 API Key 后显示额度</div>'; return; }
    // 帧率设置：value 表示多少秒一帧，帧率 = 1/value 帧/秒
    const frameInterval = S.settings?.edit?.frameRate || 1; // 秒/帧
    const fps = 1 / frameInterval; // 帧/秒
    const requestsPerSecond = fps;
    box.innerHTML = usage.map(u => {
      const pct = u.limit > 0 ? Math.round((u.used / u.limit) * 100) : 0;
      const totalSeconds = u.remaining > 0 ? Math.floor(u.remaining / requestsPerSecond) : 0;
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
      return `<div class="api-usage-item">
        <div class="api-usage-head"><span class="api-usage-key">${esc(u.keyMasked)}</span><span class="api-usage-remain">可剪辑 ${durationText}</span></div>
        <div class="api-usage-bar"><div class="api-usage-bar-fill" style="width:${pct}%"></div></div>
        <div class="api-usage-meta">已用 ${u.used}/${u.limit} · 失败 ${u.failed} · 限频 ${u.rateLimited}</div>
      </div>`;
    }).join('');
  } catch { box.innerHTML = ''; }
}

/* ── Render: VC/Data/Status ── */
function renderVC(){const v=S.vc;if(el.vcStep)el.vcStep.textContent=v.step||'等待';if(el.vcPct)el.vcPct.textContent=`${v.pct||0}%`;if(el.vcBar)el.vcBar.style.width=`${v.pct||0}%`;if(el.vcLog)el.vcLog.textContent=v.logs.length?v.logs.join('\n'):'暂无日志';if(el.vcRun)el.vcRun.disabled=!!v.running}
function renderData(){const d=S.dataInfo;if(!d)return;if(el.dataVer)el.dataVer.textContent=d.version||'-';if(el.dataPath)el.dataPath.textContent=d.dataDir||d.userData||'-';if(el.dataLog)el.dataLog.textContent=d.logDir||'-'}
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
function toggleSendBtn(){if(!el.runBtn||!el.input)return;el.runBtn.classList.toggle('show',el.input.value.trim().length>0)}
function renderAll(opts={}){renderStatus();renderChips();renderVC();renderData();fillForm();renderBtns();renderChat(opts);renderStats()}

/* ── State ── */
function reconcile(){const ids=new Set((S.history||[]).map(r=>r.id));S.pending=S.pending.filter(b=>!ids.has(b.runId))}
function appendPending(p){if(!p.runId||!p.inputText)return;S.pending.push({runId:p.runId,txt:p.inputText,createdAt:new Date().toISOString()});reconcile()}
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
}

/* ── Preview ── */
function autoInput(){if(!el.input)return;el.input.style.height='auto';el.input.style.height=`${Math.max(28,Math.min(el.input.scrollHeight,200))}px`}
async function refreshPreview(){const raw=el.input?.value?.trim()||'',seq=++previewSeq;if(!raw){S.preview={count:0,items:[],error:'',empty:true};return}try{const p=await window.antbot.parseTasks(raw);if(seq!==previewSeq)return;S.preview={count:p.length,items:p.slice(0,5),error:p.length?'':'未识别到有效任务',empty:false}}catch(e){if(seq!==previewSeq)return;S.preview={count:0,items:[],error:compact(e?.message||'解析失败'),empty:false}}}
function queuePreview(){if(previewTimer)clearTimeout(previewTimer);previewTimer=setTimeout(()=>refreshPreview().catch(()=>{}),160)}

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
      apiConfig: { baseUrl: apiCfg.baseUrl, apiKey: apiCfg.apiKey, apiKeys: apiCfg.apiKeys || [apiCfg.apiKey].filter(Boolean), modelId: apiCfg.modelId },
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
  else if (pending.length > 0) { btn.disabled = false; btn.textContent = `开始 ${pending.length} 个`; }
  else { btn.disabled = true; btn.textContent = '开始剪辑'; }

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
    const icons = { pending: '⏳', preparing: '🔧', ready: '📋', composing: '🎬', paused: '⏸', completed: '✅', failed: '❌', cancelled: '🚫' };
    const icon = icons[st] || '';
    const txt = st === 'preparing' ? `${v.step || '准备中'} ${pct}%` : st === 'ready' ? `待合成 · ${v.videoName || ''}` : st === 'composing' ? `合成中 ${pct}%` : st === 'completed' ? `完成 ${fmtDur(v.duration)}` : st === 'failed' ? `失败` : st === 'paused' ? '已暂停' : st === 'cancelled' ? '已取消' : '等待中';
    const selectedClass = v.selected ? ' selected' : '';
    let acts = '';
    if (st === 'pending') acts = `<button class="edit-act-btn" data-act="start" data-vid="${esc(v.id)}">开始</button><button class="edit-act-btn danger" data-act="remove" data-vid="${esc(v.id)}">移除</button>`;
    else if (st === 'preparing') acts = `<button class="edit-act-btn" data-act="pause" data-vid="${esc(v.id)}">暂停</button><button class="edit-act-btn danger" data-act="cancel" data-vid="${esc(v.id)}">取消</button>`;
    else if (st === 'ready') acts = `<button class="edit-act-btn" data-act="compose" data-vid="${esc(v.id)}">合成</button><button class="edit-act-btn danger" data-act="cancel" data-vid="${esc(v.id)}">取消</button>`;
    else if (st === 'composing') acts = `<button class="edit-act-btn danger" data-act="cancel" data-vid="${esc(v.id)}">取消</button>`;
    else if (st === 'paused') acts = `<button class="edit-act-btn" data-act="resume" data-vid="${esc(v.id)}">继续</button><button class="edit-act-btn danger" data-act="cancel" data-vid="${esc(v.id)}">取消</button>`;
    else if (st === 'completed') acts = `<button class="edit-act-btn" data-act="open" data-vid="${esc(v.id)}">打开</button><button class="edit-act-btn danger" data-act="remove" data-vid="${esc(v.id)}">移除</button>`;
    else { const retryLabel = v.retryCount > 0 ? `重试 (${v.retryCount})` : '重试'; acts = `<button class="edit-act-btn" data-act="retry" data-vid="${esc(v.id)}">${retryLabel}</button><button class="edit-act-btn danger" data-act="remove" data-vid="${esc(v.id)}">移除</button>`; }

    const showProgress = ['preparing', 'composing'].includes(st);
    const etaText = v.eta ? ` · 预计${v.eta}` : '';
    const errorDetail = st === 'failed' && v.error ? `<div class="edit-card-error" data-error-toggle="${esc(v.id)}"><span class="error-summary">${esc(v.error.slice(0, 50))}${v.error.length > 50 ? '...' : ''}</span><span class="error-expand">展开</span></div><div class="edit-card-error-full hidden" data-error-full="${esc(v.id)}">${esc(v.error)}</div>` : '';
    const optDisabled = ['completed', 'composing'].includes(st) ? ' disabled' : '';
    const thumbnailHtml = v.thumbnailUrl ? `<img src="${v.thumbnailUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:var(--r-sm)" />` : `<span class="icon" data-icon="film"></span>`;
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
    else if (action === 'cancel') await window.antbot.cancelEditTask(vid);
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
  const addedPaths = new Set(S.publish.videos.map(v => v.path));

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
          <div class="edit-hist-name">${ok ? '✅' : '❌'} ${esc(displayName)}</div>
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
      if (h?.outputPath) {
        const existingIndex = S.publish.videos.findIndex(v => v.path === h.outputPath);
        if (existingIndex >= 0) {
          // 撤销添加
          S.publish.videos.splice(existingIndex, 1);
          toast(`已从发布队列移除`, 'info');
        } else {
          // 添加到发布队列
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
  let options;
  if (type === 'style') { options = S.styleRefs.filter(s => !s.learning && s.prompt).map(s => s.name); if (!options.length) options = ['暂无风格']; }
  else if (type === 'voice') { const voices = S.voices || []; options = voices.length ? voices.map(v => v.name) : ['暂无音色']; }
  else { options = ['开启', '关闭']; }
  popup.innerHTML = `<ul class="style-list">${options.map(o => `<li class="style-item${o === current ? ' active' : ''}" data-val="${esc(o)}">${esc(o)}</li>`).join('')}</ul>`;
  positionPopup(popup, anchor); activePopup = popup;
  popup.querySelectorAll('.style-item').forEach(item => item.addEventListener('click', async () => {
    const val = item.dataset.val;
    video[type] = val;
    // 同步更新到调度器
    if (type === 'style' || type === 'voice') {
      const updateData = {};
      updateData[type] = val;
      if (type === 'voice') {
        const voice = (S.voices || []).find(v => v.name === val);
        if (voice) {
          updateData.voiceProfileId = voice.id;
          updateData.voiceProfileName = voice.name;
        }
      }
      await window.antbot.editUpdateTask(vid, updateData).catch(() => {});
    }
    renderEditCards(); closeAllPopups();
  }));
}

function showEditDefaultPopup(anchor, type) {
  closeAllPopups();
  const current = S.editDefaults[type] || '';
  let options;
  if (type === 'style') { options = S.styleRefs.filter(s => !s.learning && s.prompt).map(s => s.name); if (!options.length) options = ['暂无风格']; }
  else if (type === 'voice') { const voices = S.voices || []; options = voices.length ? voices.map(v => v.name) : ['暂无音色']; }
  else { options = ['开启', '关闭']; }
  const popup = document.createElement('div'); popup.className = 'chip-popup';
  popup.innerHTML = `<ul class="style-list">${options.map(o => `<li class="style-item${o === current ? ' active' : ''}" data-val="${esc(o)}">${esc(o)}</li>`).join('')}</ul>`;
  positionPopup(popup, anchor); activePopup = popup;
  popup.querySelectorAll('.style-item').forEach(item => item.addEventListener('click', () => {
    const val = item.dataset.val;
    S.editDefaults[type] = val;
    if (type === 'style') {
      S.selectedStyle = val;
      renderChips();
    }
    S.editVideos.forEach(v => { if (v.status === 'pending' || v.status === 'failed' || v.status === 'cancelled') v[type] = val; });
    const valEl = document.getElementById(`default-${type}-val`);
    if (valEl) valEl.textContent = val || '默认';
    renderEditCards(); closeAllPopups();
    toast(`默认${type === 'style' ? '风格' : type === 'voice' ? '音色' : '字幕'}: ${val || '默认'}`, 'info');
  }));
}

/* ── Context menu ── */
function showContextMenu(x, y, videoId) {
  const menu = document.getElementById('ctx-menu');
  if (!menu) return;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.remove('hidden');
  menu.dataset.videoId = videoId;
}
function hideContextMenu() {
  const menu = document.getElementById('ctx-menu');
  if (menu) menu.classList.add('hidden');
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
  list.innerHTML = deps.map(d => `<div class="dep-check-item" data-dep-key="${d.key}"><div><span class="dep-check-name">${d.name}</span> <span class="dep-check-status">检查中...</span></div></div>`).join('');
  for (const d of deps) {
    try {
      const r = await window.antbot.checkDep(d.key);
      const item = list.querySelector(`[data-dep-key="${d.key}"]`);
      if (item) {
        item.className = `dep-check-item ${r.ok ? 'ok' : 'missing'}`;
        item.innerHTML = `<div><span class="dep-check-name">${d.name}</span> <span class="dep-check-status">${r.ok ? (r.version || '已安装') : '未安装'}</span></div>
          <div class="dep-acts">${r.ok
            ? '<span style="color:var(--green);font-weight:600">✓</span>'
            : '<button class="btn btn-sm btn-primary" data-dep-install="' + d.key + '" type="button">安装</button>'
          }</div>`;
      }
    } catch {}
  }
  list.querySelectorAll('[data-dep-install]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tool = btn.dataset.depInstall;
      const item = btn.closest('.dep-check-item');
      const origHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span style="animation:spin .8s linear infinite;display:inline-block">⟳</span> 安装中...';
      try {
        const r = await window.antbot.installDep(tool);
        if (r.ok) {
          if (item) { item.className = 'dep-check-item ok'; const s = item.querySelector('.dep-check-status'); if (s) s.textContent = '已安装'; }
          btn.outerHTML = '<span style="color:var(--green);font-weight:600">✓</span>';
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
  list.innerHTML = entries.map(([key, m]) => `
    <div class="model-item ${m.downloaded ? 'downloaded' : ''}" data-model-key="${esc(key)}">
      <div class="model-info">
        <div class="model-name">${esc(m.name)}</div>
        <div class="model-meta">${esc(m.size)} · ${m.downloaded ? '已下载' : '未下载'}</div>
        <div class="model-progress" id="model-progress-${esc(key)}"></div>
      </div>
      <div class="model-actions">
        ${m.downloaded
          ? `<button class="btn btn-sm btn-danger" data-model-delete="${esc(key)}" type="button"><span class="icon" data-icon="trash"></span>删除</button>`
          : `<button class="btn btn-sm btn-primary" data-model-download="${esc(key)}" type="button"><span class="icon" data-icon="download"></span>下载</button>`
        }
      </div>
    </div>
  `).join('');
  injectIcons();
}

/* ── Voicebox dependency check ── */
async function checkVoicebox() {
  const container = document.getElementById('voicebox-items');
  const pathEl = document.getElementById('voicebox-path');
  if (!container) return;
  container.innerHTML = '<div class="voicebox-item"><span class="voicebox-name">检测中...</span></div>';
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
        <span class="voicebox-ver">${item.ok ? (item.version || '✓') : '缺失'}</span>
      </div>
    `).join('');
  } catch {
    container.innerHTML = '<div class="voicebox-item fail"><span class="voicebox-name">检测失败</span></div>';
  }
}

/* ── Actions ── */
async function startTasks(){const raw=el.input?.value?.trim();if(!raw){toast('请输入任务','error');return}if(!S.editDefaults?.style&&!S.selectedStyle){toast('建议先在底部菜单选择风格，否则剪辑将无风格指导','info')}try{const r=await window.antbot.startTasks(raw);appendPending({runId:r.runId,inputText:raw});el.input.value='';autoInput();queuePreview();toast(r.queued?`已排队 (${r.queuePosition})`:`已启动 ${r.taskCount} 条`,'success');renderChat({stick:true})}catch(e){toast(`失败: ${e.message}`,'error')}}
async function stopTasks(){if(!window.confirm('确认停止所有任务？'))return;try{await window.antbot.stopTasks();toast('已停止','success');await refreshAppState().catch(()=>{})}catch(e){toast(`失败: ${e.message}`,'error')}}
async function saveSettings(){
  try{
    const form=readForm();
    S.settings=await window.antbot.updateSettings(form);
  }catch(e){console.error('[saveSettings]',e)}
}
async function runVC(){const f=el.vcForm;if(!f||!S.settings)return;const sp=f.samplePath?.value?.trim(),rt=f.referenceText?.value?.trim();if(!sp){toast('请选择样本','error');return}if(!rt){toast('请填写文本','error');return}S.vc={running:true,status:'running',step:'准备中',pct:5,logs:[]};renderVC();try{S.settings=await window.antbot.updateSettings({voiceClone:{...S.settings.voiceClone,samplePath:sp,referenceText:rt,profileName:f.profileName?.value?.trim(),language:f.language?.value||'zh'}});const vc=await window.antbot.runVoiceClone({samplePath:sp,referenceText:rt,profileName:f.profileName?.value?.trim(),language:f.language?.value||'zh'});S.settings.voiceClone={...S.settings.voiceClone,...vc};S.vc={running:false,status:'completed',step:'完成',pct:100,logs:[`完成: ${vc.voiceId}`]};toast(`克隆完成: ${vc.voiceId}`,'success');renderAll();await runStartup()}catch(e){S.vc={running:false,status:'failed',step:'失败',pct:0,logs:[e.message]};toast(`失败: ${e.message}`,'error')}renderVC()}
async function loadData(){try{S.dataInfo=await window.antbot.getDataInfo();renderData()}catch{}}
async function migrate(){
  try{
    const r=await window.antbot.migrateData();
    const items=r.results||r.migrations||[];
    if(items.length){
      const details=items.map(i=>`${i.item}: ${i.status}`).join(', ');
      toast(`迁移完成 — ${details}`,'success',5000);
    }else{
      toast('无需迁移','info');
    }
    await loadData();
    await refreshAppState();
  }catch(e){toast(`迁移失败: ${e.message}`,'error')}
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
    list.innerHTML = '<div class="sv-note">暂无已克隆音色</div>';
    return;
  }
  list.innerHTML = S.voices.map(v => `
    <div class="voice-item" data-voice-id="${esc(v.id)}">
      <div class="voice-item-info">
        <div class="voice-item-name">${esc(v.name)}</div>
        <div class="voice-item-id">${esc(v.id)}</div>
      </div>
      <div class="voice-item-actions">
        <button class="btn btn-sm btn-ghost" data-voice-rename="${esc(v.id)}" type="button">重命名</button>
        <button class="btn btn-sm btn-ghost" data-voice-delete="${esc(v.id)}" type="button" style="color:var(--red)">删除</button>
      </div>
    </div>
  `).join('');
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
          ? '<span style="color:var(--success);font-size:12px;font-weight:500">✓ 已安装</span>'
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
    try {
      const unsub = window.antbot.onVoiceCloneProgress((p) => {
        if (animText && (p?.step || p?.message)) animText.textContent = p.message || p.step || '';
      });
      const result = await window.antbot.runVoiceClone({ samplePath, referenceText: refText, profileName, language: 'zh' });
      unsub?.();
      if (result?.voiceId) {
        S.voices.push({ id: result.voiceId, name: profileName });
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
    }
    if (anim) anim.classList.add('hidden');
    if (btn) { btn.disabled = false; btn.textContent = '\u5F00\u59CB\u514B\u9686'; updateCloneBtn(); }
  });
}

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
        <span class="publish-video-index">${publishing ? '⏳' : i+1}</span>
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
          <span class="publish-history-icon ${h.success ? 'success' : 'failed'}">${h.success ? '✓' : '✗'}</span>
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
        else setResult('启动失败', 'error');
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
  setInterval(refreshBridge, 3000);
  loadPublishHistory();
  render();

  // 暴露 refreshPublishPage 函数供剪辑页面调用
  window.refreshPublishPage = render;
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
  el.editStartBtn?.addEventListener('click', async () => {
    await window.antbot.editStartAll();
  });

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
  // Context menu - 右键菜单已禁用
  document.addEventListener('click',()=>hideContextMenu());
  // Stat period
  document.querySelectorAll('.stat-sw').forEach(btn=>{btn.addEventListener('click',()=>{document.querySelectorAll('.stat-sw').forEach(b=>b.classList.remove('active'));btn.classList.add('active');S.statPeriod=btn.dataset.period;saveUI();renderStats()})});
  // Platform buttons
  el.openVideoBtn?.addEventListener('click',()=>void window.antbot.openExternal('https://channels.weixin.qq.com/platform').catch(e=>toast(e.message,'error')));
  el.openDouyinBtn?.addEventListener('click',()=>void window.antbot.openExternal('https://creator.douyin.com/creator-micro/home').catch(e=>toast(e.message,'error')));
  // Settings
  el.openSettingsBtn?.addEventListener('click',()=>{fillForm();el.setDlg?.showModal();if(isMobile())closeSidebar();checkDeps();loadModels();checkVoicebox();loadApiUsage();});
  el.setClose?.addEventListener('click',()=>closeDlg(el.setDlg));
  // Auto-save on settings input change
  document.getElementById('settings-body')?.addEventListener('change',()=>{void saveSettings();});
  document.getElementById('settings-body')?.addEventListener('input',(e)=>{if(e.target.matches('input[type=password],input[type=text],input[type=number]')){clearTimeout(S._settingsSaveTimer);S._settingsSaveTimer=setTimeout(()=>void saveSettings(),800);}});
  // Reload default styles
  document.getElementById('reload-default-styles-btn')?.addEventListener('click',async()=>{
    const btn=document.getElementById('reload-default-styles-btn');
    if(btn){btn.disabled=true;btn.textContent='加载中...';}
    try{
      const result=await window.antbot.reloadDefaultStyles();
      if(result.ok){
        toast(`已加载 ${result.count} 个内置风格`,'success');
        await loadStyles();
      }else{
        toast('加载失败: '+result.error,'error');
      }
    }catch(e){
      toast('加载失败: '+e.message,'error');
    }
    if(btn){btn.disabled=false;btn.innerHTML='<span class="icon" data-icon="refresh"></span>重新加载内置风格';injectIcons();}
  });
  // Fetch models button
  document.getElementById('fetch-models-btn')?.addEventListener('click',async()=>{
    const apiKey=[...document.querySelectorAll('#api-keys-list input[name="apiKey"]')].map(e=>e.value.trim()).filter(Boolean)[0]||'';
    const baseUrl=document.getElementById('s-apiBaseUrl')?.value?.trim()||'https://apihub.agnes-ai.com/v1';
    if(!apiKey){toast('请先输入 API Key','error');return;}
    toast('正在获取模型...','info');
    const result=await window.antbot.fetchModels({baseUrl,apiKey});
    if(result.ok&&result.models.length){
      S.settings.api={...S.settings.api,availableModels:result.models};
      await saveSettings();
      fillForm();
      toast(`发现 ${result.models.length} 个模型，请选择一个`,'info');
    }else{toast(result.message||'获取模型失败','error');}
  });
  // Add/remove API key buttons
  document.getElementById('add-api-key-btn')?.addEventListener('click',()=>{
    const list=document.getElementById('api-keys-list');if(!list)return;
    const count=list.querySelectorAll('.s-input-row').length+1;
    const row=document.createElement('div');row.className='s-input-row';
    row.innerHTML=`<input name="apiKey" type="password" placeholder="Key ${count}" /><button type="button" class="btn btn-sm btn-ghost s-key-vis" title="显示/隐藏">👁</button><button type="button" class="btn btn-sm btn-ghost s-key-del" title="删除">✕</button>`;
    list.appendChild(row);
    row.querySelector('input').focus();
  });
  document.getElementById('api-keys-list')?.addEventListener('click',(e)=>{
    const del=e.target.closest('.s-key-del');if(del){const row=del.closest('.s-input-row');if(row)row.remove();void saveSettings();return;}
    const vis=e.target.closest('.s-key-vis');if(vis){const inp=vis.closest('.s-input-row')?.querySelector('input');if(inp)inp.type=inp.type==='password'?'text':'password';}
  });
  // Voice clone
  el.vcRun?.addEventListener('click',()=>void runVC());el.vcClose?.addEventListener('click',()=>closeDlg(el.vcDlg));
  el.vcPick?.addEventListener('click',async()=>{try{const f=await window.antbot.pickAudioFile();if(f&&el.vcForm)el.vcForm.samplePath.value=f}catch(e){toast(e.message,'error')}});
  // Data
  el.dataOpen?.addEventListener('click',async()=>{try{const r=await window.antbot.openDataDir();toast(`已打开: ${r.path}`,'info')}catch(e){toast(e.message,'error')}});
  el.dataOpenLog?.addEventListener('click',async()=>{try{await window.antbot.openExternal(S.dataInfo?.logDir||'')}catch(e){toast(e.message,'error')}});
  el.dataOpenMain?.addEventListener('click',async()=>{try{const r=await window.antbot.openDataDir();toast(`已打开: ${r.path}`,'info')}catch(e){toast(e.message,'error')}});
  el.dataMigrate?.addEventListener('click',()=>void migrate());el.dataClose?.addEventListener('click',()=>closeDlg(el.dataDlg));
  document.getElementById('migrate-old-btn')?.addEventListener('click',()=>void migrate());
  // Video picker
  el.pickVideoBtn?.addEventListener('click',async()=>{try{const f=await window.antbot.pickVideoFile();if(f){const current=el.input.value.trim();el.input.value=current?current+'\n'+f:f;autoInput();queuePreview();renderBtns()}}catch(e){toast(e.message,'error')}});
  bindPublishPage();
  bindDownloadPage();
  // Task input
  el.input?.addEventListener('input',()=>{autoInput();queuePreview();renderBtns();toggleSendBtn()});
  el.input?.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();void startTasks()}});
  el.runBtn?.addEventListener('click',()=>void startTasks());
  // Chat actions
  el.stream?.addEventListener('click',e=>{
    const stopBtn=e.target.closest('[data-stop]');
    const skipBtn=e.target.closest('[data-skip]');
    const retryBtn=e.target.closest('[data-retry]');
    if(stopBtn){void window.antbot.stopTask(stopBtn.dataset.stop).then(()=>toast('已停止','success')).catch(err=>toast(err.message,'error'))}
    if(skipBtn){void window.antbot.stopTask(skipBtn.dataset.skip).then(()=>toast('已跳过','success')).catch(err=>toast(err.message,'error'))}
    if(retryBtn){
      const taskId=retryBtn.dataset.retry;
      // 从当前进度中找到任务信息进行重试
      const task=S.progress?.tasks?.find(t=>t.id===taskId);
      if(task){void window.antbot.resumeTask({taskId,rawLine:task.rawLine||''}).then(()=>toast('已重试','success')).catch(err=>toast(err.message,'error'))}
    }
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
  document.addEventListener('mousedown',e=>{if(activePopup&&!e.target.closest('.chip-popup')&&!e.target.closest('[data-act]'))closeAllPopups()});
  // Chat scroll
  el.scroll?.addEventListener('scroll',()=>{if(!el.scroll||el.scroll.scrollTop>80||S.chatCount>=S.history.length)return;const ph=el.scroll.scrollHeight,pt=el.scroll.scrollTop;S.chatCount=Math.min(S.chatCount+20,S.history.length);renderChat();requestAnimationFrame(()=>{el.scroll.scrollTop=el.scroll.scrollHeight-ph+pt})});
  // IPC
  window.antbot.onProgress(p=>{const pin=el.scroll&&(el.scroll.scrollHeight-el.scroll.scrollTop-el.scroll.clientHeight<80);S.progress=p||S.progress;renderChat({stick:pin});renderBtns();renderStats();renderStatus()});
  window.antbot.onLog(p=>{if(p?.message?.startsWith('[语音克隆]')){S.vc.logs.push(p.message.replace('[语音克隆] ',''));S.vc.logs=S.vc.logs.slice(-16);renderVC()}});
  window.antbot.onVoiceCloneProgress(p=>{
    S.vc={...S.vc,running:p?.status==='running',status:p?.status||S.vc.status,step:p?.step||S.vc.step,pct:typeof p?.percent==='number'?p.percent:S.vc.pct};
    if(p?.message){S.vc.logs.push(p.message);S.vc.logs=S.vc.logs.slice(-16)}
    renderVC();
    // Update animation text
    const animText=document.getElementById('voice-anim-text')||document.querySelector('.voice-anim-text');
    if(animText&&(p?.step||p?.message)) animText.textContent=p.message||p.step||'';
  });
  window.antbot.onStartupStatus(p=>{S.startup=p});
  window.antbot.onHistoryChanged(h=>{const pin=el.scroll&&(el.scroll.scrollHeight-el.scroll.scrollTop-el.scroll.clientHeight<80);S.history=h||[];reconcile();renderChat({stick:pin});renderStats()});
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
      dlBtn.disabled = true;
      dlBtn.innerHTML = '<span class="icon" data-icon="loader"></span>下载中...';
      try {
        const r = await window.antbot.modelsDownload(key);
        if (r.ok) { toast('下载完成', 'success'); await loadModels(); }
        else toast(r.message || '下载失败', 'error');
      } catch (err) { toast(err.message, 'error'); }
      await loadModels();
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
    }
  });
  // Listen for download progress
  window.antbot.onModelsProgress?.((p) => {
    const el = document.getElementById(`model-progress-${p.model}`);
    if (!el) return;
    if (p.status === 'downloading') {
      el.innerHTML = `<div class="prog-track"><div class="prog-bar" style="width:${p.percent||0}%"></div></div><div class="prog-info"><span>${p.message||''}</span><span>${p.percent||0}%</span></div>`;
    } else if (p.status === 'completed') {
      el.innerHTML = '<div class="prog-info"><span style="color:var(--green)">✓ 下载完成</span></div>';
      setTimeout(() => loadModels(), 1000);
    } else if (p.status === 'failed') {
      el.innerHTML = `<div class="prog-info"><span style="color:var(--red)">✗ ${esc(p.message||'失败')}</span></div>`;
    }
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
      const st = s === 'done' ? '✓' : s === 'error' ? '失败' : s === 'cancelled' ? '已取消' : s === 'downloading' ? `${pct}%` : '等待';
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
  document.getElementById('voicebox-open-btn')?.addEventListener('click', async () => {
    try { const r = await window.antbot.voiceboxOpenDir(); if (r.path) toast(`已打开: ${r.path}`, 'info'); }
    catch (e) { toast(e.message, 'error'); }
  });

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
      btn.innerHTML = `<span class="icon" data-icon="refreshCw"></span>重试安装`;
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
        toast('未检测到 ffmpeg，高清视频合并需要它。请运行: brew install ffmpeg', 'warning');
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

/* ── Batch Clone Voices ── */
window.batchCloneVoices = async function() {
  const dir = '/Users/chenxincheng/导出目录/音色';
  const refText = '生活总在催促我们奔赴前路，我们步履匆匆，追赶时间、奔赴目标，常常在喧嚣里弄丢了平和的自己。其实，人生最珍贵的美好，从不在疾驰的前路，而在细碎温柔的日常里。晨起推开窗，清风裹挟着草木的清香扑面而来，枝头鸟鸣清脆，晨光温柔洒落，驱散一夜的疲惫。午后静坐窗边，泡一杯温热的茶，翻几页闲书，任由时光缓缓流淌。没有琐事的叨扰，没有浮躁的焦虑，这一刻的松弛，便是生活最好的馈赠。';
  const files = ['TVB女生（内置）.mp3','乌萨奇（内置）.mp3','奶龙（内置）.mp3','小姐姐（内置）.mp3','懒羊羊（内置）.mp3','曼波（内置）.mp3','熊二（内置）.mp3','猪妞（内置）.mp3','蜡笔小新（内置）.mp3','解说小帅（内置）.mp3'];
  const voices = files.map(f => ({ name: f.replace('.mp3','').replace('（内置）',''), path: dir + '/' + f }));

  const stopListener = window.antbot.onVoiceBatchProgress((p) => {
    if (p.status === 'done') {
      console.log('========== 批量克隆完成 ==========');
      (p.results||[]).forEach(r => console.log(r.ok ? `✅ ${r.name}` : `❌ ${r.name}: ${r.error}`));
      toast('批量克隆完成', 'success');
    } else {
      console.log(`[${p.done+1}/${p.total}] ${p.name} - ${p.step || '处理中'}...`);
    }
  });

  toast('开始批量克隆 10 个音色...', 'info');
  try {
    const results = await window.antbot.batchCloneVoices({ voices, refText });
    return results;
  } catch(e) {
    toast('批量克隆失败: ' + e.message, 'error');
  } finally {
    stopListener?.();
  }
};
console.log('💡 输入 batchCloneVoices() 开始批量克隆 10 个音色');

/* ── Init ── */
async function init(){
  // Remove splash immediately if anime not loaded, otherwise animate
  const splash=document.getElementById('splash');
  const ball=document.getElementById('splash-ball');
  if(splash&&ball&&typeof anime!=='undefined'){
    const cy=window.innerHeight/2;
    try{anime({targets:ball,top:[-60,cy-20],duration:600,easing:'easeInQuad',complete:()=>{
      anime({targets:ball,top:[cy-20,cy-40],duration:200,easing:'easeOutQuad',complete:()=>{
        anime({targets:ball,top:[cy-40,cy],duration:200,easing:'easeInQuad',complete:()=>{
          const sz=Math.max(window.innerWidth,window.innerHeight)*3;
          anime({targets:ball,width:[40,sz],height:[40,sz],marginLeft:[-20,-sz/2],top:[cy,-sz/2+cy],duration:500,easing:'easeInCubic',complete:()=>{
            splash.classList.add('hide');setTimeout(()=>splash.remove(),500);
          }});
        }});
      }});
    }});}catch(e){splash.remove()}
  } else if(splash) {
    splash.remove();
  }

  // Initialize app regardless of splash
  initTheme();injectIcons();bind();initResize();initDialogClose();syncSidebar();
  await loadUISettings();
  // 先加载风格和音色（本地文件读取很快），再渲染，避免空状态闪烁
  await Promise.all([loadStyles(), loadVoices()]);
  const initState=await window.antbot.getInitialState();
  applySnap(initState);renderAll({stick:true});queuePreview();
  await runStartup();
  try{await window.antbot.migrateData()}catch{}
  await loadData();
  await loadModels();
  loadEditTasks();
}
init();
