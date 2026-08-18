export function createRemotePage({ toast, injectIcons }) {
/* ── Remote Control page ── */
let currentUrl = '';
let _bound = false;

async function initRemotePage() {
  const statusText = document.getElementById('remote-status-text');
  const urlEl = document.getElementById('remote-url');
  const toggle = document.getElementById('remote-toggle');
  const toggleText = document.getElementById('remote-toggle-text');
  const passwordEl = document.getElementById('remote-password');
  const deviceNameEl = document.getElementById('remote-device-name');
  const copyBtn = document.getElementById('remote-copy-btn');
  const saveBtn = document.getElementById('remote-save-btn');
  const qrRow = document.getElementById('remote-qr-row');
  const qrCode = document.getElementById('remote-qr-code');
  const passToggle = document.getElementById('remote-pass-toggle');
  const autoToggle = document.getElementById('remote-auto-toggle');

  // 加载当前设置
  try {
    const creds = await window.antbot.remoteGetCredentials();
    if (passwordEl) passwordEl.value = creds.password || '';
    if (deviceNameEl) deviceNameEl.value = creds.deviceName || '';
    if (autoToggle && creds.autoStart) autoToggle.classList.add('on');
  } catch {}

  // 检查当前状态（每次进入页面刷新）
  try {
    const status = await window.antbot.remoteStatus();
    if (status.serverRunning) {
      toggle?.classList.add('on');
      toggleText.textContent = '已启用';
      statusText.textContent = status.tunnel?.running ? '已连接' : '服务已启动';
      if (status.tunnel?.url) {
        currentUrl = 'https://hub.onebugmanai.online';
        urlEl.textContent = currentUrl;
        copyBtn.style.display = '';
        showQrCode(currentUrl);
      }
    }
  } catch {}

  // 事件绑定与 IPC 订阅：仅首次绑定，避免切页重复注册导致 N 次触发
  if (_bound) return;
  _bound = true;

  // 密码显示/隐藏
  passToggle?.addEventListener('click', () => {
    const isPassword = passwordEl.type === 'password';
    passwordEl.type = isPassword ? 'text' : 'password';
    passToggle.querySelector('.icon').dataset.icon = isPassword ? 'eyeOff' : 'eye';
    injectIcons();
  });

  // 自动启动开关
  autoToggle?.addEventListener('click', async () => {
    const isOn = autoToggle.classList.toggle('on');
    await window.antbot.remoteUpdateCredentials({ autoStart: isOn });
    toast(isOn ? '已开启自动启动' : '已关闭自动启动', 'info');
  });

  // 保存并启用按钮
  saveBtn?.addEventListener('click', async () => {
    const password = passwordEl?.value?.trim();
    const deviceName = deviceNameEl?.value?.trim() || '';
    if (!password) { toast('请设置密码', 'error'); return; }

    saveBtn.disabled = true;
    saveBtn.textContent = '启动中...';
    toggleText.textContent = '启动中...';

    try {
      const r = await window.antbot.remoteStart({ password, deviceName });
      if (!r.ok) { toast(r.error, 'error'); toggleText.textContent = '关闭'; saveBtn.disabled = false; saveBtn.textContent = '保存并启用'; return; }

      // 启动 tunnel
      statusText.textContent = '正在连接 Cloudflare...';
      const t = await window.antbot.remoteStartTunnel();
      if (t.ok) {
        toggle.classList.add('on');
        toggleText.textContent = '已启用';
        statusText.textContent = '已连接';
        currentUrl = 'https://hub.onebugmanai.online';
        urlEl.textContent = currentUrl;
        copyBtn.style.display = '';
        showQrCode(currentUrl);
        toast('远程访问已启动', 'success');
      } else {
        statusText.textContent = '服务已启动（隧道连接失败）';
        toast('Tunnel 启动失败: ' + t.error, 'error');
      }
    } catch (e) {
      toggleText.textContent = '关闭';
      toast('启动失败: ' + e.message, 'error');
    }
    saveBtn.disabled = false;
    saveBtn.textContent = '保存并启用';
  });

  // 复制链接
  copyBtn?.addEventListener('click', () => {
    if (currentUrl) {
      navigator.clipboard.writeText(currentUrl).then(() => {
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
      }).catch(() => toast('复制失败', 'error'));
    }
  });

  // 开关切换（仅关闭）
  toggle?.addEventListener('click', async () => {
    if (!toggle.classList.contains('on')) return; // 开启通过保存按钮
    await window.antbot.remoteStop();
    toggle.classList.remove('on');
    toggleText.textContent = '关闭';
    statusText.textContent = '未启动';
    urlEl.textContent = '-';
    currentUrl = '';
    copyBtn.style.display = 'none';
    qrRow.style.display = 'none';
    toast('远程访问已关闭', 'info');
  });

  // 生成二维码
  function showQrCode(url) {
    if (!qrCode || !qrRow) return;
    window.antbot.remoteGenerateQr(url).then(result => {
      if (result.ok && result.dataUrl) {
        qrCode.innerHTML = `<img src="${result.dataUrl}" style="width:140px;height:140px;border-radius:var(--radius)" alt="扫码访问" />`;
        qrRow.style.display = '';
      }
    }).catch(() => {});
  }

  // 监听 tunnel URL 更新
  window.antbot.onRemoteTunnelUrl?.((url) => {
    if (url) {
      currentUrl = 'https://hub.onebugmanai.online';
      urlEl.textContent = currentUrl;
      copyBtn.style.display = '';
      showQrCode(currentUrl);
    }
  });
  window.antbot.onRemoteTunnelStatus?.((s) => {
    if (statusText) statusText.textContent = s.status === 'running' ? '已连接' : s.status === 'starting' ? '连接中...' : '未连接';
  });
}

  return { init: initRemotePage };
}