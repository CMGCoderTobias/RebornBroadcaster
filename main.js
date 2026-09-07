const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const tcpServer = require('./tcpServer'); // Make sure this path is correct
const { startIcecastAudioStream } = require('./engines/audioEngineIcecast');
const { ObsWebsocketClient } = require('./adapters/obsWebsocketClient');
const iconv = require('iconv-lite');
const { listenerCount } = require('process');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { autoUpdater } = require('electron-updater');
const { bootstrapAndDoctor, launchStagedApp, reportHealthFromEnvironment } = require('./updaterClient');
const REBORN_UPDATE_FEED_URL = process.env.REBORN_UPDATE_FEED_URL || '';
const _REBORN_PRIMARY_GITHUB_TOKEN = process.env.REBORN_GITHUB_TOKEN || '';
const _REBORN_LEGACY_GITHUB_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
if (!_REBORN_PRIMARY_GITHUB_TOKEN && _REBORN_LEGACY_GITHUB_TOKEN) {
  console.warn('Using legacy GH_TOKEN/GITHUB_TOKEN. Please migrate to REBORN_GITHUB_TOKEN.');
}
const REBORN_GITHUB_TOKEN = _REBORN_PRIMARY_GITHUB_TOKEN || _REBORN_LEGACY_GITHUB_TOKEN || '';
const IS_TESTING = process.env.IS_TESTING === 'true';
const REBORN_REPO_OWNER = "CMGCoderTobias";
const REBORN_REPO_NAME = "RebornBroadcaster";
let appInitialized = false;

function toTestingFeedUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.pathname.includes('/updates-testing/')) return u.toString();

    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('updates');
    if (idx !== -1) parts[idx] = 'updates-testing';
    u.pathname = '/' + parts.join('/');
    return u.toString();
  } catch (err) {
    if (String(rawUrl).includes('/updates-testing/')) return rawUrl;
    return String(rawUrl).replace('/updates/', '/updates-testing/');
  }
}

function configureAutoUpdaterFeed() {
  if (REBORN_UPDATE_FEED_URL) {
    const feedUrl = IS_TESTING ? toTestingFeedUrl(REBORN_UPDATE_FEED_URL) : REBORN_UPDATE_FEED_URL;
    console.log('Using backend update feed:', feedUrl);
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
    return;
  }

  // Only override to GitHub feed if we actually need prerelease support or a private token.
  if (!IS_TESTING && !REBORN_GITHUB_TOKEN) return;

  const githubConfig = {
    provider: "github",
    owner: REBORN_REPO_OWNER,
    repo: REBORN_REPO_NAME,
    prerelease: IS_TESTING,
  };

  if (REBORN_GITHUB_TOKEN) {
    githubConfig.private = true;
    githubConfig.token = REBORN_GITHUB_TOKEN;
  }

  console.log('Using GitHub updates.', IS_TESTING ? '(testing/prerelease allowed)' : '');
  autoUpdater.setFeedURL(githubConfig);
}

function configureAutoUpdaterFeedGitHub() {
  const githubConfig = {
    provider: "github",
    owner: REBORN_REPO_OWNER,
    repo: REBORN_REPO_NAME,
    prerelease: IS_TESTING,
  };

  if (REBORN_GITHUB_TOKEN) {
    githubConfig.private = true;
    githubConfig.token = REBORN_GITHUB_TOKEN;
  }

  console.log('Falling back to GitHub updates.', IS_TESTING ? '(testing/prerelease allowed)' : '');
  autoUpdater.setFeedURL(githubConfig);
  return true;
}
const isDev = !app.isPackaged; // Correctly detects if running in dev mode
const ffmpegPath = isDev
  ? require('ffmpeg-static')
  : path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');

function getPreloadPath() {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar', 'preload.js')
        : path.join(__dirname, 'preload.js');
}

function getMigrationPreloadPath() {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar', 'migrationPreload.js')
        : path.join(__dirname, 'migrationPreload.js');
}

function normalizeMountpoint(mountpoint) {
    const raw = String(mountpoint ?? '').trim();
    const cleaned = raw.replace(/^\/+/, '').replace(/\s+/g, '');
    return cleaned ? `/${cleaned}` : '';
}

function toInt(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    const parsed = parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(parsed) ? parsed : NaN;
}


function detectObsInstalled(customPath = '') {
  try {
    if (customPath && fs.existsSync(customPath)) return { installed: true, path: customPath };

    const candidates = [];
    const pf = process.env.ProgramFiles;
    const pfx86 = process.env["ProgramFiles(x86)"];

    if (pf) candidates.push(path.join(pf, 'obs-studio', 'bin', '64bit', 'obs64.exe'));
    if (pfx86) candidates.push(path.join(pfx86, 'obs-studio', 'bin', '64bit', 'obs64.exe'));

    for (const p of candidates) {
      if (p && fs.existsSync(p)) return { installed: true, path: p };
    }

    return { installed: false, path: '' };
  } catch (err) {
    return { installed: false, path: '', error: err?.message || String(err) };
  }
}

