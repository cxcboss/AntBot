import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function safeFileComponent(name) {
  return String(name || 'input.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function createJobPaths({ workspaceDir, outputDir, originalName = 'input.mp4' }) {
  const jobId = crypto.randomUUID().slice(0, 12);
  const safeName = safeFileComponent(originalName);
  const videoExt = path.extname(safeName).toLowerCase() || '.mp4';
  const outputName = `dubbed_${jobId}.mp4`;
  const jobDir = path.join(workspaceDir, jobId);
  return {
    jobId,
    jobDir,
    outputName,
    outputPath: path.join(outputDir, outputName),
    videoPath: path.join(jobDir, `video${videoExt}`),
    subtitlePath: path.join(jobDir, 'subtitles.srt'),
    voiceTrackPath: path.join(jobDir, 'voiceover.wav'),
    voiceTrackSpedPath: path.join(jobDir, 'voiceover_sped.wav'),
    ttsDir: path.join(jobDir, 'tts'),
    subtitleTextDir: path.join(jobDir, 'subtitle_texts'),
  };
}

export async function cleanupJobArtifacts(job, options = {}) {
  const removeOutput = options.removeOutput !== false;
  if (job?.jobDir) {
    await fs.rm(job.jobDir, { recursive: true, force: true }).catch(() => {});
  }
  if (removeOutput && job?.outputPath) {
    await fs.rm(job.outputPath, { force: true }).catch(() => {});
  }
}

export async function cleanupStaleRuntimeArtifacts({ workspaceDir, outputDir }) {
  for (const dir of [workspaceDir, outputDir]) {
    await fs.mkdir(dir, { recursive: true });
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      await fs.rm(path.join(dir, entry.name), { recursive: true, force: true }).catch(() => {});
    }
  }
}
