const fs = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');
const { buildDefaultSettings, getSettingsOverridesFromEnv } = require('./config');

const STORE_FILE = 'antbot-store.json';
const STORE_SCHEMA_VERSION = 6;
const DEFAULT_USER_ID = 'user-1';
const DEFAULT_USER_NAME = '蚂蚁1';
const DEFAULT_GEMINI_PROFILE_ID = 'default';
const DEFAULT_GEMINI_PROFILE_NAME = '默认 Gemini';
const MAX_USERS = 5;
const AVAILABLE_AVATAR_IDS = [1, 2, 3, 4, 5];
const LEGACY_SUBTITLE_TEXT_COLORS = new Set(['', '#FFDD00']);
const LEGACY_SUBTITLE_STROKE_COLORS = new Set(['', '#FFFFFF']);

function nowIso() {
  return new Date().toISOString();
}

function deepMerge(target, source) {
  if (typeof source !== 'object' || source === null) {
    return target;
  }

  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      target[key] = value.slice();
      continue;
    }

    if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      deepMerge(target[key], value);
      continue;
    }

    target[key] = value;
  }

  return target;
}

function clone(value) {
  return structuredClone(value);
}

function buildDefaultLoginState() {
  return {
    videoChannel: { loggedIn: false, checkedAt: '' },
    douyin: { loggedIn: false, checkedAt: '' },
    gemini: { loggedIn: false, checkedAt: '' }
  };
}

function buildSharedLoginState(seed = {}) {
  return deepMerge({
    gemini: { loggedIn: false, checkedAt: '' }
  }, seed || {});
}

function normalizeGeminiProfileId(value, fallback = DEFAULT_GEMINI_PROFILE_ID) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return raw || fallback;
}

function sanitizeGeminiProfileName(name, fallback = DEFAULT_GEMINI_PROFILE_NAME) {
  const value = String(name || '').replace(/\s+/g, ' ').trim();
  return value || fallback;
}

function sanitizeUserName(name, fallback = DEFAULT_USER_NAME) {
  const value = String(name || '').replace(/\s+/g, ' ').trim();
  return value || fallback;
}

function normalizeUserId(value, fallbackIndex = 1) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return raw || `user-${fallbackIndex}`;
}

function normalizeAvatarId(value) {
  const numeric = Number(value);
  return AVAILABLE_AVATAR_IDS.includes(numeric) ? numeric : null;
}

function pickAvailableAvatarId(users = [], preferredId = null) {
  const preferred = normalizeAvatarId(preferredId);
  const used = new Set(
    (users || [])
      .map((user) => normalizeAvatarId(user?.avatarId))
      .filter(Boolean)
  );

  if (preferred && !used.has(preferred)) {
    return preferred;
  }

  for (const avatarId of AVAILABLE_AVATAR_IDS) {
    if (!used.has(avatarId)) {
      return avatarId;
    }
  }

  return AVAILABLE_AVATAR_IDS[0];
}

function buildSharedVoiceClone(seed = {}) {
  return deepMerge(clone(buildDefaultSettings().voiceClone || {}), seed || {});
}

function buildSharedRemote(seed = {}) {
  return deepMerge({
    ...clone(buildDefaultSettings().remote || {}),
    password: ''
  }, seed || {});
}

function buildSharedSystem(seed = {}) {
  return deepMerge(clone(buildDefaultSettings().system || {}), seed || {});
}

function buildUserProfileSettingsOverrides(seed = {}, geminiProfiles = buildGeminiProfiles()) {
  const result = {};

  if (seed.retry && typeof seed.retry === 'object') {
    result.retry = clone(seed.retry);
  }
  if (seed.publish && typeof seed.publish === 'object') {
    result.publish = clone(seed.publish);
  }
  if (seed.style && typeof seed.style === 'object') {
    result.style = clone(seed.style);
  }
  if (seed.voiceClone && typeof seed.voiceClone === 'object') {
    result.voiceClone = clone(seed.voiceClone);
  }
  if (typeof seed.geminiProfileId === 'string') {
    result.geminiProfileId = resolveGeminiProfileId(seed.geminiProfileId, geminiProfiles);
  }

  return result;
}

function buildGeminiProfile(seed = {}, fallbackId = DEFAULT_GEMINI_PROFILE_ID) {
  return {
    id: normalizeGeminiProfileId(seed.id, fallbackId),
    name: sanitizeGeminiProfileName(seed.name, DEFAULT_GEMINI_PROFILE_NAME),
    loggedIn: Boolean(seed.loggedIn),
    checkedAt: String(seed.checkedAt || ''),
    createdAt: String(seed.createdAt || nowIso()),
    updatedAt: String(seed.updatedAt || nowIso())
  };
}