function normalizeBool(v, defaultValue = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return defaultValue;
}
function sanitizeSettingsForApi(settings) {
    const safe = { ...(settings || {}) };

    if ('sourcepassword' in safe) {
        safe.sourcepassword = safe.sourcepassword ? '***' : '';
        safe.hasSourcePassword = !!(settings && settings.sourcepassword);
    }

    if ('obsPassword' in safe) {
        safe.obsPassword = safe.obsPassword ? '***' : '';
        safe.hasObsPassword = !!(settings && settings.obsPassword);
    }

    return safe;
}


    function createDownloadingWindow() {
        if (isHeadless) return;
        downloadingWindow = new BrowserWindow({
        width: 400,
        height: 200,
        frame: false,
        webPreferences: {
            preload: getPreloadPath(),
            contextIsolation: true,
            nodeIntegration: false,
        },
        });
        downloadingWindow.loadFile(path.join(__dirname, 'downloading.html'));  // Show "Downloading..." page
    }
  
  // Function to handle app initialization
  function initializeApp() {
    if (appInitialized) return;
    appInitialized = true;
    console.log("App Initialization started...");
    if (isSmokeTest) {
      console.log('[smoke-test]', JSON.stringify(buildStateSnapshot()));
      setTimeout(() => app.quit(), 250);
      return;
    }
    loadAudioDevices(); // Example: Initialize any audio-related features
    
    createWindow(); // Open the main window of the app
    
    // Start the TCP server or any other background services
    tcpServer.startTCPServer();
    setTimeout(() => reportHealthFromEnvironment(app.getVersion()), 1000);
    
    // Ensure that the app behaves as expected when activated (e.g., no duplicate windows)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();  // If no windows exist, create a new one
      }
    });
  }
  
  // Function to set up auto-updater with downloading and install handling
  function setupAutoUpdater() {
  console.log('Setting up auto-updater...');

  const hasBackendFeed = !!REBORN_UPDATE_FEED_URL;
  let usedGithubFallback = false;

  configureAutoUpdaterFeed();

  let startupDone = false;
  let checkTimeout = null;
  let downloadTimeout = null;

  const safeInitialize = (reason) => {
    if (startupDone) return;
    startupDone = true;

    if (checkTimeout) clearTimeout(checkTimeout);
    if (downloadTimeout) clearTimeout(downloadTimeout);

    if (reason) console.log(`[updater] continuing startup (${reason})`);
    initializeApp();
  };

  const restartCheckTimeout = () => {
    if (checkTimeout) clearTimeout(checkTimeout);
    checkTimeout = setTimeout(() => {
      if (tryGithubFallback('check-timeout')) return;
      console.warn('[updater] check timeout; continuing startup');
      safeInitialize('check-timeout');
    }, 8000);
  };

  const tryGithubFallback = (reason) => {
    if (!hasBackendFeed) return false;
    if (usedGithubFallback) return false;

    usedGithubFallback = true;
    console.warn(`[updater] backend feed failed (${reason}); retrying via GitHub`);

    const ok = configureAutoUpdaterFeedGitHub();
    if (!ok) return false;

    autoUpdater.checkForUpdates();
    restartCheckTimeout();
    return true;
  };

  autoUpdater.on('update-available', () => {
    console.log('Update available. Downloading...');

    if (checkTimeout) {
      clearTimeout(checkTimeout);
      checkTimeout = null;
    }

    if (!isHeadless) createDownloadingWindow();

    // If downloads hang forever, don't block the broadcaster.
    downloadTimeout = setTimeout(() => {
      console.warn('[updater] download timeout; continuing startup');
      safeInitialize('download-timeout');
    }, 5 * 60 * 1000);
  });

  autoUpdater.on('update-downloaded', () => {
    console.log('Update downloaded. Installing...');
    if (downloadTimeout) clearTimeout(downloadTimeout);
    autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (error) => {
    console.error('Error in update process:', error?.message || error);
    if (tryGithubFallback('error')) return;
    safeInitialize('error');
  });

  autoUpdater.on('update-not-available', () => {
    console.log('No update available.');
    safeInitialize('no-update');
  });

  // Kick off update check (no notify in a broadcaster app)
  autoUpdater.checkForUpdates();

  // If the check hangs (offline, DNS, etc), continue startup.
  restartCheckTimeout();
}

const isSmokeTest = process.argv.includes('--smoke-test');
let isHeadless = process.argv.includes('--headless') || isSmokeTest;
const settingsFilePath = path.join(app.getPath('userData'), 'settings.json');
const isSingleInstance = app.requestSingleInstanceLock();

let listenerInterval = null;
let currentListenerCount = 0;
let mainWindow = null;
let settingsWindow = null;
let aboutWindow = null;
let downloadingWindow = null;
let migrationWindow = null;
let migrationRunning = false;
let latestMigrationStatus = null;
let ffmpegProcess = null;
let ffmpegRecordingProcess = null;
let audioEngine = null;
let obsClient = null;
let isStreaming = false;
let isRecording = false;
let lastFfmpegError = '';
let lastIcecastStatusTest = null;
let lastListenUrlTest = null;
let nowPlaying = '';
const liveMode = { icecast: false, obs: false };
let streamTimer = 0;
let recordingTimer = 0;
let recordingTimerInterval = null;
let streamTimerInterval = null;
const audioDevicesCache = [];

global.streamActive = false;
global.recordingActive = false;

function createMigrationWindow() {
    if (migrationWindow && !migrationWindow.isDestroyed()) return migrationWindow;
    migrationWindow = new BrowserWindow({
        width: 560,
        height: 420,
        minWidth: 500,
        minHeight: 380,
        maximizable: false,
        closable: false,
        title: 'Updating RebornBroadcaster',
        backgroundColor: '#0b1020',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: getMigrationPreloadPath(),
        },
    });
    migrationWindow.setMenuBarVisibility(false);
    migrationWindow.loadFile(path.join(__dirname, 'migration.html'));
    migrationWindow.webContents.on('did-finish-load', () => {
        if (latestMigrationStatus) migrationWindow?.webContents.send('migration-status', latestMigrationStatus);
    });
    migrationWindow.on('closed', () => { migrationWindow = null; });
    return migrationWindow;
}

function setMigrationStatus(status) {
    latestMigrationStatus = status;
    if (migrationWindow && !migrationWindow.isDestroyed() && !migrationWindow.webContents.isLoading()) {
        migrationWindow.webContents.send('migration-status', status);
    }
}

function migrationError(result) {
    return result?.error || result?.stderr || result?.stdout || 'The native update could not be prepared.';
}

async function runAgentMigration() {
    if (migrationRunning) return;
    migrationRunning = true;
    createMigrationWindow();
    setMigrationStatus({
        state: 'working',
        title: 'Preparing the native broadcaster',
        message: 'Starting the secure update handoff…',
    });

    try {
        const result = await bootstrapAndDoctor(app, IS_TESTING, shell, ({ phase, message }) => {
            setMigrationStatus({ state: 'working', phase, title: 'Updating RebornBroadcaster', message });
        });
        if (!result.ok) {
            console.warn(`[updater] agent migration failed during ${result.phase || 'startup'}: ${migrationError(result)}`);
            setMigrationStatus({
                state: 'error',
                title: 'The native update did not finish',
                message: migrationError(result),
            });
            return;
        }

        setMigrationStatus({
            state: 'working',
            title: 'Starting native RebornBroadcaster',
            message: 'The update is verified. Activating it and opening the new app…',
        });
        tcpServer.stopTCPServer?.();
        const launch = await launchStagedApp();
        if (!launch.ok) throw new Error(launch.error);
        setMigrationStatus({
            state: 'success',
            title: 'Native RebornBroadcaster is open',
            message: 'Migration finished successfully. The legacy Electron app will now close, and the Reborn Update Agent will remain in the system tray.',
        });
        await new Promise((resolve) => setTimeout(resolve, 900));
        app.quit();
    } catch (error) {
        console.error('[updater] unexpected agent migration failure:', error);
        setMigrationStatus({
            state: 'error',
            title: 'The native update did not finish',
            message: error?.message || String(error),
        });
    } finally {
        migrationRunning = false;
    }
}

ipcMain.on('migration-retry', () => {
    if (!migrationRunning) runAgentMigration();
});

ipcMain.on('migration-continue-legacy', () => {
    if (migrationRunning) return;
    initializeApp();
    if (migrationWindow && !migrationWindow.isDestroyed()) {
        migrationWindow.setClosable(true);
        migrationWindow.close();
    }
    setupAutoUpdater();
});

function readSettingsFromDisk() {
    try {
        if (!fs.existsSync(settingsFilePath)) return {};
        return JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    } catch (error) {
        console.error('Unable to read settings:', error?.message || error);
        return {};
    }
}

function stripSecretsForExport(settings) {
    const exported = { ...(settings || {}) };
    delete exported.sourcepassword;
    delete exported.obsPassword;
    return exported;
}

function sendToApi(data) {
    const socket = tcpServer.getApiSocket();
    if (!tcpServer.getIsApiConnected() || !socket || socket.destroyed) return false;
    socket.write(`${JSON.stringify(data)}\n`);
    return true;
}

function sendSettingsToApi(settings) {
    return sendToApi({ type: 'settings', settings: sanitizeSettingsForApi(settings) });
}

function buildStateSnapshot() {
    return {
        ok: true,
        version: app.getVersion(),
        headless: isHeadless,
        streaming: isStreaming,
        recording: isRecording,
        outputs: {
            icecast: { active: liveMode.icecast },
            obs: { active: liveMode.obs },
        },
        listeners: currentListenerCount,
        nowPlaying,
        timers: { stream: streamTimer, recording: recordingTimer },
        diagnostics: {
            ffmpeg: lastFfmpegError,
            icecast: lastIcecastStatusTest,
            listenUrl: lastListenUrlTest,
        },
    };
}

