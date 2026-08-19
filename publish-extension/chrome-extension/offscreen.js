// Offscreen keepalive for MV3 Service Worker
// 20s 定时发 heartbeat，保持 SW 活跃
setInterval(() => {
  chrome.runtime.sendMessage({ action: 'offscreenHeartbeat' }).catch(() => {});
}, 20000);

// 播放静音音频 trick（部分 Chrome 版本需要）
try {
  const ctx = new (self.AudioContext || self.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
} catch {}
