const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * 解析 requirements.txt 为包列表
 */
async function parseRequirements(requirementsPath) {
  const content = await fs.readFile(requirementsPath, 'utf8');
  const packages = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const match = line.match(/^([a-zA-Z0-9_.-]+)\s*(.*)/);
    if (match) {
      packages.push({
        name: match[1].toLowerCase().replace(/[-_.]+/g, '-'),
        rawName: match[1],
        constraint: match[2].trim()
      });
    }
  }
  return packages;
}

/**
 * 检查包是否已安装
 */
async function isPackageInstalled(venvPython, packageName) {
  return new Promise((resolve) => {
    const child = spawn(venvPython, ['-m', 'pip', 'show', packageName], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true
    });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

/**
 * 从 pip stderr 行中解析下载进度
 */
function parsePipProgressLine(line) {
  const result = { percent: -1, speed: '', size: '' };
  const percentMatch = line.match(/(\d+)%/);
  if (percentMatch) result.percent = parseInt(percentMatch[1], 10);
  const speedMatches = [...line.matchAll(/(\d+\.?\d*)\s*([kKmMgG][bB])\/s/g)];
  if (speedMatches.length > 0) {
    const last = speedMatches[speedMatches.length - 1];
    result.speed = `${last[1]} ${last[2].toUpperCase()}/s`;
  }
  const sizeMatch = line.match(/(\d+\.?\d*)\s*([kKmMgG][bB])\s*\/\s*(\d+\.?\d*)\s*([kKmMgG][bB])/);
  if (sizeMatch) result.size = `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()} / ${sizeMatch[3]} ${sizeMatch[4].toUpperCase()}`;
  return result;
}

/**
 * 安装单个包，支持进度解析和取消
 */
function installSinglePackage(venvPython, pkg, env, pushEvent, abortSignal) {
  return new Promise((resolve) => {
    const spec = pkg.constraint ? `${pkg.rawName}${pkg.constraint}` : pkg.rawName;
    pushEvent({ type: 'package-start', name: pkg.rawName, normalizedName: pkg.name, constraint: pkg.constraint, percent: 0, speed: '', size: '', message: `准备安装 ${pkg.rawName}...` });

    const child = spawn(venvPython, ['-u', '-m', 'pip', 'install', '--no-cache-dir', '--progress-bar', 'on', '--timeout', '60', '--retries', '5', spec], {
      env: { ...env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let killed = false;
    let timedOut = false;
    const onAbort = () => { killed = true; try { child.kill('SIGTERM'); } catch {} };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    // 单包安装最长 60 分钟（大模型包下载慢），超时强制结束，避免 UI 无限等待
    const TIMEOUT_MS = 60 * 60 * 1000;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
    }, TIMEOUT_MS);
    timeoutTimer.unref?.();

    let lastPercent = -1;
    let stderrBuffer = '';

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Requirement already satisfied')) return;

      // "Collecting torch>=2.1.0" — pip 正在处理这个包
      if (trimmed.startsWith('Collecting ')) {
        pushEvent({ type: 'package-progress', name: pkg.rawName, normalizedName: pkg.name, constraint: pkg.constraint, percent: Math.max(lastPercent, 5), speed: '', size: '', message: '正在下载...' });
        return;
      }

      const progress = parsePipProgressLine(trimmed);
      if (progress.percent >= 0 || progress.speed || progress.size) {
        const percent = Math.max(0, Math.min(100, progress.percent >= 0 ? progress.percent : lastPercent));
        if (progress.percent >= 0) lastPercent = progress.percent;
        pushEvent({ type: 'package-progress', name: pkg.rawName, normalizedName: pkg.name, constraint: pkg.constraint, percent, speed: progress.speed, size: progress.size, message: progress.speed ? `下载中 ${progress.speed}` : (progress.size ? `下载中 ${progress.size}` : '处理中...') });
        return;
      }
      if (trimmed.includes('Installing collected packages') || trimmed.includes('Installing')) {
        pushEvent({ type: 'package-progress', name: pkg.rawName, normalizedName: pkg.name, constraint: pkg.constraint, percent: 90, speed: '', size: '', message: '正在安装...' });
        return;
      }
      if (trimmed.includes('Using cached')) {
        pushEvent({ type: 'package-progress', name: pkg.rawName, normalizedName: pkg.name, constraint: pkg.constraint, percent: 50, speed: '', size: '', message: '使用缓存...' });
      }
    };

    child.stderr.on('data', (chunk) => {
      // pip 用 \r 做进度条原地更新，需要按 \r 和 \n 都拆行
      stderrBuffer += chunk.toString('utf8');
      const lines = stderrBuffer.split(/\r\n|\r|\n/);
      stderrBuffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    });

    child.once('error', (error) => {
      clearTimeout(timeoutTimer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      if (killed) {
        pushEvent({ type: 'package-cancelled', name: pkg.rawName, normalizedName: pkg.name, constraint: pkg.constraint, percent: 0, speed: '', size: '', message: '已取消' });
        resolve({ status: 'cancelled', name: pkg.rawName });
      } else {
        const msg = `启动失败: ${error?.message || error}`;
        pushEvent({ type: 'package-error', name: pkg.rawName, normalizedName: pkg.name, constraint: pkg.constraint, percent: 0, speed: '', size: '', message: msg });
        resolve({ status: 'error', name: pkg.rawName, error: msg });
      }
    });

    child.once('close', (code) => {
      clearTimeout(timeoutTimer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      if (stderrBuffer.trim()) processLine(stderrBuffer);
      if (killed) {
        pushEvent({ type: 'package-cancelled', name: pkg.rawName, normalizedName: pkg.name, constraint: pkg.constraint, percent: 0, speed: '', size: '', message: '已取消' });
        resolve({ status: 'cancelled', name: pkg.rawName });
        return;
      }
      if (timedOut) {
        const msg = `安装超时（超过 60 分钟），已强制终止`;
        pushEvent({ type: 'package-error', name: pkg.rawName, normalizedName: pkg.name, constraint: pkg.constraint, percent: 0, speed: '', size: '', message: msg });
        resolve({ status: 'error', name: pkg.rawName, error: msg });
        return;
      }
      if (code === 0) {
        pushEvent({ type: 'package-done', name: pkg.rawName, normalizedName: pkg.name, constraint: pkg.constraint, percent: 100, speed: '', size: '', message: '安装完成' });
        resolve({ status: 'done', name: pkg.rawName });
      } else {
        const errorLines = stderrBuffer ? stderrBuffer.split(/\r?\n/).filter(Boolean).slice(-5).join('\n') : `pip exit code ${code}`;
        pushEvent({ type: 'package-error', name: pkg.rawName, normalizedName: pkg.name, constraint: pkg.constraint, percent: 0, speed: '', size: '', message: errorLines || '安装失败' });
        resolve({ status: 'error', name: pkg.rawName, error: errorLines });
      }
    });
  });
}

/**
 * 逐包安装所有依赖
 */
async function installDependencies({ venvPython, requirementsPath, env, pushEvent, abortControllers }) {
  const packages = await parseRequirements(requirementsPath);
  if (!packages.length) return { done: [], errors: [], cancelled: [] };

  const done = [];
  const errors = [];
  const cancelled = [];

  for (const pkg of packages) {
    const globalCtrl = abortControllers?.get('__global__');
    if (globalCtrl?.signal.aborted) {
      cancelled.push(pkg.rawName);
      pushEvent({ type: 'package-cancelled', name: pkg.rawName, normalizedName: pkg.name, constraint: pkg.constraint, percent: 0, speed: '', size: '', message: '已取消' });
      continue;
    }

    const installed = await isPackageInstalled(venvPython, pkg.rawName);
    if (installed) {
      pushEvent({ type: 'package-done', name: pkg.rawName, normalizedName: pkg.name, constraint: pkg.constraint, percent: 100, speed: '', size: '', message: '已安装' });
      done.push(pkg.rawName);
      continue;
    }

    const abortCtrl = new AbortController();
    if (abortControllers) abortControllers.set(pkg.rawName, abortCtrl);

    const result = await installSinglePackage(venvPython, pkg, env, pushEvent, abortCtrl.signal);

    if (abortControllers) abortControllers.delete(pkg.rawName);
    if (result.status === 'done') done.push(pkg.rawName);
    else if (result.status === 'cancelled') cancelled.push(pkg.rawName);
    else errors.push({ name: pkg.rawName, error: result.error || '未知错误' });
  }

  pushEvent({ type: 'all-done', name: '', normalizedName: '', constraint: '', percent: 100, speed: '', size: '', message: `安装完成：${done.length} 成功，${errors.length} 失败，${cancelled.length} 取消` });
  return { done, errors, cancelled };
}

module.exports = { parseRequirements, isPackageInstalled, installDependencies, installSinglePackage };