function startStreamTimer() {
    startTimers();
}

function stopStreamTimer() {
    stopTimers();
}

function switchMode(fromApi = false) {
    isHeadless = !isHeadless;
    if (isHeadless) {
        mainWindow?.hide();
        if (fromApi) sendToApi({ type: 'renderer-hidden', status: 'headless mode' });
        return;
    }

    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else {
        mainWindow.show();
        mainWindow.focus();
    }
    if (fromApi) sendToApi({ type: 'renderer-visible', status: 'normal mode' });
}

async function handleAppClose(sender, callType) {
    const apiConnected = tcpServer.getIsApiConnected();
    if (callType === 'Total') {
        if (apiConnected) sendToApi({ type: 'disconnect', reason: 'graceful' });
        gracefulShutdown();
        return;
    }

    if (callType === 'Partial') {
        if (sender === 'Api' && apiConnected) sendToApi({ type: 'disconnect', reason: 'graceful' });
        if (sender === 'Renderer' && !apiConnected) {
            gracefulShutdown();
            return;
        }
        isHeadless = true;
        mainWindow?.hide();
        return;
    }

    if (callType !== 'Warning') return;
    if (sender === 'Api' && apiConnected) sendToApi({ type: 'disconnect', reason: 'graceful' });
    if (isHeadless || !mainWindow || mainWindow.isDestroyed()) {
        gracefulShutdown();
        return;
    }

    const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Close App', 'Minimize to Background'],
        defaultId: 0,
        cancelId: 1,
        title: 'RebornBroadcaster',
        message: 'Do you want to close RebornBroadcaster?',
        detail: 'Closing stops all services. Minimizing keeps broadcasting services available.',
    });
    if (response === 0) gracefulShutdown();
    else {
        isHeadless = true;
        mainWindow.hide();
    }
}

function createWindow() {
    if (isHeadless) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        return;
    }

    mainWindow = new BrowserWindow({
        width: 760,
        height: 780,
        minWidth: 560,
        minHeight: 480,
        frame: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: getPreloadPath(),
        },
    });
    mainWindow.loadFile('broadcaster.html');
    mainWindow.on('closed', () => {
        if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
        settingsWindow = null;
        mainWindow = null;
    });
}

function startListenerCountPolling(settings) {
    if (listenerInterval) return;
    const host = String(settings.icecastHost || '').trim();
    const port = toInt(settings.icecastPort);
    const mount = normalizeMountpoint(settings.mountpoint) || '/stream';
    if (!host || !Number.isFinite(port)) return;

    listenerInterval = setInterval(async () => {
        try {
            const response = await fetch(`http://${host}:${port}/status-json.xsl`);
            if (!response.ok) throw new Error(`Icecast status returned HTTP ${response.status}`);
            const data = await response.json();
            const sources = data?.icestats?.source;
            const sourceList = Array.isArray(sources) ? sources : (sources ? [sources] : []);
            const source = sourceList.find((item) => {
                const itemMount = normalizeMountpoint(item?.mount || '');
                const listenPath = item?.listenurl ? new URL(item.listenurl).pathname : '';
                return itemMount === mount || normalizeMountpoint(listenPath) === mount;
            });
            currentListenerCount = isStreaming ? Number(source?.listeners || 0) : 0;
            BrowserWindow.getAllWindows().forEach((window) => {
                window.webContents.send('listener-count-updated', currentListenerCount);
                window.webContents.send('stream-status-updated', isStreaming ? 'Live' : 'Offline');
            });
        } catch (error) {
            console.warn('Unable to poll Icecast listener count:', error?.message || error);
        }
    }, 5000);
}

function stopListenerCountPolling() {
    if (listenerInterval) clearInterval(listenerInterval);
    listenerInterval = null;
    currentListenerCount = 0;
    BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send('listener-count-updated', 0);
        window.webContents.send('stream-status-updated', 'Offline');
    });
}

function gracefulShutdown() {
    try { obsClient?.close?.(); } catch (_) {}
    try { ffmpegProcess?.kill?.('SIGINT'); } catch (_) {}
    try { ffmpegRecordingProcess?.stdin?.write?.('q\n'); } catch (_) {}
    stopListenerCountPolling();
    tcpServer.stopTCPServer?.();
    app.quit();
}

function startRecording({ settings, event = null, respond = null }) {
    const reply = (payload) => {
        event?.reply?.('start-recording-response', payload);
        respond?.(payload);
    };
    if (!settings?.recordingPath || !settings?.audioSourceName) {
        reply({ success: false, message: 'Recording path and audio source are required' });
        return;
    }
    if (isRecording || (ffmpegRecordingProcess && !ffmpegRecordingProcess.killed)) {
        reply({ success: false, message: 'Recording is already running' });
        return;
    }
    if (!fs.existsSync(settings.recordingPath)) {
        reply({ success: false, message: 'The recording path does not exist' });
        return;
    }

    const encoding = String(settings.encodingType || 'mp3').toLowerCase();
    const bitrate = Math.max(32, toInt(settings.bitrate) || 128);
    const formats = {
        mp3: { codec: 'libmp3lame', format: 'mp3', extension: 'mp3', options: ['-b:a', `${bitrate}k`] },
        aac: { codec: 'aac', format: 'adts', extension: 'aac', options: ['-b:a', `${bitrate}k`] },
        flac: { codec: 'flac', format: 'flac', extension: 'flac', options: [] },
        opus: { codec: 'libopus', format: 'ogg', extension: 'opus', options: ['-b:a', `${bitrate}k`] },
    };
    const selected = formats[encoding];
    if (!selected) {
        reply({ success: false, message: `Unsupported recording encoding: ${encoding}` });
        return;
    }

    const filename = `recording_${new Date().toISOString().replace(/[:.-]/g, '_')}.${selected.extension}`;
    const outputPath = path.join(settings.recordingPath, filename);
    const args = [
        '-hide_banner', '-nostats',
        '-f', 'dshow', '-i', `audio=${settings.audioSourceName}`,
        '-acodec', selected.codec, ...selected.options,
        '-f', selected.format, outputPath,
    ];

    let replied = false;
    const replyOnce = (payload) => {
        if (replied) return;
        replied = true;
        reply(payload);
    };
    try {
        const processHandle = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
        ffmpegRecordingProcess = processHandle;
        processHandle.once('spawn', () => {
            isRecording = true;
            global.recordingActive = true;
            startTimers();
            sendLog(`Recording started: ${outputPath}`);
            replyOnce({ success: true, message: 'Recording started', filePath: outputPath });
        });
        processHandle.stderr.on('data', (data) => {
            const line = String(data).trim();
            if (line) sendLog(`[recording] ${line}`);
        });
        processHandle.once('error', (error) => {
            isRecording = false;
            global.recordingActive = false;
            if (ffmpegRecordingProcess === processHandle) ffmpegRecordingProcess = null;
            stopTimers();
            replyOnce({ success: false, message: error.message });
        });
        processHandle.once('exit', (code, signal) => {
            isRecording = false;
            global.recordingActive = false;
            if (ffmpegRecordingProcess === processHandle) ffmpegRecordingProcess = null;
            stopTimers();
            sendLog(`Recording stopped (code ${code ?? 'none'}, signal ${signal || 'none'})`);
        });
    } catch (error) {
        ffmpegRecordingProcess = null;
        isRecording = false;
        global.recordingActive = false;
        replyOnce({ success: false, message: error.message });
    }
}

