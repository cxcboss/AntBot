const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createBridgeQueue } = require('./bridgeQueue');

const { app } = require('electron');

const API_PORT = 18930;
let _server = null;
const bridgeQueue = createBridgeQueue();
const BRIDGE_CAPABILITIES = [
  'publish.start', 'publish.stop', 'publish.getState',
  'browser.getState', 'browser.getTabs', 'browser.navigate',
  'browser.click', 'browser.type', 'browser.select', 'browser.scroll',
  'browser.screenshot', 'browser.eval', 'media.list', 'media.info', 'history.list'
];

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
      // GET /api/bridge/status
      if (method === 'GET' && pathname === '/api/bridge/status') {
        const snapshot = bridgeQueue.snapshot();
        return send(200, { ok: true, name: '搬运蚁发布助手', protocolVersion: 1, status: snapshot.pending.length || snapshot.queued.length ? 'busy' : 'ready', queued: snapshot.queued.length, pending: snapshot.pending.length });
      }
      if (method === 'GET' && pathname === '/api/bridge/capabilities') {
        return send(200, { ok: true, protocolVersion: 1, capabilities: BRIDGE_CAPABILITIES });
      }
      if (method === 'POST' && pathname === '/api/bridge/commands') {
        try {
          const command = bridgeQueue.enqueue(await readBody());
          bridgeQueue.addEvent(command.id, { type: 'accepted', action: command.action, status: 'queued' });
          return send(202, { ok: true, command });
        } catch (error) { return send(400, { ok: false, message: error.message }); }
      }
      if (method === 'GET' && pathname === '/api/bridge/commands/next') {
        const command = bridgeQueue.claim();
        if (!command) { res.writeHead(204); return res.end(); }
        bridgeQueue.addEvent(command.id, { type: 'started', action: command.action, status: 'running' });
        return send(200, { ok: true, command });
      }
      const bridgeMatch = pathname.match(/^\/api\/bridge\/commands\/([^/]+)(?:\/(events|result|cancel))?$/);
      if (bridgeMatch) {
        const id = decodeURIComponent(bridgeMatch[1]);
        if (method === 'GET' && !bridgeMatch[2]) {
          const command = bridgeQueue.get(id);
          if (!command) return send(404, { ok: false, message: '命令不存在' });
          return send(200, { ok: true, command, events: bridgeQueue.events.get(id) || [] });
        }
        if (method === 'POST' && bridgeMatch[2] === 'events') {
          if (!bridgeQueue.get(id)) return send(404, { ok: false, message: '命令不存在' });
          return send(200, { ok: true, event: bridgeQueue.addEvent(id, await readBody()) });
        }
        if (method === 'POST' && bridgeMatch[2] === 'result') {
          const command = bridgeQueue.resolve(id, await readBody());
          if (!command) return send(404, { ok: false, message: '命令不存在' });
          bridgeQueue.addEvent(id, { type: 'result', status: command.status, success: command.result?.success !== false });
          return send(200, { ok: true, command });
        }
        if (method === 'POST' && bridgeMatch[2] === 'cancel') {
          const body = await readBody();
          const command = bridgeQueue.cancel(id, body.reason || '已取消');
          if (!command) return send(404, { ok: false, message: '命令不存在' });
          bridgeQueue.addEvent(id, { type: 'cancelled', status: 'cancelled', reason: body.reason || '已取消' });
          return send(200, { ok: true, command });
        }
      }

      // GET /api/health
      if (method === 'GET' && pathname === '/api/health') {
        return send(200, { ok: true, version: app.getVersion() });
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
          version: app.getVersion(),
          dataDir,
          tasks: tasks.map(t => ({ id: t.id, name: t.name, status: t.status, progress: t.progress, step: t.step, error: t.error, outputPath: t.outputPath })),
          recentLogs: logFiles,
          settings: {
            apiBaseUrl: settings.api?.keys?.[0]?.baseUrl || settings.api?.baseUrl || '',
            hasApiKeys: !!(settings.api?.keys?.length || settings.api?.apiKeys?.length || settings.api?.apiKey),
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
          apiConfig: body.apiConfig || settings.api || {},
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

      send(404, { ok: false, message: `接口不存在: ${method} ${pathname}` });
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
