/**
 * 批量克隆音色 — 直接通过 voicebox HTTP API
 * 用法: node scripts/batch-clone.mjs
 */
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const VOICEBOX_PORT = 17493;
const VOICEBOX_URL = `http://127.0.0.1:${VOICEBOX_PORT}`;
const PROJECT_DIR = path.resolve('.');
const VOICE_DIR = '/Users/chenxincheng/导出目录/音色';
const REF_TEXT = '生活总在催促我们奔赴前路，我们步履匆匆，追赶时间、奔赴目标，常常在喧嚣里弄丢了平和的自己。其实，人生最珍贵的美好，从不在疾驰的前路，而在细碎温柔的日常里。晨起推开窗，清风裹挟着草木的清香扑面而来，枝头鸟鸣清脆，晨光温柔洒落，驱散一夜的疲惫。午后静坐窗边，泡一杯温热的茶，翻几页闲书，任由时光缓缓流淌。没有琐事的叨扰，没有浮躁的焦虑，这一刻的松弛，便是生活最好的馈赠。';
const DATA_DIR = path.join(os.homedir(), 'AntBot');
const VOICEBOX_DATA = path.join(DATA_DIR, 'voicebox-data');
const VENV_DIR = path.join(DATA_DIR, 'voicebox-env', '.venv-voicebox');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchApi(endpoint, options = {}) {
  const url = `${VOICEBOX_URL}${endpoint}`;
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

// 启动 voicebox 后端
async function startVoicebox() {
  // 先检查是否已在运行
  try {
    await fetchApi('/profiles', { timeoutMs: 3000 });
    console.log('✅ voicebox 后端已在运行');
    return null;
  } catch {}

  console.log('启动 voicebox 后端...');
  const python = path.join(VENV_DIR, 'bin', 'python');
  const vendorDir = path.join(PROJECT_DIR, 'vendors', 'auto_dub_web', 'vendor', 'voicebox');
  const rootDir = path.join(PROJECT_DIR, 'vendors', 'auto_dub_web');
  const dataDir = VOICEBOX_DATA;
  const modelsDir = path.join(dataDir, 'models');

  try { await fs.access(python); } catch { throw new Error('Python venv 不存在: ' + python); }

  await fs.mkdir(path.join(dataDir, 'profiles'), { recursive: true });
  await fs.mkdir(modelsDir, { recursive: true });

  const child = spawn(python, ['-u', '-m', 'backend.main', '--host', '127.0.0.1', '--port', String(VOICEBOX_PORT), '--data-dir', dataDir], {
    cwd: rootDir,
    env: {
      ...process.env,
      PYTHONPATH: vendorDir + ':' + (process.env.PYTHONPATH || ''),
      VOICEBOX_DATA_DIR: dataDir,
      VOICEBOX_MODELS_DIR: modelsDir,
      PYTHONUNBUFFERED: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', d => {
    const s = d.toString();
    if (s.includes('Uvicorn') || s.includes('startup')) console.log('  voicebox:', s.trim());
  });
  child.stderr.on('data', d => {
    const s = d.toString();
    if (s.includes('ERROR') || s.includes('Traceback') || s.includes('Error')) console.error('  voicebox:', s.trim());
  });

  // 等待就绪
  console.log('等待 voicebox 就绪...');
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    try {
      await fetchApi('/profiles', { timeoutMs: 3000 });
      console.log('✅ voicebox 后端已就绪');
      return child;
    } catch {}
  }
  child.kill();
  throw new Error('voicebox 启动超时');
}

// 裁剪音频到 30 秒
async function trimAudio(inputPath) {
  const outPath = inputPath + '.trimmed.wav';
  try {
    execSync(`ffmpeg -y -i "${inputPath}" -t 30 -ar 24000 -ac 1 "${outPath}"`, { stdio: 'ignore' });
    return outPath;
  } catch {
    return inputPath;
  }
}

// 克隆单个音色
async function cloneVoice(name, audioPath) {
  console.log(`\n[${name}] 创建 profile...`);

  // 1. 创建 profile
  const profile = await fetchApi('/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description: 'AntBot built-in voice', language: 'zh' }),
    timeoutMs: 20000
  });
  console.log(`[${name}] profile 创建成功: ${profile.id}`);

  // 2. 裁剪音频
  const trimmedPath = await trimAudio(audioPath);
  const audioBuffer = await fs.readFile(trimmedPath);

  // 3. 上传样本
  console.log(`[${name}] 上传音频样本 (${(audioBuffer.length / 1024).toFixed(0)}KB)...`);
  const formData = new FormData();
  formData.append('reference_text', REF_TEXT);
  formData.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'ref.wav');

  await fetchApi(`/profiles/${profile.id}/samples`, {
    method: 'POST',
    body: formData,
    timeoutMs: 120000
  });

  // 清理临时文件
  if (trimmedPath !== audioPath) await fs.unlink(trimmedPath).catch(() => {});

  console.log(`[${name}] ✅ 克隆完成`);
  return { id: profile.id, name };
}

// 主流程
const voices = [
  { name: 'TVB女生', file: 'TVB女生（内置）.mp3' },
  { name: '乌萨奇', file: '乌萨奇（内置）.mp3' },
  { name: '奶龙', file: '奶龙（内置）.mp3' },
  { name: '小姐姐', file: '小姐姐（内置）.mp3' },
  { name: '懒羊羊', file: '懒羊羊（内置）.mp3' },
  { name: '曼波', file: '曼波（内置）.mp3' },
  { name: '熊二', file: '熊二（内置）.mp3' },
  { name: '猪妞', file: '猪妞（内置）.mp3' },
  { name: '蜡笔小新', file: '蜡笔小新（内置）.mp3' },
  { name: '解说小帅', file: '解说小帅（内置）.mp3' },
];

let voiceboxProcess = null;
try {
  voiceboxProcess = await startVoicebox();

  const results = [];
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i];
    console.log(`\n========== [${i + 1}/${voices.length}] ${v.name} ==========`);
    try {
      const r = await cloneVoice(v.name, path.join(VOICE_DIR, v.file));
      results.push({ ...r, ok: true });
    } catch (e) {
      console.error(`[${v.name}] ❌ 失败: ${e.message}`);
      results.push({ name: v.name, ok: false, error: e.message });
    }
  }

  // 写入 voices.json
  const voicesPath = path.join(DATA_DIR, 'voices.json');
  let existing = [];
  try { existing = JSON.parse(await fs.readFile(voicesPath, 'utf-8')); } catch {}
  const okResults = results.filter(r => r.ok);
  for (const r of okResults) {
    if (!existing.find(v => v.id === r.id)) {
      existing.push({ id: r.id, name: r.name });
    }
  }
  await fs.writeFile(voicesPath, JSON.stringify(existing, null, 2));

  console.log('\n========== 结果 ==========');
  results.forEach(r => console.log(r.ok ? `✅ ${r.name} (${r.id})` : `❌ ${r.name}: ${r.error}`));
  console.log(`\n共 ${okResults.length}/${voices.length} 个成功，已写入 voices.json`);

} finally {
  if (voiceboxProcess) {
    console.log('\n关闭 voicebox 后端...');
    voiceboxProcess.kill('SIGTERM');
  }
}
