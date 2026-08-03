#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

const browsersJson = require('../node_modules/playwright-core/browsers.json');
const chromiumConfig = browsersJson.browsers.find((item) => item.name === 'chromium');
if (!chromiumConfig) throw new Error('未找到 Playwright Chromium 配置。');

const CHROMIUM_REVISION = String(chromiumConfig.revision);
const CACHE_DIR = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
const TARGET_DIR = path.resolve(__dirname, '..', 'vendors', 'ms-playwright', `chromium-${CHROMIUM_REVISION}`);
const arch = process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64';
const SOURCE_DIR = path.join(CACHE_DIR, `chromium-${CHROMIUM_REVISION}`, arch);
const DEST_DIR = path.join(TARGET_DIR, arch);

async function main() {
  console.log(`[prepare-playwright-mac] Chromium ${chromiumConfig.browserVersion} (${arch})`);

  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`[prepare-playwright-mac] 错误: 源目录不存在，请先执行 npx playwright install chromium`);
    process.exit(1);
  }

  // 清理整个 chromium 目录，重建
  if (fs.existsSync(TARGET_DIR)) {
    fs.rmSync(TARGET_DIR, { recursive: true, force: true });
    console.log('[prepare-playwright-mac] 已清理旧的 Chromium 目录');
  }
  fs.mkdirSync(TARGET_DIR, { recursive: true });

  // 用 ditto 复制（正确处理 macOS symlink 和 framework 结构）
  execSync(`ditto "${SOURCE_DIR}" "${DEST_DIR}"`);
  console.log(`[prepare-playwright-mac] Mac Chromium 已复制完成`);
}

main().catch((err) => {
  console.error('[prepare-playwright-mac] 失败:', err.message);
  process.exit(1);
});
