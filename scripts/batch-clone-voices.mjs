/**
 * 批量克隆音色脚本
 * 用法: node scripts/batch-clone-voices.mjs
 *
 * 通过 Electron 主进程的 voiceClone 服务批量克隆音色
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const VOICE_DIR = '/Users/chenxincheng/导出目录/音色';
const REF_TEXT = '生活总在催促我们奔赴前路，我们步履匆匆，追赶时间、奔赴目标，常常在喧嚣里弄丢了平和的自己。其实，人生最珍贵的美好，从不在疾驰的前路，而在细碎温柔的日常里。晨起推开窗，清风裹挟着草木的清香扑面而来，枝头鸟鸣清脆，晨光温柔洒落，驱散一夜的疲惫。午后静坐窗边，泡一杯温热的茶，翻几页闲书，任由时光缓缓流淌。没有琐事的叨扰，没有浮躁的焦虑，这一刻的松弛，便是生活最好的馈赠。';

// 获取所有 MP3 文件
const files = (await fs.readdir(VOICE_DIR))
  .filter(f => f.endsWith('.mp3'))
  .map(f => ({
    name: f.replace('.mp3', '').replace('（内置）', ''),
    path: path.join(VOICE_DIR, f),
  }));

console.log(`找到 ${files.length} 个音色文件\n`);

// 通过 Electron 主进程执行克隆
// 使用 electron 的 IPC 机制
const electronPath = path.resolve('node_modules/.bin/electron');

for (const voice of files) {
  console.log(`\n========== 克隆: ${voice.name} ==========`);
  console.log(`音频: ${voice.path}`);

  // 创建一个临时脚本来执行克隆
  const script = `
    const { app } = require('electron');
    const { runVoiceClone } = require('./src/main/services/voiceClone');
    const store = require('./src/main/services/store');

    app.whenReady().then(async () => {
      try {
        const settings = await store.getSettings();
        const result = await runVoiceClone(
          {
            samplePath: ${JSON.stringify(voice.path)},
            referenceText: ${JSON.stringify(REF_TEXT)},
            profileName: ${JSON.stringify(voice.name)},
            language: 'zh'
          },
          settings,
          {
            log: (msg) => console.log('[LOG]', msg),
            progress: (p) => console.log('[PROGRESS]', JSON.stringify(p))
          }
        );
        console.log('[RESULT]', JSON.stringify(result));
      } catch (e) {
        console.error('[ERROR]', e.message);
      }
      app.quit();
    });
  `;

  const tmpScript = path.join(os.tmpdir(), `clone-${voice.name}.js`);
  await fs.writeFile(tmpScript, script);

  try {
    execSync(`${electronPath} ${tmpScript}`, {
      stdio: 'inherit',
      timeout: 300000, // 5 分钟超时
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    console.log(`✅ ${voice.name} 克隆完成`);
  } catch (e) {
    console.error(`❌ ${voice.name} 克隆失败:`, e.message);
  } finally {
    await fs.unlink(tmpScript).catch(() => {});
  }
}

console.log('\n========== 全部完成 ==========');
// 显示结果
const voicesPath = path.join(os.homedir(), 'AntBot', 'voices.json');
try {
  const voices = JSON.parse(await fs.readFile(voicesPath, 'utf-8'));
  console.log(`共 ${voices.length} 个音色:`);
  voices.forEach(v => console.log(`  - ${v.name} (${v.id})`));
} catch {}