function buildGeminiProfiles(seed = [], loginState = {}) {
  const profiles = Array.isArray(seed) ? seed : [];
  const seenIds = new Set();
  const result = [];

  for (const [index, item] of profiles.entries()) {
    const profile = buildGeminiProfile(item, index === 0 ? DEFAULT_GEMINI_PROFILE_ID : `gemini-${index + 1}`);
    if (seenIds.has(profile.id)) {
      profile.id = normalizeGeminiProfileId(`${profile.id}-${index + 1}`, `gemini-${index + 1}`);
    }
    seenIds.add(profile.id);
    result.push(profile);
  }

  if (!result.length) {
    result.push(buildGeminiProfile({
      id: DEFAULT_GEMINI_PROFILE_ID,
      name: DEFAULT_GEMINI_PROFILE_NAME,
      loggedIn: Boolean(loginState?.loggedIn),
      checkedAt: loginState?.checkedAt || ''
    }));
  }

  if (!result.some((item) => item.id === DEFAULT_GEMINI_PROFILE_ID)) {
    result.unshift(buildGeminiProfile({
      id: DEFAULT_GEMINI_PROFILE_ID,
      name: DEFAULT_GEMINI_PROFILE_NAME,
      loggedIn: Boolean(loginState?.loggedIn),
      checkedAt: loginState?.checkedAt || ''
    }));
  }

  return result;
}

function resolveGeminiProfileId(profileId, geminiProfiles = []) {
  const normalized = normalizeGeminiProfileId(profileId, DEFAULT_GEMINI_PROFILE_ID);
  return geminiProfiles.some((item) => item.id === normalized)
    ? normalized
    : DEFAULT_GEMINI_PROFILE_ID;
}

function buildUserSettings(
  seed = {},
  sharedVoiceClone = buildSharedVoiceClone(),
  sharedRemote = buildSharedRemote(),
  sharedSystem = buildSharedSystem(),
  geminiProfiles = buildGeminiProfiles()
) {
  const settings = deepMerge(buildDefaultSettings(), seed || {});
  settings.voiceClone = deepMerge(clone(sharedVoiceClone), settings.voiceClone || {});
  settings.remote = deepMerge(clone(sharedRemote), settings.remote || {});
  settings.system = deepMerge(clone(sharedSystem), settings.system || {});
  settings.remote.password = '';
  settings.geminiProfileId = resolveGeminiProfileId(settings.geminiProfileId, geminiProfiles);
  return settings;
}

function buildUserRecord(seed = {}, options = {}) {
  const sharedVoiceClone = options.sharedVoiceClone || buildSharedVoiceClone();
  const sharedRemote = options.sharedRemote || buildSharedRemote();
  const sharedSystem = options.sharedSystem || buildSharedSystem();
  const geminiProfiles = options.geminiProfiles || buildGeminiProfiles();
  return {
    id: normalizeUserId(seed.id, options.index || 1),
    name: sanitizeUserName(seed.name, options.defaultName || DEFAULT_USER_NAME),
    avatarId: normalizeAvatarId(seed.avatarId) || options.avatarId || AVAILABLE_AVATAR_IDS[0],
    settings: buildUserSettings(
      seed.settings || {},
      sharedVoiceClone,
      sharedRemote,
      sharedSystem,
      geminiProfiles
    ),
    profileSettingsEnabled: Boolean(seed.profileSettingsEnabled),
    profileSettingsOverrides: buildUserProfileSettingsOverrides(
      seed.profileSettingsOverrides || {},
      geminiProfiles
    ),
    history: Array.isArray(seed.history) ? seed.history.slice(0, 200) : [],
    publishedRecords: Array.isArray(seed.publishedRecords) ? seed.publishedRecords.slice(0, 500) : [],
    loginState: deepMerge(buildDefaultLoginState(), seed.loginState || {}),
    createdAt: String(seed.createdAt || nowIso()),
    updatedAt: String(seed.updatedAt || nowIso())
  };
}

function buildDefaultState() {
  const sharedVoiceClone = buildSharedVoiceClone();
  const sharedLoginState = buildSharedLoginState();
  const sharedRemote = buildSharedRemote();
  const sharedSystem = buildSharedSystem();
  const geminiProfiles = buildGeminiProfiles([], sharedLoginState.gemini);
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    activeUserId: DEFAULT_USER_ID,
    sharedVoiceClone,
    sharedRemote,
    sharedSystem,
    sharedLoginState,
    geminiProfiles,
    users: [
      buildUserRecord({
        id: DEFAULT_USER_ID,
        name: DEFAULT_USER_NAME,
        settings: buildDefaultSettings()
      }, {
        index: 1,
        sharedVoiceClone,
        sharedRemote,
        sharedSystem,
        geminiProfiles,
        avatarId: AVAILABLE_AVATAR_IDS[0]
      })
    ]
  };
}

