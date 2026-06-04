export interface ElectronAPI {
  getDeviceInfo: () => Promise<{
    fingerprint: string;
    deviceName: string;
    deviceOs: string;
    appVersion: string;
  }>;
  getPermissionsStatus: () => Promise<{
    screen: 'unknown' | 'granted' | 'denied' | 'limited';
    accessibility: 'unknown' | 'granted' | 'denied' | 'limited';
  }>;
  requestSystemPermissions: (type: 'screen' | 'accessibility') => Promise<{
    screen: 'unknown' | 'granted' | 'denied' | 'limited';
    accessibility: 'unknown' | 'granted' | 'denied' | 'limited';
  }>;
  captureScreen: () => Promise<{
    success: boolean;
    buffer?: Uint8Array;
    error?: string;
  }>;
  saveTempScreenshot: (buffer: Uint8Array) => Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
  }>;
  readTempScreenshot: (filePath: string) => Promise<{
    success: boolean;
    buffer?: Uint8Array;
    error?: string;
  }>;
  setActivityTracking: (enabled: boolean) => Promise<boolean>;
  getActivityStats: () => Promise<{
    keyboardCount: number;
    mouseCount: number;
    mouseClickCount: number;
    activeApp: string | null;
    activeWindowTitle: string | null;
  }>;
  // Phase 4D
  getSleepGaps: () => Promise<Array<{start: number, end: number, durationMinutes: number}>>;
  enqueueSyncItem: (item: any) => Promise<any>;
  getSyncQueue: () => Promise<any[]>;
  updateQueueItem: (local_id: string, updates: any) => Promise<number>;
  deleteQueueItem: (local_id: string) => Promise<number>;
  getQueueStats: () => Promise<{pendingCount: number, failedCount: number}>;
  forceSyncRetry: () => Promise<number>;
  onPowerStateChange: (callback: (state: 'suspend' | 'resume') => void) => () => void;
  getAppVersion: () => Promise<string>;
  checkForUpdates: () => Promise<{ success: boolean; version?: string; error?: string }>;
  onUpdaterStatus: (callback: (text: string) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
