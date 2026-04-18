const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const tcpServer = require('./tcpServer'); // Make sure this path is correct
const iconv = require('iconv-lite');
const { listenerCount } = require('process');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { autoUpdater } = require('electron-updater');
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
  ? require('@ffmpeg-installer/ffmpeg').path
  : path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');

function getPreloadPath() {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar', 'preload.js')
        : path.join(__dirname, 'preload.js');
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

function sanitizeSettingsForApi(settings) {
    const safe = { ...(settings || {}) };
    if ('sourcepassword' in safe) {
        safe.sourcepassword = safe.sourcepassword ? '***' : '';
        safe.hasSourcePassword = !!(settings && settings.sourcepassword);
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
    console.log("App Initialization started...");
    loadAudioDevices(); // Example: Initialize any audio-related features
    
    createWindow(); // Open the main window of the app
    
    // Start the TCP server or any other background services
    tcpServer.startTCPServer();
    
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


async function startStream({ settings, event = null, respond = null }) {
    const requiredFields = ['mountpoint', 'username', 'sourcepassword', 'bitrate', 'encodingType', 'audioSourceName', 'icecastHost', 'icecastPort'];
    const missingFields = requiredFields.filter(field => !settings[field]);

    if (missingFields.length) {
        const errorMsg = `❌ Missing required settings: ${missingFields.join(', ')}`;
        sendLog('❌ Stream Failed Error: ', errorMsg );

        console.error(errorMsg);
        if (event) event.reply('start-stream-response', { success: false, message: errorMsg });
        if (respond) respond({ success: false, message: errorMsg });
        return;
    }

    if (isStreaming || ffmpegProcess) {
        const msg = "⚠️ Stream is already running.";
        console.warn(msg);
        if (event) event.reply('start-stream-response', { success: false, message: msg });
        if (respond) respond({ success: false, message: msg });
        return;
    }

    const mount = normalizeMountpoint(settings.mountpoint);
    const icecastPort = toInt(settings.icecastPort);
    const bitrate = toInt(settings.bitrate);

    if (!mount) {
        const msg = '❌ Invalid mountpoint';
        if (event) event.reply('start-stream-response', { success: false, message: msg });
        if (respond) respond({ success: false, message: msg });
        return;
    }

    if (!Number.isFinite(icecastPort) || icecastPort < 1 || icecastPort > 65535) {
        const msg = '❌ Invalid Icecast port (must be 1-65535)';
        if (event) event.reply('start-stream-response', { success: false, message: msg });
        if (respond) respond({ success: false, message: msg });
        return;
    }

    if (!Number.isFinite(bitrate) || bitrate < 8) {
        const msg = '❌ Invalid bitrate';
        if (event) event.reply('start-stream-response', { success: false, message: msg });
        if (respond) respond({ success: false, message: msg });
        return;
    }

    let codec, extension, format;
    let audioOptions = [`-b:a`, `${bitrate}k`];

    switch (settings.encodingType) {
        case 'mp3': codec = 'libmp3lame'; format = 'mp3'; extension = 'mp3'; break;
        case 'aac': codec = 'aac'; format = 'adts'; extension = 'aac'; break;
        case 'flac': codec = 'flac'; format = 'flac'; extension = 'flac'; audioOptions = []; break;
        case 'opus': codec = 'libopus'; format = 'ogg'; extension = 'opus'; break;
        default:
            const msg = `❌ Unsupported encoding type: ${settings.encodingType}`;
            console.error(msg);
            if (event) event.reply('start-stream-response', { success: false, message: msg });
            if (respond) respond({ success: false, message: msg });
            return;
    }

    const contentType = (format === 'mp3'
        ? 'audio/mpeg'
        : (format === 'adts'
            ? 'audio/aac'
            : (format === 'ogg'
                ? 'audio/ogg'
                : 'application/octet-stream')));

    const urlOptions = new URLSearchParams();
    if (settings.streamName) urlOptions.set('ice_name', String(settings.streamName));
    if (settings.streamGenre) urlOptions.set('ice_genre', String(settings.streamGenre));
    if (settings.streamDescription) urlOptions.set('ice_description', String(settings.streamDescription));
    if (settings.streamUrl) urlOptions.set('ice_url', String(settings.streamUrl));
    urlOptions.set('ice_public', String(settings.streamPublic ?? '0'));
    if (contentType) urlOptions.set('content_type', contentType);

    const outputUrl = `icecast://${settings.username}:${settings.sourcepassword}@${settings.icecastHost}:${icecastPort}${mount}${urlOptions.toString() ? `?${urlOptions}` : ''}`;

    const ffmpegArgs = [
        '-f', 'dshow',
        '-i', `audio=${settings.audioSourceName}`,
        '-acodec', codec,
        ...audioOptions,
        '-f', format,
        outputUrl
    ];

    console.log("🚀 Starting FFmpeg with:\n", ffmpegArgs.join(' '));

    try {
        ffmpegProcess = spawn(`${ffmpegPath}`, ffmpegArgs);
        isStreaming = true;
        startListenerCountPolling(settings);

        let streamStarted = false;

        ffmpegProcess.stdout.on('data', (data) => {
            console.log('📢 [FFmpeg stdout]:', data.toString());
        });

        ffmpegProcess.stderr.on('data', (data) => {
            const msg = data.toString();
            const match = msg.match(/size=\s*\S+\s+time=\S+\s+bitrate=\s*\S+\s+speed=\s*\S+/);
        
            if (match) {
                process.stdout.write(`\r📈 ${match[0]}   `);
                return;
            }
        
            // This message has already been handled
            if (!streamStarted && msg.includes('Press [q] to stop')) {
                console.log('\n✅ Stream confirmed live!');
                sendLog('✅ Stream started');
                startListenerCountPolling(settings);
                streamStarted = true;
                global.streamActive = true;
                startTimers();
                if (tcpServer.getIsApiConnected()) {
                    sendToApi({ type: 'stream-status', status: 'live' });
                }
                return;
            }
        
            // Special handling for common auth failure
            if (msg.includes('401 Unauthorized') || msg.includes('authorization failed')) {
                sendLog('Invalid Username Or Password');
            }
        
            // ✅ Catch-all for any message with "error" that hasn't been handled
            if (/error/i.test(msg)) {
                lastFfmpegError = msg.trim().slice(0, 5000);
                sendLog(`❌ Unhandled FFmpeg Error: ${msg.trim()}`);
            }
        
            // Also log other stderr output just for visibility
            console.error('⚠️ [FFmpeg stderr]:', msg);
        });
        
        

        ffmpegProcess.on('exit', (code, signal) => {
            console.log(`🔴 FFmpeg exited with code ${code}, signal ${signal}`);
            isStreaming = false;
            global.streamActive = false;
            ffmpegProcess = null;
            stopListenerCountPolling();

            sendLog('🔴 Stream Stopped');

            stopTimers();
            if (tcpServer.getIsApiConnected()) {
                sendToApi({ type: 'stream-status', status: 'stopped', code, signal });
            }
        });

        ffmpegProcess.on('error', (err) => {
            console.error("❌ FFmpeg error:", err);
            sendLog('❌ Stream Failed Error: ', err);

            isStreaming = false;
            global.streamActive = false;
            ffmpegProcess = null;
        });

        const msg = "✅ Stream started successfully";
        if (event) event.reply('start-stream-response', { success: true, message: msg });
        if (respond) respond({ success: true, message: msg });

    } catch (err) {
        console.error("❌ Error starting FFmpeg:", err);
        sendLog('❌ Stream Failed Error: ', err);
        isStreaming = false;
        global.streamActive = false;
        ffmpegProcess = null;
        sendLog('❌ Stream Failed');

        if (event) event.reply('start-stream-response', { success: false, message: err.message });
        if (respond) respond({ success: false, message: err.message });
    }
}


async function startRecording({ settings, event = null, respond = null }) {
    console.log("⚙️ Received settings for recording:", settings);

    // Validation
    if (!settings || settings.error || !settings.recordingPath) {
        console.error("❌ Failed to load settings:", settings?.error || "Missing required values.");
        sendLog('❌ Recording Failed Error: ', settings?.error || "Missing required values.");

        const msg = settings?.error || 'Failed to load settings';
        if (respond) respond({ success: false, message: msg });
        if (event) event.reply('start-recording-response', { success: false, message: msg });
        return;
    }

    if (isRecording) {
        console.error('⚠️ Recording is already in progress');
        const msg = 'Recording is already running';
        if (respond) respond({ success: false, message: msg });
        if (event) event.reply('start-recording-response', { success: false, message: msg });
        return;
    }

    if (!fs.existsSync(settings.recordingPath)) {
        console.error('❌ No valid recording path specified');
        const msg = 'No valid recording path specified';
        if (respond) respond({ success: false, message: msg });
        if (event) event.reply('start-recording-response', { success: false, message: msg });
        return;
    }

    let codec, format, extension;
    let audioOptions = [];

    // Determine encoding options
    switch (settings.encodingType) {
        case 'mp3': codec = 'libmp3lame'; format = 'mp3'; extension = 'mp3'; audioOptions = ['-b:a', `${settings.bitrate}k`]; break;
        case 'aac': codec = 'aac'; format = 'adts'; extension = 'aac'; audioOptions = ['-b:a', `${settings.bitrate}k`]; break;
        case 'flac': codec = 'flac'; format = 'flac'; extension = 'flac'; break;
        case 'opus': codec = 'libopus'; format = 'ogg'; extension = 'opus'; audioOptions = ['-b:a', `${settings.bitrate}k`]; break;
        default:
            console.error('❌ Unsupported encoding type:', settings.encodingType);
            {
                const msg = 'Unsupported encoding type';
                if (respond) respond({ success: false, message: msg });
                if (event) event.reply('start-recording-response', { success: false, message: msg });
            }
            return;
    }

    // Set up file path and name
    const audioDevice = settings.audioSourceName;
    const fileName = `recording_${new Date().toISOString().replace(/[:.-]/g, '_')}.${extension}`;
    const filePath = path.join(settings.recordingPath, fileName);

    // Prevent overwriting existing files
    if (fs.existsSync(filePath)) {
        console.error(`❌ File already exists: ${filePath}`);
        sendLog(`❌ File already exists: ${filePath}`);
        const msg = 'Recording stopped, file already exists';
        if (respond) respond({ success: false, message: msg });
        if (event) event.reply('start-recording-response', { success: false, message: msg });
        return;
    }

    // Set up ffmpeg arguments for recording
    const ffmpegArgs = [
        '-f', 'dshow',
        '-i', `audio=${audioDevice}`,
        '-acodec', codec,
        ...audioOptions,
        '-f', format,
        filePath
    ];

    console.log("📼 Starting FFmpeg recording with args:\n", ffmpegArgs.join(' '));

    try {
        // Spawn the FFmpeg process
        ffmpegRecordingProcess = spawn(`${ffmpegPath}`, ffmpegArgs);
        isRecording = true;

        let recordingStarted = false;

        // Handle standard output from FFmpeg
        ffmpegRecordingProcess.stdout.on('data', (data) => {
            console.log('📢 [FFmpeg Recording stdout]:', data.toString());
        });

        // Handle error output from FFmpeg
        ffmpegRecordingProcess.stderr.on('data', (data) => {
            const msg = data.toString();

            const match = msg.match(/size=\s*\S+\s+time=\S+\s+bitrate=\s*\S+\s+speed=\s*\S+/);
            if (match) {
                process.stdout.write(`\r📈 ${match[0]}   `);
            } else {
                console.error('⚠️ [FFmpeg Recording stderr]:', msg);
            }

            if (!recordingStarted && msg.includes('Press [q] to stop')) {
                isRecording = true;
                recordingStarted = true;
                global.recordingActive = true;
                console.log('\n✅ FFmpeg recording confirmed live!');
                sendLog('✅ Recording started');

                startTimers();
                if (tcpServer.getIsApiConnected()) {
                    sendToApi({ type: 'recording-status', status: 'live', filePath });
                }
            }
        });

        // Handle FFmpeg process exit
        ffmpegRecordingProcess.on('exit', (code, signal) => {
            console.log(`🔴 FFmpeg recording exited with code ${code}, signal ${signal}`);
            isRecording = false;
            sendLog('🔴 Recording Stopped');

            global.recordingActive = false;
            ffmpegRecordingProcess = null;
            stopTimers();
            if (tcpServer.getIsApiConnected()) {
                sendToApi({ type: 'recording-status', status: 'stopped', code, signal });
            }
        });

        // Handle FFmpeg process error
        ffmpegRecordingProcess.on('error', (err) => {
            console.error("❌ FFmpeg recording failed to start:", err);
            sendLog('❌ Recording Failed: ', err);

            isRecording = false;
            global.recordingActive = false;
            ffmpegRecordingProcess = null;
        });

        const msg = `Recording started: ${filePath}`;
        if (respond) respond({ success: true, message: msg, filePath });
        if (event) event.reply('start-recording-response', { success: true, message: msg, filePath });

    } catch (err) {
        console.error("❌ Error starting FFmpeg recording:", err);
        isRecording = false;
        ffmpegRecordingProcess = null;
        sendLog('❌ Recording Failed: ', err);

        const msg = err?.message || 'Error starting recording';
        if (respond) respond({ success: false, message: msg });
        if (event) event.reply('start-recording-response', { success: false, message: msg });
    }
}


function gracefulShutdown() {
    console.log('🔻 Gracefully shutting down...');

    if (global.apiSocket) {
        global.apiSocket.end(() => {
            console.log('🛑 API connection closed.');
        });
    }

    if (global.streamActive) ipcMain.emit('stop-stream');
    if (global.recordingActive) ipcMain.emit('stop-recording');

    app.quit();
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
    console.log("🟢 Received start-stream request from renderer");

    const settings = readSettingsFromDisk() || {};

    const hasReply = event && typeof event.reply === 'function';
    const respond = hasReply
        ? null
        : (payload) => sendToApi({ type: 'start-stream-response', ...payload });

    startStream({ settings, event: hasReply ? event : null, respond });
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
    if (!isStreaming) {
        console.error('No active stream to stop');

        if (event && typeof event.reply === 'function') {
            event.reply('stop-stream-response', 'No active stream to stop');
        }

        if (tcpServer.getIsApiConnected()) {
            sendToApi({ type: 'stop-stream-response', success: false, message: 'No active stream to stop' });
        }

        return;
    }

    console.log('Stopping stream gracefully...');
    ffmpegProcess.stdin.write('q\n');

    ffmpegProcess.on('exit', (code, signal) => {
        const success = code === 0;
        const message = success
            ? 'Streaming stopped successfully'
            : `Streaming failed to stop (code: ${code}, signal: ${signal})`;

        if (event && typeof event.reply === 'function') {
            event.reply('stop-stream-response', message);
        }

        if (tcpServer.getIsApiConnected()) {
            sendToApi({
                action: success ? 'stop-stream-success' : 'stop-stream-error',
                message,
            });
            sendToApi({ type: 'stop-stream-response', success, message, code, signal });
        }

        if (!isHeadless && mainWindow) {
            mainWindow.webContents.send('stop-stream-response', message);
        }

        ffmpegProcess = null;
        isStreaming = false;
        global.streamActive = false;

        if (tcpServer.getIsApiConnected()) {
            sendToApi({ type: 'stream-status', status: 'stopped' });
        }
    });


    // Optional timeout in case FFmpeg hangs and doesn't exit (can be adjusted as necessary)
    setTimeout(() => {
        if (isStreaming) {
            console.warn('Streaming stop timed out, forcing process termination');
            ffmpegProcess.kill(); // Forcefully kill the process if it takes too long
            isStreaming = false;
            if (event && typeof event.reply === 'function') {
                event.reply('stop-stream-response', 'Streaming stop timed out, process killed');
            }
            if (tcpServer.getIsApiConnected()) {
                sendToApi({ type: 'stop-stream-response', success: false, message: 'Streaming stop timed out, process killed' });
            }
        }
    }, 10000); // Wait for 10 seconds before forcefully killing the process
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
    return;
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
      console.log("Development mode � skipping update check...");
      initializeApp();
      return;
    }

    if (isHeadless) {
      console.log("Headless mode � skipping update check...");
      initializeApp();
      return;
    }

    console.log("Checking for updates...");
    setupAutoUpdater();
  });

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !isHeadless) { // Not on macOS and not in headless mode
        app.quit(); // Quit the app when the last window is closed
    }
});