function normalizeState(seed = {}) {
  if (Array.isArray(seed.users) && seed.users.length) {
    const sharedVoiceClone = buildSharedVoiceClone(
      seed.sharedVoiceClone
      || seed.settings?.voiceClone
      || seed.users.find((user) => user?.settings?.voiceClone)?.settings?.voiceClone
      || {}
    );
    const sharedLoginState = buildSharedLoginState(
      seed.sharedLoginState
      || (seed.loginState?.gemini ? { gemini: seed.loginState.gemini } : null)
      || (seed.users.find((user) => user?.loginState?.gemini)?.loginState
        ? { gemini: seed.users.find((user) => user?.loginState?.gemini).loginState.gemini }
        : null)
      || {}
    );
    const sharedRemote = buildSharedRemote(
      seed.sharedRemote
      || seed.settings?.remote
      || seed.users.find((user) => user?.settings?.remote)?.settings?.remote
      || {}
    );
    const sharedSystem = buildSharedSystem(
      seed.sharedSystem
      || seed.settings?.system
      || seed.users.find((user) => user?.settings?.system)?.settings?.system
      || {}
    );
    const geminiProfiles = buildGeminiProfiles(seed.geminiProfiles, sharedLoginState.gemini);

    const seenIds = new Set();
    const avatarSeed = [];
    const users = seed.users.map((user, index) => {
      const normalized = buildUserRecord(user, {
        index: index + 1,
        sharedVoiceClone,
        sharedRemote,
        sharedSystem,
        geminiProfiles,
        defaultName: `蚂蚁${index + 1}`,
        avatarId: pickAvailableAvatarId(avatarSeed, user?.avatarId)
      });

      if (seenIds.has(normalized.id)) {
        normalized.id = normalizeUserId(`${normalized.id}-${index + 1}`, index + 1);
      }
      seenIds.add(normalized.id);
      avatarSeed.push(normalized);
      return normalized;
    });

    const activeUserId = users.some((user) => user.id === seed.activeUserId)
      ? seed.activeUserId
      : users[0].id;

    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      activeUserId,
      sharedVoiceClone,
      sharedRemote,
      sharedSystem,
      sharedLoginState,
      geminiProfiles,
      users
    };
  }

  const legacySettings = deepMerge(buildDefaultSettings(), seed.settings || {});
  const sharedVoiceClone = buildSharedVoiceClone(legacySettings.voiceClone || {});
  const sharedLoginState = buildSharedLoginState(seed.loginState?.gemini ? { gemini: seed.loginState.gemini } : {});
  const sharedRemote = buildSharedRemote(legacySettings.remote || {});
  const sharedSystem = buildSharedSystem(legacySettings.system || {});
  const geminiProfiles = buildGeminiProfiles(seed.geminiProfiles, sharedLoginState.gemini);
  const migratedUser = buildUserRecord({
    id: DEFAULT_USER_ID,
    name: DEFAULT_USER_NAME,
    settings: legacySettings,
    history: seed.history,
    publishedRecords: seed.publishedRecords,
    loginState: seed.loginState
  }, {
    index: 1,
    sharedVoiceClone,
    sharedRemote,
    sharedSystem,
    geminiProfiles,
    avatarId: AVAILABLE_AVATAR_IDS[0]
  });

  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    activeUserId: migratedUser.id,
    sharedVoiceClone,
    sharedRemote,
    sharedSystem,
    sharedLoginState,
    geminiProfiles,
    users: [migratedUser]
  };
}

class StoreService {
  constructor() {
    this.filePath = path.join(app.getPath('userData'), STORE_FILE);
    this.state = buildDefaultState();
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.loaded) {
      return this.state;
    }

    let changed = false;
    let loadedSchemaVersion = STORE_SCHEMA_VERSION;

    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      try {
        const parsed = JSON.parse(raw);
        loadedSchemaVersion = Number(parsed?.schemaVersion || 0) || 0;
        this.state = normalizeState(parsed);
        changed = JSON.stringify(parsed?.schemaVersion || null) !== JSON.stringify(STORE_SCHEMA_VERSION);
      } catch (parseError) {
        await this.backupCorruptedStore(raw, parseError);
        this.state = buildDefaultState();
        changed = true;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      this.state = buildDefaultState();
      changed = true;
    }

    this.syncSharedVoiceCloneToUsers();
    this.syncSharedRemoteToUsers();
    this.syncSharedSystemToUsers();
    this.syncSharedLoginStateToUsers();
    changed = this.ensureStateIntegrity() || changed;
    changed = this.applyEnvOverrides() || changed;
    changed = this.migrateLegacySettings() || changed;
    changed = this.migrateSharedRemoteSettings() || changed;
    changed = this.migrateSchemaDefaults(loadedSchemaVersion) || changed;

    if (changed) {
      await this.persist();
    }

