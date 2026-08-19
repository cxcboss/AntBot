class MiniPopupController {
  constructor() {
    this.init();
  }

  init() {
    this.checkServerStatus();
    this.pollStatus();
  }

  async checkServerStatus() {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    const ports = [18321,18322,18323,18324,18325,18326,18327,18328,18329,18330,18331];
    for (const port of ports) {
      for (const host of ['127.0.0.1','localhost']) {
        try {
          const c = new AbortController(); const t=setTimeout(()=>c.abort(), 800);
          const r = await fetch(`http://${host}:${port}/api/bridge/status`, { signal: c.signal });
          clearTimeout(t);
          if (r.ok) {
            const data = await r.json();
            if (data.status === 'ready' || data.status === 'busy') {
              dot.className = 'status-dot on';
              text.textContent = `已连接 :${port}`;
              return;
            }
          }
        } catch {}
      }
    }
    dot.className = 'status-dot off';
    text.textContent = '未连接';
  }

  pollStatus() {
    setInterval(() => this.checkServerStatus(), 3000);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new MiniPopupController();
});
