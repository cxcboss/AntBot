const fs = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');
const { buildDefaultSettings, getSettingsOverridesFromEnv } = require('./config');

const STORE_FILE = 'antbot-store.json';
const STORE_SCHEMA_VERSION = 6;
const DEFAULT_USER_ID = 'user-1';
const DEFAULT_USER_NAME = '蚂蚁1';
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

function buildDefaultLoginState(seed = {}) {
  const defaults = {
    videoChannel: { loggedIn: false, checkedAt: '' },
    douyin: { loggedIn: false, checkedAt: '' }
  };

  for (const service of Object.keys(defaults)) {
    const saved = seed?.[service];
    if (saved && typeof saved === 'object') {
      defaults[service] = deepMerge(defaults[service], saved);
    }
  }

  return defaults;
}

function normalizeUserId(value, fallbackIndex = 1) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return raw || `user-${fallbackIndex}`;
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

function buildUserSettings(
  seed = {},
  sharedVoiceClone = buildSharedVoiceClone(),
  sharedRemote = buildSharedRemote(),
  sharedSystem = buildSharedSystem()
) {
  const settings = deepMerge(buildDefaultSettings(), seed || {});
  delete settings.geminiProfileId;
  settings.voiceClone = deepMerge(clone(sharedVoiceClone), settings.voiceClone || {});
  settings.remote = deepMerge(clone(sharedRemote), settings.remote || {});
  settings.system = deepMerge(clone(sharedSystem), settings.system || {});
  settings.remote.password = '';
  return settings;
}

function buildUserRecord(seed = {}, options = {}) {
  const sharedVoiceClone = options.sharedVoiceClone || buildSharedVoiceClone();
  const sharedRemote = options.sharedRemote || buildSharedRemote();
  const sharedSystem = options.sharedSystem || buildSharedSystem();
  return {
    id: normalizeUserId(seed.id, options.index || 1),
    name: String(seed.name || options.defaultName || DEFAULT_USER_NAME).replace(/\s+/g, ' ').trim() || DEFAULT_USER_NAME,
    settings: buildUserSettings(
      seed.settings || {},
      sharedVoiceClone,
      sharedRemote,
      sharedSystem
    ),
    history: Array.isArray(seed.history) ? seed.history.slice(0, 200) : [],
    publishedRecords: Array.isArray(seed.publishedRecords) ? seed.publishedRecords.slice(0, 500) : [],
    loginState: buildDefaultLoginState(seed.loginState),
    createdAt: String(seed.createdAt || nowIso()),
    updatedAt: String(seed.updatedAt || nowIso())
  };
}

function buildDefaultState() {
  const sharedVoiceClone = buildSharedVoiceClone();
  const sharedRemote = buildSharedRemote();
  const sharedSystem = buildSharedSystem();
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    activeUserId: DEFAULT_USER_ID,
    sharedVoiceClone,
    sharedRemote,
    sharedSystem,
    users: [
      buildUserRecord({
        id: DEFAULT_USER_ID,
        name: DEFAULT_USER_NAME,
        settings: buildDefaultSettings()
      }, {
        index: 1,
        sharedVoiceClone,
        sharedRemote,
        sharedSystem
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

    const seenIds = new Set();
    const users = seed.users.map((user, index) => {
      const normalized = buildUserRecord(user, {
        index: index + 1,
        sharedVoiceClone,
        sharedRemote,
        sharedSystem,
        defaultName: `蚂蚁${index + 1}`
      });

      if (seenIds.has(normalized.id)) {
        normalized.id = normalizeUserId(`${normalized.id}-${index + 1}`, index + 1);
      }
      seenIds.add(normalized.id);
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
      users
    };
  }

  const legacySettings = deepMerge(buildDefaultSettings(), seed.settings || {});
  const sharedVoiceClone = buildSharedVoiceClone(legacySettings.voiceClone || {});
  const sharedRemote = buildSharedRemote(legacySettings.remote || {});
  const sharedSystem = buildSharedSystem(legacySettings.system || {});
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
    sharedSystem
  });

  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    activeUserId: migratedUser.id,
    sharedVoiceClone,
    sharedRemote,
    sharedSystem,
    users: [migratedUser]
  };
}