// Function to start the stream and recording timer
function startTimers() {
    // Start stream timer if it's not already running
    if (!streamTimerInterval && isStreaming) {
        streamTimerInterval = setInterval(() => {
            streamTimer++; // Increment the stream timer
            broadcastTimers(); // Broadcast both timers to renderer and API
            console.log(`Stream Timer: ${streamTimer}s | Recording Timer: ${recordingTimer}s`);
        }, 1000); // Update every second
    }

    // Start recording timer if it's not already running
    if (!recordingTimerInterval && isRecording) {
        recordingTimerInterval = setInterval(() => {
            recordingTimer++; // Increment the recording timer
            broadcastTimers(); // Broadcast both timers to renderer and API
            console.log(`Stream Timer: ${streamTimer}s | Recording Timer: ${recordingTimer}s`);
        }, 1000); // Update every second
    }
}


// Function to stop the timers
function stopTimers() {
    // Stop stream timer if active
    if (streamTimerInterval && !isStreaming) {
        clearInterval(streamTimerInterval);
        streamTimerInterval = null;
        streamTimer = 0; // Reset stream timer
    }

    // Stop recording timer if active
    if (recordingTimerInterval && !isRecording) {
        clearInterval(recordingTimerInterval);
        recordingTimerInterval = null;
        recordingTimer = 0; // Reset recording timer
    }

    // Broadcast the reset timers
    broadcastTimers();
}

// Function to broadcast the updated timers to renderer and API
function broadcastTimers() {
    // Send the updated timers to the renderer (UI)
    if (mainWindow) {
        mainWindow.webContents.send('timer-update', {
            streamTime: streamTimer, // Current stream time
            recordingTime: recordingTimer // Current recording time
        });
    }

    // Optionally send to an API
    if (tcpServer.getIsApiConnected()) {
        sendToApi({
            type: 'timers',
            streamTime: streamTimer,
            recordingTime: recordingTimer
        });
    }
}

