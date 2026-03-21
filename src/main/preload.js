const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  const wrapped = (_, payload) => callback(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('antbot', {
  getInitialState: () => ipcRenderer.invoke('app:get-initial-state'),
  checkStartup: () => ipcRenderer.invoke('startup:check'),
  markLoginDone: (serviceKey) => ipcRenderer.invoke('startup:mark-login-done', serviceKey),
  openLoginWindow: (serviceKey) => ipcRenderer.invoke('startup:open-login-window', serviceKey),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  listGeminiProfiles: () => ipcRenderer.invoke('gemini-profiles:list'),
  createGeminiProfile: (name) => ipcRenderer.invoke('gemini-profiles:create', name),
  createUser: (name) => ipcRenderer.invoke('users:create', name),
  renameUser: (name) => ipcRenderer.invoke('users:rename', name),
  switchUser: (userId) => ipcRenderer.invoke('users:switch', userId),
  deleteUser: (userId) => ipcRenderer.invoke('users:delete', userId),
  pickAudioFile: () => ipcRenderer.invoke('dialog:pick-audio-file'),
  pickVideoFile: () => ipcRenderer.invoke('dialog:pick-video-file'),
  runVoiceClone: (payload) => ipcRenderer.invoke('voice:clone', payload),
  parseTasks: (input) => ipcRenderer.invoke('task:parse', input),
  startTasks: (input) => ipcRenderer.invoke('task:start', input),
  startDebugPublish: (payload) => ipcRenderer.invoke('task:debug-publish', payload),
  stopTasks: () => ipcRenderer.invoke('task:stop'),
  stopTask: (taskId) => ipcRenderer.invoke('task:stop-one', taskId),
  resumeTask: (payload) => ipcRenderer.invoke('task:resume-one', payload),
  getHistory: () => ipcRenderer.invoke('history:get'),
  getRemoteState: () => ipcRenderer.invoke('remote:get-state'),
  getDependencyState: () => ipcRenderer.invoke('deps:get-state'),
  repairDependencies: () => ipcRenderer.invoke('deps:repair'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  makeQrDataUrl: (text) => ipcRenderer.invoke('app:make-qr', text),
  onProgress: (callback) => on('task:progress', callback),
  onLog: (callback) => on('task:log', callback),
  onVoiceCloneProgress: (callback) => on('voice:clone-progress', callback),
  onStartupStatus: (callback) => on('startup:status', callback),
  onHistoryChanged: (callback) => on('history:changed', callback),
  onRemoteStatus: (callback) => on('remote:status', callback),
  onAppState: (callback) => on('app:state', callback)
});
