const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function nowIso() {
  return new Date().toISOString();
}

function normalizeCommand(input) {
  const action = String(input?.action || '').trim();
  if (!action) {
    throw new Error('桥接命令缺少 action');
  }

  return {
    id: String(input.id || `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    action,
    payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
    createdAt: String(input.createdAt || nowIso())
  };
}

function createBridgeQueue({ maxHistory = 100, maxEvents = 200 } = {}) {
  const queued = [];
  const pending = new Map();
  const commands = new Map();
  const history = [];
  const events = [];
  let state = { status: 'idle', updatedAt: nowIso() };

  const trim = (list, max) => {
    while (list.length > max) list.shift();
  };

  const enqueue = (input) => {
    const command = normalizeCommand(input);
    if (commands.has(command.id)) {
      throw new Error(`桥接命令 ID 已存在：${command.id}`);
    }
    const record = { ...command, status: 'queued' };
    queued.push(record);
    commands.set(record.id, record);
    return { ...record };
  };

  const claim = () => {
    const record = queued.shift();
    if (!record) return null;
    record.status = 'running';
    record.startedAt = nowIso();
    pending.set(record.id, record);
    return { ...record };
  };

  const resolve = (id, result = {}) => {
    const record = commands.get(String(id));
    if (!record) return null;
    pending.delete(record.id);
    record.status = result.status && TERMINAL_STATUSES.has(result.status)
      ? result.status
      : (result.success === false ? 'failed' : 'completed');
    record.finishedAt = nowIso();
    record.result = result;
    history.unshift({ ...record });
    trim(history, maxHistory);
    return { ...record };
  };

  const cancel = (id) => resolve(id, { success: false, status: 'cancelled', error: '已取消' });

  const get = (id) => {
    const record = commands.get(String(id));
    return record ? { ...record } : null;
  };

  const updateState = (nextState = {}) => {
    state = {
      ...state,
      ...(nextState && typeof nextState === 'object' ? nextState : {}),
      updatedAt: nowIso()
    };
    return { ...state };
  };

  const addEvent = (event = {}) => {
    const record = { ...event, timestamp: event.timestamp || nowIso() };
    events.push(record);
    trim(events, maxEvents);
    return { ...record };
  };

  const snapshot = () => ({
    state: { ...state },
    queued: queued.map(item => ({ ...item })),
    pending: Array.from(pending.values()).map(item => ({ ...item })),
    history: history.map(item => ({ ...item })),
    events: events.map(item => ({ ...item }))
  });

  return { enqueue, claim, resolve, cancel, get, updateState, addEvent, snapshot };
}

module.exports = { createBridgeQueue, TERMINAL_STATUSES };
