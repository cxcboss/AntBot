// 远程控制凭证统一管理：唯一密码来源（登录验证、远程页面改密、autoStart 全部走这里）。
// 密码用 Electron safeStorage 加密存储（macOS Keychain / Windows DPAPI），
// safeStorage 不可用时回退明文并标记 v:'plain'。
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const CREDS_PATH = path.join(os.homedir(), 'AntBot', 'remote-credentials.json');

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
    const password = raw.passwordEnc
      ? decryptPassword(raw.passwordEnc)
      : String(raw.password || ''); // 兼容旧版明文格式
    return {
      username: raw.username || '',
      password,
      deviceName: raw.deviceName || '',
      autoStart: !!raw.autoStart,
      deviceId: raw.deviceId || '',
    };
  } catch {
    return { username: '', password: '', deviceName: '', autoStart: false, deviceId: '' };
  }
}

async function writeCreds(creds) {
  const dir = path.dirname(CREDS_PATH);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const current = await readCreds();
  const merged = { ...current, ...creds };
  const payload = {
    username: merged.username || '',
    passwordEnc: encryptPassword(merged.password || ''),
    deviceName: merged.deviceName || '',
    autoStart: !!merged.autoStart,
    deviceId: merged.deviceId || ensureDeviceId(),
  };
  await fs.writeFile(CREDS_PATH, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return payload;
}

// 获取稳定的设备唯一 ID（不存在则生成并持久化）
async function getDeviceId() {
  const creds = await readCreds();
  if (creds.deviceId) return creds.deviceId;
  const deviceId = ensureDeviceId();
  await writeCreds({ deviceId });
  return deviceId;
}

module.exports = { readCreds, writeCreds, getDeviceId, CREDS_PATH };