function sendLog(...parts) {
    const message = parts
        .filter(p => p !== undefined && p !== null)
        .map(p => (typeof p === 'string' ? p : (p instanceof Error ? p.message : JSON.stringify(p))))
        .join(' ')
        .trim();
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${message}`;

    // 1. Send to renderer if available
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('log-message', formatted);
    }

    // 2. Send to API if connected
    if (tcpServer.getIsApiConnected()) {
        sendToApi({ type: 'log', message: formatted });
        console.log('sent.to.api');
    }

    // 3. Fallback
    console.log(formatted);
}




// Function to create the settings window (popout)
function openSettings() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.close();
        settingsWindow = null;
    }

    // Determine the correct path for the preload script in packaged and development modes
    const preloadPath = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar', 'preload.js')  // For packaged app
        : path.join(__dirname, 'preload.js');  // For development mode

    // Create the settings window
    settingsWindow = new BrowserWindow({
        width: 600,
        height: 720,
        maxWidth: 600,      // Maximum width the window can be resized to
        frame:false,
        webPreferences: {
            preload: preloadPath,  // Use the correct path to preload.js
        },
    });

    settingsWindow.loadFile('settings.html');  // Load the settings page
}

function openAbout() {
    if (aboutWindow && !aboutWindow.isDestroyed()) {
        aboutWindow.focus();
        return;
    }

    aboutWindow = new BrowserWindow({
        width: 700,
        height: 720,
        maxWidth: 900,
        frame: false,
        webPreferences: {
            preload: getPreloadPath(),
        },
    });

    aboutWindow.loadFile('about.html');
    aboutWindow.on('closed', () => {
        aboutWindow = null;
    });
}


// Function to load audio devices when app starts
async function loadAudioDevices() {
    console.log("Loading audio devices on app startup...");

    exec(`"${ffmpegPath}" -list_devices true -f dshow -i dummy`, (error, stdout, stderr) => {
        if (error) {
            console.error("Error loading audio devices on app startup:", error.message);
            return;
        }

        if (stderr) {
            console.warn("FFmpeg stderr output:", stderr);
        }

        const output = (stdout + '\n' + stderr).split('\n');
        const devices = output.filter(line => line.includes('audio'));

        if (devices.length === 0) {
            console.error("No audio devices found on startup.");
            return;
        }

        // Now map the devices into an array of objects with both id and name
        const deviceList = devices.map((line, index) => {
            const match = line.match(/"(.+)"/);
            return match ? { id: index, name: match[1] } : null;
        }).filter(Boolean);  // Filter out any null values

        // Cache the devices with both id and name
        audioDevicesCache.push(...deviceList);

        console.log("Cached audio devices on app startup:", deviceList);
    });
}



function startIcecastEngine(settings, { event = null, respond = null } = {}) {
  const missingFields = ['mountpoint', 'username', 'sourcepassword', 'icecastHost', 'icecastPort', 'bitrate', 'encodingType', 'audioSourceName']
    .filter((f) => !settings?.[f]);

  if (missingFields.length) {
    const msg = `? Missing required settings: ${missingFields.join(', ')}`;
    sendLog(msg);
    event?.reply?.('start-stream-response', { success: false, message: msg });
    respond?.({ success: false, message: msg });
    throw new Error(msg);
  }

  if (audioEngine?.proc && !audioEngine.proc.killed) {
    return;
  }

  const effectiveSettings = { ...settings };

  const engine = startIcecastAudioStream({
    ffmpegPath,
    settings: effectiveSettings,
    onLog: (t) => sendLog(String(t).trim()),
    onStatus: (s) => {
      if (s?.type === 'backoff') {
        lastFfmpegError = `Backoff: targetBitrate=${s.targetBitrate} speed=${s.speed}`;
      }
    },
    onNeedRestart: ({ newBitrate }) => {
      // Backoff should not block OBS or UI; restart only the Icecast engine.
      if (!global.streamActive) return;

      try {
        sendLog(`?? FFmpeg slow. Backing off bitrate to ${newBitrate}kbps and restarting Icecast stream...`);
        const next = { ...readSettingsFromDisk(), bitrate: newBitrate };
        stopIcecastEngine();
        setTimeout(() => {
          try {
            startIcecastEngine(next, { event: null, respond: null });
          } catch (err) {
            sendLog(`? Backoff restart failed: ${err?.message || err}`);
          }
        }, 800);
      } catch (_) {}
    }
  });

  audioEngine = engine;
  ffmpegProcess = engine.proc;

  global.streamActive = true;
  isStreaming = true;
  liveMode.icecast = true;

  event?.reply?.('start-stream-response', { success: true, message: 'Stream started', url: engine.outputUrl });
  respond?.({ success: true, message: 'Stream started', url: engine.outputUrl });

  // timers + listeners
  startStreamTimer();
  startListenerCountPolling(effectiveSettings);

  BrowserWindow.getAllWindows().forEach((win) => {
    try { win.webContents.send('stream-status-updated', 'Online'); } catch (_) {}
  });
}

function stopIcecastEngine() {
  try {
    audioEngine?.stop?.();
  } catch (_) {}
  audioEngine = null;

  try { ffmpegProcess?.kill?.('SIGINT'); } catch (_) {}
  ffmpegProcess = null;
  global.streamActive = false;
  isStreaming = false;
  liveMode.icecast = false;

  stopStreamTimer();
  stopListenerCountPolling();

  BrowserWindow.getAllWindows().forEach((win) => {
    try { win.webContents.send('stream-status-updated', 'Offline'); } catch (_) {}
  });
}

async function getObsClient(settings) {
  const host = String(settings.obsHost || '127.0.0.1').trim();
  const port = Number(settings.obsPort || 4455);
  const password = String(settings.obsPassword || '');

  if (!obsClient || obsClient.host !== host || obsClient.port !== port || obsClient.password !== password) {
    try { obsClient?.close?.(); } catch (_) {}
    obsClient = new ObsWebsocketClient({ host, port, password });
  }

  return obsClient;
}

async function startObsLive(settings) {
  const obsInstalled = detectObsInstalled(settings.obsExePath);
  if (!obsInstalled.installed) {
    throw new Error('OBS not installed (or path not detected).');
  }

  const client = await getObsClient(settings);
  await client.startStream();
  liveMode.obs = true;
}

async function stopObsLive(settings) {
  const client = await getObsClient(settings);
  await client.stopStream();
  liveMode.obs = false;
}

async function goLive(settings, { event = null, respond = null } = {}) {
  const s = settings || {};
  const icecastEnabled = s.icecastEnabled !== false;
  const obsEnabled = !!s.obsEnabled;

  const results = { icecast: 'skipped', obs: 'skipped', errors: {} };

  if (icecastEnabled) {
    try {
      startIcecastEngine(s, { event: null, respond: null });
      results.icecast = 'on';
    } catch (err) {
      results.icecast = 'error';
      results.errors.icecast = err?.message || String(err);
    }
  }

  if (obsEnabled) {
    try {
      await startObsLive(s);
      results.obs = 'on';
    } catch (err) {
      results.obs = 'error';
      results.errors.obs = err?.message || String(err);
    }
  }

  const anyOn = results.icecast === 'on' || results.obs === 'on';

  event?.reply?.('go-live-response', { success: anyOn, result: results });
  respond?.({ success: anyOn, result: results });
  sendLog(`Go Live: ${JSON.stringify(results)}`);

  if (!anyOn) {
    throw new Error(results.errors?.obs || results.errors?.icecast || 'Go Live failed');
  }

  return results;
}
async function stopLive(settings, { event = null, respond = null } = {}) {
  const s = settings || {};
  const icecastEnabled = s.icecastEnabled !== false;
  const obsEnabled = !!s.obsEnabled;

  const results = { icecast: 'skipped', obs: 'skipped', errors: {} };

  if (obsEnabled) {
    try {
      await stopObsLive(s);
      results.obs = 'off';
    } catch (err) {
      results.obs = 'error';
      results.errors.obs = err?.message || String(err);
    }
  }

  if (icecastEnabled) {
    try {
      stopIcecastEngine();
      results.icecast = 'off';
    } catch (err) {
      results.icecast = 'error';
      results.errors.icecast = err?.message || String(err);
    }
  }

  const okIcecast = results.icecast === 'off' || results.icecast === 'skipped';
  const okObs = results.obs === 'off' || results.obs === 'skipped';
  const success = okIcecast && okObs;

  event?.reply?.('stop-live-response', { success, result: results });
  respond?.({ success, result: results });
  sendLog(`Stop Live: ${JSON.stringify(results)}`);

  // Don't throw unless *everything* failed.
  if (!success && okIcecast === false && okObs === false) {
    throw new Error('Stop Live had errors');
  }

  return results;
}


function getWindowFromWebContents(sender) {
    return BrowserWindow.fromWebContents(sender);
}

ipcMain.on('window-minimize', (event) => {
    const win = getWindowFromWebContents(event.sender);
    if (win) win.minimize();
});

ipcMain.on('window-close', (event) => {
    const win = getWindowFromWebContents(event.sender);
    if (win) win.close();
});


// Handler for starting the stream
ipcMain.on('start-stream', (event) => {
    const settings = readSettingsFromDisk() || {};
    try {
      startIcecastEngine(settings, { event });
    } catch (err) {
      event.reply('start-stream-response', { success: false, message: err?.message || String(err) });
    }
});
// Handler for starting the recording
ipcMain.on('start-recording', (event) => {
    console.log("🎙️ Start recording request received...");

    const settings = readSettingsFromDisk() || {};

    const hasReply = event && typeof event.reply === 'function';
    const respond = hasReply
        ? null
        : (payload) => sendToApi({ type: 'start-recording-response', ...payload });

    startRecording({ settings, event: hasReply ? event : null, respond });
});






// The load-for-use function that is specifically used to fetch settings when starting the stream or recording
ipcMain.on('load-for-use', (event) => {
    console.log("🟢 Loading settings before stream/recording...");

    try {
        // Read the settings from the file
        const rawData = fs.readFileSync(settingsFilePath, 'utf-8');
        const settings = JSON.parse(rawData);
        console.log('Settings loaded successfully:', settings);

        // Check if essential settings are valid for streaming/recording
        if (!settings.mountpoint) {
            console.error("❌ Missing required setting: mountpoint");
            event.reply('load-settings-response', { error: 'Missing required setting: mountpoint' });
            sendLog('Missing Mountpoint');

            return;
        }
        if (!settings.username) {
            console.error("❌ Missing required setting: Username");
            event.reply('load-settings-response', { error: 'Missing required setting: Username' });
            sendLog('Missing Username');
            return;
        }

        if (!settings.sourcepassword) {
            console.error("❌ Missing required setting: sourcepassword");
            event.reply('load-settings-response', { error: 'Missing required setting: sourcepassword' });
            sendLog('Missing Password');
            return;
        }

        if (!settings.icecastHost) {
            console.error("❌ Missing required setting: Ip Address");
            event.reply('load-settings-response', { error: 'Missing required setting: Ip Address' });
            sendLog('Missing Ip Address');

            return;
        }

        if (!settings.icecastPort) {
            console.error("❌ Missing required setting: Port");
            event.reply('load-settings-response', { error: 'Missing required setting: port' });
            sendLog('Missing Port');
            return;
        }


        if (!settings.audioSourceName) {
            console.error("❌ Missing required setting: audioSourceName");
            event.reply('load-settings-response', { error: 'Missing required setting: audioSourceName' });
            sendLog('Missing Audio Source');
            return;
        }

        if (!settings.encodingType) {
            console.error("❌ Missing required setting: encodingType");
            event.reply('load-settings-response', { error: 'Missing required setting: encodingType' });
            sendLog('Missing encoding Type')
            return;
        }

        if (!settings.bitrate) {
            console.error("❌ Missing required setting: bitrate");
            event.reply('load-settings-response', { error: 'Missing required setting: bitrate' });
            sendLog('Missing Bitrate')
            return;
        }

        if (!settings.recordingPath) {
            console.error("❌ Missing required setting: recordingPath");
            event.reply('load-settings-response', { error: 'Missing required setting: recordingPath' });
            sendLog('Missing Recording Path')
            return;
        }

        console.log("✅ All required settings are valid for stream/recording");

        // Instead of responding to the renderer, emit an internal event indicating success
        ipcMain.emit('settings-loaded', settings);

    } catch (err) {
        console.error('Error loading settings for use:', err);
        event.reply('load-settings-response', { error: 'Failed to load settings for use' });
    }
});







// Stop the recording gracefully (using ipcMain.on) with headless and API connection checks
ipcMain.on('stop-recording', (event) => {
    if (!isRecording) {
        console.error('No active recording to stop');
        // Only reply if event is defined (renderer process)
        if (event) {
            event.reply('stop-recording-response', 'No active recording to stop');
        }
        if (tcpServer.getIsApiConnected()) {
            sendToApi({ type: 'stop-recording-response', success: false, message: 'No active recording to stop' });
        }
        return;
    }

    console.log('Stopping recording gracefully...');

    // Send the "q" command to FFmpeg through stdin to tell it to finish and exit gracefully
    ffmpegRecordingProcess.stdin.write('q\n'); // Sends the 'quit' command to FFmpeg to stop gracefully

    // Check if the application is in headless mode and if the API is connected
    if (isHeadless) {
        if (tcpServer.getIsApiConnected()) {
            sendToApi({ action: 'stop-recording' }); // Notify API of stop request
        }
    } else {
        // If not in headless mode, communicate with the renderer process (UI)
        if (mainWindow) {
            mainWindow.webContents.send('stop-recording-ui', 'Recording is stopping gracefully.');
        }
    }

    // Listen for the process exit
    ffmpegRecordingProcess.on('exit', (code, signal) => {
        const success = code === 0;
        const message = success
            ? 'Recording stopped successfully'
            : `Recording failed to stop (code: ${code}, signal: ${signal})`;

        if (code === 0) {
            console.log(`Recording stopped gracefully with exit code: ${code}`);
            if (event) {
                event.reply('stop-recording-response', message);
            }
        } else {
            console.error(`FFmpeg exited with code: ${code}, signal: ${signal}`);
            if (event) {
                event.reply('stop-recording-response', message);
            }
        }

        ffmpegRecordingProcess = null; // Clear the process reference
        isRecording = false; // Reset the recording state
        global.recordingActive = false;
        if (tcpServer.getIsApiConnected()) {
            sendToApi({ type: 'recording-status', status: 'stopped', code, signal });
            sendToApi({ type: 'stop-recording-response', success, message, code, signal });
        }
    });

    // Optional timeout in case FFmpeg hangs and doesn't exit (can be adjusted as necessary)
    setTimeout(() => {
        if (isRecording) {
            console.warn('Recording stop timed out, forcing process termination');
            ffmpegRecordingProcess.kill(); // Forcefully kill the process if it takes too long
            isRecording = false;
            if (event) {
                event.reply('stop-recording-response', 'Recording stop timed out, process killed');
            }
            if (tcpServer.getIsApiConnected()) {
                sendToApi({ type: 'stop-recording-response', success: false, message: 'Recording stop timed out, process killed' });
            }
        }
    }, 10000); // Wait for 10 seconds before forcefully killing the process
});




// Stop the streaming gracefully (using ipcMain.on) with headless and API connection checks
ipcMain.on('stop-stream', (event) => {
    try {
      stopIcecastEngine();
      event.reply('stop-stream-response', { success: true, message: 'Stream stopped' });
    } catch (err) {
      event.reply('stop-stream-response', { success: false, message: err?.message || String(err) });
    }
});


// Get the current recording status
ipcMain.on('get-recording-status', (event) => {
    event.reply('get-recording-status-response', isRecording);
});

ipcMain.on('get-stream-status', (event) => {
    event.reply('get-stream-status-response', isStreaming);
});


ipcMain.handle('open-folder-dialog', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory'], // Only allow selecting directories
    });

    if (result.canceled) {
        return null;
    }
    return result.filePaths[0]; // Return the selected folder path
});

ipcMain.handle('open-config-file-dialog', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Config Files', extensions: ['json', 'conf', 'cfg', 'xml'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePaths[0]) return null;

  const selectedFile = result.filePaths[0];

  try {
    const fileContent = fs.readFileSync(selectedFile, 'utf-8');
    const newSettings = JSON.parse(fileContent);

    // Load existing settings (if file exists)
    let currentSettings = {};
    if (fs.existsSync(settingsFilePath)) {
      const existingContent = fs.readFileSync(settingsFilePath, 'utf-8');
      currentSettings = JSON.parse(existingContent);
    }

    // Merge the new settings over the old ones
    const mergedSettings = {
      ...currentSettings,
      ...newSettings
    };

    // Save back the merged settings
    fs.writeFileSync(settingsFilePath, JSON.stringify(mergedSettings, null, 2), 'utf-8');
    console.log('✅ Config imported and merged:', mergedSettings);

    // Notify renderer and possibly API
    if (!isHeadless) {
      mainWindow.webContents.send('load-settings', mergedSettings);
    }

    if (tcpServer.getIsApiConnected()) {
      sendSettingsToApi(mergedSettings);
    }

    return selectedFile;

  } catch (error) {
    console.error('❌ Failed to load and apply config file:', error);
    throw error;
  }
});


ipcMain.handle('open-save-folder-dialog', async () => {
  const result = await dialog.showSaveDialog({
    title: 'Save Config File',
    defaultPath: path.join(app.getPath('documents'), 'stream-settings.json'), // default filename
    filters: [
      { name: 'JSON Files', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  const sourcePath = path.join(app.getPath('userData'), 'settings.json'); // or whatever your actual file is

  try {
    await fs.promises.copyFile(sourcePath, result.filePath);
    return result.filePath;
  } catch (err) {
    console.error('❌ Error saving config file:', err);
    throw err;
  }
});

ipcMain.handle('export-config', async (event, { includeSecrets } = {}) => {
    const result = await dialog.showSaveDialog({
        title: 'Export Config File',
        defaultPath: path.join(app.getPath('documents'), 'stream-settings.json'),
        filters: [
            { name: 'JSON Files', extensions: ['json'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });

    if (result.canceled || !result.filePath) {
        return { canceled: true };
    }

    const settings = readSettingsFromDisk() || {};
    const toWrite = includeSecrets ? settings : stripSecretsForExport(settings);
    fs.writeFileSync(result.filePath, JSON.stringify(toWrite, null, 2), 'utf-8');

    return { filePath: result.filePath };
});

ipcMain.handle('get-state', async () => {
    return buildStateSnapshot();
});




ipcMain.on('open-settings-window', () => {
    openSettings(); // Open the settings window when requested
});

ipcMain.on('open-about-window', () => {
    openAbout();
});

ipcMain.handle('get-app-info', async () => {
    return {
        productName: app.getName(),
        version: app.getVersion(),
    };
});

ipcMain.handle('get-third-party-notices', async () => {
    try {
        const noticesPath = path.join(__dirname, 'THIRD_PARTY_NOTICES.txt');
        return fs.readFileSync(noticesPath, 'utf8');
    } catch (err) {
        console.error('Failed to load THIRD_PARTY_NOTICES.txt:', err);
        return '';
    }
});

ipcMain.handle('icecast-test', async (event, { icecastHost, icecastPort, mountpoint }) => {
    const host = String(icecastHost || '').trim();
    const port = toInt(icecastPort);
    const mount = normalizeMountpoint(mountpoint) || '/stream';

    if (!host || !Number.isFinite(port)) {
        return { ok: false, message: 'Missing host or port' };
    }

    const url = `http://${host}:${port}/status-json.xsl`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            const result = { ok: false, message: `HTTP ${response.status} ${response.statusText}` };
            lastIcecastStatusTest = { at: Date.now(), input: { host, port, mount }, result };
            return result;
        }

        const data = await response.json();
        const sources = data?.icestats?.source;
        const list = Array.isArray(sources) ? sources : (sources ? [sources] : []);

        const mounts = list.map(src => {
            const listenurl = String(src?.listenurl || '');
            const srcMount = String(src?.mount || (listenurl ? new URL(listenurl).pathname : '') || '').trim();
            const listeners = typeof src?.listeners === 'number' ? src.listeners : 0;
            return { mount: srcMount || listenurl, listenurl, listeners };
        });

        const source = mounts.find(m => String(m.listenurl || '').endsWith(mount) || String(m.mount || '') === mount);
        const mountFound = !!source;
        const listeners = source ? source.listeners : 0;

        const result = { ok: true, mount: mount, mountFound, listeners, mounts };
        lastIcecastStatusTest = { at: Date.now(), input: { host, port, mount }, result: { ok: result.ok, mount: result.mount, mountFound: result.mountFound, listeners: result.listeners } };
        return result;
    } catch (err) {
        const result = { ok: false, message: err?.message || String(err) };
        lastIcecastStatusTest = { at: Date.now(), input: { host, port, mount }, result };
        return result;
    }
});

