const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');
const { STEP_NAMES } = require('./services/config');
const { ensureDir, getDaySequence, buildTaskBaseName } = require('./services/fileUtil');
const { downloadVideo } = require('./services/downloader');
const { prepareEditVideo, composeEditVideo } = require('./services/smartEditor');
const { publishVideo } = require('./services/publisher');

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  if (!ms || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TaskRunner {
  constructor({ store, onProgress, onLog, onRunDone }) {
    this.store = store;
    this.onProgress = onProgress;
    this.onLog = onLog;
    this.onRunDone = onRunDone;

    this.running = false;
    this.stopRequested = false;
    this.currentTaskId = '';
    this.progressRows = [];
    this.runId = '';
    this.runLogPath = '';
    this.logWriteChain = Promise.resolve();
    this.queue = [];
    this.jobSequence = 0;
    this.currentJob = null;
    this.persistedTasksFile = path.join(os.homedir(), 'AntBot', 'main-control-tasks.json');
  }

  buildRunId() {
    this.jobSequence += 1;
    return `run-${Date.now()}-${this.jobSequence}`;
  }

  buildTaskId() {
    this.jobSequence += 1;
    return `task-${Date.now()}-${this.jobSequence}`;
  }

  createJob(kind, payload, userContext = {}) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return {
      kind,
      payload,
      runId: this.buildRunId(),
      userId: String(userContext?.id || userContext?.userId || '').trim() || 'user-1',
      userName: String(userContext?.name || userContext?.userName || '').trim() || '蚂蚁1',
      promise,
      resolve,
      reject,
      enqueuedAt: nowIso()
    };
  }

  decorateTask(task, job, index = 0) {
    return {
      ...task,
      __stopped: Boolean(task?.__stopped),
      __batchRunId: job.runId,
      __userId: job.userId,
      __userName: job.userName,
      __queueIndex: index + 1
    };
  }

  summarizeQueuedTask(task, job, index = 0) {
    return {
      id: task.id,
      batchRunId: job.runId,
      kind: job.kind,
      userId: job.userId,
      userName: job.userName,
      inputText: String(job.payload?.inputText || '').trim(),
      taskName: task.isOriginal ? '原创' : task.taskName,
      rawLine: task.rawLine || '',
      status: task.__stopped ? 'stopped' : 'queued',
      step: task.__stopped ? '已停止' : '等待执行',
      message: task.__stopped ? '已停止，等待恢复' : '排队中',
      progress: 0,
      attempt: 0,
      retryCount: 0,
      retryLimit: 0,
      submittedAt: job.enqueuedAt,
      enqueuedAt: job.enqueuedAt,
      queueIndex: index + 1
    };
  }

  getQueuedTaskRows() {
    return this.queue.flatMap((job) => {
      const tasks = job.kind === 'debug-publish'
        ? [job.payload?.task].filter(Boolean)
        : (Array.isArray(job.payload?.tasks) ? job.payload.tasks : []);
      return tasks.map((task, index) => this.summarizeQueuedTask(task, job, index));
    });
  }

  emitProgress() {
    this.onProgress(this.getSnapshot());
  }

  getSnapshot() {
    return this.buildSnapshot();
  }

  getSnapshotForUser(userId) {
    return this.buildSnapshot(String(userId || '').trim());
  }

  buildSnapshot(userId = '') {
    const filterByUser = (item) => !userId || item?.userId === userId;
    const queueTasks = this.getQueuedTaskRows().filter(filterByUser);
    const tasks = this.progressRows.filter(filterByUser);
    const queue = this.queue
      .filter((job) => !userId || job.userId === userId)
      .map((job) => ({
        runId: job.runId,
        kind: job.kind,
        userId: job.userId,
        userName: job.userName,
        inputText: String(job.payload?.inputText || '').trim(),
        taskCount: job.kind === 'debug-publish' ? 1 : (job.payload?.tasks?.length || 0),
        enqueuedAt: job.enqueuedAt
      }));
    const ownsCurrentJob = !userId || this.currentJob?.userId === userId;

    return {
      runId: ownsCurrentJob ? this.runId : '',
      running: tasks.some((item) => item.status === 'running'),
      stopRequested: ownsCurrentJob ? this.stopRequested : false,
      queueLength: queueTasks.filter((item) => item.status !== 'stopped').length,
      ownerUserId: ownsCurrentJob ? (this.currentJob?.userId || '') : '',
      ownerUserName: ownsCurrentJob ? (this.currentJob?.userName || '') : '',
      queue,
      queueTasks,
      tasks,
      logPath: ownsCurrentJob ? this.runLogPath : ''
    };
  }

  getQueueLength() {
    return this.queue.length;
  }

  log(taskId, message, level = 'info') {
    const payload = {
      runId: this.runId,
      taskId,
      level,
      timestamp: nowIso(),
      message
    };
    this.onLog(payload);
    this.appendRunLog(payload);
  }

  appendRunLog(payload) {
    if (!this.runLogPath) {
      return;
    }
    const taskLabel = payload.taskId || 'system';
    const line = `[${payload.timestamp}] [${payload.level}] [${taskLabel}] ${payload.message}\n`;
    this.logWriteChain = this.logWriteChain
      .then(() => fs.appendFile(this.runLogPath, line, 'utf-8'))
      .catch(() => {});
  }

  async initRunLog() {
    const logDir = path.join(app.getPath('userData'), 'logs', 'tasks');
    await ensureDir(logDir);
    this.runLogPath = path.join(logDir, `${this.runId}.log`);
    const header = `# AntBot Task Log\n# runId=${this.runId}\n# startedAt=${nowIso()}\n\n`;
    await fs.writeFile(this.runLogPath, header, 'utf-8');
  }

  setTaskState(taskId, partial) {
    const index = this.progressRows.findIndex((item) => item.id === taskId);
    if (index === -1) {
      return;
    }

    this.progressRows[index] = {
      ...this.progressRows[index],
      ...partial,
      updatedAt: nowIso()
    };

    this.emitProgress();
  }

  async runStep(task, stepKey, stepFn, progressValue) {
    this.ensureTaskNotStopped(task.id);

    this.setTaskState(task.id, {
      step: STEP_NAMES[stepKey],
      message: `正在${STEP_NAMES[stepKey]}`
    });

    this.log(task.id, `开始${STEP_NAMES[stepKey]}`);
    const result = await stepFn();
    this.ensureTaskNotStopped(task.id);
    this.setTaskState(task.id, {
      progress: progressValue,
      message: `${STEP_NAMES[stepKey]}完成`
    });
    this.log(task.id, `${STEP_NAMES[stepKey]}完成`);
    return result;
  }

  ensureTaskNotStopped(taskId) {
    if (!taskId) {
      return;
    }
    const row = this.progressRows.find((item) => item.id === taskId);
    const task = this.currentJob?.payload?.tasks?.find((item) => item.id === taskId)
      || (this.currentJob?.payload?.task?.id === taskId ? this.currentJob.payload.task : null);
    if (this.stopRequested && this.currentTaskId === taskId) {
      throw new Error('任务已停止');
    }
    if (row?.status === 'stopped' || task?.__stopped) {
      throw new Error('任务已停止');
    }
  }

  async stop(requestUser = {}) {
    const requestUserId = typeof requestUser === 'string'
      ? String(requestUser || '').trim()
      : String(requestUser?.id || requestUser?.userId || '').trim();
    // 单用户模式：requestUserId 为空时跳过用户校验
    if (requestUserId && this.running && this.currentJob?.userId && this.currentJob.userId !== requestUserId) {
      throw new Error(`当前正在执行的是 ${this.currentJob.userName || '其他用户'} 的任务，不能从当前用户停止。`);
    }

    let changed = false;

    // 设置停止标志（单用户模式直接设置）
    if (this.running && this.currentTaskId) {
      this.stopRequested = true;
      changed = true;
    }

    const currentTasks = Array.isArray(this.currentJob?.payload?.tasks) ? this.currentJob.payload.tasks : [];
    for (const task of currentTasks) {
      if (task.id !== this.currentTaskId) {
        task.__stopped = true;
        changed = true;
      }
    }

    for (const row of this.progressRows) {
      if (requestUserId && row.userId !== requestUserId) {
        continue;
      }
      if (row.id === this.currentTaskId && row.status === 'running') {
        row.message = '正在停止当前任务';
        row.updatedAt = nowIso();
        continue;
      }
      if (row.status === 'pending') {
        row.status = 'stopped';
        row.step = '已停止';
        row.message = '已停止，等待恢复';
        row.updatedAt = nowIso();
        changed = true;
      }
    }

    for (const job of this.queue) {
      if (job.userId !== requestUserId) {
        continue;
      }
      const queuedTasks = job.kind === 'debug-publish'
        ? [job.payload?.task].filter(Boolean)
        : (Array.isArray(job.payload?.tasks) ? job.payload.tasks : []);
      for (const task of queuedTasks) {
        if (!task.__stopped) {
          task.__stopped = true;
          changed = true;
        }
      }
    }

    if (changed) {
      this.log('', '已停止当前用户的待执行任务。');
      this.emitProgress();
    }
  }

  async stopTask(taskId, requestUser = {}) {
    const targetId = String(taskId || '').trim();
    if (!targetId) {
      throw new Error('缺少任务。');
    }

    const requestUserId = typeof requestUser === 'string'
      ? String(requestUser || '').trim()
      : String(requestUser?.id || requestUser?.userId || '').trim();

    const row = this.progressRows.find((item) => item.id === targetId);
    if (row) {
      if (requestUserId && row.userId !== requestUserId) {
        throw new Error('不能停止其他用户的任务。');
      }
      const task = this.currentJob?.payload?.tasks?.find((item) => item.id === targetId)
        || (this.currentJob?.payload?.task?.id === targetId ? this.currentJob.payload.task : null);
      if (task) {
        task.__stopped = true;
      }
      if (row.status === 'running') {
        this.currentTaskId = targetId;
        this.stopRequested = true;
        this.setTaskState(targetId, {
          status: 'cancelling',
          message: '正在停止当前任务'
        });
      } else if (row.status === 'pending') {
        this.setTaskState(targetId, {
          status: 'stopped',
          step: '已停止',
          message: '已停止，等待恢复'
        });
      }
      return { stopped: true, taskId: targetId };
    }

    for (const job of this.queue) {
      const queuedTasks = job.kind === 'debug-publish'
        ? [job.payload?.task].filter(Boolean)
        : (Array.isArray(job.payload?.tasks) ? job.payload.tasks : []);
      const task = queuedTasks.find((item) => item.id === targetId);
      if (!task) {
        continue;
      }
      if (requestUserId && job.userId !== requestUserId) {
        throw new Error('不能停止其他用户的任务。');
      }
      task.__stopped = true;
      this.emitProgress();
      return { stopped: true, taskId: targetId };
    }

    throw new Error('任务不存在。');
  }

  async resumeTask(taskId, requestUser = {}, taskPayload = null) {
    const targetId = String(taskId || '').trim();
    if (!targetId) {
      throw new Error('缺少任务。');
    }

    const requestUserId = typeof requestUser === 'string'
      ? String(requestUser || '').trim()
      : String(requestUser?.id || requestUser?.userId || '').trim();
    const requestUserName = typeof requestUser === 'string'
      ? ''
      : String(requestUser?.name || requestUser?.userName || '').trim();

    const row = this.progressRows.find((item) => item.id === targetId);
    if (row) {
      if (requestUserId && row.userId !== requestUserId) {
        throw new Error('不能恢复其他用户的任务。');
      }
      // Clear __stopped on both the job payload task AND the queue reference
      const tasks = this.currentJob?.payload?.tasks || [];
      const debugTask = this.currentJob?.payload?.task;
      for (const t of tasks) {
        if (t.id === targetId) {
          t.__stopped = false;
        }
      }
      if (debugTask?.id === targetId) {
        debugTask.__stopped = false;
      }
      // Also clear __stopped on any queued jobs containing this task
      for (const job of this.queue) {
        const queuedTasks = job.kind === 'debug-publish'
          ? [job.payload?.task].filter(Boolean)
          : (Array.isArray(job.payload?.tasks) ? job.payload.tasks : []);
        for (const t of queuedTasks) {
          if (t.id === targetId) {
            t.__stopped = false;
          }
        }
      }
      if (row.status === 'stopped' || row.status === 'failed') {
        // 重新入队为新任务
        const rawLine = row.rawLine || '';
        if (rawLine) {
          const { parseTaskInput } = require('./services/parser');
          try {
            const tasks = parseTaskInput(rawLine);
            if (tasks.length) {
              const scheduled = this.enqueueTasks(tasks, { id: requestUserId || row.userId || 'user-1', name: requestUserName || '' }, rawLine);
              return { resumed: true, taskId: targetId, queued: scheduled.queued, runId: scheduled.runId };
            }
          } catch (e) {
            throw new Error(`重试失败: ${e.message}`);
          }
        }
        throw new Error('无法重试：缺少原始输入');
      }
      return { resumed: true, taskId: targetId };
    }

    for (const job of this.queue) {
      const queuedTasks = job.kind === 'debug-publish'
        ? [job.payload?.task].filter(Boolean)
        : (Array.isArray(job.payload?.tasks) ? job.payload.tasks : []);
      const task = queuedTasks.find((item) => item.id === targetId);
      if (!task) {
        continue;
      }
      if (requestUserId && job.userId !== requestUserId) {
        throw new Error('不能恢复其他用户的任务。');
      }
      task.__stopped = false;
      this.emitProgress();
      return { resumed: true, taskId: targetId };
    }

    if (taskPayload && requestUserId) {
      const publishAt = taskPayload.publishAt
        ? new Date(taskPayload.publishAt)
        : null;
      const clonedTask = {
        ...taskPayload,
        id: this.buildTaskId(),
        publishAt: publishAt && !Number.isNaN(publishAt.getTime()) ? publishAt : null
      };
      const scheduled = this.enqueueTasks([clonedTask], {
        id: requestUserId,
        name: requestUserName || requestUser?.name || requestUser?.userName || ''
      }, taskPayload.rawLine || taskPayload.taskName || '');
      return {
        resumed: true,
        taskId: clonedTask.id,
        queued: scheduled.queued,
        queuePosition: scheduled.queuePosition,
        runId: scheduled.runId
      };
    }

    throw new Error('任务不存在或无法恢复。');
  }

  enqueueTasks(tasks, userContext = {}, inputText = '') {
    if (!tasks || !tasks.length) {
      throw new Error('未检测到有效任务。');
    }

    const job = this.createJob('tasks', {
      inputText,
      tasks: []
    }, userContext);
    job.payload.tasks = tasks.map((task, index) => this.decorateTask(task, job, index));
    const activeQueuedCount = this.getQueuedTaskRows().filter((item) => item.status !== 'stopped').length;

    if (this.running) {
      this.queue.push(job);
      const queuePosition = activeQueuedCount + job.payload.tasks.filter((task) => !task.__stopped).length;
      this.log('', `收到 ${job.userName} 的新任务，已加入队列（前方还有 ${Math.max(0, activeQueuedCount)} 条）。`);
      this.emitProgress();
      return {
        queued: true,
        queuePosition,
        runId: job.runId,
        taskIds: job.payload.tasks.map((task) => task.id),
        promise: job.promise
      };
    }

    // Set running immediately to prevent TOCTOU race with concurrent calls
    this.running = true;
    void this.runJob(job);

    return {
      queued: false,
      queuePosition: 0,
      runId: job.runId,
      taskIds: job.payload.tasks.map((task) => task.id),
      promise: job.promise
    };
  }

  enqueuePublishDebug({ task, videoPath }, userContext = {}) {
    if (!task || !videoPath) {
      throw new Error('发布调试缺少任务或视频路径。');
    }

    const job = this.createJob('debug-publish', { task: null, videoPath }, userContext);
    job.payload.task = this.decorateTask(task, job, 0);
    const activeQueuedCount = this.getQueuedTaskRows().filter((item) => item.status !== 'stopped').length;

    if (this.running) {
      this.queue.push(job);
      const queuePosition = activeQueuedCount + 1;
      this.log('', `${job.userName} 的调试发布已加入队列（前方还有 ${Math.max(0, activeQueuedCount)} 条）。`);
      this.emitProgress();
      return {
        queued: true,
        queuePosition,
        runId: job.runId,
        taskIds: [job.payload.task.id],
        promise: job.promise
      };
    }

    this.running = true;
    void this.runJob(job);

    return {
      queued: false,
      queuePosition: 0,
      runId: job.runId,
      taskIds: [job.payload.task.id],
      promise: job.promise
    };
  }

  async start(tasks) {
    return this.enqueueTasks(tasks).promise;
  }

  async startPublishDebug(payload) {
    return this.enqueuePublishDebug(payload).promise;
  }

  async runNextQueuedJob() {
    if (this.running || !this.queue.length) {
      return;
    }

    const nextJob = this.queue.shift();
    if (!nextJob) {
      return;
    }

    void this.runJob(nextJob);
  }

  async runJob(job) {
    try {
      const result = job.kind === 'debug-publish'
        ? await this.executePublishDebug(job)
        : await this.executeTaskBatch(job);
      job.resolve(result);
      return result;
    } catch (error) {
      job.reject(error);
      return null;
    } finally {
      if (!this.running && this.queue.length) {
        setTimeout(() => {
          this.runNextQueuedJob().catch(() => {});
        }, 10);
      }
    }
  }

  serializeTaskSnapshot(task) {
    return {
      id: task.id,
      rawLine: task.rawLine || '',
      taskName: task.taskName || '',
      isOriginal: Boolean(task.isOriginal),
      videoUrl: task.videoUrl || '',
      timeRange: task.timeRange || '',
      platforms: Array.isArray(task.platforms) ? task.platforms.slice() : [],
      publishCopy: task.publishCopy || '',
      publishTopics: Array.isArray(task.publishTopics) ? task.publishTopics.slice() : [],
      publishAt: task.publishAt instanceof Date
        ? task.publishAt
        : (task.publishAt ? new Date(task.publishAt) : null)
    };
  }

  buildRunItem(job, task, row, status, extra = {}) {
    return {
      userId: job.userId,
      userName: job.userName,
      taskId: task.id,
      taskName: row?.taskName || (task.isOriginal ? '原创' : task.taskName),
      rawLine: task.rawLine || '',
      status,
      taskSnapshot: this.serializeTaskSnapshot(task),
      ...extra
    };
  }

  async fileExists(filePath) {
    if (!filePath) {
      return false;
    }
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  async savePersistedTask(row) {
    if (!row || (row.status !== 'warning' && row.status !== 'completed')) return;
    try {
      const fsSync = require('node:fs');
      await fs.mkdir(path.dirname(this.persistedTasksFile), { recursive: true });
      let tasks = [];
      try { tasks = JSON.parse(await fs.readFile(this.persistedTasksFile, 'utf-8')); } catch {}
      const idx = tasks.findIndex(t => t.id === row.id);
      const entry = {
        id: row.id,
        taskName: row.taskName,
        rawLine: row.rawLine,
        inputText: row.inputText,
        status: row.status,
        step: row.step,
        message: row.message,
        outputPath: row.outputPath,
        publishAt: row.publishAt || '',
        platforms: row.platforms || [],
        publishCopy: row.publishCopy || '',
        publishTopics: row.publishTopics || [],
        batchRunId: row.batchRunId,
        submittedAt: row.submittedAt,
        updatedAt: nowIso()
      };
      if (idx >= 0) tasks[idx] = entry;
      else tasks.push(entry);
      // 最多保留100条
      if (tasks.length > 100) tasks = tasks.slice(-100);
      await fs.writeFile(this.persistedTasksFile, JSON.stringify(tasks, null, 2));
    } catch {}
  }

  async loadPersistedTasks() {
    try {
      const data = await fs.readFile(this.persistedTasksFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  async removePersistedTask(taskId) {
    try {
      let tasks = await this.loadPersistedTasks();
      tasks = tasks.filter(t => t.id !== taskId);
      await fs.writeFile(this.persistedTasksFile, JSON.stringify(tasks, null, 2));
    } catch {}
  }

  isEncryptedDownloadError(error) {
    const message = String(error?.message || error || '');
    return /(drm|encrypted|widevine|fairplay|playready|受保护|已加密|加密视频|加密源)/i.test(message);
  }

  getExpiredPublishMessage(task) {
    if (!(task?.publishAt instanceof Date) || Number.isNaN(task.publishAt.getTime())) {
      return '';
    }
    if (task.publishAt.getTime() >= Date.now()) {
      return '';
    }
    return `定时时间 ${task.publishAt.toLocaleString('zh-CN', { hour12: false })} 已经过期，任务已跳过。`;
  }

  async executeTaskBatch(job) {
    const tasks = job.payload.tasks;

    this.running = true;
    this.stopRequested = false;
    this.currentTaskId = '';
    this.currentJob = job;
    this.runId = job.runId;
    await this.initRunLog();
    this.progressRows = tasks.map((task, index) => ({
      id: task.id,
      index: index + 1,
      userId: job.userId,
      userName: job.userName,
      inputText: String(job.payload?.inputText || '').trim(),
      taskName: task.isOriginal ? '原创' : task.taskName,
      rawLine: task.rawLine,
      status: task.__stopped ? 'stopped' : 'pending',
      progress: 0,
      step: task.__stopped ? '已停止' : '等待执行',
      message: task.__stopped ? '已停止，等待恢复' : '',
      attempt: 0,
      retryCount: 0,
      retryLimit: 0,
      outputPath: '',
      batchRunId: job.runId,
      submittedAt: job.enqueuedAt,
      updatedAt: nowIso()
    }));

    this.emitProgress();

    const runRecord = {
      id: this.runId,
      userId: job.userId,
      userName: job.userName,
      inputText: String(job.payload?.inputText || '').trim(),
      submittedAt: job.enqueuedAt,
      startedAt: nowIso(),
      endedAt: '',
      status: 'completed',
      items: []
    };

    const publishedRecords = [];
    // #1: 按任务收集临时文件，整批结束后统一清理
    const taskTempFiles = new Map(); // taskId → {downloadPath, tmpDir}

    try {
      const settings = await this.store.getSettingsForUser(job.userId);
      const outputBaseDir = settings.paths.outputBaseDir || path.join(os.homedir(), 'Desktop', '视频');
      const mainControlCacheDir = path.join(outputBaseDir, '主控缓存');
      const mainControlOutputDir = path.join(outputBaseDir, '主控输出');
      await ensureDir(mainControlCacheDir);
      await ensureDir(mainControlOutputDir);
      settings.paths._mainControlCacheDir = mainControlCacheDir;
      settings.paths._mainControlOutputDir = mainControlOutputDir;

      // 加载 UI 设置（获取选中的风格名称）
      let selectedStyleName = '';
      try {
        const uiPath = path.join(os.homedir(), 'AntBot', 'ui-settings.json');
        const uiData = JSON.parse(await fs.readFile(uiPath, 'utf-8'));
        selectedStyleName = uiData?.editDefaults?.style || uiData?.selectedStyle || '';
      } catch {}

      // 加载风格参考库（获取风格提示词）
      let styleRefs = [];
      try {
        const srPath = path.join(os.homedir(), 'AntBot', 'style-refs.json');
        styleRefs = JSON.parse(await fs.readFile(srPath, 'utf-8'));
      } catch {}
      settings._styleRefs = styleRefs;

      // 为每个任务附加风格名称
      for (const task of tasks) {
        task._styleName = task._styleName || selectedStyleName;
      }

      // #6: 启动时清理残留缓存
      await this.cleanupStaleCache(mainControlCacheDir);

      let sequence = await getDaySequence(mainControlCacheDir, new Date());
      const retryLimit = Math.max(0, Number(settings?.retry?.failedTaskRetries ?? 0));
      const failedTasks = [];

      this.progressRows = this.progressRows.map((row) => ({
        ...row,
        retryLimit
      }));
      this.emitProgress();

      // ── Phase 1: 并行下载所有视频 ──
      this.log('', `开始并行下载 ${tasks.length} 个视频...`);
      const activeTasks = tasks.filter(t => !t.__stopped);
      const downloadResults = new Map();

      // 并发限制（最多 5 个同时下载）
      const MAX_DOWNLOAD_CONCURRENCY = 5;
      const downloadPool = async (tasks) => {
        const results = [];
        let idx = 0;
        const workers = Array.from({ length: Math.min(MAX_DOWNLOAD_CONCURRENCY, tasks.length) }, async () => {
          while (idx < tasks.length) {
            const i = idx++;
            const task = tasks[i];
            const row = this.progressRows.find(r => r.id === task.id);
            if (!row || this.stopRequested) continue;

            this.setTaskState(task.id, { status: 'running', progress: 5, step: '下载中', message: `下载中 (${i + 1}/${tasks.length})...` });
            const baseName = buildTaskBaseName(task, sequence++, new Date());
            task._baseName = baseName;
            task._cacheDir = mainControlCacheDir;

            try {
              if (this.stopRequested) {
                downloadResults.set(task.id, { error: new Error('用户停止') });
                this.setTaskState(task.id, { status: 'stopped', step: '已停止', message: '已停止' });
                continue;
              }
              const downloadResult = await downloadVideo({ task, tempDir: mainControlCacheDir, baseName, settings, log: (msg) => this.log(task.id, msg) });
              downloadResults.set(task.id, downloadResult);
              taskTempFiles.set(task.id, { downloadPath: downloadResult.outputPath, tmpDir: '' });
              this.setTaskState(task.id, { progress: 25, step: '下载完成', message: '视频下载完成，等待剪辑...' });
            } catch (err) {
              downloadResults.set(task.id, { error: err });
              this.setTaskState(task.id, { status: 'failed', step: '下载失败', message: err.message });
              this.log(task.id, `下载失败: ${err.message}`, 'error');
            }
          }
        });
        await Promise.allSettled(workers);
      };

      await downloadPool(activeTasks);

      // #4: 下载阶段汇总
      const dlSuccess = [...downloadResults.values()].filter(r => !r.error).length;
      const dlFailed = activeTasks.length - dlSuccess;
      this.log('', `下载阶段完成。成功: ${dlSuccess}/${activeTasks.length}`);
      if (dlSuccess === 0 && activeTasks.length > 0) {
        this.setTaskState(activeTasks[0]?.id || '', {
          step: '下载失败', message: `全部 ${dlFailed} 个视频下载失败，请检查链接和网络`
        });
      }

      // ── Phase 2: 串行执行 subtitle → edit → publish ──
      const runSingleTask = async (task, attemptIndex = 0) => {
        const row = this.progressRows.find((item) => item.id === task.id);
        if (!row) return { status: 'skipped', retryable: false };

        if (task.__stopped) {
          this.setTaskState(task.id, { status: 'stopped', step: '已停止', message: '任务已停止' });
          runRecord.status = 'stopped';
          runRecord.items.push(this.buildRunItem(job, task, row, 'stopped', { message: '执行前被停止', finishedAt: nowIso(), attempt: attemptIndex + 1, retryCount: attemptIndex, retryable: false }));
          return { status: 'stopped', retryable: false };
        }

        const expiredPublishMessage = this.getExpiredPublishMessage(task);
        if (expiredPublishMessage) {
          this.setTaskState(task.id, { status: 'failed', step: '失败', message: expiredPublishMessage, attempt: attemptIndex + 1, retryCount: attemptIndex, retryLimit });
          this.log(task.id, expiredPublishMessage, 'error');
          runRecord.items.push(this.buildRunItem(job, task, row, 'failed', { message: expiredPublishMessage, finishedAt: nowIso(), attempt: attemptIndex + 1, retryCount: attemptIndex, retryable: true }));
          return { status: 'failed', retryable: true };
        }

        // 检查下载结果（重试时如果之前下载成功则跳过）
        const dlResult = downloadResults.get(task.id);
        const hasExistingOutput = dlResult?.outputPath && !dlResult?.error;
        if (!hasExistingOutput && (!dlResult || dlResult.error)) {
          // 重试时重新下载
          if (attemptIndex > 0 && (!dlResult || dlResult.error)) {
            try {
              this.setTaskState(task.id, { status: 'running', progress: 10, step: '重新下载', message: `重试: 重新下载...` });
              const baseName = task._baseName || buildTaskBaseName(task, 0, new Date());
              const redlResult = await downloadVideo({ task, settings, baseName, tempDir: mainControlCacheDir, log: (msg) => this.log(task.id, msg) });
              downloadResults.set(task.id, redlResult);
            } catch (redlErr) {
              downloadResults.set(task.id, { error: redlErr });
              const errMsg = redlErr.message || '视频下载失败';
              this.setTaskState(task.id, { status: 'failed', step: '失败', message: errMsg, attempt: attemptIndex + 1, retryCount: attemptIndex, retryLimit });
              runRecord.items.push(this.buildRunItem(job, task, row, 'failed', { message: errMsg, finishedAt: nowIso(), attempt: attemptIndex + 1, retryCount: attemptIndex, retryable: !task.__stopped }));
              return { status: 'failed', retryable: !task.__stopped };
            }
          } else {
            const errMsg = dlResult?.error?.message || '视频下载失败';
            this.setTaskState(task.id, { status: 'failed', step: '失败', message: errMsg, attempt: attemptIndex + 1, retryCount: attemptIndex, retryLimit });
            runRecord.items.push(this.buildRunItem(job, task, row, 'failed', { message: errMsg, finishedAt: nowIso(), attempt: attemptIndex + 1, retryCount: attemptIndex, retryable: !task.__stopped }));
            return { status: 'failed', retryable: !task.__stopped };
          }
        }

        this.currentTaskId = task.id;
        const publishOnlyRetry = attemptIndex > 0 && task._outPath && await this.fileExists(task._outPath);
        if (publishOnlyRetry) {
          this.log(task.id, '视频已生成，跳过下载和编辑，直接重试发布');
        }
        this.setTaskState(task.id, { status: 'running', progress: publishOnlyRetry ? 80 : 30, step: publishOnlyRetry ? '重新发布' : '字幕生成', message: attemptIndex > 0 ? `重试中（第${attemptIndex}次）` : '正在生成字幕...', attempt: attemptIndex + 1, retryCount: attemptIndex, retryLimit });

        if (publishOnlyRetry) {
          // 发布重试：直接跳到发布步骤
          const outPath = task._outPath;
          const publishEnabled = settings?.publish?.enabled !== false;
          try {
            let publishResult = null;
            if (publishEnabled) {
              publishResult = await publishVideo({ task, settings, outputPath: outPath, log: (msg) => this.log(task.id, msg) });
            }
            const publishedPlatforms = publishResult?.platforms || [];
            const platformNames = publishedPlatforms.map(p => p === 'videoChannel' ? '视频号' : '抖音').join('、');
            const completionMsg = platformNames ? `已发布到 ${platformNames}` : '任务完成';
            this.setTaskState(task.id, { status: 'completed', progress: 100, step: '完成', message: completionMsg, attempt: attemptIndex + 1, retryCount: attemptIndex, retryLimit, outputPath: outPath });
            this.savePersistedTask(this.progressRows.find(r => r.id === task.id));
            runRecord.items.push(this.buildRunItem(job, task, row, 'completed', { outputPath: outPath, publishedPlatforms, publishMode: publishResult?.mode || '', finishedAt: nowIso(), attempt: attemptIndex + 1, retryCount: attemptIndex }));
            if (publishEnabled && publishedPlatforms.length) {
              publishedRecords.push({ userId: job.userId, userName: job.userName, taskName: row.taskName, outputPath: outPath, publishAt: nowIso(), publishedPlatforms, publishMode: publishResult?.mode || '', completedAt: nowIso(), runId: this.runId });
            }
            return { status: 'completed', retryable: false };
          } catch (pubErr) {
            this.setTaskState(task.id, { status: 'failed', step: '发布失败', message: pubErr.message, attempt: attemptIndex + 1, retryCount: attemptIndex, retryLimit, outputPath: outPath });
            runRecord.items.push(this.buildRunItem(job, task, row, 'failed', { message: pubErr.message, finishedAt: nowIso(), attempt: attemptIndex + 1, retryCount: attemptIndex, retryable: true }));
            return { status: 'failed', retryable: true };
          }
        }

        const baseName = task._baseName;
        let outDir = '';
        let outPath = '';
        const publishEnabled = settings?.publish?.enabled !== false;
        let editCompleted = false;

        try {
          // ── 新剪辑流程: prepareEditVideo + composeEditVideo ──
          const voiceoverEnabled = settings?.style?.voiceoverEnabled !== false;
          const subtitleEnabled = voiceoverEnabled && settings?.style?.subtitleEnabled !== false;

          // 构建 apiConfig（与剪辑页面一致）
          const apiCfg = settings?.api || {};
          const apiConfig = {
            baseUrl: apiCfg.baseUrl,
            apiKey: apiCfg.apiKey,
            apiKeys: apiCfg.apiKeys || [apiCfg.apiKey].filter(Boolean),
            modelId: apiCfg.modelId
          };

          // 获取风格提示词
          let stylePrompt = '';
          if (task._styleName && settings?._styleRefs) {
            const found = settings._styleRefs.find(s => s.name === task._styleName);
            if (found?.prompt) stylePrompt = found.prompt;
          }

          // 重试时清理旧临时目录
          const ttf = taskTempFiles.get(task.id);
          if (ttf?.tmpDir) {
            try { await fs.rm(ttf.tmpDir, { recursive: true, force: true }); } catch {}
          }

          // 3a. prepareEditVideo: 抽帧 → AI识别 → 生成SRT
          const prepareResult = await this.runStep(task, 'prepare', () => prepareEditVideo({
            taskId: task.id,
            videoPath: dlResult.outputPath,
            stylePrompt,
            apiConfig,
            language: settings?.language || 'zh',
            frameRate: settings?.edit?.frameRate || 1,
            dataDir: path.join(os.homedir(), 'AntBot'),
            log: (msg) => this.log(task.id, msg),
            progress: (p) => this.setTaskState(task.id, {
              progress: 25 + Math.round((p.percent || 0) * 0.25),
              step: p.step || '准备中',
              message: p.message || ''
            })
          }), 50);

          // 记录临时文件路径用于清理
          if (ttf) ttf.tmpDir = prepareResult.tmpDir;

          // 输出路径
          const dayDir = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          outDir = path.join(mainControlOutputDir, dayDir);
          await ensureDir(outDir);
          outPath = path.join(outDir, `${prepareResult.videoName || task._baseName}.mp4`);

          // 3b. composeEditVideo: 合成视频 (配音+字幕+音频混合)
          const voiceClone = settings?.voiceClone || {};
          const subtitleStyle = {
            textColor: settings?.style?.subtitleTextColor || '#0D9488',
            strokeColor: settings?.style?.subtitleStrokeColor || '#000000',
            positionPercent: settings?.style?.subtitlePositionPercent ?? 12,
          };

          await this.runStep(task, 'compose', () => composeEditVideo({
            videoPath: dlResult.outputPath,
            srtPath: prepareResult.srtPath,
            outputPath: outPath,
            voiceProfileId: voiceClone.voiceId || '',
            voiceProfileName: voiceClone.profileName || '',
            language: settings?.language || 'zh',
            voiceSpeed: settings?.style?.voiceSpeed || 1.1,
            subtitleStyle,
            voiceoverEnabled,
            subtitleEnabled,
            videoWidth: prepareResult.videoWidth || 0,
            videoHeight: prepareResult.videoHeight || 0,
            log: (msg) => this.log(task.id, msg),
            progress: (p) => this.setTaskState(task.id, {
              progress: 50 + Math.round((p.percent || 0) * 0.25),
              step: p.step || '合成中',
              message: p.message || ''
            })
          }), 75);
          editCompleted = true;
          task._outPath = outPath; // 保存路径供发布重试使用

          let publishResult = null;
          if (publishEnabled) {
            const extensionConfig = settings?.publish?.browserExtension;

            if (extensionConfig?.enabled) {
              const { bridgeServiceManager } = require('./services/bridgeServiceManager');
              const { createBrowserPublishBridge } = require('./services/browserPublishBridge');

              // 1. 确保桥接服务运行
              const status = bridgeServiceManager.getStatus();
              if (!status.running) {
                this.log(task.id, '桥接服务未启动，正在自动启动...');
                this.setTaskState(task.id, { step: '发布准备', message: '正在启动桥接服务...' });
                const started = await bridgeServiceManager.start();
                if (!started) throw new Error('桥接服务启动失败，请在发布页面手动启动服务后重试');
                await new Promise(r => setTimeout(r, 1500));
                this.log(task.id, '桥接服务已启动');

                // 尝试启动系统浏览器让插件连接
                try {
                  const { shell } = require('electron');
                  this.log(task.id, '正在打开浏览器...');
                  await shell.openExternal('https://channels.weixin.qq.com/platform');
                } catch (e) {
                  this.log(task.id, `打开浏览器失败: ${e.message}，请手动打开浏览器`);
                }
              }

              // 2. 等待桥接服务就绪（确保端口开放）
              this.setTaskState(task.id, { step: '发布准备', message: '等待桥接服务就绪...' });
              this.log(task.id, '等待桥接服务就绪...');
              let bridgeReady = false;
              for (let i = 0; i < 15; i++) {
                try {
                  const { createBrowserPublishBridge } = require('./services/browserPublishBridge');
                  const bridgeCheck = createBrowserPublishBridge({ baseUrl: extensionConfig.baseUrl, timeoutMs: 5000 });
                  const s = await bridgeCheck.getStatus();
                  if (s.status === 'ready' || s.status === 'busy') {
                    bridgeReady = true;
                    this.log(task.id, '桥接服务就绪');
                    break;
                  }
                } catch {}
                await new Promise(r => setTimeout(r, 1000));
              }
              if (!bridgeReady) {
                throw new Error('桥接服务未就绪，请在发布页面手动启动服务后重试');
              }
            }

            this.log(task.id, '开始发布...');
            publishResult = await this.runStep(task, 'publish', () => publishVideo({
              task, settings, outputPath: outPath,
              log: (msg) => this.log(task.id, msg)
            }), 95);
            this.log(task.id, `发布完成: mode=${publishResult?.mode}, platforms=${JSON.stringify(publishResult?.platforms)}`);
          } else {
            this.setTaskState(task.id, { step: STEP_NAMES.publish, progress: 95, message: '自动发布已关闭，输出视频即视为完成' });
            this.log(task.id, '自动发布已关闭，输出视频已视为任务完成。');
          }

          const publishedPlatforms = publishEnabled && Array.isArray(publishResult?.platforms) && publishResult.platforms.length
            ? publishResult.platforms
            : (publishEnabled && Array.isArray(task.platforms) && task.platforms.length ? task.platforms : []);

          const platformNames = publishedPlatforms.map(p => p === 'videoChannel' ? '视频号' : '抖音').join('、');
          const completionMsg = platformNames ? `已发布到 ${platformNames}` : '任务完成';
          this.setTaskState(task.id, { status: 'completed', progress: 100, step: '完成', message: completionMsg, attempt: attemptIndex + 1, retryCount: attemptIndex, retryLimit, outputPath: outPath });
          this.savePersistedTask(this.progressRows.find(r => r.id === task.id));

          runRecord.items.push(this.buildRunItem(job, task, row, 'completed', {
            outputPath: outPath, publishAt: task.publishAt ? task.publishAt.toISOString() : '',
            publishedPlatforms, publishMode: publishEnabled ? (publishResult?.mode || '') : 'disabled',
            finishedAt: nowIso(), attempt: attemptIndex + 1, retryCount: attemptIndex
          }));

          if (publishEnabled && publishedPlatforms.length) {
            publishedRecords.push({ userId: job.userId, userName: job.userName, taskName: row.taskName, outputPath: outPath, publishAt: task.publishAt ? task.publishAt.toISOString() : nowIso(), publishedPlatforms, publishMode: publishResult?.mode || '', completedAt: nowIso(), runId: this.runId });
          }

          // #1: 不在这里清理，整批结束后统一清理
          await sleep(settings?.browser?.pauseBetweenTasksMs || 0);
          return { status: 'completed', retryable: false };
        } catch (error) {
          // #3: 修复 — 只要视频已生成就算完成，不受 publishEnabled 限制
          const outputReady = editCompleted && await this.fileExists(outPath);
          if (outputReady) {
            this.log(task.id, `发布失败但视频已生成: ${error.message}`, 'warn');
            this.setTaskState(task.id, { status: 'warning', progress: 100, step: '部分完成', message: publishEnabled ? `发布失败: ${error.message}` : '成品视频已输出', attempt: attemptIndex + 1, retryCount: attemptIndex, retryLimit, outputPath: outPath });
            this.savePersistedTask(this.progressRows.find(r => r.id === task.id));
            runRecord.items.push(this.buildRunItem(job, task, row, 'warning', { outputPath: outPath, publishAt: task.publishAt ? task.publishAt.toISOString() : '', publishedPlatforms: [], publishMode: publishEnabled ? 'failed' : 'disabled', finishedAt: nowIso(), attempt: attemptIndex + 1, retryCount: attemptIndex, message: publishEnabled ? '发布失败，但视频已生成' : '成品视频已输出', retryable: publishEnabled }));
            return { status: publishEnabled ? 'failed' : 'completed', retryable: publishEnabled };
          }

          const isStopped = task.__stopped || (this.stopRequested && this.currentTaskId === task.id);
          const status = isStopped ? 'stopped' : 'failed';
          const finalMessage = error.message;
          const retryable = true; // 所有失败/停止的任务都可以重试

          this.setTaskState(task.id, { status, progress: row.progress, step: status === 'failed' ? '失败' : '已取消', message: finalMessage, attempt: attemptIndex + 1, retryCount: attemptIndex, retryLimit });
          this.log(task.id, finalMessage, 'error');

          if (status === 'stopped') runRecord.status = 'stopped';
          runRecord.items.push(this.buildRunItem(job, task, row, status, { message: finalMessage, finishedAt: nowIso(), attempt: attemptIndex + 1, retryCount: attemptIndex, retryable }));

          return { status, retryable };
        } finally {
          // 取消/失败时清理相关服务
          if (task.__stopped || row?.status === 'stopped') {
            try {
              const { shutdownVoicebox } = require('./services/autoDubClient');
              await shutdownVoicebox(this.log).catch(() => {});
              this.log(task.id, '已清理语音克隆服务');
            } catch {}
          }
          if (this.currentTaskId === task.id) {
            this.currentTaskId = '';
            this.stopRequested = false;
          }
        }
      };

      for (const task of tasks) {
        const result = await runSingleTask(task, 0);
        if (result.status === 'failed' && result.retryable) {
          failedTasks.push(task);
        }
      }

      let pendingRetries = failedTasks.slice();
      if (retryLimit > 0 && pendingRetries.length) {
        for (let attempt = 1; attempt <= retryLimit && pendingRetries.length; attempt += 1) {
          this.log('', `开始重试失败任务（${attempt}/${retryLimit}），共 ${pendingRetries.length} 条。`);
          const nextPending = [];
          for (const task of pendingRetries) {
            const result = await runSingleTask(task, attempt);
            if (result.status === 'failed' && result.retryable) {
              nextPending.push(task);
            }
          }
          pendingRetries = nextPending;
        }
      }

      if (runRecord.status === 'completed' && pendingRetries.length) {
        runRecord.status = 'partial_failed';
      }

      // #1: 整批结束后统一清理缓存
      for (const [, tmp] of taskTempFiles) {
        await this.cleanupMainControlCache(tmp.downloadPath, tmp.subtitlePath);
      }
    } catch (error) {
      runRecord.status = 'failed';
      runRecord.items.push({
        userId: job.userId,
        userName: job.userName,
        taskName: '系统',
        status: 'failed',
        message: error.message,
        finishedAt: nowIso()
      });
      this.log('', error.message, 'error');
    } finally {
      // 整批任务结束，关闭 voicebox 和 auto_dub_web 释放内存
      try {
        const { shutdownVoicebox, shutdownAutoDub } = require('./services/autoDubClient');
        await shutdownAutoDub(this.log).catch(() => {});
        await shutdownVoicebox(this.log).catch(() => {});
      } catch {}

      runRecord.endedAt = nowIso();
      // 状态重置优先执行，确保 runner 不会卡死
      this.running = false;
      this.stopRequested = false;
      this.currentTaskId = '';
      this.currentJob = null;

      try {
        await this.store.appendHistoryForUser(job.userId, runRecord);
        if (publishedRecords.length) {
          await this.store.appendPublishedRecordsForUser(job.userId, publishedRecords);
        }
      } catch (e) {
        // 历史记录保存失败不应阻止后续清理
      }

      // #1: 缓存已在上面统一清理
      await this.logWriteChain.catch(() => {});
      this.emitProgress();
      try { await this.onRunDone(runRecord); } catch {}
    }

    return runRecord;
  }

  async executePublishDebug(job) {
    const { task, videoPath } = job.payload;

    try {
      const stat = await fs.stat(videoPath);
      if (!stat.isFile() || stat.size <= 0) {
        throw new Error('empty');
      }
    } catch {
      throw new Error(`调试视频不存在或为空：${videoPath}`);
    }

    this.running = true;
    this.stopRequested = false;
    this.currentTaskId = '';
    this.currentJob = job;
    this.runId = job.runId;
    await this.initRunLog();
    this.progressRows = [{
      id: task.id,
      index: 1,
      userId: job.userId,
      userName: job.userName,
      taskName: task.isOriginal ? '原创' : (task.taskName || path.basename(videoPath)),
      rawLine: task.rawLine || '',
      status: 'pending',
      progress: 0,
      step: '等待执行',
      message: '',
      attempt: 1,
      retryCount: 0,
      retryLimit: 0,
      outputPath: videoPath,
      submittedAt: job.enqueuedAt,
      updatedAt: nowIso()
    }];

    this.emitProgress();

    const runRecord = {
      id: this.runId,
      userId: job.userId,
      userName: job.userName,
      inputText: task.rawLine || '',
      submittedAt: job.enqueuedAt,
      startedAt: nowIso(),
      endedAt: '',
      status: 'completed',
      items: []
    };

    const publishedRecords = [];

    try {
      const settings = await this.store.getSettingsForUser(job.userId);
      this.currentTaskId = task.id;
      this.setTaskState(task.id, {
        status: 'running',
        progress: 70,
        step: '调试发布',
        message: '调试模式：跳过下载、字幕、剪辑',
        attempt: 1,
        retryCount: 0,
        retryLimit: 0
      });
      this.log(task.id, `发布调试模式：直接使用本地视频 ${videoPath}`);

      const publishResult = await this.runStep(
        task,
        'publish',
        () => publishVideo({
          task,
          settings,
          outputPath: videoPath,
          log: (msg) => this.log(task.id, msg)
        }),
        95
      );

      const publishedPlatforms = Array.isArray(publishResult?.platforms) && publishResult.platforms.length
        ? publishResult.platforms
        : (Array.isArray(task.platforms) && task.platforms.length ? task.platforms : ['videoChannel']);

      this.setTaskState(task.id, {
        status: 'completed',
        progress: 100,
        step: '完成',
        message: '发布调试完成',
        attempt: 1,
        retryCount: 0,
        retryLimit: 0,
        outputPath: videoPath
      });

      runRecord.items.push(this.buildRunItem(job, task, this.progressRows[0], 'completed', {
        outputPath: videoPath,
        publishAt: task.publishAt ? task.publishAt.toISOString() : '',
        publishedPlatforms,
        publishMode: `${publishResult?.mode || 'playwright'}:debug`,
        finishedAt: nowIso()
      }));

      publishedRecords.push({
        userId: job.userId,
        userName: job.userName,
        taskName: this.progressRows[0].taskName,
        outputPath: videoPath,
        publishAt: task.publishAt ? task.publishAt.toISOString() : nowIso(),
        publishedPlatforms,
        publishMode: `${publishResult?.mode || 'playwright'}:debug`,
        completedAt: nowIso(),
        runId: this.runId
      });
    } catch (error) {
      const status = this.stopRequested ? 'stopped' : 'failed';
      this.setTaskState(task.id, {
        status,
        progress: this.progressRows[0]?.progress || 70,
        step: status === 'failed' ? '失败' : '停止',
        message: error.message,
        attempt: 1,
        retryCount: 0,
        retryLimit: 0,
        outputPath: videoPath
      });
      this.log(task.id, error.message, 'error');
      runRecord.status = status === 'failed' ? 'failed' : 'stopped';
      runRecord.items.push(this.buildRunItem(job, task, this.progressRows[0], status, {
        message: error.message,
        outputPath: videoPath,
        finishedAt: nowIso()
      }));
    } finally {
      runRecord.endedAt = nowIso();
      await this.store.appendHistoryForUser(job.userId, runRecord);
      if (publishedRecords.length) {
        await this.store.appendPublishedRecordsForUser(job.userId, publishedRecords);
      }
      this.running = false;
      this.stopRequested = false;
      this.currentTaskId = '';
      this.currentJob = null;
      await this.logWriteChain.catch(() => {});
      this.emitProgress();
      await this.onRunDone(runRecord);
    }

    return runRecord;
  }

  async cleanupTempFiles(tempFiles) {
    const uniquePaths = Array.from(new Set(tempFiles));
    for (const targetPath of uniquePaths) {
      try {
        await fs.rm(targetPath, { force: true });
      } catch {
        // noop
      }
    }

    if (!uniquePaths.length) {
      return;
    }

    // Collect all unique parent directories
    const parentDirs = new Set(uniquePaths.map((p) => path.dirname(p)));
    for (const tempDir of parentDirs) {
      try {
        const remain = await fs.readdir(tempDir);
        if (!remain.length) {
          await fs.rm(tempDir, { recursive: true, force: true });
        }
      } catch {
        // noop
      }
    }
  }

  async cleanupStaleCache(cacheDir) {
    // 清理上次崩溃残留的临时文件
    try {
      const entries = await fs.readdir(cacheDir);
      for (const e of entries) {
        if (e.startsWith('.tmp_') || e.endsWith('.part') || e.endsWith('.ytdl') || e.includes('.f') && e.includes('-temp')) {
          const fp = path.join(cacheDir, e);
          try { await fs.rm(fp, { recursive: true, force: true }); } catch {}
        }
      }
    } catch {}
  }

  async cleanupMainControlCache(downloadPath, tmpDir) {
    // 清理下载文件
    if (downloadPath) {
      try { await fs.rm(downloadPath, { force: true }); } catch {}
      // 清理 yt-dlp 的中间分轨文件
      const dir = path.dirname(downloadPath);
      const base = path.basename(downloadPath, path.extname(downloadPath));
      try {
        const entries = await fs.readdir(dir);
        for (const e of entries) {
          if (e.startsWith(base) && e !== path.basename(downloadPath)) {
            await fs.rm(path.join(dir, e), { force: true }).catch(() => {});
          }
        }
      } catch {}
    }
    // 清理 prepareEditVideo 产生的临时目录（帧、SRT 等）
    if (tmpDir) {
      try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}

module.exports = {
  TaskRunner
};
