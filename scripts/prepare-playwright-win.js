#!/usr/bin/env node

const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');

const browsersJson = require('../node_modules/playwright-core/browsers.json');

const chromiumConfig = browsersJson.browsers.find((item) => item.name === 'chromium');
if (!chromiumConfig) {
  throw new Error('未找到 Playwright Chromium 配置。');
}

const CHROMIUM_REVISION = String(chromiumConfig.revision);
const CHROMIUM_VERSION = String(chromiumConfig.browserVersion);
const DOWNLOAD_URL = `https://cdn.playwright.dev/builds/cft/${CHROMIUM_VERSION}/win64/chrome-win64.zip`;
const TARGET_ROOT = path.resolve(__dirname, '..', 'vendors', 'ms-playwright');
const TARGET_DIR = path.join(TARGET_ROOT, `chromium-${CHROMIUM_REVISION}`);
const TARGET_EXE = path.join(TARGET_DIR, 'chrome-win64', 'chrome.exe');

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error((stderr || stdout || `${command} exit ${code}`).trim()));
    });
  });
}

async function expandZip(zipPath, outputDir) {
  await fsPromises.mkdir(outputDir, { recursive: true });
  if (process.platform === 'win32') {
    const psCommand = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outputDir.replace(/'/g, "''")}' -Force`;
    await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand]);
    return;
  }
  await runCommand('unzip', ['-q', zipPath, '-d', outputDir]);
}

async function downloadZip(zipPath) {
  const response = await fetch(DOWNLOAD_URL, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`下载 Playwright Chromium 失败（HTTP ${response.status}）`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(zipPath));
}

async function main() {
  if (fs.existsSync(TARGET_EXE)) {
    console.log(`[prepare-playwright-win] bundled Chromium already prepared: ${TARGET_DIR}`);
    return;
  }

  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'antbot-playwright-win-'));
  const zipPath = path.join(tempRoot, 'chromium-win64.zip');

  try {
    console.log(`[prepare-playwright-win] downloading Chromium ${CHROMIUM_VERSION}...`);
    await downloadZip(zipPath);

    await fsPromises.mkdir(TARGET_ROOT, { recursive: true });
    await fsPromises.rm(TARGET_DIR, { recursive: true, force: true });
    await expandZip(zipPath, TARGET_DIR);

    if (!fs.existsSync(TARGET_EXE)) {
      throw new Error(`解压后未找到 Chromium 可执行文件：${TARGET_EXE}`);
    }

    console.log(`[prepare-playwright-win] bundled Chromium ready: ${TARGET_DIR}`);
  } finally {
    await fsPromises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[prepare-playwright-win] ${error.message}`);
  process.exit(1);
});
