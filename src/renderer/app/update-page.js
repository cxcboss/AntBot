export function createUpdatePage({ toast }) {
/* ── Update Page ── */
async function initUpdatePage() {
  // 加载各组件当前版本
  const [appV, pluginV, remoteV] = await Promise.all([
    window.antbot.getAppVersion?.().catch(()=>null),
    window.antbot.getPluginVersion?.().catch(()=>null),
    window.antbot.remoteGetLocalVersion?.().catch(()=>null),
  ]);
  const $t = (id) => document.getElementById(id);
  if($t('upd-app-current')) $t('upd-app-current').textContent = appV?.version || '-';
  if($t('upd-plugin-current')) $t('upd-plugin-current').textContent = pluginV?.version || '-';
  if($t('upd-remote-current')) $t('upd-remote-current').textContent = remoteV?.version || '-';

  setupUpdater('plugin', {
    checkFn: async () => {
      const r = await window.antbot.checkAllUpdates();
      return r?.plugin || {hasUpdate: false};
    },
    downloadFn: async (url) => window.antbot.downloadPluginUpdate(url),
    installFn: async (zip, result) => window.antbot.installPluginUpdate(zip, result?.latestVersion),
    noRestart: true,
  });
  setupUpdater('remote', {
    checkFn: async () => {
      const r = await window.antbot.remoteCheckUpdate?.();
      return r || {hasUpdate: false};
    },
    downloadFn: async () => window.antbot.remoteDoUpdate?.(),
    installFn: null,
    noRestart: true,
  });
  setupUpdater('app', {
    checkFn: async () => {
      const r = await window.antbot.checkAllUpdates();
      return r?.app || {hasUpdate: false};
    },
    downloadFn: async (url) => window.antbot.downloadAppUpdate(url),
    installFn: async (zip, result) => window.antbot.installAppUpdate(zip, result?.latestVersion),
    noRestart: false,
  });

  // 浏览器插件位置按钮
  const pluginDirBtn = document.getElementById('upd-plugin-dir-btn');
  if (pluginDirBtn && !pluginDirBtn._bound) {
    pluginDirBtn._bound = true;
    pluginDirBtn.addEventListener('click', async () => {
      try { await window.antbot.openPluginDir(); }
      catch (e) { toast('打开失败: ' + e.message, 'error'); }
    });
  }

  // 打开下载目录按钮
  const appDirBtn = document.getElementById('upd-app-dir-btn');
  if (appDirBtn && !appDirBtn._bound) {
    appDirBtn._bound = true;
    appDirBtn.addEventListener('click', async () => {
      try {
        const info = await window.antbot.getDataInfo();
        const dataDir = info?.dataDir || '';
        const home = dataDir.replace(/[/\\]AntBot$/, '');
        const sep = home.includes('\\') ? '\\' : '/';
        await window.antbot.openDir(home + sep + 'Downloads');
      }
      catch (e) { toast('打开失败: ' + e.message, 'error'); }
    });
  }
}

function setupUpdater(key, { checkFn, downloadFn, installFn, noRestart }) {
  const $t = (id) => document.getElementById(id);
  const checkBtn = $t(`upd-${key}-check-btn`);
  if (!checkBtn || checkBtn._bound) return;
  checkBtn._bound = true;

  function log(msg, type='') {
    const el = $t(`upd-${key}-log`);
    if (!el) return;
    const line = document.createElement('div');
    if (type) line.className = `log-${type}`;
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  function setProgress(pct, text) {
    const bar = $t(`upd-${key}-bar`);
    const txt = $t(`upd-${key}-progress-text`);
    const wrap = $t(`upd-${key}-progress`);
    if (wrap) wrap.classList.remove('hidden');
    if (bar) { bar.style.width = pct + '%'; bar.style.background = ''; }
    if (txt) txt.textContent = text || pct + '%';
  }

  function hideProgress() {
    $t(`upd-${key}-progress`)?.classList.add('hidden');
    const bar = $t(`upd-${key}-bar`);
    if (bar) { bar.style.width = '0%'; bar.style.background = ''; }
  }

  function resetUI(newVersion) {
    hideProgress();
    $t(`upd-${key}-actions`)?.classList.add('hidden');
    $t(`upd-${key}-changelog`)?.classList.add('hidden');
    $t(`upd-${key}-latest-label`)?.style.setProperty('display','none');
    $t(`upd-${key}-latest`)?.style.setProperty('display','none');
    if (newVersion) { const curEl = $t(`upd-${key}-current`); if (curEl) curEl.textContent = newVersion; }
    const dlBtn = $t(`upd-${key}-download-btn`);
    if (dlBtn) { dlBtn.disabled = false; dlBtn.textContent = '下载并安装'; dlBtn._bound = false; }
    checkBtn.disabled = false;
    checkBtn.textContent = '检查更新';
  }

  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    checkBtn.textContent = '检查中...';
    $t(`upd-${key}-log`).innerHTML = '';
    $t(`upd-${key}-changelog`)?.classList.add('hidden');
    $t(`upd-${key}-actions`)?.classList.add('hidden');
    $t(`upd-${key}-latest-label`)?.style.setProperty('display','none');
    $t(`upd-${key}-latest`)?.style.setProperty('display','none');
    hideProgress();

    try {
      const result = await checkFn();
      if (result.hasUpdate) {
        const latestEl = $t(`upd-${key}-latest`);
        const latestLbl = $t(`upd-${key}-latest-label`);
        if (latestEl) { latestEl.textContent = result.latestVersion || result.remoteVersion || ''; latestEl.style.display = ''; }
        if (latestLbl) latestLbl.style.display = '';
        if (result.changelog) {
          const cl = $t(`upd-${key}-changelog`);
          if (cl) { cl.textContent = result.changelog.replace(/\\n/g, '\n'); cl.classList.remove('hidden'); }
        }
        const sizeEl = $t(`upd-${key}-size`);
        if (sizeEl && result.fileSize) sizeEl.textContent = (result.fileSize/1024/1024).toFixed(1) + ' MB';
        $t(`upd-${key}-actions`)?.classList.remove('hidden');
        log(`发现新版本 ${result.latestVersion || result.remoteVersion}`, 'success');
        checkBtn.disabled = false;
        checkBtn.textContent = '重新检查';

        // 绑定下载按钮（每次检查更新重新绑定）
        const dlBtn = $t(`upd-${key}-download-btn`);
        if (dlBtn) {
          dlBtn.disabled = false;
          const newBtn = dlBtn.cloneNode(true);
          dlBtn.parentNode.replaceChild(newBtn, dlBtn);

          // Windows: 跳转浏览器下载
          if (result.openBrowser && result.releaseUrl) {
            newBtn.textContent = '前往下载';
            newBtn.addEventListener('click', async () => {
              try {
                await window.antbot.openExternal(result.releaseUrl);
                log('已打开下载页面，请下载后手动安装', 'info');
                toast('已打开浏览器，请下载新版本后手动安装', 'info');
              } catch (e) { toast('打开浏览器失败: ' + e.message, 'error'); }
            });
          } else {
          newBtn.textContent = '下载并安装';
          newBtn.addEventListener('click', async () => {
            newBtn.disabled = true;
            newBtn.textContent = '下载中...';
            setProgress(0, '准备下载...');
            log('开始下载...');

            // 添加取消按钮
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn btn-ghost btn-sm';
            cancelBtn.textContent = '取消';
            cancelBtn.style.cssText = 'margin-left:8px';
            newBtn.parentNode.appendChild(cancelBtn);

            let cancelled = false;
            cancelBtn.addEventListener('click', async () => {
              cancelled = true;
              await window.antbot.cancelDownload?.();
              cancelBtn.remove();
              hideProgress();
              newBtn.disabled = false;
              newBtn.textContent = '下载并安装';
              log('已取消下载');
              toast('已取消更新', 'info');
            });

            try {
              const removeListener = window.antbot.onUpdateProgress?.((p) => {
                if (p.key === key && typeof p.percent === 'number') {
                  let label = p.percent.toFixed(1) + '%';
                  if (p.speedText) label = p.speedText + ' · ' + (p.downloadedText || '');
                  if (p.totalText) label += ' / ' + p.totalText;
                  setProgress(Math.min(99, p.percent), label);
                }
              });

              let zipPath = null;
              const newVer = result.latestVersion || result.remoteVersion || '';

              if (key === 'remote') {
                const r = await downloadFn(result.downloadUrl || newVer);
                if (removeListener) removeListener();
                cancelBtn?.remove();
                if (r?.ok) {
                  log('远程页面已更新', 'success');
                  resetUI(r.version || newVer);
                  toast('远程页面已更新', 'success');
                } else {
                  throw new Error(r?.error || '更新失败');
                }
              } else {
                const dlResult = await downloadFn(result.downloadUrl);
                if (removeListener) removeListener();
                cancelBtn?.remove();
                if (!dlResult?.ok && !dlResult?.zipPath) throw new Error(dlResult?.error || '下载失败');
                zipPath = dlResult?.zipPath || dlResult;
                setProgress(95, '安装中...');
                log('下载完成，正在安装...');

                if (installFn) {
                  const installResult = await installFn(zipPath, result);
                  if (!installResult?.ok) throw new Error(installResult?.error || '安装失败');
                  log('已解压到下载目录', 'success');

                  if (!noRestart && installResult.appPath) {
                    resetUI(newVer);
                    showDownloadCompleteDialog(installResult.appPath, installResult.appDir);
                  } else {
                    resetUI(newVer);
                    toast('更新成功', 'success');
                  }
                }
              }
            } catch (e) {
              cancelBtn?.remove();
              if (cancelled) return;
              const bar = $t(`upd-${key}-bar`);
              if (bar) bar.style.background = 'var(--destructive)';
              setProgress(0, '失败');
              log('失败: ' + e.message, 'error');
              newBtn.disabled = false;
              newBtn.textContent = '重试';
            }
          });
          } // end else (not openBrowser)
        }
      } else {
        log('已是最新版本', 'success');
        checkBtn.disabled = false;
        checkBtn.textContent = '检查更新';
      }
    } catch (e) {
      log('检查失败: ' + e.message, 'error');
      checkBtn.disabled = false;
      checkBtn.textContent = '检查更新';
    }
  });
}

function showDownloadCompleteDialog(appPath, appDir) {
  const old = document.getElementById('app-restart-overlay');
  if (old) old.remove();
  const appName = appPath.split('/').pop() || '搬运蚁.app';
  const overlay = document.createElement('div');
  overlay.id = 'app-restart-overlay';
  overlay.className = 'update-restart-overlay';
  overlay.innerHTML = `<div class="update-restart-box">
    <h3>更新已下载</h3>
    <p>新版本已解压到下载目录。<br><br><strong>操作步骤：</strong><br>1. 关闭当前 App<br>2. 打开下载目录，将 <strong>${appName}</strong> 拖到原 App 位置替换<br>3. 重新打开 App</p>
    <div class="update-restart-actions">
      <button id="restart-later-btn" class="btn btn-ghost">稍后</button>
      <button id="restart-open-btn" class="btn btn-primary">打开下载目录</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  document.getElementById('restart-later-btn').addEventListener('click', () => overlay.remove());
  document.getElementById('restart-open-btn').addEventListener('click', async () => {
    try { await window.antbot.openDir(appDir || appPath.substring(0, appPath.lastIndexOf('/'))); } catch {}
    overlay.remove();
  });
}



  return { init: initUpdatePage };
}
