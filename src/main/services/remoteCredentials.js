// 远程控制凭证统一管理：唯一密码来源（登录验证、远程页面改密、autoStart 全部走这里）。
// 密码用 SHA-256 hash 存储（主验证方式）+ Electron safeStorage 加密（仅用于改密时判断密码是否变化）。
// safeStorage 解密失败时 hash 验证仍可正常工作，避免打包后签名变更导致密码失效。
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const CREDS_PATH = path.join(os.homedir(), 'AntBot', 'remote-credentials.json');

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

let _safeStorage = null;

function getSafeStorage() {
  if (_safeStorage === null) {
    try {
      const { safeStorage } = require('electron');
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        _safeStorage = safeStorage;
      } else {
        _safeStorage = false;
      }
    } catch {
      _safeStorage = false;
    }
  }
  return _safeStorage || null;
}

function encryptPassword(plain) {
  const value = String(plain || '');
  if (!value) return { v: 'plain', data: '' };
  const ss = getSafeStorage();
  if (ss) return { v: 'enc', data: ss.encryptString(value).toString('base64') };
  return { v: 'plain', data: value };
}

function decryptPassword(enc) {
  if (!enc || !enc.data) return '';
  if (enc.v === 'enc') {
    const ss = getSafeStorage();
    if (!ss) return '';
    try {
      return ss.decryptString(Buffer.from(enc.data, 'base64'));
    } catch {
      return '';
    }
  }
  return String(enc.data);
}

function ensureDeviceId() {
  return crypto.randomUUID();
}

async function readCreds() {
  try {
    const raw = JSON.parse(await fs.readFile(CREDS_PATH, 'utf-8'));
    const passwordEnc = raw.passwordEnc;
    const password = passwordEnc ? decryptPassword(passwordEnc) : String(raw.password || '');
    const passwordHash = raw.passwordHash || (password ? hashPassword(password) : '');
    return {
      username: raw.username || '',
      password,
      passwordHash,
      deviceName: raw.deviceName || '',
      autoStart: !!raw.autoStart,
      deviceId: raw.deviceId || '',
    };
  } catch {
    return { username: '', password: '', passwordHash: '', deviceName: '', autoStart: false, deviceId: '' };
  }
}

function verifyPassword(inputPassword, storedCreds) {
  const inputHash = hashPassword(inputPassword);

  if (storedCreds.passwordHash && storedCreds.passwordHash === inputHash) {
    return true;
  }

  if (storedCreds.password && storedCreds.password === inputPassword) {
    return true;
  }

  return false;
}

let _writeQueue = Promise.resolve();

async function writeCreds(creds) {
  const task = _writeQueue.then(async () => {
    const dir = path.dirname(CREDS_PATH);
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const current = await readCreds();
    const passwordExplicitlySet = 'password' in creds;
    let newPassword, newHash;
    if (passwordExplicitlySet) {
      newPassword = String(creds.password || '');
      newHash = hashPassword(newPassword);
    } else {
      newHash = current.passwordHash || hashPassword(current.password || '');
      newPassword = current.password || '';
    }
    const payload = {
      username: creds.username || current.username || '',
      passwordEnc: encryptPassword(newPassword),
      passwordHash: newHash,
      deviceName: creds.deviceName || current.deviceName || '',
      autoStart: creds.autoStart !== undefined ? !!creds.autoStart : !!current.autoStart,
      deviceId: creds.deviceId || current.deviceId || ensureDeviceId(),
    };
    await fs.writeFile(CREDS_PATH, JSON.stringify(payload, null, 2), { mode: 0o600 });
    return payload;
  });
  _writeQueue = task.catch(() => {});
  return task;
}

async function getDeviceId() {
  const creds = await readCreds();
  if (creds.deviceId) return creds.deviceId;
  const deviceId = ensureDeviceId();
  await writeCreds({ deviceId });
  return deviceId;
}

module.exports = { readCreds, writeCreds, getDeviceId, verifyPassword, hashPassword, CREDS_PATH };