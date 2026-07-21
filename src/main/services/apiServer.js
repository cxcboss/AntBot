const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const API_PORT = 18930;
let _server = null;

function startApiServer({ store, taskRunner, editScheduler, mainWindowRef, appLog }) {
  _server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${API_PORT}`);
    const method = req.method;
    const pathname = url.pathname;

    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    };

    const readBody = () => new Promise((resolve) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({}); }
      });
    });

    try {
      // GET /api/health
      if (method === 'GET' && pathname === '/api/health') {
        return send(200, { ok: true, version: store ? '0.3.6' : 'unknown' });
      }

      // GET /api/status
      if (method === 'GET' && pathname === '/api/status') {
        const settings = store ? await store.getSettings() : {};
        const tasks = editScheduler ? editScheduler.getAllTasks() : [];
        const dataDir = path.join(os.homedir(), 'AntBot');
        let logFiles = [];
        try { logFiles = (await fs.readdir(path.join(dataDir, 'logs'))).filter(f => f.endsWith('.log')).sort().reverse().slice(0, 5); } catch {}
        return send(200, {
          ok: true,
          version: settings?.app?.version || '0.3.6',
          dataDir,
          tasks: tasks.map(t => ({ id: t.id, name: t.name, status: t.status, progress: t.progress, step: t.step, error: t.error, outputPath: t.outputPath })),
          recentLogs: logFiles,
          settings: {
            apiBaseUrl: settings.api?.baseUrl || '',
            hasApiKeys: !!(settings.api?.apiKeys?.length || settings.api?.apiKey),
            frameRate: settings.edit?.frameRate || 1,
            outputDir: settings.paths?.outputBaseDir || '',
          }
        });
      }

      // GET /api/logs - 最新日志内容
      if (method === 'GET' && pathname === '/api/logs') {
        const dataDir = path.join(os.homedir(), 'AntBot');
        const logsDir = path.join(dataDir, 'logs');
        try {
          const files = (await fs.readdir(logsDir)).filter(f => f.endsWith('.log')).sort().reverse();
          const count = parseInt(url.searchParams.get('count')) || 1;
          const results = [];
          for (const f of files.slice(0, count)) {
            const content = await fs.readFile(path.join(logsDir, f), 'utf-8');
            results.push({ filename: f, content });
          }
          return send(200, { ok: true, logs: results });
        } catch (e) { return send(500, { ok: false, message: e.message }); }
      }

      // GET /api/edit-tasks
      if (method === 'GET' && pathname === '/api/edit-tasks') {
        const tasks = editScheduler ? editScheduler.getAllTasks() : [];
        return send(200, { ok: true, tasks });
      }

      // POST /api/edit/start-all
      if (method === 'POST' && pathname === '/api/edit/start-all') {
        if (!editScheduler) return send(500, { ok: false, message: '调度器未初始化' });
        await editScheduler.startAll();
        return send(200, { ok: true });
      }

      // POST /api/edit/start - 添加并启动单个视频任务
      if (method === 'POST' && pathname === '/api/edit/start') {
        const body = await readBody();
        if (!body.videoPath) return send(400, { ok: false, message: '需要 videoPath' });
        const settings = store ? await store.getSettings() : {};
        const t = editScheduler.addTask({
          id: body.id || `api-${Date.now()}`,
          path: body.videoPath,
          name: body.name || path.basename(body.videoPath),
          style: body.style || '',
          voice: body.voice || '',
          subtitle: body.subtitle || '开启',
          voiceProfileId: body.voiceProfileId || settings.voiceClone?.voiceId || '',
          voiceProfileName: body.voiceProfileName || settings.voiceClone?.profileName || '',
          voiceSpeed: body.voiceSpeed || settings.style?.voiceSpeed || 1.1,
          apiConfig: body.apiConfig || { baseUrl: settings.api?.baseUrl, apiKey: settings.api?.apiKey, apiKeys: settings.api?.apiKeys, modelId: settings.api?.modelId },
          outputDir: body.outputDir || settings.paths?.outputBaseDir || '',
          language: body.language || 'zh',
          frameRate: body.frameRate || settings.edit?.frameRate || 1,
        });
        await editScheduler.startTask(t.id);
        appLog('info', `[API] 添加并启动任务: ${t.name}`);
        return send(200, { ok: true, task: t });
      }

      // POST /api/edit/pause
      if (method === 'POST' && pathname === '/api/edit/pause') {
        const body = await readBody();
        if (!body.taskId) return send(400, { ok: false, message: '需要 taskId' });
        editScheduler.pauseTask(body.taskId);
        return send(200, { ok: true });
      }

      // POST /api/edit/cancel
      if (method === 'POST' && pathname === '/api/edit/cancel') {
        const body = await readBody();
        if (!body.taskId) return send(400, { ok: false, message: '需要 taskId' });
        await editScheduler.cancelTask(body.taskId);
        return send(200, { ok: true });
      }

      // POST /api/edit/remove
      if (method === 'POST' && pathname === '/api/edit/remove') {
        const body = await readBody();
        if (!body.taskId) return send(400, { ok: false, message: '需要 taskId' });
        await editScheduler.removeTask(body.taskId);
        return send(200, { ok: true });
      }

      // GET /api/edit-history
      if (method === 'GET' && pathname === '/api/edit-history') {
        const dataDir = path.join(os.homedir(), 'AntBot');
        try {
          const raw = await fs.readFile(path.join(dataDir, 'edit-history.json'), 'utf-8');
          return send(200, { ok: true, history: JSON.parse(raw) });
        } catch { return send(200, { ok: true, history: [] }); }
      }

      // GET /api/settings
      if (method === 'GET' && pathname === '/api/settings') {
        const settings = store ? await store.getSettings() : {};
        return send(200, { ok: true, settings });
      }

      // POST /api/settings
      if (method === 'POST' && pathname === '/api/settings') {
        const body = await readBody();
        if (!store) return send(500, { ok: false });
        const settings = await store.updateSettings(body);
        return send(200, { ok: true, settings });
      }

      // GET /api/voices
      if (method === 'GET' && pathname === '/api/voices') {
        const dataDir = path.join(os.homedir(), 'AntBot');
        try {
          const raw = await fs.readFile(path.join(dataDir, 'voices.json'), 'utf-8');
          return send(200, { ok: true, voices: JSON.parse(raw) });
        } catch { return send(200, { ok: true, voices: [] }); }
      }

      send(404, { ok: false, message: `Not found: ${method} ${pathname}` });
    } catch (err) {
      send(500, { ok: false, message: err.message });
    }
  });

  _server.listen(API_PORT, '127.0.0.1', () => {
    appLog('info', `API 服务已启动: http://127.0.0.1:${API_PORT}/api/`);
  });
}

function stopApiServer() {
  if (_server) { _server.close(); _server = null; }
}

module.exports = { startApiServer, stopApiServer, API_PORT };
