#!/usr/bin/env node

const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');

const VOICEBOX_ZIP_URL = 'https://codeload.github.com/jamiepine/voicebox/zip/refs/heads/main';
const TARGET_ROOT = path.resolve(__dirname, '..', 'vendors', 'auto_dub_web', 'vendor', 'voicebox');
const TARGET_BACKEND = path.join(TARGET_ROOT, 'backend');
const TARGET_LICENSE = path.join(TARGET_ROOT, 'LICENSE');

function targetReady() {
  return fs.existsSync(path.join(TARGET_BACKEND, 'main.py'))
    && fs.existsSync(path.join(TARGET_BACKEND, 'requirements.txt'));
}

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
  const response = await fetch(VOICEBOX_ZIP_URL, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`下载 voicebox 源码失败（HTTP ${response.status}）`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(zipPath));
}

async function main() {
  if (targetReady()) {
    console.log('[prepare-voicebox] bundled backend already prepared.');
    return;
  }

  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'antbot-voicebox-'));
  const zipPath = path.join(tempRoot, 'voicebox.zip');
  const extractDir = path.join(tempRoot, 'extract');

  try {
    console.log('[prepare-voicebox] downloading voicebox backend source...');
    await downloadZip(zipPath);
    await expandZip(zipPath, extractDir);

    const entries = await fsPromises.readdir(extractDir, { withFileTypes: true });
    const sourceRootEntry = entries.find((entry) => entry.isDirectory());
    if (!sourceRootEntry) {
      throw new Error('解压 voicebox 源码失败：未找到根目录');
    }

    const sourceRoot = path.join(extractDir, sourceRootEntry.name);
    const sourceBackend = path.join(sourceRoot, 'backend');
    await fsPromises.access(path.join(sourceBackend, 'main.py'));
    await fsPromises.access(path.join(sourceBackend, 'requirements.txt'));

    await fsPromises.mkdir(TARGET_ROOT, { recursive: true });
    await fsPromises.rm(TARGET_BACKEND, { recursive: true, force: true });
    await fsPromises.cp(sourceBackend, TARGET_BACKEND, { recursive: true, force: true });

    const sourceLicense = path.join(sourceRoot, 'LICENSE');
    if (fs.existsSync(sourceLicense)) {
      await fsPromises.copyFile(sourceLicense, TARGET_LICENSE);
    }

    console.log('[prepare-voicebox] bundled backend ready.');
  } finally {
    await fsPromises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[prepare-voicebox] ${error.message}`);
  process.exit(1);
});
