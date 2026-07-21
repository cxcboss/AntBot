const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareEditVideo, composeEditVideo } = require('./smartEditor');
const { resolveAutoDubProjectPath, shutdownVoicebox } = require('./autoDubClient');
const { createClipArtifactManager, reconcileEditTaskCaches } = require('./clipArtifacts');

const MAX_PREPARING = 2;
const DEFAULT_DATA_DIR = path.join(os.homedir(), 'AntBot');

class EditScheduler {
  constructor({ onTaskUpdate, onProgress, log, dataDir = DEFAULT_DATA_DIR }) {
    this.onTaskUpdate = onTaskUpdate || (() => {});
    this.onProgress = onProgress || (() => {});
    this.log = log || (() => {});
    this.dataDir = dataDir;
    this.stateFile = path.join(this.dataDir, 'edit-tasks.json');
    this.artifacts = createClipArtifactManager({ dataDir: this.dataDir, log: this.log });
    this.tasks = new Map();       // id -> task
    this.abortControllers = new Map(); // id -> AbortController
    this._running = false;
    this._composingId = null;
  }

  /* ── State persistence ── */

  async loadState() {
    try {
      const raw = await fs.readFile(this.stateFile, 'utf-8');
      const list = JSON.parse(raw);
      const reconciled = await reconcileEditTaskCaches(list, {
        dataDir: this.dataDir,
        tempDir: os.tmpdir(),
        log: this.log,
      });
      for (const t of reconciled.tasks) {
        this.tasks.set(t.id, t);
      }
      if (reconciled.removed.length) {
        this.log(`[调度] 启动清理剪辑缓存 ${reconciled.removed.length} 项`);
      }
      if (reconciled.changed) await this.saveState();
    } catch {}
  }

