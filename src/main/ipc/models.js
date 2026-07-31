const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { shell } = require('electron');
const { resolveDependencyPath } = require('../services/dependencyManager');

// ── Model management ──
const MODEL_REGISTRY = {
  'whisper-base': { name: 'Whisper Base (语音识别)', url: 'https://openaipublic.azureedge.net/main/whisper/models/ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e/base.pt', filename: 'whisper-base.pt', size: '142MB', type: 'stt' },
  'qwen3-tts-0.6b': { name: 'Qwen3 TTS 0.6B (语音克隆/朗读)', repoId: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', size: '~1.2GB', type: 'tts', hfDownload: true },
};

function register({ ipcMain, store, mainWindowRef }) {
  const activeDownloads = new Map(); // modelKey -> AbortController

  async function getModelsDir() {
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    const dir = path.join(dataDir, 'models');
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    return dir;
  }

  ipcMain.handle('models:list', async () => {
    const dir = await getModelsDir();
    const result = {};
    for (const [key, meta] of Object.entries(MODEL_REGISTRY)) {
      let downloaded = false;
      let localPath = '';
      if (meta.hfDownload) {
        // HuggingFace models are directories
        const modelDir = path.join(dir, key);
        try { const stat = await fs.stat(modelDir); downloaded = stat.isDirectory(); localPath = modelDir; } catch { localPath = modelDir; }
      } else {
        const filePath = path.join(dir, meta.filename);
        try { const stat = await fs.stat(filePath); downloaded = stat.size > 0; localPath = filePath; } catch { localPath = filePath; }
      }
      result[key] = { ...meta, downloaded, localPath };
    }
    return { models: result, modelsDir: dir };
  });

  ipcMain.handle('models:download', async (_event, modelKey) => {
    const meta = MODEL_REGISTRY[modelKey];
    if (!meta) return { ok: false, message: '未知模型' };
    const dir = await getModelsDir();

    const win = mainWindowRef();
    const sendProgress = (p) => { if (win && !win.isDestroyed()) win.webContents.send('models:progress', p); };

    // HuggingFace model download via Python huggingface_hub
    if (meta.hfDownload) {
      const destDir = path.join(dir, modelKey);
      const settings = await store.getSettings();
      const useMirror = settings.models?.useHfMirror;
      try {
        sendProgress({ model: modelKey, status: 'downloading', percent: 5, message: useMirror ? '通过国内镜像下载...' : '正在通过 HuggingFace 下载...' });
        const { spawn } = require('node:child_process');
        // Write a temp script to avoid escaping issues
        const scriptPath = path.join(dir, `_download_${modelKey}.py`);
        await fs.writeFile(scriptPath, `
  import sys, os
  os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
  ${useMirror ? "os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'" : ''}
  try:
    from huggingface_hub import snapshot_download
    p = snapshot_download(
        repo_id=${JSON.stringify(meta.repoId)},
        local_dir=${JSON.stringify(destDir)},
        resume_download=True
    )
    print("OK:" + p)
  except Exception as e:
    print("ERR:" + str(e), file=sys.stderr)
    sys.exit(1)
  `, 'utf-8');

        const _pythonBin = await resolveDependencyPath('python') || 'python3';
        await new Promise((resolve, reject) => {
          const child = spawn(_pythonBin, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
          activeDownloads.set(modelKey, child); // store child process for cancellation
          let stderr = '';
          let lastProgress = Date.now();
          child.stderr.on('data', d => { stderr += d.toString(); });
          child.stdout.on('data', d => {
            const msg = d.toString().trim();
            if (msg.startsWith('OK:')) return;
            lastProgress = Date.now();
            sendProgress({ model: modelKey, status: 'downloading', percent: 50, message: '正在下载模型文件...' });
          });
          const timeout = setTimeout(() => {
            child.kill();
            reject(new Error('下载超时（30分钟），请检查网络连接'));
          }, 30 * 60 * 1000);
          child.on('close', code => {
            clearTimeout(timeout);
            activeDownloads.delete(modelKey);
            fs.unlink(scriptPath).catch(() => {});
            if (code === 0) resolve();
            else if (code === null) reject(new Error('已取消'));
            else reject(new Error(stderr.trim() || '下载失败'));
          });
          child.on('error', (e) => {
            clearTimeout(timeout);
            activeDownloads.delete(modelKey);
            fs.unlink(scriptPath).catch(() => {});
            reject(e);
          });
        });
        sendProgress({ model: modelKey, status: 'completed', percent: 100, message: '下载完成' });
        return { ok: true, path: destDir };
      } catch (error) {
        activeDownloads.delete(modelKey);
        if (error.message === '已取消') {
          sendProgress({ model: modelKey, status: 'cancelled', message: '已取消' });
          return { ok: false, message: '已取消' };
        }
        sendProgress({ model: modelKey, status: 'failed', message: error.message });
        return { ok: false, message: error.message };
      }
    }

    // Direct URL download
    const filePath = path.join(dir, meta.filename);
    const tempPath = filePath + '.downloading';
    const controller = new AbortController();
    activeDownloads.set(modelKey, controller);
    try {
      sendProgress({ model: modelKey, status: 'downloading', percent: 0, message: '开始下载...' });
      const response = await fetch(meta.url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const total = parseInt(response.headers.get('content-length') || '0', 10);
      const reader = response.body.getReader();
      const chunks = [];
      let downloaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        downloaded += value.length;
        if (total > 0) {
          const percent = Math.round((downloaded / total) * 100);
          sendProgress({ model: modelKey, status: 'downloading', percent, message: `${(downloaded/1024/1024).toFixed(1)}MB / ${(total/1024/1024).toFixed(1)}MB` });
        }
      }
      await fs.writeFile(tempPath, Buffer.concat(chunks));
      await fs.rename(tempPath, filePath);
      activeDownloads.delete(modelKey);
      sendProgress({ model: modelKey, status: 'completed', percent: 100, message: '下载完成' });
      return { ok: true, path: filePath };
    } catch (error) {
      activeDownloads.delete(modelKey);
      await fs.unlink(tempPath).catch(() => {});
      if (error.name === 'AbortError') {
        sendProgress({ model: modelKey, status: 'cancelled', message: '已取消' });
        return { ok: false, message: '已取消' };
      }
      sendProgress({ model: modelKey, status: 'failed', message: error.message });
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('models:cancel', async (_event, modelKey) => {
    const target = activeDownloads.get(modelKey);
    if (!target) return { ok: false, message: '没有正在下载的任务' };
    try {
      if (typeof target.abort === 'function') target.abort(); // AbortController
      else if (typeof target.kill === 'function') target.kill(); // child process
      activeDownloads.delete(modelKey);
      return { ok: true };
    } catch (e) { return { ok: false, message: e.message }; }
  });

  ipcMain.handle('models:delete', async (_event, modelKey) => {
    const meta = MODEL_REGISTRY[modelKey];
    if (!meta) return { ok: false, message: '未知模型' };
    const dir = await getModelsDir();
    try {
      if (meta.hfDownload) {
        const modelDir = path.join(dir, modelKey);
        await fs.rm(modelDir, { recursive: true, force: true });
      } else {
        const filePath = path.join(dir, meta.filename);
        await fs.unlink(filePath);
      }
      return { ok: true };
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: true, message: '文件不存在' };
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('models:open-dir', async () => {
    const dir = await getModelsDir();
    await shell.openPath(dir);
    return { path: dir };
  });

  ipcMain.handle('models:change-path', async (_event, newPath) => {
    if (!newPath) return { ok: false, message: '路径不能为空' };
    await fs.mkdir(newPath, { recursive: true }).catch(() => {});
    const settings = await store.getSettings();
    settings.api = settings.api || {};
    settings.api.modelsDir = newPath;
    await store.updateSettings({ api: settings.api });
    return { ok: true, path: newPath };
  });

  // 浏览器下载：返回模型的下载 URL
  ipcMain.handle('models:get-url', async (_event, modelKey) => {
    const meta = MODEL_REGISTRY[modelKey];
    if (!meta) return { ok: false, message: '未知模型' };
    if (meta.hfDownload) {
      return { ok: true, url: `https://huggingface.co/${meta.repoId}`, type: 'huggingface' };
    }
    return { ok: true, url: meta.url, type: 'direct' };
  });

  // 导入已下载的模型文件
  ipcMain.handle('models:import', async (_event, { modelKey, sourcePath }) => {
    const meta = MODEL_REGISTRY[modelKey];
    if (!meta) return { ok: false, message: '未知模型' };
    if (meta.hfDownload) return { ok: false, message: 'HuggingFace 模型不支持文件导入，请使用内置下载' };

    try {
      const stat = await fs.stat(sourcePath);
      if (stat.size < 1024 * 1024) return { ok: false, error: '文件太小，可能不是模型文件' };
    } catch { return { ok: false, error: '无法读取源文件' }; }

    const dir = await getModelsDir();
    const destPath = path.join(dir, meta.filename);

    try {
      // 同分区 rename，跨分区 copy+delete
      try {
        await fs.rename(sourcePath, destPath);
      } catch (renameErr) {
        if (renameErr.code === 'EXDEV') {
          await fs.copyFile(sourcePath, destPath);
          await fs.unlink(sourcePath);
        } else {
          throw renameErr;
        }
      }
      return { ok: true, path: destPath };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

module.exports = { register };
