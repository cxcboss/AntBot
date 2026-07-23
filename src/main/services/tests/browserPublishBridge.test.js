const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createBrowserPublishBridge } = require('../browserPublishBridge');

function startFakeBridge(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('browser publish bridge starts a command and waits for the terminal result', async (t) => {
  let polls = 0;
  const { server, baseUrl } = await startFakeBridge((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/bridge/commands') {
      res.end(JSON.stringify({ ok: true, command: { id: 'publish-1', status: 'queued' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/bridge/commands/publish-1') {
      polls += 1;
      res.end(JSON.stringify(polls < 2
        ? { ok: true, command: { id: 'publish-1', status: 'running' }, events: [{ sequence: 1, step: '上传中' }] }
        : { ok: true, command: { id: 'publish-1', status: 'completed', result: { success: true, platforms: ['douyin'], records: [{ status: 'success' }] } }, events: [] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, message: 'not found' }));
  });
  t.after(() => server.close());

  const events = [];
  const bridge = createBrowserPublishBridge({ baseUrl, pollIntervalMs: 5, timeoutMs: 1000 });
  const result = await bridge.publish({
    videos: [{ name: 'demo.mp4' }],
    settings: {},
    videoPath: '/tmp',
    platform: 'douyin',
    onProgress: event => events.push(event)
  });

  assert.deepEqual(result.platforms, ['douyin']);
  assert.equal(events[0].step, '上传中');
});
