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
const statusMap={queued:'等待',pending:'等待',running:'执行中',completed:'成功',failed:'失败',stopped:'已停止',partial_failed:'部分失败'};
const statusText=(s)=>statusMap[s]||s;

/* ── Icons ── */
function injectIcons(){document.querySelectorAll('[data-icon]').forEach(e=>{const n=e.dataset.icon;if(ICONS[n])e.innerHTML=ICONS[n];})}
function closeDlg(dlg){if(!dlg)return;dlg.classList.add('closing');setTimeout(()=>{dlg.close();dlg.classList.remove('closing');},180);}

/* ── Toast ── */
function toast(msg,type='info',ms=3000){const c=$('#toast-container');if(!c)return;const t=document.createElement('div');t.className=`toast ${type}`;const im={success:ICONS.check,error:ICONS.alertCircle,info:ICONS.alertCircle};t.innerHTML=`<span class="icon">${im[type]||''}</span><span>${esc(msg)}</span>`;c.appendChild(t);setTimeout(()=>{t.classList.add('out');setTimeout(()=>t.remove(),200);},ms);}

/* ── Persist UI state ── */
function saveUI(){
  const ui={
    selectedStyle:S.selectedStyle,
    editDefaults:S.editDefaults,
    sidebarOpen:S.sidebarOpen,
    statPeriod:S.statPeriod,
  };
  // Persist to dedicated UI settings file
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
  const titles={main:'主控',edit:'剪辑',publish:'发布','style-ref':'风格参考','subtitle-voice':'字幕与音色'};
  if(el.pageTitle)el.pageTitle.textContent=titles[feat]||feat;
  if(isMobile())closeSidebar();
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
  return lines.map((line,i)=>{const num=`${i+1}、`;const f=line.replace(/https?:\/\/[^\s,，]+/g,url=>url.slice(-5));return num+esc(f)}).join('\n');
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
  return`<div class="task ${esc(st)}"><div class="task-head"><div class="task-title">${esc(title)}</div><div class="task-badge">${esc(statusLabel)}</div></div><div class="task-bar"><div class="task-bar-in" style="width:${pg}%"></div></div>${(canSkip||canCancel)?`<div class="task-acts">${canSkip?`<button class="task-btn skip" data-stop="${esc(t.id)}">跳过</button>`:''}${canCancel?`<button class="task-btn cancel" data-stop="${esc(t.id)}">取消</button>`:''}</div>`:''}</div>`;
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
  const st=S.selectedStyle||(S.styleRefs.length?'选择风格':'暂无风格');
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
    popup.innerHTML=`<div class="slider-row"><span class="slider-label">1x</span><input type="range" min="1" max="1.5" step="0.1" value="${cur}"><span class="slider-label">1.5x</span></div><div class="slider-value">${cur.toFixed(1)}x</div>`;
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
  popup.innerHTML=`<ul class="style-list">${learned.map(s=>`<li class="style-item${s===S.selectedStyle?' active':''}" data-style="${esc(s)}">${esc(s)}</li>`).join('')}</ul>`;
  positionPopup(popup,anchor);activePopup=popup;
  popup.querySelectorAll('.style-item').forEach(item=>{
    item.addEventListener('click',()=>{
      S.selectedStyle=item.dataset.style;
      renderChips();
      toast(`风格: ${S.selectedStyle}`,'success');
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
  set('s-apiKey',s.api?.apiKey||'');set('s-apiBaseUrl',s.api?.baseUrl||'https://apihub.agnes-ai.com/v1');
  const ms=document.getElementById('s-apiModelId');
  if(ms){const m=s.api?.availableModels||[],c=s.api?.modelId||'';ms.innerHTML=m.length?m.map(x=>`<option value="${esc(x.id)}"${x.id===c?' selected':''}>${esc(x.name)}</option>`).join(''):'<option value="">请先获取模型</option>';}
}
function readForm(){
  const get=(id)=>{const e=document.getElementById(id);return e?.value?.trim()||'';};
  return{dataDir:get('s-dataDir'),paths:{outputBaseDir:get('s-outputBaseDir')},style:S.settings?.style||{},voiceClone:S.settings?.voiceClone||{},commands:S.settings?.commands||{},api:{baseUrl:get('s-apiBaseUrl')||'https://apihub.agnes-ai.com/v1',apiKey:get('s-apiKey'),modelId:get('s-apiModelId'),availableModels:S.settings?.api?.availableModels||[]}};
}

/* ── Render: VC/Data/Status ── */
function renderVC(){const v=S.vc;if(el.vcStep)el.vcStep.textContent=v.step||'等待';if(el.vcPct)el.vcPct.textContent=`${v.pct||0}%`;if(el.vcBar)el.vcBar.style.width=`${v.pct||0}%`;if(el.vcLog)el.vcLog.textContent=v.logs.length?v.logs.join('\n'):'暂无日志';if(el.vcRun)el.vcRun.disabled=!!v.running}
function renderData(){const d=S.dataInfo;if(!d)return;if(el.dataVer)el.dataVer.textContent=d.version||'-';if(el.dataPath)el.dataPath.textContent=d.dataDir||d.userData||'-';if(el.dataLog)el.dataLog.textContent=d.logDir||'-'}
function renderStatus(){if(!el.status)return;const live=(S.progress?.tasks||[]).filter(t=>['queued','pending','running'].includes(t.status));const running=live.filter(t=>t.status==='running').length;const pending=live.filter(t=>t.status!=='running').length;if(live.length>0){const p=[];if(running>0)p.push(`${running}个正在执行`);if(pending>0)p.push(`${pending}个等待中`);el.status.textContent=p.join('，');el.status.className='tb-status active'}else{el.status.textContent='没有任务';el.status.className='tb-status'}}
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
    if(ui.editDefaults) S.editDefaults={...S.editDefaults,...ui.editDefaults};
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

/* ── Edit videos ── */
S.editVideos = [];
S.editDefaults = { style: '', voice: '', subtitle: '开启' };
let editIdSeq = 0;

function addEditVideos(filePaths) {
  for (const fp of filePaths) {
    const name = fp.split(/[/\\]/).pop() || fp;
    S.editVideos.push({
      id: `ev-${++editIdSeq}`,
      path: fp,
      name,
      style: S.editDefaults.style,
      voice: S.editDefaults.voice,
      subtitle: S.editDefaults.subtitle,
    });
  }
  renderEditCards();
}

function removeEditVideo(id) {
  S.editVideos = S.editVideos.filter(v => v.id !== id);
  renderEditCards();
}

function renderEditCards() {
  const container = document.getElementById('edit-cards');
  const empty = document.getElementById('edit-empty');
  if (!container) return;
  if (!S.editVideos.length) {
    container.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  container.innerHTML = S.editVideos.map(v => `
    <div class="edit-card" data-video-id="${esc(v.id)}">
      <div class="edit-card-preview" data-vid="${esc(v.id)}">
        <video src="safe-file://${encodeURIComponent(v.path)}" preload="metadata" muted></video>
        <div class="play-icon"><span class="icon" data-icon="play"></span></div>
      </div>
      <div class="edit-card-info">
        <div class="edit-card-name">${esc(v.name)}</div>
        <div class="edit-card-meta">${esc(v.path)}</div>
        <div class="edit-card-opts">
          <button class="edit-opt-btn" data-edit-card-opt="style" data-vid="${esc(v.id)}" type="button">风格: <span class="val">${esc(v.style)}</span></button>
          <button class="edit-opt-btn" data-edit-card-opt="voice" data-vid="${esc(v.id)}" type="button">音色: <span class="val">${esc(v.voice)}</span></button>
          <button class="edit-opt-btn" data-edit-card-opt="subtitle" data-vid="${esc(v.id)}" type="button">字幕: <span class="val">${esc(v.subtitle)}</span></button>
        </div>
      </div>
    </div>
  `).join('');
  injectIcons();
  // Card option click handlers
  container.querySelectorAll('[data-edit-card-opt]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const vid = btn.dataset.vid;
      const opt = btn.dataset.editCardOpt;
      showEditCardPopup(btn, vid, opt);
    });
  });
  // Preview click to play/pause
  container.querySelectorAll('.edit-card-preview').forEach(preview => {
    preview.addEventListener('click', () => {
      const video = preview.querySelector('video');
      if (!video) return;
      const icon = preview.querySelector('.play-icon');
      if (video.paused) {
        video.play();
        if (icon) icon.style.display = 'none';
        video.addEventListener('ended', () => { if (icon) icon.style.display = ''; }, { once: true });
      } else {
        video.pause();
        if (icon) icon.style.display = '';
      }
    });
  });
}

function showEditDefaultPopup(anchor, type) {
  closeAllPopups();
  const popup = document.createElement('div');
  popup.className = 'chip-popup';
  const current = S.editDefaults[type] || '';
  let options;
  if (type === 'style') {
    options = S.styleRefs.filter(s => !s.learning && s.prompt).map(s => s.name);
    if (!options.length) options = ['暂无风格'];
  } else if (type === 'voice') {
    const vcName = S.settings?.voiceClone?.profileName || S.settings?.voiceClone?.voiceId;
    options = vcName ? [vcName] : ['暂无音色'];
  } else {
    options = ['开启', '关闭'];
  }
  popup.innerHTML = `<ul class="style-list">${options.map(o =>
    `<li class="style-item${o === current ? ' active' : ''}" data-val="${esc(o)}">${esc(o)}</li>`
  ).join('')}</ul>`;
  positionPopup(popup, anchor);
  activePopup = popup;
  popup.querySelectorAll('.style-item').forEach(item => {
    item.addEventListener('click', () => {
      S.editDefaults[type] = item.dataset.val;
      const valEl = $(`#default-${type}-val`);
      if (valEl) valEl.textContent = item.dataset.val;
      toast(`${type === 'style' ? '风格' : type === 'voice' ? '音色' : '字幕'}: ${item.dataset.val}`, 'info');
      saveUI();
      closeAllPopups();
    });
  });
}

function showEditCardPopup(anchor, vid, type) {
  closeAllPopups();
  const video = S.editVideos.find(v => v.id === vid);
  if (!video) return;
  const popup = document.createElement('div');
  popup.className = 'chip-popup';
  const current = video[type] || '';
  let options;
  if (type === 'style') {
    options = S.styleRefs.filter(s => !s.learning && s.prompt).map(s => s.name);
    if (!options.length) options = ['暂无风格'];
  } else if (type === 'voice') {
    const vcName = S.settings?.voiceClone?.profileName || S.settings?.voiceClone?.voiceId;
    options = vcName ? [vcName] : ['暂无音色'];
  } else {
    options = ['开启', '关闭'];
  }
  popup.innerHTML = `<ul class="style-list">${options.map(o =>
    `<li class="style-item${o === current ? ' active' : ''}" data-val="${esc(o)}">${esc(o)}</li>`
  ).join('')}</ul>`;
  positionPopup(popup, anchor);
  activePopup = popup;
  popup.querySelectorAll('.style-item').forEach(item => {
    item.addEventListener('click', () => {
      video[type] = item.dataset.val;
      renderEditCards();
      closeAllPopups();
    });
  });
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
  try {
    const styles = await window.antbot.loadStyles();
    if (Array.isArray(styles) && styles.length) {
      S.styleRefs = styles.filter(s => s && s.id && s.name);
      // Update styleIdSeq to avoid ID conflicts
      for (const s of S.styleRefs) {
        const num = parseInt(String(s.id).replace('sty-', ''), 10);
        if (num > styleIdSeq) styleIdSeq = num;
      }
      renderStyleCards();
    }
  } catch {}
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
async function startTasks(){const raw=el.input?.value?.trim();if(!raw){toast('请输入任务','error');return}if(S.startup?.type!=='result')await runStartup();const ls=S.startup?.result?.loginState||{};if(!ls.videoChannel?.loggedIn&&!ls.douyin?.loggedIn){toast('请先登录视频号或抖音','error');return}try{const r=await window.antbot.startTasks(raw);appendPending({runId:r.runId,inputText:raw});el.input.value='';autoInput();queuePreview();toast(r.queued?`已排队 (${r.queuePosition})`:`已启动 ${r.taskCount} 条`,'success');renderChat({stick:true})}catch(e){toast(`失败: ${e.message}`,'error')}}
async function stopTasks(){try{await window.antbot.stopTasks();toast('已停止','success');await refreshAppState().catch(()=>{})}catch(e){toast(`失败: ${e.message}`,'error')}}
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
        toast('已删除', 'info');
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
      S._voiceFilePath = f.path || f.name;
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

/* ── Bind ── */
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
  })});
  // Edit page - drag and drop
  const editList = document.getElementById('edit-list');
  if (editList) {
    editList.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); editList.style.borderColor = 'var(--brand)'; });
    editList.addEventListener('dragleave', () => { editList.style.borderColor = ''; });
    editList.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation(); editList.style.borderColor = '';
      const files = Array.from(e.dataTransfer?.files || []).filter(f => /\.(mp4|mov|m4v|webm|mkv|avi|flv|wmv|ts)$/i.test(f.name));
      if (files.length) addEditVideos(files.map(f => f.path));
    });
  }
  el.editAddBtn?.addEventListener('click',async()=>{try{const files=await window.antbot.pickVideoFiles();if(files&&files.length)addEditVideos(files)}catch(e){toast(e.message,'error')}});
  el.editStartBtn?.addEventListener('click',()=>{if(!S.editVideos.length){toast('请先添加视频','error');return}toast('剪辑功能开发中','info')});
  // Edit default buttons
  document.querySelectorAll('[data-edit-default]').forEach(btn=>{
    btn.addEventListener('click',()=>showEditDefaultPopup(btn,btn.dataset.editDefault));
  });
  // Context menu
  document.addEventListener('click',()=>hideContextMenu());
  document.addEventListener('contextmenu',e=>{
    const card=e.target.closest('.edit-card');
    if(card){e.preventDefault();showContextMenu(e.clientX,e.clientY,card.dataset.videoId)}
  });
  const ctxMenu=document.getElementById('ctx-menu');
  ctxMenu?.querySelector('[data-ctx="delete"]')?.addEventListener('click',()=>{
    const vid=ctxMenu.dataset.videoId;if(vid)removeEditVideo(vid);
    hideContextMenu();toast('已删除','info');
  });
  // Stat period
  document.querySelectorAll('.stat-sw').forEach(btn=>{btn.addEventListener('click',()=>{document.querySelectorAll('.stat-sw').forEach(b=>b.classList.remove('active'));btn.classList.add('active');S.statPeriod=btn.dataset.period;saveUI();renderStats()})});
  // Platform buttons
  el.openVideoBtn?.addEventListener('click',()=>void window.antbot.openExternal('https://channels.weixin.qq.com/platform').catch(e=>toast(e.message,'error')));
  el.openDouyinBtn?.addEventListener('click',()=>void window.antbot.openExternal('https://creator.douyin.com/creator-micro/home').catch(e=>toast(e.message,'error')));
  // Settings
  el.openSettingsBtn?.addEventListener('click',()=>{fillForm();el.setDlg?.showModal();if(isMobile())closeSidebar();checkDeps();loadModels();checkVoicebox();});
  el.setClose?.addEventListener('click',()=>closeDlg(el.setDlg));
  // Auto-save on settings input change
  document.getElementById('settings-body')?.addEventListener('change',()=>{void saveSettings();});
  document.getElementById('settings-body')?.addEventListener('input',(e)=>{if(e.target.matches('input[type=password],input[type=text],input[type=number]')){clearTimeout(S._settingsSaveTimer);S._settingsSaveTimer=setTimeout(()=>void saveSettings(),800);}});
  // Fetch models button
  document.getElementById('fetch-models-btn')?.addEventListener('click',async()=>{
    const apiKey=document.getElementById('s-apiKey')?.value?.trim();
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
  // Task input
  el.input?.addEventListener('input',()=>{autoInput();queuePreview();renderBtns();toggleSendBtn()});
  el.input?.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();void startTasks()}});
  el.runBtn?.addEventListener('click',()=>void startTasks());
  // Chat actions
  el.stream?.addEventListener('click',e=>{const s=e.target.closest('[data-stop]');if(s){void window.antbot.stopTask(s.dataset.stop).then(()=>toast('已停止','success')).catch(err=>toast(err.message,'error'))}});
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
    const dir = el.setForm?.outputBaseDir?.value?.trim();
    if (dir) { try { await window.antbot.openExternal(dir); } catch { try { await window.antbot.openDataDir(); } catch (e) { toast(e.message, 'error'); } } }
    else { toast('请先设置输出目录', 'info'); }
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

  // Voicebox dependency handlers
  document.getElementById('voicebox-install-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('voicebox-install-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="icon">${ICONS.loader}</span>安装中...`; }
    try {
      const r = await window.antbot.voiceboxInstall();
      toast(r.ok ? '语音克隆依赖安装完成' : (r.message || '安装失败'), r.ok ? 'success' : 'error');
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
      toast('语音克隆依赖安装完成', 'success');
    } else if (p.status === 'failed') {
      btn.disabled = false;
      btn.innerHTML = `<span class="icon" data-icon="download"></span>安装依赖`;
      injectIcons();
      toast(p.message || '安装失败', 'error');
    }
  });

  // Style reference events
  bindStyleRefEvents();
  // Subtitle & Voice events
  bindSubtitleVoiceEvents();
}

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
  injectIcons();bind();initResize();initDialogClose();syncSidebar();
  await loadUISettings();
  const initState=await window.antbot.getInitialState();
  applySnap(initState);renderAll({stick:true});queuePreview();
  await runStartup();
  try{await window.antbot.migrateData()}catch{}
  await loadData();
  await loadModels();
  await loadVoices();
  await loadStyles();
}
init();