ipcMain.on('go-live', async (event) => {
    const settings = readSettingsFromDisk() || {};
    try {
      await goLive(settings, { event });
    } catch (err) {
      event.reply('go-live-response', { success: false, message: err?.message || String(err) });
    }
  });

  ipcMain.on('stop-live', async (event) => {
    const settings = readSettingsFromDisk() || {};
    try {
      await stopLive(settings, { event });
    } catch (err) {
      event.reply('stop-live-response', { success: false, message: err?.message || String(err) });
    }
  });

  ipcMain.handle('obs-test', async (event, params) => {
    const settings = { ...(readSettingsFromDisk() || {}), ...(params || {}) };
    try {
      const installed = detectObsInstalled(settings.obsExePath);
      if (!installed.installed) return { ok: false, message: 'OBS not installed (path not detected)' };
      const client = await getObsClient(settings);
      return await client.test();
    } catch (err) {
      return { ok: false, message: err?.message || String(err) };
    }
  });

  ipcMain.handle('icecast-test-listen-url', async (event, { icecastHost, icecastPort, mountpoint }) => {
    const host = String(icecastHost || '').trim();
    const port = toInt(icecastPort);
    const mount = normalizeMountpoint(mountpoint);

    if (!host || !Number.isFinite(port)) {
        return { ok: false, message: 'Missing host or port' };
    }
    if (!mount) {
        return { ok: false, message: 'Missing mountpoint' };
    }

    const url = `http://${host}:${port}${mount}`;

    const tryFetch = async (method, extraHeaders = {}) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        try {
            const response = await fetch(url, {
                method,
                headers: {
                    'User-Agent': 'RebornBroadcaster/icecast-test',
                    ...extraHeaders,
                },
                signal: controller.signal,
            });
            const contentType = response.headers.get('content-type') || '';
            return { ok: true, status: response.status, statusText: response.statusText, contentType };
        } finally {
            clearTimeout(timeout);
        }
    };

    try {
        // Prefer HEAD to avoid downloading audio.
        const head = await tryFetch('HEAD');
        const result = { ok: true, url, status: head.status, contentType: head.contentType };
        lastListenUrlTest = { at: Date.now(), input: { host, port, mount }, result };
        return result;
    } catch (_) {
        try {
            // Fallback: small GET request attempt. Some servers don't support HEAD for streams.
            const get = await tryFetch('GET', { Range: 'bytes=0-0' });
            const result = { ok: true, url, status: get.status, contentType: get.contentType };
            lastListenUrlTest = { at: Date.now(), input: { host, port, mount }, result };
            return result;
        } catch (err) {
            const result = { ok: false, message: err?.message || String(err), url };
            lastListenUrlTest = { at: Date.now(), input: { host, port, mount }, result };
            return result;
        }
    }
});