    this.loaded = true;
    return this.state;
  }

  ensureStateIntegrity() {
    let changed = false;

    if (!Array.isArray(this.state.users) || !this.state.users.length) {
      this.state = buildDefaultState();
      return true;
    }

    this.state.sharedLoginState = buildSharedLoginState(this.state.sharedLoginState || {});
    this.state.sharedRemote = buildSharedRemote(this.state.sharedRemote || {});
    this.state.sharedSystem = buildSharedSystem(this.state.sharedSystem || {});
    this.state.geminiProfiles = buildGeminiProfiles(this.state.geminiProfiles, this.state.sharedLoginState.gemini);

    const seenIds = new Set();
    const avatarSeed = [];
    this.state.users = this.state.users.map((user, index) => {
      const next = buildUserRecord(user, {
        index: index + 1,
        sharedVoiceClone: this.state.sharedVoiceClone,
        sharedRemote: this.state.sharedRemote,
        sharedSystem: this.state.sharedSystem,
        geminiProfiles: this.state.geminiProfiles,
        defaultName: `蚂蚁${index + 1}`,
        avatarId: pickAvailableAvatarId(avatarSeed, user?.avatarId)
      });
      if (seenIds.has(next.id)) {
        next.id = normalizeUserId(`${next.id}-${index + 1}`, index + 1);
        changed = true;
      }
      seenIds.add(next.id);
      avatarSeed.push(next);
      return next;
    });

    if (!this.state.users.some((user) => user.id === this.state.activeUserId)) {
      this.state.activeUserId = this.state.users[0].id;
      changed = true;
    }

    return changed;
  }

  syncSharedVoiceCloneToUsers() {
    this.state.sharedVoiceClone = buildSharedVoiceClone(this.state.sharedVoiceClone || {});
    for (const user of this.state.users) {
      user.settings = buildUserSettings(
        user.settings || {},
        this.state.sharedVoiceClone,
        this.state.sharedRemote,
        this.state.sharedSystem,
        this.state.geminiProfiles
      );
    }
  }

  syncSharedRemoteToUsers() {
    this.state.sharedRemote = buildSharedRemote(this.state.sharedRemote || {});
    for (const user of this.state.users) {
      user.settings = buildUserSettings(
        user.settings || {},
        this.state.sharedVoiceClone,
        this.state.sharedRemote,
        this.state.sharedSystem,
        this.state.geminiProfiles
      );
    }
  }

  syncSharedSystemToUsers() {
    this.state.sharedSystem = buildSharedSystem(this.state.sharedSystem || {});
    for (const user of this.state.users) {
      user.settings = buildUserSettings(
        user.settings || {},
        this.state.sharedVoiceClone,
        this.state.sharedRemote,
        this.state.sharedSystem,
        this.state.geminiProfiles
      );
    }
  }

  syncSharedLoginStateToUsers() {
    this.state.sharedLoginState = buildSharedLoginState(this.state.sharedLoginState || {});
    for (const user of this.state.users) {
      user.loginState = deepMerge(buildDefaultLoginState(), user.loginState || {});
    }
  }

  applyEnvOverrides() {
    const overrides = getSettingsOverridesFromEnv();
    if (!overrides || Object.keys(overrides).length === 0) {
      return false;
    }

    let changed = false;
    for (const user of this.state.users) {
      const before = JSON.stringify(user.settings);
      const userOverrides = clone(overrides);
      delete userOverrides.voiceClone;
      delete userOverrides.remote;
      user.settings = deepMerge(user.settings, userOverrides);
      if (before !== JSON.stringify(user.settings)) {
        changed = true;
      }
    }

    if (overrides.voiceClone) {
      this.state.sharedVoiceClone = deepMerge(this.state.sharedVoiceClone, overrides.voiceClone);
      this.syncSharedVoiceCloneToUsers();
      changed = true;
    }

    if (overrides.remote) {
      this.state.sharedRemote = deepMerge(this.state.sharedRemote, overrides.remote);
      this.state.sharedRemote.password = '';
      this.syncSharedRemoteToUsers();
      changed = true;
    }

    return changed;
  }

  migrateLegacySettings() {
    let changed = false;

    for (const user of this.state.users) {
      const style = user?.settings?.style;
      if (!style || typeof style !== 'object') {
        continue;
      }

      const currentTextColor = String(style.subtitleTextColor || '').trim().toUpperCase();
      const currentStrokeColor = String(style.subtitleStrokeColor || '').trim().toUpperCase();

      if (LEGACY_SUBTITLE_TEXT_COLORS.has(currentTextColor)) {
        style.subtitleTextColor = '#FFA100';
        changed = true;
      }

      if (LEGACY_SUBTITLE_STROKE_COLORS.has(currentStrokeColor)) {
        style.subtitleStrokeColor = '#000000';
        changed = true;
      }
    }

    return changed;
  }

  migrateSharedRemoteSettings() {
    let changed = false;

    if (!this.state.sharedRemote || typeof this.state.sharedRemote !== 'object') {
      this.state.sharedRemote = buildSharedRemote();
      changed = true;
    }

    if (String(this.state.sharedRemote.password || '').trim()) {
      this.state.sharedRemote.password = '';
      changed = true;
    }

    for (const user of this.state.users) {
      if (String(user?.settings?.remote?.password || '').trim()) {
        user.settings.remote.password = '';
        changed = true;
      }
    }

    return changed;
  }

  migrateSchemaDefaults(previousSchemaVersion) {
    let changed = false;
    const version = Number(previousSchemaVersion || 0);

    if (version >= STORE_SCHEMA_VERSION) {
      return false;
    }

    if (version < 5) {
      if (this.state.sharedRemote?.enabled !== true) {
        this.state.sharedRemote = buildSharedRemote({
          ...this.state.sharedRemote,
          enabled: true
        });
        changed = true;
      }
      if (this.state.sharedRemote?.publicMode !== 'cloudflare-quick') {
        this.state.sharedRemote = buildSharedRemote({
          ...this.state.sharedRemote,
          publicMode: 'cloudflare-quick'
        });
        changed = true;
      }
      if (this.state.sharedSystem?.preventSleepOnTasks !== true) {
        this.state.sharedSystem = buildSharedSystem({
          ...this.state.sharedSystem,
          preventSleepOnTasks: true
        });
        changed = true;
      }
      if (this.state.sharedSystem?.launchAtLogin !== true) {
        this.state.sharedSystem = buildSharedSystem({
          ...this.state.sharedSystem,
          launchAtLogin: true
        });
        changed = true;
      }
      if (changed) {
        this.syncSharedRemoteToUsers();
        this.syncSharedSystemToUsers();
      }
    }

    if (version < 6) {
      for (const user of this.state.users) {
        if (user.profileSettingsEnabled !== false) {
          user.profileSettingsEnabled = false;
          changed = true;
        }
        if (user.profileSettingsOverrides && Object.keys(user.profileSettingsOverrides).length > 0) {
          user.profileSettingsOverrides = {};
          changed = true;
        }
      }
    }

    return changed;
  }

  async backupCorruptedStore(raw, parseError) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(path.dirname(this.filePath), `antbot-store.corrupted-${stamp}.txt`);
    const header = `# AntBot store parse failed\n# ${String(parseError?.message || parseError)}\n\n`;
    await fs.writeFile(backupPath, `${header}${raw}`, 'utf-8');
  }

  async persist() {
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        const payload = JSON.stringify(this.state, null, 2);
        const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(tempPath, payload, 'utf-8');
        await fs.rename(tempPath, this.filePath);
      });

    return this.writeQueue;
  }

  getActiveUserRecord() {
    return this.state.users.find((user) => user.id === this.state.activeUserId) || this.state.users[0];
  }

  getUserRecordById(userId) {
    return this.state.users.find((user) => user.id === userId) || null;
  }

  buildUserSummary(user) {
    const loginState = user.loginState || {};
    const effectiveSettings = this.cloneSettingsForUser(user);
    const geminiProfileId = resolveGeminiProfileId(effectiveSettings.geminiProfileId, this.state.geminiProfiles);
    const geminiProfile = this.state.geminiProfiles.find((item) => item.id === geminiProfileId)
      || this.state.geminiProfiles[0]
      || buildGeminiProfile();
    return {
      id: user.id,
      name: user.name,
      avatarId: normalizeAvatarId(user.avatarId) || AVAILABLE_AVATAR_IDS[0],
      isActive: user.id === this.state.activeUserId,
      platformReady: Boolean(loginState.videoChannel?.loggedIn || loginState.douyin?.loggedIn),
      geminiReady: Boolean(loginState.gemini?.loggedIn),
      geminiProfileId,
      geminiProfileName: geminiProfile.name,
      profileSettingsEnabled: Boolean(user.profileSettingsEnabled),
      remoteEnabled: Boolean(this.state.sharedRemote?.enabled),
      remotePasswordConfigured: false,
      historyCount: Array.isArray(user.history) ? user.history.length : 0,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };
  }

  cloneSettingsForUser(user) {
    const globalSettings = this.cloneGlobalSettingsForUser(user);
    const settings = clone(globalSettings);
    if (user.profileSettingsEnabled) {
      deepMerge(settings, clone(user.profileSettingsOverrides || {}));
    }
    settings.__userId = user.id;
    settings.__userName = user.name;
    settings.__avatarId = normalizeAvatarId(user.avatarId) || AVAILABLE_AVATAR_IDS[0];
    settings.__geminiProfileId = settings.geminiProfileId;
    settings.__geminiProfileName = this.state.geminiProfiles.find((item) => item.id === settings.geminiProfileId)?.name
      || DEFAULT_GEMINI_PROFILE_NAME;
    settings.__profileSettingsEnabled = Boolean(user.profileSettingsEnabled);
    settings.__profileSettingsOverrides = clone(user.profileSettingsOverrides || {});
    settings.__globalSettings = globalSettings;
    return settings;
  }

  cloneGlobalSettingsForUser(user) {
    const settings = clone(user.settings || buildDefaultSettings());
    settings.voiceClone = clone(this.state.sharedVoiceClone || buildSharedVoiceClone());
    settings.remote = clone(this.state.sharedRemote || buildSharedRemote());
    settings.system = clone(this.state.sharedSystem || buildSharedSystem());
    settings.geminiProfileId = resolveGeminiProfileId(settings.geminiProfileId, this.state.geminiProfiles);
    settings.remote.password = '';
    settings.__userId = user.id;
    settings.__userName = user.name;
    settings.__avatarId = normalizeAvatarId(user.avatarId) || AVAILABLE_AVATAR_IDS[0];
    settings.__geminiProfileId = settings.geminiProfileId;
    settings.__geminiProfileName = this.state.geminiProfiles.find((item) => item.id === settings.geminiProfileId)?.name
      || DEFAULT_GEMINI_PROFILE_NAME;
    return settings;
  }

  touchUser(user) {
    user.updatedAt = nowIso();
  }

  nextUserName() {
    const numbers = this.state.users
      .map((user) => {
        const matched = String(user.name || '').match(/^蚂蚁(\d+)$/);
        return matched ? Number(matched[1]) : 0;
      })
      .filter((value) => Number.isFinite(value) && value > 0);

    const nextIndex = numbers.length ? Math.max(...numbers) + 1 : this.state.users.length + 1;
    return `蚂蚁${nextIndex}`;
  }

  nextUserId() {
    const existing = new Set(this.state.users.map((user) => user.id));
    let index = this.state.users.length + 1;
    while (existing.has(`user-${index}`)) {
      index += 1;
    }
    return `user-${index}`;
  }

  nextGeminiProfileName() {
    const numbers = this.state.geminiProfiles
      .map((profile) => {
        const matched = String(profile.name || '').match(/^Gemini\s*(\d+)$/i);
        return matched ? Number(matched[1]) : 0;
      })
      .filter((value) => Number.isFinite(value) && value > 0);
    const nextIndex = numbers.length ? Math.max(...numbers) + 1 : 2;
    return `Gemini ${nextIndex}`;
  }

  async getState() {
    await this.load();
    return clone(this.state);
  }

  async getSettings() {
    await this.load();
    return this.cloneSettingsForUser(this.getActiveUserRecord());
  }

  async getSettingsForUser(userId) {
    await this.load();
    const user = this.getUserRecordById(userId);
    if (!user) {
      throw new Error('用户不存在。');
    }
    return this.cloneSettingsForUser(user);
  }

  async getGlobalSettingsForUser(userId) {
    await this.load();
    const user = this.getUserRecordById(userId);
    if (!user) {
      throw new Error('用户不存在。');
    }
    return this.cloneGlobalSettingsForUser(user);
  }

  async updateSettings(partialSettings) {
    await this.load();
    return this.updateSettingsForUser(this.getActiveUserRecord().id, partialSettings);
  }

  async updateSettingsForUser(userId, partialSettings, options = {}) {
    await this.load();

    const user = this.getUserRecordById(userId);
    if (!user) {
      throw new Error('用户不存在。');
    }
    const nextPartial = clone(partialSettings || {});
    const scope = options.scope === 'user-profile' ? 'user-profile' : 'global';
    const profileSettingsEnabled = typeof options.profileSettingsEnabled === 'boolean'
      ? options.profileSettingsEnabled
      : null;
    const voiceClonePatch = nextPartial.voiceClone && typeof nextPartial.voiceClone === 'object'
      ? nextPartial.voiceClone
      : null;
    const remotePatch = nextPartial.remote && typeof nextPartial.remote === 'object'
      ? nextPartial.remote
      : null;
    const systemPatch = nextPartial.system && typeof nextPartial.system === 'object'
      ? nextPartial.system
      : null;
    const geminiProfileId = typeof nextPartial.geminiProfileId === 'string'
      ? resolveGeminiProfileId(nextPartial.geminiProfileId, this.state.geminiProfiles)
      : '';

    if (scope === 'user-profile') {
      const profilePatch = buildUserProfileSettingsOverrides(nextPartial, this.state.geminiProfiles);
      if (profileSettingsEnabled !== null) {
        user.profileSettingsEnabled = profileSettingsEnabled;
        if (!profileSettingsEnabled) {
          user.profileSettingsOverrides = {};
        }
      }
      if (Object.keys(profilePatch).length > 0) {
        user.profileSettingsOverrides = deepMerge(
          clone(user.profileSettingsOverrides || {}),
          profilePatch
        );
        user.profileSettingsEnabled = profileSettingsEnabled ?? true;
      }
      this.touchUser(user);
      await this.persist();
      return this.cloneSettingsForUser(user);
    }

    if (voiceClonePatch) {
      delete nextPartial.voiceClone;
      this.state.sharedVoiceClone = deepMerge(this.state.sharedVoiceClone, voiceClonePatch);
    }

    if (remotePatch) {
      delete nextPartial.remote;
      const normalizedRemotePatch = { ...remotePatch };
      if (typeof normalizedRemotePatch.enabled === 'boolean') {
        normalizedRemotePatch.publicMode = normalizedRemotePatch.enabled
          ? 'cloudflare-quick'
          : 'off';
      }
      this.state.sharedRemote = deepMerge(this.state.sharedRemote, normalizedRemotePatch);
      this.state.sharedRemote.password = '';
    }

    if (systemPatch) {
      delete nextPartial.system;
      this.state.sharedSystem = deepMerge(this.state.sharedSystem, systemPatch);
    }

    if (geminiProfileId) {
      nextPartial.geminiProfileId = geminiProfileId;
    }

    for (const item of this.state.users) {
      item.settings = deepMerge(item.settings, clone(nextPartial));
      this.touchUser(item);
    }
    this.syncSharedVoiceCloneToUsers();
    this.syncSharedRemoteToUsers();
    this.syncSharedSystemToUsers();
    await this.persist();
    return this.cloneSettingsForUser(user);
  }

  async getHistory() {
    await this.load();
    return clone(this.getActiveUserRecord().history || []);
  }

  async getHistoryForUser(userId) {
    await this.load();
    const user = this.getUserRecordById(userId);
    if (!user) {
      throw new Error('用户不存在。');
    }
    return clone(user.history || []);
  }

  async appendHistory(runRecord) {
    await this.load();
    return this.appendHistoryForUser(this.getActiveUserRecord().id, runRecord);
  }

  async appendHistoryForUser(userId, runRecord) {
    await this.load();
    const user = this.getUserRecordById(userId);
    if (!user) {
      throw new Error('用户不存在。');
    }
    user.history.unshift(clone(runRecord));
    user.history = user.history.slice(0, 200);
    this.touchUser(user);
    await this.persist();
    return clone(user.history);
  }

  async appendPublishedRecords(records) {
    await this.load();
    return this.appendPublishedRecordsForUser(this.getActiveUserRecord().id, records);
  }

  async appendPublishedRecordsForUser(userId, records) {
    await this.load();
    const user = this.getUserRecordById(userId);
    if (!user) {
      throw new Error('用户不存在。');
    }
    const items = Array.isArray(records) ? clone(records) : [];
    user.publishedRecords.unshift(...items);
    user.publishedRecords = user.publishedRecords.slice(0, 500);
    this.touchUser(user);
    await this.persist();
    return clone(user.publishedRecords);
  }

  async getLoginState() {
    await this.load();
    return clone(this.getActiveUserRecord().loginState || buildDefaultLoginState());
  }

  async getLoginStateForUser(userId) {
    await this.load();
    const user = this.getUserRecordById(userId);
    if (!user) {
      throw new Error('用户不存在。');
    }
    return clone(user.loginState || buildDefaultLoginState());
  }

  async setLoginState(service, loggedIn) {
    await this.load();
    return this.setLoginStateForUser(this.getActiveUserRecord().id, service, loggedIn);
  }

  async setLoginStateForUser(userId, service, loggedIn) {
    await this.load();
    const user = this.getUserRecordById(userId);
    if (!user) {
      throw new Error('用户不存在。');
    }
    const nextState = {
      loggedIn: Boolean(loggedIn),
      checkedAt: nowIso()
    };

    if (service === 'gemini') {
      if (!user.loginState[service]) {
        user.loginState[service] = { loggedIn: false, checkedAt: '' };
      }
      user.loginState[service] = nextState;
      const effectiveSettings = this.cloneSettingsForUser(user);
      const geminiProfileId = resolveGeminiProfileId(effectiveSettings.geminiProfileId, this.state.geminiProfiles);
      const geminiProfile = this.state.geminiProfiles.find((item) => item.id === geminiProfileId);
      if (geminiProfile) {
        geminiProfile.loggedIn = nextState.loggedIn;
        geminiProfile.checkedAt = nextState.checkedAt;
        geminiProfile.updatedAt = nowIso();
      }
      this.touchUser(user);
      await this.persist();
      return clone(user.loginState);
    }

    if (!user.loginState[service]) {
      user.loginState[service] = { loggedIn: false, checkedAt: '' };
    }

    user.loginState[service] = nextState;

    this.touchUser(user);
    await this.persist();
    return clone(user.loginState);
  }

  async setVoiceClone(voiceClone) {
    await this.load();
    this.state.sharedVoiceClone = {
      ...this.state.sharedVoiceClone,
      ...voiceClone,
      lastUpdatedAt: nowIso()
    };
    this.syncSharedVoiceCloneToUsers();
    for (const user of this.state.users) {
      this.touchUser(user);
    }
    await this.persist();
    return clone(this.state.sharedVoiceClone);
  }

  async listUsers() {
    await this.load();
    return this.state.users.map((user) => this.buildUserSummary(user));
  }

  async listGeminiProfiles() {
    await this.load();
    return clone(this.state.geminiProfiles || []);
  }

  async createGeminiProfile(name = '') {
    await this.load();
    const profileName = sanitizeGeminiProfileName(name, this.nextGeminiProfileName());
    const profileId = normalizeGeminiProfileId(profileName, `gemini-${Date.now()}`);
    const existing = this.state.geminiProfiles.find((item) => item.id === profileId);
    if (existing) {
      return clone(existing);
    }

    const created = buildGeminiProfile({
      id: profileId,
      name: profileName
    }, profileId);
    this.state.geminiProfiles.push(created);
    await this.persist();
    return clone(created);
  }

  async getActiveUserSummary() {
    await this.load();
    return this.buildUserSummary(this.getActiveUserRecord());
  }

  async getUserSummary(userId) {
    await this.load();
    const user = this.getUserRecordById(userId);
    if (!user) {
      throw new Error('用户不存在。');
    }
    return this.buildUserSummary(user);
  }

  async createUser(name = '') {
    await this.load();
    return this.createUserFromUser(this.getActiveUserRecord().id, name);
  }

  async createUserFromUser(sourceUserId, name = '') {
    await this.load();
    if (this.state.users.length >= MAX_USERS) {
      throw new Error(`最多只支持 ${MAX_USERS} 个用户。`);
    }
    const source = this.getUserRecordById(sourceUserId) || this.getActiveUserRecord();
    const newUser = buildUserRecord({
      id: this.nextUserId(),
      name: sanitizeUserName(name, this.nextUserName()),
      avatarId: pickAvailableAvatarId(this.state.users),
      settings: {
        ...clone(source.settings),
        geminiProfileId: DEFAULT_GEMINI_PROFILE_ID
      },
      profileSettingsEnabled: false,
      profileSettingsOverrides: {},
      loginState: {
        ...buildDefaultLoginState()
      }
    }, {
      index: this.state.users.length + 1,
      sharedVoiceClone: this.state.sharedVoiceClone,
      sharedRemote: this.state.sharedRemote,
      sharedSystem: this.state.sharedSystem,
      geminiProfiles: this.state.geminiProfiles
    });

    this.state.users.push(newUser);
    this.touchUser(newUser);
    await this.persist();
    return this.buildUserSummary(newUser);
  }

  async switchUser(userId) {
    await this.load();
    const user = this.state.users.find((item) => item.id === userId);
    if (!user) {
      throw new Error('用户不存在。');
    }
    this.state.activeUserId = user.id;
    this.touchUser(user);
    await this.persist();
    return this.buildUserSummary(user);
  }

  async renameUser(userId, name) {
    await this.load();
    const user = this.state.users.find((item) => item.id === userId);
    if (!user) {
      throw new Error('用户不存在。');
    }
    user.name = sanitizeUserName(name, user.name || DEFAULT_USER_NAME);
    this.touchUser(user);
    await this.persist();
    return this.buildUserSummary(user);
  }

  async deleteUser(userId) {
    await this.load();

    if (this.state.users.length <= 1) {
      throw new Error('至少保留一个用户。');
    }

    const index = this.state.users.findIndex((item) => item.id === userId);
    if (index === -1) {
      throw new Error('用户不存在。');
    }

    const [removed] = this.state.users.splice(index, 1);
    const nextActiveUser = this.state.users[Math.max(0, index - 1)] || this.state.users[0];
    if (this.state.activeUserId === removed.id) {
      this.state.activeUserId = nextActiveUser.id;
    }

    if (nextActiveUser) {
      this.touchUser(nextActiveUser);
    }

    await fs.rm(
      path.join(app.getPath('userData'), 'browser-profiles', normalizeUserId(removed.id, 1)),
      { recursive: true, force: true }
    ).catch(() => {});

    await this.persist();
    return {
      deletedUserId: removed.id,
      activeUser: this.buildUserSummary(this.getActiveUserRecord()),
      users: this.state.users.map((user) => this.buildUserSummary(user))
    };
  }
}

module.exports = {
  StoreService,
  deepMerge,
  buildDefaultState,
  buildDefaultLoginState
};
