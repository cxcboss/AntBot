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

    // HuggingFace model download via Node.js fetch (no Python dependency)
    if (meta.hfDownload) {
      const destDir = path.join(dir, modelKey);
      const settings = await store.getSettings();
      const useMirror = settings.models?.useHfMirror;
      const baseUrl = useMirror ? 'https://hf-mirror.com' : 'https://huggingface.co';
      const controller = new AbortController();
      activeDownloads.set(modelKey, controller);
      try {
        sendProgress({ model: modelKey, status: 'downloading', percent: 0, message: useMirror ? '通过国内镜像获取文件列表...' : '获取文件列表...' });

        // 1. 获取仓库文件列表
        const treeUrl = `${baseUrl}/api/models/${meta.repoId}/tree/main`;
        const treeResp = await fetch(treeUrl, { signal: controller.signal });
        if (!treeResp.ok) throw new Error(`获取文件列表失败: HTTP ${treeResp.status}`);
        const treeData = await treeResp.json();

        // 展开子目录（获取 speech_tokenizer 等子目录的文件）
        const files = [];
        for (const item of treeData) {
          if (item.type === 'tree') {
            const subUrl = `${baseUrl}/api/models/${meta.repoId}/tree/main/${item.path}`;
            const subResp = await fetch(subUrl, { signal: controller.signal });
            if (subResp.ok) {
              const subData = await subResp.json();
              for (const f of subData) {
                if (f.type !== 'tree' && f.lfs) {
                  files.push({ path: `${item.path}/${f.path}`, size: f.size || 0 });
                }
              }
            }
          } else if (item.lfs) {
            files.push({ path: item.path, size: item.size || 0 });
          }
        }

        // 也下载小文件（config.json 等）
        for (const item of treeData) {
          if (item.type !== 'tree' && !item.lfs && !files.some(f => f.path === item.path)) {
            files.push({ path: item.path, size: item.size || 0 });
          }
        }

        const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
        let downloadedBytes = 0;

        sendProgress({ model: modelKey, status: 'downloading', percent: 2, message: `${files.length} 个文件，共 ${(totalBytes / 1024 / 1024).toFixed(0)}MB` });

        // 2. 逐个下载文件
        for (const file of files) {
          if (controller.signal.aborted) throw new Error('已取消');

          const fileUrl = `${baseUrl}/${meta.repoId}/resolve/main/${file.path}`;
          const destPath = path.join(destDir, file.path);
          await fs.mkdir(path.dirname(destPath), { recursive: true });

          const resp = await fetch(fileUrl, { signal: controller.signal, redirect: 'follow' });
          if (!resp.ok) throw new Error(`下载 ${file.path} 失败: HTTP ${resp.status}`);

          const fileBytes = [];
          const reader = resp.body.getReader();
          let fileDownloaded = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fileBytes.push(value);
            fileDownloaded += value.length;
            downloadedBytes += value.length;
            if (totalBytes > 0) {
              const percent = Math.round((downloadedBytes / totalBytes) * 100);
              sendProgress({ model: modelKey, status: 'downloading', percent, message: `${file.path} (${(downloadedBytes / 1024 / 1024).toFixed(0)}MB / ${(totalBytes / 1024 / 1024).toFixed(0)}MB)` });
            }
          }
          await fs.writeFile(destPath, Buffer.concat(fileBytes));
        }

        activeDownloads.delete(modelKey);
        sendProgress({ model: modelKey, status: 'completed', percent: 100, message: '下载完成' });
        return { ok: true, path: destDir };
      } catch (error) {
        activeDownloads.delete(modelKey);
        if (error.name === 'AbortError' || error.message === '已取消') {
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

  // 导入已下载的模型（支持单文件和目录）
  ipcMain.handle('models:import', async (_event, { modelKey, sourcePath }) => {
    const meta = MODEL_REGISTRY[modelKey];
    if (!meta) return { ok: false, message: '未知模型' };

    const dir = await getModelsDir();

    try {
      const stat = await fs.stat(sourcePath);

      if (meta.hfDownload) {
        // HF 模型：导入整个目录
        if (!stat.isDirectory()) return { ok: false, error: 'HuggingFace 模型请选择下载后的文件夹' };
        // 验证目录内有 model.safetensors 或 config.json
        const files = await fs.readdir(sourcePath);
        const hasModel = files.some(f => f.endsWith('.safetensors') || f === 'config.json');
        if (!hasModel) return { ok: false, error: '目录内未找到模型文件（.safetensors 或 config.json）' };
        const destDir = path.join(dir, modelKey);
        await fs.mkdir(destDir, { recursive: true });
        // 复制所有文件
        for (const file of files) {
          const src = path.join(sourcePath, file);
          const dst = path.join(destDir, file);
          const fileStat = await fs.stat(src);
          if (fileStat.isDirectory()) {
            await fs.cp(src, dst, { recursive: true });
          } else {
            await fs.copyFile(src, dst);
          }
        }
        return { ok: true, path: destDir };
      } else {
        // 单文件模型：导入文件
        if (!stat.isFile()) return { ok: false, error: '请选择模型文件' };
        if (stat.size < 1024 * 1024) return { ok: false, error: '文件太小，可能不是模型文件' };
        const destPath = path.join(dir, meta.filename);
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
      }
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

module.exports = { register };
