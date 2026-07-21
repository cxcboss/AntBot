const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createClipArtifactManager,
  reconcileEditTaskCaches,
} = require('../clipArtifacts');

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

test('task cleanup removes only owned clip cache and preserves protected app data', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'antbot-clip-artifacts-'));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'antbot-temp-'));
  const manager = createClipArtifactManager({ dataDir, tempDir });

  const taskDir = manager.getTaskCacheDir('task/one');
  const protectedModelsDir = path.join(dataDir, 'models');
  const protectedVoiceboxModelsDir = path.join(dataDir, 'voicebox-data', 'models');

  await fs.mkdir(path.join(taskDir, 'frames'), { recursive: true });
  await fs.writeFile(path.join(taskDir, 'frames', 'frame_00001.jpg'), 'frame');
  await fs.mkdir(protectedModelsDir, { recursive: true });
  await fs.writeFile(path.join(protectedModelsDir, 'model.bin'), 'model');
  await fs.mkdir(protectedVoiceboxModelsDir, { recursive: true });
  await fs.writeFile(path.join(protectedVoiceboxModelsDir, 'voice-model.bin'), 'model');

  await manager.cleanupTaskCache({ id: 'task/one' });

  assert.equal(await exists(taskDir), false);
  assert.equal(await exists(path.join(protectedModelsDir, 'model.bin')), true);
  assert.equal(await exists(path.join(protectedVoiceboxModelsDir, 'voice-model.bin')), true);
});

test('startup reconciliation cleans terminal and interrupted task caches while preserving valid ready subtitles', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'antbot-reconcile-'));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'antbot-temp-'));
  const manager = createClipArtifactManager({ dataDir, tempDir });

  const failedDir = manager.getTaskCacheDir('failed-task');
  const readyDir = manager.getTaskCacheDir('ready-task');
  const interruptedDir = manager.getTaskCacheDir('interrupted-task');
  const orphanDir = manager.getTaskCacheDir('orphan-task');
  const legacyDir = path.join(tempDir, 'antbot-smart-edit-legacy');

  await fs.mkdir(failedDir, { recursive: true });
  await fs.writeFile(path.join(failedDir, 'voice.wav'), 'wav');
  await fs.mkdir(readyDir, { recursive: true });
  const readySrtPath = path.join(readyDir, 'subtitle.srt');
  await fs.writeFile(readySrtPath, '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
  await fs.mkdir(interruptedDir, { recursive: true });
  await fs.writeFile(path.join(interruptedDir, 'partial.mp4'), 'video');
  await fs.mkdir(orphanDir, { recursive: true });
  await fs.mkdir(legacyDir, { recursive: true });

  const tasks = [
    { id: 'failed-task', status: 'failed', tmpDir: failedDir, srtPath: path.join(failedDir, 'subtitle.srt') },
    { id: 'ready-task', status: 'ready', tmpDir: readyDir, srtPath: readySrtPath },
    { id: 'interrupted-task', status: 'composing', tmpDir: interruptedDir, srtPath: path.join(interruptedDir, 'subtitle.srt'), progress: 70 },
  ];

  const result = await reconcileEditTaskCaches(tasks, { dataDir, tempDir, now: Date.now() });
  const byId = new Map(result.tasks.map((task) => [task.id, task]));

  assert.equal(await exists(failedDir), false);
  assert.equal(await exists(readyDir), true);
  assert.equal(await exists(readySrtPath), true);
  assert.equal(byId.get('ready-task').status, 'ready');
  assert.equal(await exists(interruptedDir), false);
  assert.equal(byId.get('interrupted-task').status, 'pending');
  assert.equal(byId.get('interrupted-task').tmpDir, '');
  assert.equal(byId.get('interrupted-task').srtPath, '');
  assert.equal(byId.get('interrupted-task').progress, 0);
  assert.equal(await exists(orphanDir), false);
  assert.equal(await exists(legacyDir), false);
});
