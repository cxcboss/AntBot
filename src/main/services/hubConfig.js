// Hub 共享配置：App 端与 Hub Worker 的通信常量。
// 安全说明：HUB_SECRET 是 Worker 端 API 的共享密钥（wrangler secret put HUB_SECRET=xxx 可覆盖）。
// 默认值仅供默认部署使用；更换后必须在两端同步。
const HUB_URL = 'https://hub.onebugmanai.online';
const HUB_SECRET = 'd0c20fdaf8a0bbd9c74c95edd1eb1fdbc4fc0caf8e673cc3';
const HUB_SECRET_HEADER = 'x-hub-secret';

module.exports = { HUB_URL, HUB_SECRET, HUB_SECRET_HEADER };