ipcMain.handle('icecast-update-now-playing', async (event, { icecastHost, icecastPort, mountpoint, nowPlaying: newNowPlaying }) => {
    const host = String(icecastHost || '').trim();
    const port = toInt(icecastPort);
    const mount = normalizeMountpoint(mountpoint);
    const song = String(newNowPlaying || '').trim();

    if (!host || !Number.isFinite(port)) {
        return { ok: false, message: 'Missing host or port' };
    }
    if (!mount) {
        return { ok: false, message: 'Missing mountpoint' };
    }
    if (!song) {
        return { ok: false, message: 'Missing Now Playing text' };
    }

    const url = `http://${host}:${port}/admin/metadata?mode=updinfo&mount=${encodeURIComponent(mount)}&song=${encodeURIComponent(song)}`;

    try {
        const saved = readSettingsFromDisk() || {};
        const user = String(saved.username || '').trim();
        const pass = String(saved.sourcepassword || '').trim();
        if (!user || !pass) {
            return { ok: false, message: 'Missing source credentials (username/sourcepassword)' };
        }

        const auth = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
        const response = await fetch(url, {
            method: 'GET',
            headers: { Authorization: `Basic ${auth}` },
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            return { ok: false, message: `HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ''}` };
        }

        nowPlaying = song;
        sendLog('Now Playing updated:', song);
        if (tcpServer.getIsApiConnected()) {
            sendToApi({ type: 'now-playing', text: song });
        }
        try {
            const next = { ...(saved || {}), nowPlaying: song };
            fs.writeFileSync(settingsFilePath, JSON.stringify(next, null, 2), 'utf-8');
            if (!isHeadless && mainWindow) {
                mainWindow.webContents.send('load-settings', next);
            }
            sendSettingsToApi(next);
        } catch (e) {
            console.warn('Failed to persist nowPlaying:', e?.message || e);
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, message: err?.message || String(err) };
    }
});



ipcMain.on('get-audio-sources', async (event) => {
    console.log("Received 'get-audio-sources' request from:", event.sender.id);

    if (audioDevicesCache.length > 0) {
        console.log("Returning cached audio devices:", audioDevicesCache);
        event.sender.send('get-audio-sources-reply', { devices: audioDevicesCache });
        return;
    }

    console.log("Running FFmpeg command to list devices...");

    exec(`"${ffmpegPath}" -list_devices true -f dshow -i dummy`, (error, stdout, stderr) => {
        const output = stdout + '\n' + stderr;
        const lines = output.split('\n').map(line => line.trim());

        // Find the index where DirectShow audio devices section starts
        const audioSectionIndex = lines.findIndex(line => line.toLowerCase().includes('directshow audio devices'));

        if (audioSectionIndex === -1) {
            console.error("DirectShow audio devices section not found!");
            event.sender.send('get-audio-sources-reply', { error: "No DirectShow audio devices found" });
            return;
        }

        // Extract lines under that section until next section or end
        // Usually next section starts with "DirectShow video devices" or empty line
        const devices = [];
        for (let i = audioSectionIndex + 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.toLowerCase().includes('directshow video devices') || line === '') {
                break; // End of audio devices section
            }
            // Skip alternative name lines
            if (line.toLowerCase().includes('alternative name')) {
                continue;
            }
            // Extract device name in quotes
            const match = line.match(/"(.+?)"/);
            if (match) {
                devices.push(match[1]);
            }
        }

        if (devices.length === 0) {
            console.error("No valid audio devices parsed in DirectShow section.");
            event.sender.send('get-audio-sources-reply', { error: "No valid audio devices found" });
            return;
        }

        // Format as array of objects with id and name
        const deviceList = devices.map((name, idx) => ({ id: idx, name }));

        audioDevicesCache.push(...deviceList);
        console.log("Found and cached DirectShow audio devices:", deviceList);
        event.sender.send('get-audio-sources-reply', { devices: deviceList });
    });
});