  async saveState() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const list = [...this.tasks.values()].map(t => ({
        id: t.id, path: t.path, name: t.name,
        style: t.style, voice: t.voice, subtitle: t.subtitle,
        status: t.status, progress: t.progress, step: t.step, message: t.message,
        outputPath: t.outputPath, error: t.error,
        startedAt: t.startedAt, completedAt: t.completedAt, duration: t.duration,
        srtContent: t.srtContent, srtPath: t.srtPath, videoName: t.videoName,
        tmpDir: t.tmpDir, videoDuration: t.videoDuration,
        voiceProfileId: t.voiceProfileId, voiceProfileName: t.voiceProfileName,
        voiceSpeed: t.voiceSpeed, apiConfig: t.apiConfig,
        outputDir: t.outputDir, language: t.language, frameRate: t.frameRate,
      }));
      await fs.writeFile(this.stateFile, JSON.stringify(list, null, 2), 'utf-8');
    } catch {}
  }

  /* ── Task management ── */

  addTask(taskData) {
    const t = {
      id: taskData.id || `ev-${Date.now()}`,
      path: taskData.path, name: taskData.name,
      style: taskData.style || '', voice: taskData.voice || '', subtitle: taskData.subtitle || '开启',
      status: 'pending', progress: 0, step: '', message: '',
      outputPath: '', error: '', startedAt: null, completedAt: null, duration: 0,
      srtContent: '', srtPath: '', videoName: '', tmpDir: '', videoDuration: 0,
      voiceProfileId: taskData.voiceProfileId || '',
      voiceProfileName: taskData.voiceProfileName || '',
      voiceSpeed: taskData.voiceSpeed || 1.1,
      apiConfig: taskData.apiConfig || {},
      outputDir: taskData.outputDir || '',
      language: taskData.language || 'zh',
      frameRate: taskData.frameRate || 1,
    };
    this.tasks.set(t.id, t);
    this.saveState();
    this.onTaskUpdate(t);
    return t;
  }

  getTask(id) { return this.tasks.get(id); }
  getAllTasks() { return [...this.tasks.values()]; }

  async removeTask(id) {
    await this.cancelTask(id);
    this.tasks.delete(id);
    await this.saveState();
  }

  /* ── User actions ── */

  async startTask(id) {
    const t = this.tasks.get(id);
    if (!t || (t.status !== 'pending' && t.status !== 'paused')) return;
    t.status = 'pending'; t.error = ''; t.message = '';
    this.onTaskUpdate(t);
    this.saveState();
    this._tick();
  }

  pauseTask(id) {
    const t = this.tasks.get(id);
    if (!t || t.status !== 'preparing') return;
    this.log(`[调度] 暂停: ${t.name}`);
    const ctrl = this.abortControllers.get(id);
    if (ctrl) ctrl.abort();
    t.status = 'paused';
    t.message = '已暂停';
    this.onTaskUpdate(t);
    this.saveState();
    this._maybeShutdownVoicebox();
  }

  async cancelTask(id) {
    const t = this.tasks.get(id);
    if (!t) return;
    this.log(`[调度] 取消: ${t.name}（当前状态: ${t.status}）`);
    const ctrl = this.abortControllers.get(id);
    if (ctrl) ctrl.abort();
    t.status = 'cancelled';
    t.message = '已取消';
    await this.artifacts.cleanupTaskCache(t);
    t.tmpDir = '';
    t.srtPath = '';
    t.srtContent = '';
    this.abortControllers.delete(id);
    this.onTaskUpdate(t);
    this.saveState();
    this._maybeShutdownVoicebox();
  }

  async startAll() {
    for (const t of this.tasks.values()) {
      if (t.status === 'pending' || t.status === 'paused') { t.status = 'pending'; t.error = ''; }
    }
    this.saveState();
    this._tick();
  }

  _hasActiveTasks() {
    return [...this.tasks.values()].some(t =>
      ['preparing', 'ready', 'composing', 'pending'].includes(t.status)
    );
  }

  async _maybeShutdownVoicebox() {
    if (this._hasActiveTasks()) return;
    this.log('[调度] 无活跃任务，关闭 voicebox 后端释放内存');
    await shutdownVoicebox(this.log).catch(() => {});
  }

  /* ── Pipeline scheduler ── */

  async _tick() {
    if (this._running) return;
    this._running = true;

    try {
      // Phase 2: 如果没有正在合成的，取第一个 ready 的开始合成
      if (!this._composingId) {
        const readyTask = [...this.tasks.values()].find(t => t.status === 'ready');
        if (readyTask) {
          this._composingId = readyTask.id;
          await this._runCompose(readyTask);
          this._composingId = null;
        }
      }

      // Phase 1: 如果 preparing 的 < MAX_PREPARING，取 pending 的开始准备
      const preparingCount = [...this.tasks.values()].filter(t => t.status === 'preparing').length;
      const pendingTasks = [...this.tasks.values()].filter(t => t.status === 'pending');
      const slots = MAX_PREPARING - preparingCount;
      if (slots > 0 && pendingTasks.length > 0) {
        const toStart = pendingTasks.slice(0, slots);
        await Promise.all(toStart.map(t => this._runPrepare(t)));
      }
    } catch (err) {
      this.log(`调度器错误: ${err.message}`);
    }

    this._running = false;

    // 检查是否还有待处理任务
    const hasPending = [...this.tasks.values()].some(t => t.status === 'pending' || t.status === 'ready');
    if (hasPending) {
      setTimeout(() => this._tick(), 500);
    } else {
      this._maybeShutdownVoicebox();
    }
  }

  async _runPrepare(t) {
    // 已被取消的任务不启动
    if (t.status === 'cancelled' || t.status === 'paused') {
      this.log(`[调度] 跳过 ${t.name}（状态: ${t.status}）`);
      return;
    }

    t.status = 'preparing'; t.startedAt = t.startedAt || new Date().toISOString();
    t.progress = 0; t.step = '准备中'; t.message = ''; t.error = '';
    this.log(`[调度] 开始准备: ${t.name} (${t.path})`);
    this.onTaskUpdate(t);

    const ctrl = new AbortController();
    this.abortControllers.set(t.id, ctrl);
    const sendProgress = (p) => {
      if (ctrl.signal.aborted) return; // 已取消，不再更新
      t.progress = p.percent ?? t.progress;
      t.step = p.step || t.step;
      t.message = p.message || t.message;
      this.onProgress({ ...p, taskId: t.id });
      this.onTaskUpdate(t);
    };

    try {
      // 查找风格的实际 prompt 文字
      let stylePrompt = t.style || '';
      if (t.style && !t.style.includes(' ')) {
        try {
          const stylesPath = path.join(os.homedir(), 'AntBot', 'style-refs.json');
          const styles = JSON.parse(await fs.readFile(stylesPath, 'utf-8'));
          const found = styles.find(s => s.name === t.style);
          if (found?.prompt) stylePrompt = found.prompt;
        } catch {}
      }

      const result = await prepareEditVideo({
        taskId: t.id,
        videoPath: t.path, stylePrompt, apiConfig: t.apiConfig,
        language: t.language, frameRate: t.frameRate || 1,
        dataDir: this.dataDir,
        abortSignal: ctrl.signal,
        log: (msg) => this.log(`[${t.name}] ${msg}`), progress: sendProgress
      });

      // 检查任务是否已被取消/暂停（prepareEditVideo 可能在取消前已完成）
      if (t.status === 'cancelled' || t.status === 'paused') {
        this.log(`[调度] ${t.name} 准备完成但已被取消/暂停，清理结果`);
        await this.artifacts.cleanupTaskCache({ ...t, tmpDir: result.tmpDir });
        return;
      }

      t.srtContent = result.srtContent; t.srtPath = result.srtPath;
      t.videoName = result.videoName; t.tmpDir = result.tmpDir;
      t.videoDuration = result.videoDuration;
      t.status = 'ready'; t.progress = 52; t.step = '待合成';
      t.message = `字幕就绪：${result.videoName}`;
      this.log(`[调度] ${t.name} 准备完成，等待合成`);
    } catch (err) {
      if (ctrl.signal.aborted || t.status === 'cancelled' || t.status === 'paused') {
        this.log(`[调度] ${t.name} 已取消/暂停`);
        if (t.status !== 'paused' && t.status !== 'cancelled') t.status = 'cancelled';
      } else {
        t.status = 'failed'; t.error = err.message;
        this.log(`[调度] ${t.name} 失败: ${err.message}`);
      }
      await this.artifacts.cleanupTaskCache(t);
      t.tmpDir = '';
      t.srtPath = '';
      t.srtContent = '';
    } finally {
      this.abortControllers.delete(t.id);
    }
    this.onTaskUpdate(t);
    this.saveState();
  }

  async _runCompose(t) {
    t.status = 'composing'; t.progress = 55; t.step = '合成中';
    this.onTaskUpdate(t);

    const sendProgress = (p) => {
      t.progress = p.percent ?? t.progress;
      t.step = p.step || t.step;
      t.message = p.message || t.message;
      this.onProgress({ ...p, taskId: t.id });
      this.onTaskUpdate(t);
    };

    const now = new Date();
    const ts = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const dayDir = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const outDir = path.join(t.outputDir || path.dirname(t.path), '完成剪辑', dayDir);
    const outputPath = path.join(outDir, `${t.videoName || '视频'}_${ts}.mp4`);

    const t0 = Date.now();
    const composeCtrl = new AbortController();
    this.abortControllers.set(t.id, composeCtrl);
    try {
      const result = await composeEditVideo({
        videoPath: t.path, srtPath: t.srtPath, outputPath,
        voiceProfileId: t.voiceProfileId, voiceProfileName: t.voiceProfileName || '',
        language: t.language,
        voiceSpeed: t.voiceSpeed, subtitleStyle: t.subtitleStyle || {},
        log: (msg) => this.log(`[${t.name}] ${msg}`), progress: sendProgress
      });
      if (composeCtrl.signal.aborted || t.status === 'cancelled') {
        await fs.rm(result.outputPath || outputPath, { force: true }).catch(() => {});
        await this.artifacts.cleanupTaskCache(t);
        t.tmpDir = '';
        t.srtPath = '';
        t.srtContent = '';
        t.message = '已取消';
        return;
      }
      t.status = 'completed'; t.outputPath = result.outputPath; t.progress = 100;
      t.completedAt = new Date().toISOString(); t.duration = Math.round((Date.now() - t0) / 1000);
      t.message = '完成';
      await this.artifacts.cleanupTaskCache(t);
      t.tmpDir = '';
      t.srtPath = '';
      t.srtContent = '';
    } catch (err) {
      if (composeCtrl.signal.aborted || t.status === 'cancelled') {
        t.status = 'cancelled';
        t.message = '已取消';
      } else {
        t.status = 'failed';
        t.error = err.message;
      }
      t.completedAt = new Date().toISOString(); t.duration = Math.round((Date.now() - t0) / 1000);
      await fs.rm(outputPath, { force: true }).catch(() => {});
      await this.artifacts.cleanupTaskCache(t);
      t.tmpDir = '';
      t.srtPath = '';
      t.srtContent = '';
    } finally {
      this.abortControllers.delete(t.id);
    }
    this.onTaskUpdate(t);
    this.saveState();
  }

  async shutdown() {
    for (const ctrl of this.abortControllers.values()) {
      try { ctrl.abort(); } catch {}
    }
    for (const task of this.tasks.values()) {
      if (task.status === 'preparing' || task.status === 'composing') {
        await this.artifacts.cleanupTaskCache(task);
        task.status = 'pending';
        task.progress = 0;
        task.step = '';
        task.message = '';
        task.tmpDir = '';
        task.srtPath = '';
        task.srtContent = '';
      } else if (task.status === 'failed' || task.status === 'cancelled') {
        await this.artifacts.cleanupTaskCache(task);
        task.tmpDir = '';
        task.srtPath = '';
        task.srtContent = '';
      }
    }
    await this.saveState();
  }
}

module.exports = { EditScheduler };
