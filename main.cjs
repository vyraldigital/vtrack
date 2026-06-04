const { app, BrowserWindow, ipcMain, systemPreferences, powerMonitor, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const { uIOhook } = require('uiohook-napi');
const { activeWindow } = require('get-windows');
const Datastore = require('@seald-io/nedb');

let mainWindow = null;
let keyboardCount = 0;
let mouseCount = 0;
let mouseClickCount = 0;
let isActivityTrackingEnabled = false;
let uiohookRunning = false; // tracks whether uIOhook has been started

// Phase 4D: Sleep gap tracking
let lastSleepTime = 0;
let sleepGaps = [];

// Phase 4D: NeDB Local Queue
let queueDb = null;

// Throttle timestamp for mousemove — raw mousemove on Windows fires hundreds/thousands
// of events per minute, making mouse_count meaninglessly large in the DB.
// Cap at 10 events/second (one per 100 ms) so the stored value stays human-readable.
let _lastMouseMove = 0;

// Register uIOhook event listeners once at module load.
// uIOhook is NOT started here — it starts only when activity tracking is enabled
// via the set-activity-tracking IPC call (i.e. when the editor clocks in AND has the feature flag on).
uIOhook.on('keydown', () => {
  if (isActivityTrackingEnabled) keyboardCount++;
});

uIOhook.on('mousemove', () => {
  if (isActivityTrackingEnabled) {
    const now = Date.now();
    if (now - _lastMouseMove >= 100) {
      mouseCount++;
      _lastMouseMove = now;
    }
  }
});

uIOhook.on('mousedown', () => {
  if (isActivityTrackingEnabled) mouseClickCount++;
});

// Unique device fingerprint generator (stable across app runs)
function getDeviceFingerprint() {
  const interfaces = os.networkInterfaces();
  let macs = '';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.mac !== '00:00:00:00:00:00') {
        macs += iface.mac;
      }
    }
  }
  const hostname = os.hostname();
  const username = os.userInfo().username;
  const platform = os.platform();
  const raw = `${hostname}-${username}-${platform}-${macs}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function getPermissions() {
  const permissions = {
    screen: 'unknown',
    accessibility: 'unknown'
  };

  const isMac = process.platform === 'darwin';

  if (isMac) {
    try {
      // Check Screen Recording permission
      if (systemPreferences.getMediaAccessStatus) {
        permissions.screen = systemPreferences.getMediaAccessStatus('screen');
      } else {
        permissions.screen = 'unknown';
      }
    } catch (e) {
      permissions.screen = 'unknown';
    }

    try {
      // Check Accessibility permission (do not prompt user automatically)
      const isTrusted = systemPreferences.isTrustedAccessibilityClient(false);
      permissions.accessibility = isTrusted ? 'granted' : 'denied';
    } catch (e) {
      permissions.accessibility = 'unknown';
    }
  } else {
    // Windows/Linux don't require macOS-style screen recording & accessibility checks for basic MVP tracking
    permissions.screen = 'granted';
    permissions.accessibility = 'granted';
  }

  return permissions;
}

// ─── Auto-updater ─────────────────────────────────────────────────────────────
// Security model:
//   • Only runs in production builds (app.isPackaged) — never in dev
//   • Downloads silently over HTTPS from GitHub Releases
//   • electron-updater verifies the SHA512 hash before applying — MITM-proof
//   • Never force-installs: editor must click "Restart Now" to apply
//   • All errors are non-fatal — a broken update check never blocks the app
// ──────────────────────────────────────────────────────────────────────────────
function setupAutoUpdater(win) {
  if (!app.isPackaged) return; // skip entirely in dev mode

  // Do not auto-install on quit — only install when the user explicitly approves
  autoUpdater.autoInstallOnAppQuit = false;
  // Download in background; the hash is verified before the file is used
  autoUpdater.autoDownload = true;
  // Never install pre-release builds on stable installs
  autoUpdater.allowPrerelease = false;

  const sendStatus = (text) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater-status', text);
    }
  };

  autoUpdater.on('checking-for-update', () => {
    sendStatus('Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    sendStatus(`Update v${info.version} available. Downloading...`);
  });

  autoUpdater.on('update-not-available', () => {
    sendStatus('vTrack is up to date.');
  });

  autoUpdater.on('download-progress', (progressObj) => {
    let percent = Math.round(progressObj.percent);
    sendStatus(`Downloading update: ${percent}%`);
  });

  autoUpdater.on('update-downloaded', () => {
    sendStatus('Update ready to install.');
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'vTrack Update Ready',
      message: 'A new version of vTrack has been downloaded.',
      detail: 'Click "Restart Now" to apply the update, or "Later" to install it the next time vTrack opens.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        // isSilent=false: shows UAC if needed (perMachine install requires admin)
        // isForceRunAfter=true: restarts the app after install
        autoUpdater.quitAndInstall(false, true);
      }
    }).catch((e) => {
      console.warn('[updater] dialog error (non-fatal):', e?.message || e);
    });
  });

  autoUpdater.on('error', (err) => {
    const errorMsg = err == null ? "unknown" : (err.stack || err).toString();
    sendStatus(`Update error: ${errorMsg.substring(0, 50)}...`);
    console.error('[updater] Error:', err);
  });

  // Check 8 seconds after startup so it doesn't slow down the initial load
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => {
      const errorMsg = e == null ? "unknown" : (e.stack || e).toString();
      sendStatus(`Check error: ${errorMsg.substring(0, 50)}...`);
      console.error('[updater] checkForUpdates failed:', e);
    });
  }, 8000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 700,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    title: 'vTrack',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Run the renderer in an OS-level sandbox. The preload only uses
      // contextBridge + ipcRenderer, both of which are sandbox-compatible,
      // so this adds a strong isolation layer with no functional cost.
      sandbox: true,
      // Block <webview>; we never embed external content.
      webviewTag: false,
      // Disallow window.open / target=_blank popups opening arbitrary URLs.
      nodeIntegrationInSubFrames: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  const isDev = !app.isPackaged;

  // --- Security: lock down navigation & popups ---
  // The renderer only ever loads our own UI (local file in prod, Vite dev
  // server in dev) and talks to Supabase via fetch (not navigation). So we
  // hard-block any attempt to navigate the window elsewhere, and route any
  // external link to the user's real browser instead of opening it in-app.
  const DEV_ORIGIN = 'http://localhost:5173';
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(DEV_ORIGIN) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      console.warn('[security] Blocked in-app navigation to:', url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Block attaching <webview> with unexpected settings.
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  if (isDev) {
    mainWindow.loadURL(DEV_ORIGIN);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
  // Initialize Local NeDB Queue
  const dbPath = path.join(app.getPath('userData'), 'sync_queue.db');
  queueDb = new Datastore({ filename: dbPath, autoload: true });
  queueDb.ensureIndex({ fieldName: 'status' });
  queueDb.ensureIndex({ fieldName: 'created_at' });

  createWindow();
  setupAutoUpdater(mainWindow);

  // Power monitor listeners (sleep/wake detection)
  powerMonitor.on('suspend', () => {
    lastSleepTime = Date.now();
    if (mainWindow) {
      mainWindow.webContents.send('power-state-change', 'suspend');
    }
  });

  powerMonitor.on('resume', () => {
    const now = Date.now();
    if (lastSleepTime > 0) {
      const gapMs = now - lastSleepTime;
      // If gap is more than 10 minutes (600000 ms), record it as a sleep gap
      if (gapMs > 600000) {
        sleepGaps.push({ start: lastSleepTime, end: now, durationMinutes: Math.round(gapMs / 60000) });
      }
    }
    lastSleepTime = 0;
    
    if (mainWindow) {
      mainWindow.webContents.send('power-state-change', 'resume');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
  });
} // End of single-instance else block

// Ensure uIOhook is stopped before the process exits.
// On Windows the NSIS installer sends WM_CLOSE to the running app — if uIOhook is
// still attached it can block process exit long enough that the installer gives up
// and shows "cannot be closed" dialog.
//
// Defence-in-depth: set a hard 1.5-second deadline via process.exit so the process
// is ALWAYS gone before installer.nsh's Sleep 2000 completes, even if uIOhook hangs.
app.on('before-quit', () => {
  // Hard deadline: kill the process within 1.5 s no matter what.
  // The timeout is deliberately NOT unref'd so it fires even if Electron's event loop
  // would otherwise drain cleanly (which could still leave uIOhook holding the process).
  const forceExitTimer = setTimeout(() => {
    console.log('[quit] Force-exit deadline reached. Terminating process.');
    process.exit(0);
  }, 1500);

  if (uiohookRunning) {
    try {
      uIOhook.stop();
      uiohookRunning = false;
      console.log('[uIOhook] Stopped on app quit.');
      clearTimeout(forceExitTimer); // Clean exit — cancel the hard deadline
    } catch (e) {
      console.error('[uIOhook] Failed to stop on quit:', e);
      // Deadline timer still running — will force-exit at 1.5 s
    }
  } else {
    clearTimeout(forceExitTimer); // No hook was running, clean exit
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.exit(0);
  }
});

// IPC Handler: Device Info
ipcMain.handle('get-device-info', () => {
  return {
    fingerprint: getDeviceFingerprint(),
    deviceName: os.hostname() || 'Desktop Client',
    deviceOs: `${os.type()} ${os.release()} (${os.arch()})`,
    appVersion: app.getVersion() || '1.0.0'
  };
});

// IPC Handler: Permissions
ipcMain.handle('get-permissions-status', () => {
  return getPermissions();
});

// IPC Handler: Request permissions UI trigger (opens system preferences on macOS)
ipcMain.handle('request-system-permissions', (event, type) => {
  const isMac = process.platform === 'darwin';
  if (!isMac) return getPermissions();

  if (type === 'accessibility') {
    try {
      // This will prompt system dialog if accessibility permissions are missing
      systemPreferences.isTrustedAccessibilityClient(true);
    } catch (e) {
      console.error('Failed to trigger accessibility prompt', e);
    }
  } else if (type === 'screen') {
    try {
      // Trigger macOS screen recording permission prompt programmatically
      const { desktopCapturer } = require('electron');
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
        .then(() => {
          console.log('Triggered screen recording source request');
        })
        .catch(e => {
          console.error('Failed to trigger screen recording prompt', e);
        });
    } catch (e) {
      console.error('Failed to load desktopCapturer', e);
    }
  }
  return getPermissions();
});

ipcMain.handle('capture-screen', async () => {
  try {
    const { desktopCapturer } = require('electron');
    let sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 } // High-res standard capture
    });

    if (!sources || sources.length === 0) {
      throw new Error('No screen sources found');
    }

    // Capture the primary screen (first source in list)
    const primarySource = sources[0];
    const thumbnail = primarySource.thumbnail;

    if (thumbnail.isEmpty()) {
      throw new Error('Screen capture is empty (possible missing screen recording permission)');
    }

    // Limit resolution to maximum width 1920px, keeping aspect ratio
    const size = thumbnail.getSize();
    let width = size.width;
    let height = size.height;
    if (width > 1920) {
      height = Math.round(height * (1920 / width));
      width = 1920;
    }

    const resized = thumbnail.resize({ width, height, quality: 'good' });
    const jpegBuffer = resized.toJPEG(70); // JPEG quality ~70%

    return {
      success: true,
      buffer: jpegBuffer
    };
  } catch (error) {
    console.error('Failed to capture screen:', error);
    return {
      success: false,
      error: error.message
    };
  }
});

// Phase 4D: Save screenshot buffer to disk when offline
ipcMain.handle('save-temp-screenshot', async (event, buffer) => {
  try {
    const filename = `temp_shot_${Date.now()}_${crypto.randomUUID().substring(0,6)}.jpg`;
    const tempPath = path.join(app.getPath('userData'), filename);
    fs.writeFileSync(tempPath, buffer);
    return { success: true, filePath: tempPath };
  } catch (error) {
    console.error('Failed to save temp screenshot:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('read-temp-screenshot', async (event, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    return { success: true, buffer };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// IPC Handler: Set Activity Tracking Status
// Starts / stops uIOhook to match the tracking state so the hook never runs
// when the editor is not clocked in or does not have the feature flag enabled.
ipcMain.handle('set-activity-tracking', (event, enabled) => {
  // Fix C: Validate input type — reject anything that isn't a boolean
  if (typeof enabled !== 'boolean') {
    console.warn('[set-activity-tracking] Invalid argument; expected boolean, got:', typeof enabled);
    return false;
  }

  isActivityTrackingEnabled = enabled;

  if (enabled && !uiohookRunning) {
    try {
      uIOhook.start();
      uiohookRunning = true;
      console.log('[uIOhook] Started — activity tracking enabled.');
    } catch (e) {
      console.error('[uIOhook] Failed to start:', e);
    }
  } else if (!enabled && uiohookRunning) {
    // Fix B: Mark stopped BEFORE calling stop() so state stays consistent even if stop() throws.
    // Without this, a throw leaves uiohookRunning=true and the next clock-in never restarts it.
    uiohookRunning = false;
    try {
      uIOhook.stop();
      console.log('[uIOhook] Stopped — activity tracking disabled.');
    } catch (e) {
      console.error('[uIOhook] Failed to stop:', e);
    }
    // Reset counters so stale counts don't leak into the next session
    keyboardCount = 0;
    mouseCount = 0;
    mouseClickCount = 0;
  }

  return true;
});

// IPC Handler: Get Activity Stats
ipcMain.handle('get-activity-stats', async () => {
  const stats = {
    keyboardCount,
    mouseCount,
    mouseClickCount,
    activeApp: null,
    activeWindowTitle: null
  };
  
  // Reset counters immediately
  keyboardCount = 0;
  mouseCount = 0;
  mouseClickCount = 0;

  if (isActivityTrackingEnabled) {
    try {
      // activeWindow() returns a single WindowInfo object (or undefined) — not an array.
      // accessibilityPermission: false prevents the macOS accessibility prompt.
      // screenRecordingPermission: false avoids the screen recording prompt (title will be empty on macOS if denied).
      const winInfo = await activeWindow({ accessibilityPermission: false, screenRecordingPermission: false });
      if (winInfo) {
        stats.activeApp = winInfo.owner?.name || null;
        let title = winInfo.title || '';
        // Sanitize: strip any URLs from the title and truncate to 120 chars
        title = title.replace(/https?:\/\/[^\s]+/g, '[URL HIDDEN]');
        stats.activeWindowTitle = title.length > 120 ? title.substring(0, 120) + '...' : title;
      }
    } catch (e) {
      console.error('Failed to get active window:', e);
    }
  }

  return stats;
});

// ---------------------------------------------------------
// Phase 4D: Offline Sync Queue & Sleep Gaps IPC Handlers
// ---------------------------------------------------------

ipcMain.handle('get-sleep-gaps', () => {
  const gaps = [...sleepGaps];
  sleepGaps = []; // Clear after retrieving
  return gaps;
});

ipcMain.handle('enqueue-sync-item', async (event, item) => {
  return new Promise((resolve, reject) => {
    const doc = {
      local_id: item.local_id || crypto.randomUUID(),
      type: item.type, // 'activity_log', 'screenshot', 'clock_out'
      payload_json: item.payload_json,
      file_path: item.file_path || null,
      created_at: item.created_at || new Date().toISOString(),
      retry_count: 0,
      last_attempt_at: null,
      status: 'pending', // pending, failed
      error_message: null,
      idempotency_key: item.idempotency_key || crypto.randomUUID()
    };
    queueDb.insert(doc, (err, newDoc) => {
      if (err) return reject(err);
      resolve(newDoc);
    });
  });
});

ipcMain.handle('get-sync-queue', async () => {
  return new Promise((resolve, reject) => {
    // Return all pending or failed items, sorted by oldest first
    queueDb.find({ status: { $in: ['pending', 'failed'] } }).sort({ created_at: 1 }).exec((err, docs) => {
      if (err) return reject(err);
      resolve(docs);
    });
  });
});

ipcMain.handle('update-queue-item', async (event, local_id, updates) => {
  return new Promise((resolve, reject) => {
    queueDb.update({ local_id }, { $set: updates }, {}, (err, numReplaced) => {
      if (err) return reject(err);
      resolve(numReplaced);
    });
  });
});

ipcMain.handle('delete-queue-item', async (event, local_id) => {
  return new Promise((resolve, reject) => {
    // If it's a screenshot, delete the local file before deleting the record
    queueDb.findOne({ local_id }, (err, doc) => {
      if (err) return reject(err);
      if (doc && doc.file_path && fs.existsSync(doc.file_path)) {
        try {
          fs.unlinkSync(doc.file_path);
        } catch (e) {
          console.error('Failed to delete temp screenshot file:', e);
        }
      }
      queueDb.remove({ local_id }, {}, (err, numRemoved) => {
        if (err) return reject(err);
        resolve(numRemoved);
      });
    });
  });
});

ipcMain.handle('get-queue-stats', async () => {
  return new Promise((resolve, reject) => {
    queueDb.find({}, (err, docs) => {
      if (err) return reject(err);
      const pendingCount = docs.filter(d => d.status === 'pending').length;
      const failedCount = docs.filter(d => d.status === 'failed').length;
      resolve({ pendingCount, failedCount });
    });
  });
});

ipcMain.handle('force-sync-retry', async () => {
  return new Promise((resolve, reject) => {
    queueDb.update({ status: 'failed' }, { $set: { status: 'pending', retry_count: 0 } }, { multi: true }, (err, numReplaced) => {
      if (err) return reject(err);
      resolve(numReplaced);
    });
  });
});
