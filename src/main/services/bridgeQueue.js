function nowIso() {
  return new Date().toISOString();
}

function createBridgeQueue({ maxEvents = 200, maxHistory = 100 } = {}) {
  const queued = [];
  const commands = new Map();
  const events = new Map();
  const history = [];
  const sequences = new Map();

  function enqueue(input = {}) {
    const id = String(input.id || `antbot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const action = String(input.action || '').trim();
    if (!action) throw new Error('桥接命令缺少 action');
    if (commands.has(id)) throw new Error(`桥接命令 ID 已存在：${id}`);
    const command = {
      id,
      action,
      payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
      status: 'queued',
      createdAt: nowIso()
    };
    commands.set(id, command);
    queued.push(id);
    return { ...command };
  }

  function claim() {
    const id = queued.shift();
    if (!id) return null;
    const command = commands.get(id);
    command.status = 'running';
    command.startedAt = nowIso();
    return { ...command };
  }

  function get(id) {
    const command = commands.get(String(id));
    return command ? { ...command } : null;
  }

  function addEvent(id, event = {}) {
    const key = String(id);
    const sequence = (sequences.get(key) || 0) + 1;
    sequences.set(key, sequence);
    const record = { ...event, commandId: key, sequence, timestamp: event.timestamp || nowIso() };
    const list = events.get(key) || [];
    list.push(record);
    events.set(key, list.slice(-maxEvents));
    return { ...record };
  }

  function resolve(id, result = {}) {
    const command = commands.get(String(id));
    if (!command) return null;
    command.status = result.status || (result.success === false ? 'failed' : 'completed');
    command.result = result;
    command.finishedAt = nowIso();
    history.unshift({ ...command });
    if (history.length > maxHistory) history.length = maxHistory;
    // 延迟清理已完成的命令和事件，给轮询端口时间读取最终状态
    const cmdId = String(id);
    setTimeout(() => {
      commands.delete(cmdId);
      events.delete(cmdId);
      sequences.delete(cmdId);
    }, 30_000);
    return { ...command };
  }

  function cancel(id, reason = '已取消') {
    return resolve(id, { success: false, status: 'cancelled', error: reason });
  }

  function snapshot() {
    return {
      queued: queued.map(id => ({ ...commands.get(id) })),
      pending: [...commands.values()].filter(command => command.status === 'running').map(command => ({ ...command })),
      history: history.map(command => ({ ...command }))
    };
  }

  return { enqueue, claim, get, addEvent, resolve, cancel, events, snapshot };
}

module.exports = { createBridgeQueue };