class StoreService {
  constructor(dataDir) {
    const dir = dataDir || app.getPath('userData');
    this.filePath = path.join(dir, STORE_FILE);
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

    this.state.sharedRemote = buildSharedRemote(this.state.sharedRemote || {});
    this.state.sharedSystem = buildSharedSystem(this.state.sharedSystem || {});

    const seenIds = new Set();
    this.state.users = this.state.users.map((user, index) => {
      const next = buildUserRecord(user, {
        index: index + 1,
        sharedVoiceClone: this.state.sharedVoiceClone,
        sharedRemote: this.state.sharedRemote,
        sharedSystem: this.state.sharedSystem,
        defaultName: `蚂蚁${index + 1}`
      });
      if (seenIds.has(next.id)) {
        next.id = normalizeUserId(`${next.id}-${index + 1}`, index + 1);
        changed = true;
      }
      seenIds.add(next.id);
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
        this.state.sharedSystem
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
        this.state.sharedSystem
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
        this.state.sharedSystem
      );
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
      .catch((error) => {
        console.warn('[store] previous write failed:', error?.message || error);
      })
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

  cloneSettingsForUser(user) {
    const globalSettings = this.cloneGlobalSettingsForUser(user);
    const settings = clone(globalSettings);
    settings.__userId = user.id;
    settings.__userName = user.name;
    settings.__globalSettings = globalSettings;
    return settings;
  }

  cloneGlobalSettingsForUser(user) {
    const settings = clone(user.settings || buildDefaultSettings());
    settings.voiceClone = clone(this.state.sharedVoiceClone || buildSharedVoiceClone());
    settings.remote = clone(this.state.sharedRemote || buildSharedRemote());
    settings.system = clone(this.state.sharedSystem || buildSharedSystem());
    delete settings.geminiProfileId;
    settings.remote.password = '';
    settings.__userId = user.id;
    settings.__userName = user.name;
    return settings;
  }

  touchUser(user) {
    user.updatedAt = nowIso();
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
    return this.cloneSettingsForUser(this.getActiveUserRecord());
  }

  async updateSettings(partialSettings) {
    await this.load();
    return this.updateSettingsForUser(this.getActiveUserRecord().id, partialSettings);
  }

  async updateSettingsForUser(userId, partialSettings) {
    await this.load();

    const user = this.getActiveUserRecord();
    const nextPartial = clone(partialSettings || {});
    const voiceClonePatch = nextPartial.voiceClone && typeof nextPartial.voiceClone === 'object'
      ? nextPartial.voiceClone
      : null;
    const remotePatch = nextPartial.remote && typeof nextPartial.remote === 'object'
      ? nextPartial.remote
      : null;
    const systemPatch = nextPartial.system && typeof nextPartial.system === 'object'
      ? nextPartial.system
      : null;
    delete nextPartial.geminiProfileId;
    delete nextPartial.__geminiProfileId;
    delete nextPartial.__geminiProfileName;

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
    return clone(this.getActiveUserRecord().history || []);
  }

  async appendHistory(runRecord) {
    await this.load();
    return this.appendHistoryForUser(this.getActiveUserRecord().id, runRecord);
  }

  async clearHistory() {
    await this.load();
    const user = this.getActiveUserRecord();
    user.history = [];
    this.touchUser(user);
    await this.persist();
    return true;
  }

  async removeHistoryItem(recordId) {
    await this.load();
    const user = this.getActiveUserRecord();
    const before = user.history.length;
    user.history = user.history.filter(r => String(r.id) !== String(recordId));
    if (user.history.length === before) return false;
    this.touchUser(user);
    await this.persist();
    return true;
  }

  async appendHistoryForUser(userId, runRecord) {
    await this.load();
    const user = this.getActiveUserRecord();
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
    const user = this.getActiveUserRecord();
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

  async setLoginState(service, loggedIn) {
    await this.load();
    return this.setLoginStateForUser(this.getActiveUserRecord().id, service, loggedIn);
  }

  async setLoginStateForUser(userId, service, loggedIn) {
    await this.load();
    const user = this.getActiveUserRecord();
    if (!Object.hasOwn(buildDefaultLoginState(), service)) {
      return clone(user.loginState);
    }
    const nextState = {
      loggedIn: Boolean(loggedIn),
      checkedAt: nowIso()
    };

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
}

module.exports = {
  StoreService,
  deepMerge,
  buildDefaultState,
  buildDefaultLoginState
};
