const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getDeviceInfo: () => ipcRenderer.invoke('get-device-info'),
  getPermissionsStatus: () => ipcRenderer.invoke('get-permissions-status'),
  requestSystemPermissions: (type) => ipcRenderer.invoke('request-system-permissions', type),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  saveTempScreenshot: (buffer) => ipcRenderer.invoke('save-temp-screenshot', buffer),
  readTempScreenshot: (filePath) => ipcRenderer.invoke('read-temp-screenshot', filePath),
  setActivityTracking: (enabled) => ipcRenderer.invoke('set-activity-tracking', enabled),
  getActivityStats: () => ipcRenderer.invoke('get-activity-stats'),
  
  // Phase 4D Offline Queue & Sync
  getSleepGaps: () => ipcRenderer.invoke('get-sleep-gaps'),
  enqueueSyncItem: (item) => ipcRenderer.invoke('enqueue-sync-item', item),
  getSyncQueue: () => ipcRenderer.invoke('get-sync-queue'),
  updateQueueItem: (local_id, updates) => ipcRenderer.invoke('update-queue-item', local_id, updates),
  deleteQueueItem: (local_id) => ipcRenderer.invoke('delete-queue-item', local_id),
  getQueueStats: () => ipcRenderer.invoke('get-queue-stats'),
  forceSyncRetry: () => ipcRenderer.invoke('force-sync-retry'),

  onPowerStateChange: (callback) => {
    const listener = (event, state) => callback(state);
    ipcRenderer.on('power-state-change', listener);
    return () => ipcRenderer.removeListener('power-state-change', listener);
  },
  onUpdaterStatus: (callback) => {
    const listener = (event, text) => callback(text);
    ipcRenderer.on('updater-status', listener);
    return () => ipcRenderer.removeListener('updater-status', listener);
  }
});
