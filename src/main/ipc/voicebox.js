const path = require('node:path');
const os = require('node:os');
const { shell } = require('electron');

// ── Voicebox dependency management ──
async function getVoiceboxVenvPath(store) {
  const fs = require('node:fs/promises');
  const { resolveAutoDubProjectPath } = require('../services/autoDubClient');
  const settings = await store.getSettings();
  const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
  const voiceboxEnvDir = path.join(dataDir, 'voicebox-env');
  const venvDir = path.join(voiceboxEnvDir, '.venv-voicebox');
  const venvPython = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python3');
  const projectPath = await resolveAutoDubProjectPath(settings?.paths?.editProjectPath || '');
  return {
    projectPath: projectPath || '',
    venvDir,
    venvPython,
    markerPath: path.join(voiceboxEnvDir, '.voicebox-setup-done'),
    dataDir: path.join(dataDir, 'voicebox-data')
  };
}

/**
 * Register voicebox:* IPC handlers
 * @param {{ ipcMain: typeof import('electron').ipcMain, store: import('../services/store').StoreService, mainWindowRef: () => import('electron').BrowserWindow|null, appLog: (level: string, msg: string) => void }} deps
 */
function register({ ipcMain, store, mainWindowRef, appLog }) {
  const fs = require('node:fs/promises');

  // ── Voicebox dependency installation with granular progress ──
  const activeVoiceboxAbortControllers = new Map();

  ipcMain.handle('voicebox:check', async () => {
    const { spawn } = require('node:child_process');
    const info = await getVoiceboxVenvPath(store);
    if (!info) return { ok: false, items: [], message: 'auto_dub_web 目录未找到' };

    const items = [];
    const check = (name, pythonCode) => new Promise((resolve) => {
      try {
        const child = spawn(info.venvPython, ['-c', pythonCode], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, windowsHide: true });
        let out = '';
        child.stdout.on('data', d => { out += d.toString(); });
        child.on('close', code => resolve({ name, ok: code === 0, version: out.trim().split('\n')[0].slice(0, 60) }));
        child.on('error', () => resolve({ name, ok: false, version: '' }));
      } catch { resolve({ name, ok: false, version: '' }); }
    });

    // Layer 1: Quick check
    const venvExists = await fs.access(info.venvPython).then(() => true).catch(() => false);
    if (!venvExists) return { ok: false, items: [{ name: '虚拟环境', ok: false, version: '未创建' }], message: 'venv 不存在' };

    // Layer 2: Deep check - import key packages
    const checks = [
      check('Python', 'import sys; print(f"Python {sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}")'),
      check('PyTorch', 'import torch; print(f"torch {torch.__version__}")'),
      check('librosa', 'import librosa; print(f"librosa {librosa.__version__}")'),
      check('soundfile', 'import soundfile; print(f"soundfile {soundfile.__version__}")'),
      check('Qwen TTS', 'import qwen_tts; print("qwen-tts ok")'),
      check('scikit-learn', 'from sklearn.preprocessing import normalize; import sklearn; print(f"sklearn {sklearn.__version__}")'),
      check('transformers', 'import transformers; print(f"transformers {transformers.__version__}")'),
      check('FastAPI', 'import fastapi; print(f"fastapi {fastapi.__version__}")'),
    ];
    const results = await Promise.all(checks);
    const allOk = results.every(r => r.ok);
    return { ok: allOk, items: results, venvPath: info.venvDir, message: allOk ? '所有依赖就绪' : '部分依赖缺失' };
  });

  ipcMain.handle('voicebox:install', async () => {
    const { spawn } = require('node:child_process');
    const { resolveDependencyPath } = require('../services/dependencyManager');
    const { installDependencies } = require('../services/dependencyInstaller');
    const win = mainWindowRef();
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('voicebox:progress', p); };
    const sendDeps = (p) => { if (win && !win.isDestroyed()) win.webContents.send('voicebox:deps-progress', { ...p, timestamp: new Date().toISOString() }); };
    const info = await getVoiceboxVenvPath(store);
    if (!info) return { ok: false, message: '无法获取 voicebox 环境信息' };

    send({ status: 'installing', message: '正在准备安装环境...' });
    appLog('info', '开始安装 voicebox 依赖');

    // 1. 确保 voicebox 源码存在（需要 projectPath）
    const requirementsPath = info.projectPath
      ? path.join(info.projectPath, 'vendor', 'voicebox', 'backend', 'requirements.txt')
      : '';
    const hasReqs = requirementsPath
      ? await fs.access(requirementsPath).then(() => true).catch(() => false)
      : false;
    if (!hasReqs) {
      const setupScript = path.join(info.projectPath, 'scripts', 'setup_voicebox_backend.sh');
      try { await fs.access(setupScript); } catch { return { ok: false, message: '缺少 setup_voicebox_backend.sh 和 requirements.txt' }; }
      send({ status: 'installing', message: '正在下载 voicebox 源码...' });
      const bashBin = await resolveDependencyPath('bash') || 'bash';
      const pythonBin = await resolveDependencyPath('python') || 'python3';
      await new Promise((resolve) => {
        const child = spawn(bashBin, [setupScript], {
          cwd: info.projectPath,
          env: { ...process.env, PYTHON_BIN: pythonBin },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });
        child.stdout.on('data', d => { const m = d.toString().trim(); if (m) send({ status: 'installing', message: m.slice(0, 120) }); });
        child.stderr.on('data', () => {});
        child.on('close', (code) => resolve(code));
        child.on('error', () => resolve(1));
      });
    }

    // 2. 创建 venv（如果不存在）
    const venvExists = await fs.access(info.venvPython).then(() => true).catch(() => false);
    if (!venvExists) {
      send({ status: 'installing', message: '正在创建虚拟环境...' });
      const pythonBin = await resolveDependencyPath('python') || (process.platform === 'win32' ? 'python' : 'python3');
      await new Promise((resolve) => {
        const child = spawn(pythonBin, ['-m', 'venv', info.venvDir], {
          cwd: info.projectPath, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
        });
        let stderr = '';
        child.stderr?.on('data', d => { stderr += d.toString(); });
        child.on('close', (code) => {
          if (code !== 0) send({ status: 'installing', message: `venv 创建失败 (exit ${code}): ${stderr.slice(0, 200)}` });
          resolve();
        });
        child.on('error', (e) => {
          send({ status: 'installing', message: `venv 创建错误: ${e.message}` });
          resolve();
        });
      });
    }

    // 3. 升级 pip + 预装基础依赖
    send({ status: 'installing', message: '正在升级 pip...' });
    await new Promise((resolve) => {
      const child = spawn(info.venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel', 'setuptools', 'huggingface_hub'], {
        cwd: info.projectPath, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
      });
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });

    // 3.5确保基础依赖已安装
    const basePackages = ['huggingface_hub', 'transformers', 'qwen_tts'];
    for (const pkg of basePackages) {
      send({ status: 'installing', message: `检查 ${pkg}...` });
      await new Promise((resolve) => {
        const child = spawn(info.venvPython, ['-m', 'pip', 'install', '-q', pkg], {
          cwd: info.projectPath, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
        });
        child.on('close', () => resolve());
        child.on('error', () => resolve());
      });
    }

    // 4. 逐包安装依赖，发送粒度进度
    const hasReqsNow = await fs.access(requirementsPath).then(() => true).catch(() => false);
    if (!hasReqsNow) {
      send({ status: 'failed', message: 'requirements.txt 不存在' });
      return { ok: false, message: 'requirements.txt 不存在' };
    }

    send({ status: 'installing', message: '开始逐包安装依赖...' });

    const result = await installDependencies({
      venvPython: info.venvPython,
      requirementsPath,
      env: process.env,
      pushEvent: sendDeps,
      abortControllers: activeVoiceboxAbortControllers
    });

    // 4.5 Windows GPU：requirements.txt 装完后再装 CUDA PyTorch（避免被覆盖）
    if (process.platform === 'win32') {
      const fsSync = require('node:fs');
      const logFile = (() => { try {
        const logDir = path.join(os.homedir(), 'AntBot', 'logs');
        const files = fsSync.readdirSync(logDir).filter(f => f.startsWith('app-') && f.endsWith('.log')).sort();
        return files.length ? path.join(logDir, files[files.length - 1]) : null;
      } catch { return null; } })();
      const gpuLog = (msg) => { if (logFile) try { fsSync.appendFileSync(logFile, `[GPU] ${msg}\n`); } catch {} };

      gpuLog('开始 GPU 检测...');
      // 检查 CUDA 是否已可用
      const cudaOk = await new Promise(resolve => {
        const c = spawn(info.venvPython, ['-c', 'import torch; v=torch.cuda.is_available(); print(f"CUDA={v}"); exit(0 if v else 1)'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let out = '';
        c.stdout?.on('data', d => { out += d.toString(); });
        c.on('close', code => { gpuLog(`CUDA检测: exit=${code}, output=${out.trim()}`); resolve(code === 0); });
        c.on('error', e => { gpuLog(`CUDA检测错误: ${e.message}`); resolve(false); });
      });
      if (cudaOk) {
        gpuLog('CUDA 已可用，跳过安装');
        send({ status: 'installing', message: 'GPU (CUDA) 已可用' });
      } else {
        // 检测 NVIDIA GPU
        const gpuName = await new Promise(resolve => {
          const c = spawn('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
          let out = '', err = '';
          c.stdout?.on('data', d => { out += d.toString(); });
          c.stderr?.on('data', d => { err += d.toString(); });
          c.on('close', code => { gpuLog(`nvidia-smi: exit=${code}, gpu="${out.trim()}", err="${err.trim()}"`); resolve(code === 0 ? out.trim() : ''); });
          c.on('error', e => { gpuLog(`nvidia-smi 错误: ${e.message}`); resolve(''); });
        });
        if (gpuName) {
          gpuLog(`检测到 GPU: ${gpuName}，开始安装 CUDA PyTorch...`);
          send({ status: 'installing', message: `检测到 ${gpuName}，正在安装 CUDA PyTorch...` });
          await new Promise((resolve) => {
            const child = spawn(info.venvPython, [
              '-m', 'pip', 'install', 'torch', 'torchaudio',
              '--index-url', 'https://download.pytorch.org/whl/cu121',
              '--force-reinstall', '--no-deps'
            ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            let lastGpuMsg = '';
            const onGpuLine = (chunk) => {
              const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
              const line = lines[lines.length - 1]?.trim();
              if (line && line !== lastGpuMsg) {
                lastGpuMsg = line;
                send({ status: 'installing', message: line.slice(0, 150) });
              }
            };
            child.stdout?.on('data', onGpuLine);
            child.stderr?.on('data', onGpuLine);
            child.on('close', code => { gpuLog(`CUDA PyTorch 安装完成: exit=${code}`); resolve(); });
            child.on('error', e => { gpuLog(`CUDA PyTorch 安装错误: ${e.message}`); resolve(); });
          });
          // 验证安装结果
          const gpuOk = await new Promise(resolve => {
            const c = spawn(info.venvPython, ['-c', 'import torch; print(f"torch={torch.__version__}, cuda={torch.cuda.is_available()}")'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            let out = '';
            c.stdout?.on('data', d => { out += d.toString(); });
            c.on('close', () => { gpuLog(`安装后验证: ${out.trim()}`); resolve(/cuda=True/.test(out)); });
            c.on('error', () => resolve(false));
          });
          send({ status: 'installing', message: gpuOk ? 'GPU 加速已就绪' : 'CUDA PyTorch 安装完成，但 CUDA 不可用，请检查显卡驱动' });
        } else {
          gpuLog('未检测到 NVIDIA GPU');
          send({ status: 'installing', message: '未检测到 NVIDIA GPU，使用 CPU 模式' });
        }
      }
    }

    // 5. 安装完成后验证
    send({ status: 'installing', message: '正在验证安装结果...' });

    const { spawn: spawnCheck } = require('node:child_process');
    const verifyImport = (moduleName) => new Promise((resolve) => {
      try {
        const child = spawnCheck(info.venvPython, ['-c', `import ${moduleName}; print("ok")`], {
          stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, windowsHide: true
        });
        let out = '';
        child.stdout.on('data', d => { out += d.toString(); });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      } catch { resolve(false); }
    });

    const importChecks = [
      ['torch', 'torch'], ['librosa', 'librosa'], ['soundfile', 'soundfile'],
      ['transformers', 'transformers'], ['fastapi', 'fastapi'], ['qwen_tts', 'qwen_tts'],
      ['sklearn', 'sklearn'], ['numpy', 'numpy']
    ];
    const importResults = {};
    for (const [mod, label] of importChecks) {
      importResults[label] = await verifyImport(mod);
    }
    const importFailed = importChecks.filter(([, label]) => !importResults[label]).map(([, label]) => label);
    const pipFailed = result.errors.map(e => e.name);

    await fs.writeFile(info.markerPath, JSON.stringify({ completedAt: new Date().toISOString(), pipFailed, importFailed }), 'utf-8').catch(() => {});

    if (pipFailed.length === 0 && importFailed.length === 0) {
      send({ status: 'completed', message: `全部安装成功（${result.done.length} 个包）` });
      appLog('info', `voicebox 依赖安装完成: ${result.done.length} packages`);
      return { ok: true };
    }

    if (pipFailed.length === 0 && importFailed.length > 0) {
      // pip 说装好了但 import 失败 — 需要重启 app
      send({ status: 'completed', message: `安装完成，部分模块需重启后生效: ${importFailed.join(', ')}` });
      appLog('info', `voicebox 安装完成但需重启: ${importFailed.join(', ')}`);
      return { ok: true, needsRestart: true, restartPackages: importFailed };
    }

    // pip 安装失败的包
    const failedNames = pipFailed.join(', ');
    send({ status: 'failed', message: `以下依赖失败: ${failedNames}` });
    appLog('error', `voicebox 部分依赖安装失败: ${failedNames}`);
    return { ok: false, message: `失败: ${failedNames}`, failedPackages: pipFailed };
  });

  ipcMain.handle('voicebox:install-cancel', async (_event, packageName) => {
    if (packageName) {
      const ctrl = activeVoiceboxAbortControllers.get(packageName);
      if (ctrl) { ctrl.abort(); return { ok: true }; }
      return { ok: false };
    }
    for (const [, ctrl] of activeVoiceboxAbortControllers) ctrl.abort();
    return { ok: true };
  });

  // Windows GPU：独立安装 CUDA PyTorch
  ipcMain.handle('voicebox:install-gpu', async () => {
    if (process.platform !== 'win32') return { ok: false, message: '仅支持 Windows' };
    const { spawn: sp } = require('node:child_process');
    const { resolveDependencyPath } = require('../services/dependencyManager');
    const info = await getVoiceboxVenvPath(store);
    if (!info) return { ok: false, message: 'venv 不存在，请先安装依赖' };
    const win = mainWindowRef();
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('voicebox:progress', p); };

    // 检测 GPU
    send({ status: 'installing', message: '正在检测显卡...' });
    const gpuName = await new Promise(resolve => {
      const c = sp('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      c.stdout?.on('data', d => { out += d.toString(); });
      c.on('close', code => resolve(code === 0 ? out.trim() : ''));
      c.on('error', () => resolve(''));
    });
    if (!gpuName) return { ok: false, message: '未检测到 NVIDIA 显卡' };

    send({ status: 'installing', message: `检测到 ${gpuName}，正在下载 CUDA PyTorch（约2GB）...` });
    const exitCode = await new Promise(resolve => {
      const c = sp(info.venvPython, [
        '-m', 'pip', 'install', 'torch', 'torchaudio',
        '--index-url', 'https://download.pytorch.org/whl/cu121',
        '--force-reinstall', '--no-deps'
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let lastMsg = '';
      const onLine = (chunk) => {
        // pip 进度用 \r 覆盖同一行，取最后一段
        const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
        const line = lines[lines.length - 1]?.trim();
        if (line && line !== lastMsg) {
          lastMsg = line;
          send({ status: 'installing', message: line.slice(0, 150) });
        }
      };
      c.stdout?.on('data', onLine);
      c.stderr?.on('data', onLine);
      c.on('close', code => resolve(code));
      c.on('error', () => resolve(1));
    });
    if (exitCode !== 0) return { ok: false, message: '安装失败，请检查网络' };

    // 验证
    const gpuOk = await new Promise(resolve => {
      const c = sp(info.venvPython, ['-c', 'import torch; print(torch.cuda.is_available())'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      c.stdout?.on('data', d => { out += d.toString(); });
      c.on('close', () => resolve(out.trim() === 'True'));
      c.on('error', () => resolve(false));
    });
    return gpuOk
      ? { ok: true, message: `${gpuName} GPU 加速已就绪` }
      : { ok: false, message: '安装完成但 CUDA 不可用，请更新显卡驱动后重试' };
  });

  ipcMain.handle('voicebox:open-dir', async () => {
    const info = await getVoiceboxVenvPath(store);
    if (info?.venvDir) {
      await fs.mkdir(info.venvDir, { recursive: true }).catch(() => {});
      await shell.openPath(info.venvDir);
      return { path: info.venvDir };
    }
    return { path: '' };
  });

  ipcMain.handle('voicebox:reset', async () => {
    const info = await getVoiceboxVenvPath(store);
    if (!info) return { ok: false, message: 'auto_dub_web 目录未找到' };
    // Remove marker and venv
    await fs.rm(info.markerPath, { force: true }).catch(() => {});
    await fs.rm(info.venvDir, { recursive: true, force: true }).catch(() => {});
    appLog('info', 'voicebox 环境已重置');
    return { ok: true };
  });
}

module.exports = { register };
