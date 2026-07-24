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
    try {
      const r = await fetch('http://localhost:18321/api/bridge/status');
      if (r.ok) {
        const data = await r.json();
        if (data.status === 'ready' || data.status === 'busy') {
          dot.className = 'status-dot on';
          text.textContent = '已连接';
          return;
        }
      }
    } catch (_) {}
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
