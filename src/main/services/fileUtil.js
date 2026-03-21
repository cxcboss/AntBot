const fs = require('node:fs/promises');
const path = require('node:path');
const { formatCnDateFolder } = require('./config');

let lastOutputTimestamp = '';
let sameTimestampCount = 0;

function sanitizeName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

async function getDaySequence(tempDir, date = new Date()) {
  await ensureDir(tempDir);
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const files = await fs.readdir(tempDir).catch(() => []);
  const maxIndex = files.reduce((max, file) => {
    const match = file.match(new RegExp(`^${ymd}(\\d{2})-`));
    if (!match) {
      return max;
    }
    return Math.max(max, Number(match[1]));
  }, 0);
  return maxIndex + 1;
}

function buildTaskBaseName(task, sequence, date = new Date()) {
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const seq = String(sequence).padStart(2, '0');
  const namePart = task.isOriginal ? '原创' : sanitizeName(task.taskName);
  return `${ymd}${seq}-${namePart}`;
}

function buildPreciseTimestamp(date = new Date()) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  const base = `${yyyy}${mm}${dd}${hh}${min}${ss}${ms}`;

  if (base === lastOutputTimestamp) {
    sameTimestampCount += 1;
  } else {
    lastOutputTimestamp = base;
    sameTimestampCount = 0;
  }

  const seq = sameTimestampCount > 0 ? String(sameTimestampCount).padStart(2, '0') : '';
  return `${base}${seq}`;
}

function buildOutputPath(outputBaseDir, task, date = new Date(), userName = '') {
  const folderName = formatCnDateFolder(date);
  const userFolder = sanitizeName(String(userName || '').trim() || '默认用户');
  const outDir = path.join(outputBaseDir, userFolder, folderName);
  const preciseTs = buildPreciseTimestamp(new Date());
  const fileName = `${folderName}-${task.isOriginal ? '原创' : sanitizeName(task.taskName)}-${preciseTs}.mp4`;
  return {
    outDir,
    outPath: path.join(outDir, fileName),
    folderName,
    fileName
  };
}

module.exports = {
  sanitizeName,
  ensureDir,
  getDaySequence,
  buildTaskBaseName,
  buildOutputPath
};
