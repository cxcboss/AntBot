import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cleanupJobArtifacts,
  cleanupStaleRuntimeArtifacts,
  createJobPaths,
} from '../clip-workspace.mjs';

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

test('auto_dub cleanup removes a finished job workspace and returned output copy', async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'antbot-auto-dub-'));
  const workspaceDir = path.join(runtimeDir, 'workspace');
  const outputDir = path.join(runtimeDir, 'outputs');
  const job = createJobPaths({ workspaceDir, outputDir, originalName: '源视频.mp4' });

  await fs.mkdir(job.jobDir, { recursive: true });
  await fs.writeFile(path.join(job.jobDir, 'voice.wav'), 'wav');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(job.outputPath, 'mp4');

  await cleanupJobArtifacts(job);

  assert.equal(await exists(job.jobDir), false);
  assert.equal(await exists(job.outputPath), false);
});

test('auto_dub startup cleanup removes stale runtime artifacts only from its own directories', async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'antbot-auto-dub-stale-'));
  const workspaceDir = path.join(runtimeDir, 'workspace');
  const outputDir = path.join(runtimeDir, 'outputs');
  const unrelatedDir = path.join(runtimeDir, 'models');

  await fs.mkdir(path.join(workspaceDir, 'job-1'), { recursive: true });
  await fs.writeFile(path.join(outputDir, 'old.mp4'), 'mp4', { recursive: true }).catch(async () => {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'old.mp4'), 'mp4');
  });
  await fs.mkdir(unrelatedDir, { recursive: true });
  await fs.writeFile(path.join(unrelatedDir, 'keep.bin'), 'model');

  await cleanupStaleRuntimeArtifacts({ workspaceDir, outputDir });

  assert.deepEqual(await fs.readdir(workspaceDir), []);
  assert.deepEqual(await fs.readdir(outputDir), []);
  assert.equal(await exists(path.join(unrelatedDir, 'keep.bin')), true);
});
