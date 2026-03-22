const fs = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');
const { STEP_NAMES } = require('./services/config');
const { ensureDir, getDaySequence, buildTaskBaseName, buildOutputPath } = require('./services/fileUtil');
const { downloadVideo } = require('./services/downloader');
const { generateSubtitle } = require('./services/gemini');
const { editVideo } = require('./services/editor');
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
  }

  buildRunId() {
    this.jobSequence += 1;
    return `${Date.now()}-${this.jobSequence}`;
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
    if (this.running && this.currentJob?.userId && requestUserId && this.currentJob.userId !== requestUserId) {
      throw new Error(`当前正在执行的是 ${this.currentJob.userName || '其他用户'} 的任务，不能从当前用户停止。`);
    }

    let changed = false;

    if (this.running && this.currentJob?.userId === requestUserId && this.currentTaskId) {
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
      if (row.userId !== requestUserId) {
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
      const task = this.currentJob?.payload?.tasks?.find((item) => item.id === targetId)
        || (this.currentJob?.payload?.task?.id === targetId ? this.currentJob.payload.task : null);
      if (task) {
        task.__stopped = false;
      }
      if (row.status === 'stopped') {
        this.setTaskState(targetId, {
          status: 'pending',
          step: '等待执行',
          message: '已恢复，等待执行'
        });
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
        id: this.buildRunId(),
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
    const queued = this.running;
    let queuePosition = 0;
    const activeQueuedCount = this.getQueuedTaskRows().filter((item) => item.status !== 'stopped').length;

    if (queued) {
      this.queue.push(job);
      queuePosition = activeQueuedCount + job.payload.tasks.filter((task) => !task.__stopped).length;
      this.log('', `收到 ${job.userName} 的新任务，已加入队列（前方还有 ${Math.max(0, activeQueuedCount)} 条）。`);
      this.emitProgress();
    } else {
      void this.runJob(job);
    }

    return {
      queued,
      queuePosition,
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
    const queued = this.running;
    let queuePosition = 0;
    const activeQueuedCount = this.getQueuedTaskRows().filter((item) => item.status !== 'stopped').length;

    if (queued) {
      this.queue.push(job);
      queuePosition = activeQueuedCount + 1;
      this.log('', `${job.userName} 的调试发布已加入队列（前方还有 ${Math.max(0, activeQueuedCount)} 条）。`);
      this.emitProgress();
    } else {
      void this.runJob(job);
    }

    return {
      queued,
      queuePosition,
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
        ? task.publishAt.toISOString()
        : (task.publishAt || '')
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
    const createdTempFiles = [];

    try {
      const settings = await this.store.getSettingsForUser(job.userId);
      await ensureDir(settings.paths.tempDir);
      let sequence = await getDaySequence(settings.paths.tempDir, new Date());
      const retryLimit = Math.max(0, Number(settings?.retry?.failedTaskRetries ?? 0));
      const failedTasks = [];

      this.progressRows = this.progressRows.map((row) => ({
        ...row,
        retryLimit
      }));
      this.emitProgress();

      const runSingleTask = async (task, attemptIndex = 0) => {
        const row = this.progressRows.find((item) => item.id === task.id);
        if (!row) {
          return { status: 'skipped', retryable: false };
        }

        if (task.__stopped) {
          this.setTaskState(task.id, {
            status: 'stopped',
            step: '已停止',
            message: '任务已停止'
          });
          runRecord.status = 'stopped';
          runRecord.items.push(this.buildRunItem(job, task, row, 'stopped', {
            message: '执行前被停止',
            finishedAt: nowIso(),
            attempt: attemptIndex + 1,
            retryCount: attemptIndex,
            retryable: false
          }));
          return { status: 'stopped', retryable: false };
        }

        const expiredPublishMessage = this.getExpiredPublishMessage(task);
        if (expiredPublishMessage) {
          this.setTaskState(task.id, {
            status: 'failed',
            step: '失败',
            message: expiredPublishMessage,
            attempt: attemptIndex + 1,
            retryCount: attemptIndex,
            retryLimit
          });
          this.log(task.id, expiredPublishMessage, 'error');
          runRecord.items.push(this.buildRunItem(job, task, row, 'failed', {
            message: expiredPublishMessage,
            finishedAt: nowIso(),
            attempt: attemptIndex + 1,
            retryCount: attemptIndex,
            retryable: false
          }));
          return { status: 'failed', retryable: false };
        }

        this.currentTaskId = task.id;
        const attemptLabel = attemptIndex > 0 ? `重试中（第${attemptIndex}次）` : '准备执行';
        this.setTaskState(task.id, {
          status: 'running',
          progress: 5,
          step: '准备中',
          message: attemptLabel,
          attempt: attemptIndex + 1,
          retryCount: attemptIndex,
          retryLimit
        });
        if (attemptIndex > 0) {
          this.log(task.id, `开始重试（第${attemptIndex}次）`);
        }

        const taskDate = task.publishAt || new Date();
        const baseName = buildTaskBaseName(task, sequence, taskDate);
        sequence += 1;
        let currentStep = 'prepare';
        let outDir = '';
        let outPath = '';
        const publishEnabled = settings?.publish?.enabled !== false;
        let editCompleted = false;

        try {
          currentStep = 'download';
          const downloadResult = await this.runStep(
            task,
            'download',
            () => downloadVideo({ task, tempDir: settings.paths.tempDir, baseName, settings, log: (msg) => this.log(task.id, msg) }),
            25
          );
          createdTempFiles.push(downloadResult.outputPath);
          const voiceoverEnabled = settings?.style?.voiceoverEnabled !== false;
          const subtitleEnabled = voiceoverEnabled && settings?.style?.subtitleEnabled !== false;
          const needsSubtitleFile = voiceoverEnabled || subtitleEnabled;

          let subtitleResult = { subtitlePath: '' };
          if (needsSubtitleFile) {
            currentStep = 'subtitle';
            subtitleResult = await this.runStep(
              task,
              'subtitle',
              () => generateSubtitle({
                task,
                tempDir: settings.paths.tempDir,
                baseName,
                settings,
                inputVideoPath: downloadResult.outputPath,
                log: (msg) => this.log(task.id, msg)
              }),
              50
            );
            createdTempFiles.push(subtitleResult.subtitlePath);
          } else {
            this.setTaskState(task.id, {
              step: STEP_NAMES.subtitle,
              progress: 50,
              message: '字幕与旁白已关闭，跳过字幕生成'
            });
            this.log(task.id, '字幕生成已跳过（旁白语音关闭）。');
          }

          ({ outDir, outPath } = buildOutputPath(settings.paths.outputBaseDir, task, taskDate, settings.__userName || job.userName));

          currentStep = 'edit';
          const editResult = await this.runStep(
            task,
            'edit',
            () => editVideo({
              task,
              settings,
              inputVideoPath: downloadResult.outputPath,
              subtitlePath: subtitleResult.subtitlePath,
              outputPath: outPath,
              log: (msg) => this.log(task.id, msg)
            }),
            75
          );
          editCompleted = true;
          if (editResult?.voiceClone?.voiceId) {
            const currentVoice = settings.voiceClone || {};
            const nextVoice = {
              ...currentVoice,
              voiceId: editResult.voiceClone.voiceId,
              profileName: editResult.voiceClone.profileName || currentVoice.profileName || '',
              language: editResult.voiceClone.language || currentVoice.language || 'zh'
            };
            settings.voiceClone = await this.store.setVoiceClone(nextVoice);
            if (editResult.voiceClone.recovered) {
              this.log(task.id, `已自动恢复并保存语音档案：${nextVoice.profileName || nextVoice.voiceId}`);
            }
          }

          let publishResult = null;
          if (publishEnabled) {
            currentStep = 'publish';
            publishResult = await this.runStep(
              task,
              'publish',
              () => publishVideo({
                task,
                settings,
                outputPath: outPath,
                log: (msg) => this.log(task.id, msg)
              }),
              95
            );
          } else {
            this.setTaskState(task.id, {
              step: STEP_NAMES.publish,
              progress: 95,
              message: '自动发布已关闭，输出视频即视为完成'
            });
            this.log(task.id, '自动发布已关闭，输出视频已视为任务完成。');
          }

          const publishedPlatforms = publishEnabled && Array.isArray(publishResult?.platforms) && publishResult.platforms.length
            ? publishResult.platforms
            : (publishEnabled && Array.isArray(task.platforms) && task.platforms.length ? task.platforms : []);

          this.setTaskState(task.id, {
            status: 'completed',
            progress: 100,
            step: '完成',
            message: '任务完成',
            attempt: attemptIndex + 1,
            retryCount: attemptIndex,
            retryLimit,
            outputPath: outPath
          });

          runRecord.items.push(this.buildRunItem(job, task, row, 'completed', {
            outputPath: outPath,
            publishAt: task.publishAt ? task.publishAt.toISOString() : '',
            publishedPlatforms,
            publishMode: publishEnabled ? (publishResult?.mode || '') : 'disabled',
            finishedAt: nowIso(),
            attempt: attemptIndex + 1,
            retryCount: attemptIndex
          }));

          if (publishEnabled && publishedPlatforms.length) {
            publishedRecords.push({
              userId: job.userId,
              userName: job.userName,
              taskName: row.taskName,
              outputPath: outPath,
              publishAt: task.publishAt ? task.publishAt.toISOString() : nowIso(),
              publishedPlatforms,
              publishMode: publishResult?.mode || '',
              completedAt: nowIso(),
              runId: this.runId
            });
          }

          await sleep(settings.browser.pauseBetweenTasksMs || 0);
          await ensureDir(outDir);
          return { status: 'completed', retryable: false };
        } catch (error) {
          const outputReady = !publishEnabled && editCompleted && await this.fileExists(outPath);
          if (outputReady) {
            this.setTaskState(task.id, {
              status: 'completed',
              progress: 100,
              step: '完成',
              message: '自动发布已关闭，成品视频已输出',
              attempt: attemptIndex + 1,
              retryCount: attemptIndex,
              retryLimit,
              outputPath: outPath
            });
            runRecord.items.push(this.buildRunItem(job, task, row, 'completed', {
              outputPath: outPath,
              publishAt: task.publishAt ? task.publishAt.toISOString() : '',
              publishedPlatforms: [],
              publishMode: 'disabled',
              finishedAt: nowIso(),
              attempt: attemptIndex + 1,
              retryCount: attemptIndex,
              message: '自动发布已关闭，成品视频已输出'
            }));
            return { status: 'completed', retryable: false };
          }

          const isStopped = task.__stopped || (this.stopRequested && this.currentTaskId === task.id) || /任务已停止/.test(String(error?.message || ''));
          const noRetryEncryptedDownload = currentStep === 'download' && this.isEncryptedDownloadError(error);
          const status = isStopped ? 'stopped' : 'failed';
          const finalMessage = noRetryEncryptedDownload
            ? `${error.message}（已识别为加密视频源，不再自动重试）`
            : error.message;
          const retryable = status === 'failed' && !noRetryEncryptedDownload;

          this.setTaskState(task.id, {
            status,
            progress: row.progress,
            step: status === 'failed' ? '失败' : '停止',
            message: finalMessage,
            attempt: attemptIndex + 1,
            retryCount: attemptIndex,
            retryLimit
          });

          this.log(task.id, finalMessage, 'error');

          if (status === 'stopped') {
            runRecord.status = 'stopped';
          }
          runRecord.items.push(this.buildRunItem(job, task, row, status, {
            message: finalMessage,
            finishedAt: nowIso(),
            attempt: attemptIndex + 1,
            retryCount: attemptIndex,
            retryable
          }));

          return { status, retryable };
        } finally {
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
      runRecord.endedAt = nowIso();
      await this.store.appendHistoryForUser(job.userId, runRecord);
      if (publishedRecords.length) {
        await this.store.appendPublishedRecordsForUser(job.userId, publishedRecords);
      }
      await this.cleanupTempFiles(createdTempFiles);

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

    const tempDir = path.dirname(uniquePaths[0]);
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

module.exports = {
  TaskRunner
};