// Existing save-settings (for the renderer)
ipcMain.on('save-settings', (event, settings, fromApi = false) => {
    console.log("Settings will be saved to:", settingsFilePath);

    // Prepare the settings object to be saved
    const settingsToSave = {
        mountpoint: settings.mountpoint || '',
        username: settings.username || '',
        sourcepassword: settings.sourcepassword || '',
        icecastHost: settings.icecastHost || '',
        icecastPort: settings.icecastPort || '',
        streamName: settings.streamName || '',
        streamGenre: settings.streamGenre || '',
        streamDescription: settings.streamDescription || '',
        streamUrl: settings.streamUrl || '',
        streamPublic: settings.streamPublic ?? '0',
        encodingType: settings.encodingType || '',
        audioSourceId: settings.audioSourceId || '', // Store ID
        audioSourceName: settings.audioSourceName || '', // Store Name
        bitrate: settings.bitrate || 128, // Default bitrate (e.g., 128kbps)
        recordingPath: settings.recordingPath || '',
        nowPlaying: settings.nowPlaying || '',
    };

    // Write the settings to settings.json file
    try {
        fs.writeFileSync(settingsFilePath, JSON.stringify(settingsToSave, null, 2), 'utf-8');
        console.log('Settings saved successfully:', settingsToSave);

        // Trigger the appropriate updates sequentially
        console.log(`Settings saved. Now triggering update.`);

        // If it's not headless, send updated settings to the renderer
        if (!isHeadless) {
            mainWindow.webContents.send('load-settings', settingsToSave);
        }

        // After saving, ensure API gets updated as well (if connected)
        if (tcpServer.getIsApiConnected()) {
            sendSettingsToApi(settingsToSave);
        }

    } catch (err) {
        console.error('Error saving settings:', err);
    }
});

// Handle loading settings (ensure load happens after save)
ipcMain.on('load-settings', (event) => {
    console.log('Loading settings from file:', settingsFilePath);

    try {
        // Read the settings from file
        const rawData = fs.readFileSync(settingsFilePath, 'utf-8');
        const settings = JSON.parse(rawData);
        console.log('Settings loaded successfully:', settings);

        // If not in headless mode and mainWindow exists, send settings to the UI
        if (!isHeadless && mainWindow) {
            mainWindow.webContents.send('load-settings', settings);
        }

        // If the request is from the API, send the settings to the API if connected
        if (tcpServer.getIsApiConnected()) {
            sendSettingsToApi(settings);  // Notify API to load settings
        }

        // Reply to the renderer with the settings
        event.reply('load-settings-response', settings);

    } catch (err) {
        console.error('Error loading settings:', err);
        event.reply('load-settings-response', { error: 'Failed to load settings' });  // Send error response
    }
});

ipcMain.on('api-request-get-settings', () => {
    console.log('api Request Received.');

    const socket = tcpServer.getApiSocket();
    const isConnected = tcpServer.getIsApiConnected();
    const encoding = tcpServer.getClientEncoding();

    try {
        const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf-8'));

        if (isConnected && socket) {
            const settingsString = JSON.stringify(settings) + '\n';
            const encodedSettings = iconv.encode(settingsString, encoding);

            console.log('Sending settings back to client...');
            socket.write(encodedSettings, (err) => {
                if (err) {
                    console.error('❌ Failed to send settings to client:', err);
                } else {
                    console.log('✅ Settings successfully sent to client!');
                }
            });
        } else {
            console.warn('⚠️ No active API connection to send settings.');
        }
    } catch (err) {
        console.error('Failed to read settings:', err);
        if (isConnected && socket) {
            try {
                socket.write(iconv.encode('Error retrieving settings\n', encoding));
            } catch (e) {
                console.error('❌ Failed to send error response to client:', e);
            }
        }
    }
});


ipcMain.on('api-save-settings', (event, jsonString) => {
    const socket = tcpServer.getApiSocket();
    const encoding = tcpServer.getClientEncoding();
    const isConnected = tcpServer.getIsApiConnected();

    try {
        const parsed = JSON.parse(jsonString);
        ipcMain.emit('save-settings', null, parsed, true); // Reuse existing handler
        console.log('✅ Settings received from API and passed to handler.');

        if (isConnected && socket) {
            socket.write(iconv.encode('Settings saved successfully\n', encoding));
        }
    } catch (err) {
        console.error('❌ Invalid settings JSON from API:', err);

        if (isConnected && socket) {
            socket.write(iconv.encode('Error saving settings\n', encoding));
        }
    }
});

ipcMain.on('api-export-config', (event, { filePath, includeSecrets, id } = {}) => {
    try {
        if (!filePath) {
            sendToApi({ type: 'export-config-response', ok: false, message: 'Missing filePath', id });
            return;
        }

        const settings = readSettingsFromDisk() || {};
        const toWrite = includeSecrets ? settings : stripSecretsForExport(settings);
        fs.writeFileSync(filePath, JSON.stringify(toWrite, null, 2), 'utf-8');
        sendToApi({ type: 'export-config-response', ok: true, filePath, id });
    } catch (err) {
        sendToApi({ type: 'export-config-response', ok: false, message: err?.message || String(err), id });
    }
});

ipcMain.on('api-import-config', (event, { filePath, merge = true, id } = {}) => {
    try {
        if (!filePath) {
            sendToApi({ type: 'import-config-response', ok: false, message: 'Missing filePath', id });
            return;
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const incoming = JSON.parse(content);
        const current = readSettingsFromDisk() || {};
        const next = merge ? { ...current, ...incoming } : incoming;

        fs.writeFileSync(settingsFilePath, JSON.stringify(next, null, 2), 'utf-8');

        if (!isHeadless && mainWindow) {
            mainWindow.webContents.send('load-settings', next);
        }
        sendSettingsToApi(next);

        sendToApi({ type: 'import-config-response', ok: true, filePath, id });
    } catch (err) {
        sendToApi({ type: 'import-config-response', ok: false, message: err?.message || String(err), id });
    }
});

ipcMain.on('request-app-close', (event, { sender, callType }) => {
    handleAppClose(sender, callType);
});

ipcMain.on('confirm-close-response', (event, userConfirmed) => {
    if (userConfirmed) {
        console.log('✅ Renderer confirmed total shutdown.');
        handleAppClose('Api', 'Total');
    } else {
        console.log('❌ Renderer denied shutdown.');
        // Do nothing, or optionally respond to API that it was canceled
    }
});

if (!isSingleInstance) {
    app.quit();
}

// When another instance is launched, we handle mode switching
app.on('second-instance', (event, commandLine) => {
    if (commandLine.includes('--headless') !== isHeadless) {
        switchMode();  // Switch between headless and normal mode
    }
});

// Assuming you have an API endpoint to handle commands
ipcMain.on('open-renderer', () => {
    if (isHeadless) {
        console.log('[API] Switching to normal mode...');
        switchMode(true);  // `true` means it was triggered by the API
    } else {
        console.log('[API] Renderer is already visible.');
    }
});


app.whenReady().then(() => {
    console.log("App is ready.");

    if (isDev) {
      console.log("Development mode — skipping update check...");
      initializeApp();
      return;
    }

    if (isHeadless) {
      console.log("Headless mode — skipping update check...");
      initializeApp();
      return;
    }

    console.log("Preparing Reborn Update Agent migration…");
    runAgentMigration();
  });

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !isHeadless) { // Not on macOS and not in headless mode
        app.quit(); // Quit the app when the last window is closed
    }
});
