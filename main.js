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
const isDev = !app.isPackaged; // Correctly detects if running in dev mode
const ffmpegPath = isDev
  ? require('@ffmpeg-installer/ffmpeg').path
  : path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');



    function createDownloadingWindow() {
        downloadingWindow = new BrowserWindow({
        width: 400,
        height: 200,
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'src', 'preload.js'),
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
    
    autoUpdater.on('update-available', () => {
      console.log('Update available. Downloading...');
      createDownloadingWindow();  // Show downloading window when update starts
    });
    
    autoUpdater.on('update-downloaded', () => {
      console.log('Update downloaded. Installing...');
      autoUpdater.quitAndInstall();  // Install the update and restart the app
    });
    
    autoUpdater.on('error', (error) => {
      console.error('Error in update process:', error);
    });
    
    autoUpdater.on('update-not-available', () => {
      console.log('No update available.');
      initializeApp();  // Proceed with normal app initialization if no update is found
    });
  
    // Check for updates after the app is ready
    autoUpdater.checkForUpdatesAndNotify();
  }
  
  


let isHeadless = process.argv.includes('--headless'); // Headless mode flag
let isApiConnected = false; // Track whether an API client is connected

const settingsFilePath = path.join(app.getPath('userData'), 'settings.json');

let listenerInterval = null;
let currentListenerCount = 0;

let mainWindow;
let settingsWindow = null; // For managing the settings window
let ffmpegProcess = null;  // Variable to store the active FFmpeg process
let ffmpegRecordingProcess = null; // To track the recording FFmpeg process
let isStreaming = false; // Global variable to track streaming state
let isRecording = false;

let streamTimer = 0;
let recordingTimer = 0;

let recordingTimerInterval = null; // Store the interval ID globally
let streamTimerInterval = null; // Store the interval ID globally

const audioDevicesCache = []; // This will store the audio devices in memory

global.streamActive = false;  // Tracks whether streaming is active
global.recordingActive = false;  // Tracks whether recording is active



// Helper function to get the correct preload path based on whether the app is packaged or in dev mode
const basePath = isDev ? __dirname : path.join(process.resourcesPath );


const isSingleInstance = app.requestSingleInstanceLock();


function switchMode(fromApi = false) {
    if (isHeadless) {
        // Switch to normal mode (renderer visible)
        console.log('Switching to normal mode.');
        isHeadless = false;

        // Close any background processes (but don't interrupt streaming/recording)
        if (mainWindow) {
            mainWindow.show();  // Show the window
        } else {
            createWindow();  // Create the window if it's not created already
        }

        // Notify API that switch to normal mode was successful (optional)
        if (fromApi) {
            sendToApi('renderer-visible', { status: 'normal mode' });
        }
    } else {
        // Switch to headless mode
        console.log('Switching to headless mode.');
        isHeadless = true;

        if (mainWindow) {
            mainWindow.hide();  // Hide the window (but don't destroy it)
        }

        // Notify API that switch to headless mode was successful (optional)
        if (fromApi) {
            sendToApi('renderer-hidden', { status: 'headless mode' });
        }
    }
}


async function handleAppClose(sender, callType) {
    const isApiConnected = tcpServer.getIsApiConnected();

    switch (callType) {
        case 'Total':
            console.log(`[${sender}] initiating total shutdown...`);

            if (isApiConnected) {
                await sendToApi({ type: 'disconnect', reason: 'graceful' });
            }

            gracefulShutdown();
            break;

        case 'Partial':
            if (sender === 'Api') {
                if (!isHeadless && mainWindow) {
                    console.log('[Api] Partial close: entering headless mode');
                } else {
                    console.log('[Api] Already headless, shutting down API connection');
                }

                if (isApiConnected) {
                    await sendToApi({ type: 'disconnect', reason: 'graceful' });
                    global.apiSocket?.end(() => {
                        console.log('API socket disconnected.');
                    });
                }
            } else if (sender === 'Renderer') {
                if (isApiConnected) {
                    console.log('[Renderer] Partial close: API connected, entering headless mode');
                    mainWindow?.hide();
                    isHeadless = true;
                } else {
                    console.log('[Renderer] Partial close: No API, quitting app');
                    gracefulShutdown();
                }
            }
            break;

       case 'Warning':
            if (sender === 'Api') {
                // 1. Disconnect API first if connected
                if (isApiConnected) {
                    await sendToApi({ type: 'disconnect', reason: 'graceful' });
                    global.apiSocket?.end(() => {
                        console.log('API socket disconnected.');
                    });
                }

                // 2. If window visible, ask user whether to close the app
                if (!isHeadless && mainWindow) {
                    console.log('[Api] Warning: prompting user to close app...');

                    const { response } = await dialog.showMessageBox(mainWindow, {
                        type: 'question',
                        buttons: ['Yes, Close', 'No'],
                        defaultId: 0,
                        cancelId: 1,
                        title: 'RebornBroadcaster',
                        message: 'The API requested to close the app.',
                        detail: 'Do you want to close RebornBroadcaster now?',
                    });

                    if (response === 0) {
                        await handleAppClose('Api', 'Total');
                    } else {
                        console.log('[Api] User chose not to close app. API already disconnected.');
                    }
                } else {
                    console.log('[Api] Headless or no window – closing app');
                    gracefulShutdown();
                }
            } else if (sender === 'Renderer') {
                if (isApiConnected && mainWindow) {
                    console.log('[Renderer] Warning: prompting user before shutdown...');
                    const { response } = await dialog.showMessageBox(mainWindow, {
                        type: 'question',
                        buttons: ['Close App', 'Minimize to Background'],
                        defaultId: 0,
                        cancelId: 1,
                        title: 'RebornBroadcaster',
                        message: 'Do you want to close RebornBroadcaster?',
                        detail: 'Closing will stop all services. You can also minimize it to run in the background.',
                    });

                    if (response === 0) {
                        await handleAppClose('Renderer', 'Total');
                    } else {
                        mainWindow?.hide();
                        isHeadless = true;
                    }
                } else {
                    console.log('[Renderer] Warning: no API connected, closing immediately');
                    gracefulShutdown();
                }
            }
            break;
    }
}




// Function to create the main window
function createWindow() {

    // Set the preload path based on app packaging
    const preloadPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar', 'preload.js')  // For packaged app
      : path.join(__dirname, 'preload.js');  // For development mode
  
    if (!isHeadless) {
      // If not headless, create the main window
      if (!mainWindow) {  // Ensure we don't create another instance if the window already exists
        mainWindow = new BrowserWindow({
          width: 600,
          height: 720,
          maxWidth: 800,  // Maximum width the window can be resized to
          frame: false,
          webPreferences: {
            nodeIntegration: false,
            preload: preloadPath, // Preload the script based on the mode (development or packaged)
          },
        });
  
        mainWindow.loadFile('broadcaster.html'); // Load the main UI page
  
        // Add event listener for window closed (clean up)
        mainWindow.on('closed', () => {
          // Ensure that any settings window is also closed if it exists
          if (settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.close();
            settingsWindow = null;
          }
          mainWindow = null;  // Cleanup mainWindow to free memory
        });
      }
    } else {
      console.log('Running in headless mode.');
    }
  }
  




// Function to send data to the external API via TCP
function sendToApi(data) {
    const socket = tcpServer.getApiSocket();

    if (tcpServer.getIsApiConnected() && socket) {
        socket.write(JSON.stringify(data) + '\n'); // Add newline to separate messages
    } else {
        console.error('❌ No API client is connected');
    }
}


// Example of emitting a custom event from main to send data to the Python client
ipcMain.on('send-to-api', (event, data) => {
    sendToApi(data); // Call sendToApi with data
});

function startListenerCountPolling(settings) {
    if (listenerInterval) return; // Already polling

    const icecastUrl = `http://${settings.icecastHost}:${settings.icecastPort}/status-json.xsl`;

    listenerInterval = setInterval(async () => {
        try {
            const response = await fetch(icecastUrl);
            const data = await response.json();

            const mount = settings.mountpoint || '/stream';

            // Find the source mount based on the mountpoint
            const source = Array.isArray(data.icestats.source)
                ? data.icestats.source.find(src => src.listenurl.endsWith(mount))
                : data.icestats.source;

            // If the stream is live, update the listener count
            if (isStreaming) {
                if (source && source.listeners > 0) {
                    currentListenerCount = source.listeners;
                } else {
                    currentListenerCount = 0; // No listeners but stream is live
                }
            } else {
                currentListenerCount = 0; // Stream is offline
            }

            // Send the updated listener count to all renderer windows
            BrowserWindow.getAllWindows().forEach(win => {
                win.webContents.send('listener-count-updated', currentListenerCount);
                console.log(currentListenerCount);
            });

            // Use the isStreaming flag to determine if the stream is live or offline
            if (!isStreaming) {
                // Stream is offline
                BrowserWindow.getAllWindows().forEach(win => {
                    win.webContents.send('stream-status-updated', 'Offline');
                });
            }

        } catch (err) {
            console.error('❌ Error polling listener count:', err);
        }
    }, 5000); // Every 5 seconds
}

function stopListenerCountPolling() {
    if (listenerInterval) {
        clearInterval(listenerInterval);
        listenerInterval = null;

        // Optionally notify that polling has stopped or reset stream to offline
        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('stream-status-updated', 'Offline');
        });
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
    if (tcpServer.isApiConnected) {
        sendToApi({
            streamTime: streamTimer,
            recordingTime: recordingTimer
        });
    }
}


function sendLog(message) {
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

    let codec, extension, format;
    let audioOptions = [`-b:a`, `${settings.bitrate}k`];

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

    const ffmpegArgs = [
        '-f', 'dshow',
        '-i', `audio=${settings.audioSourceName}`,
        '-acodec', codec,
        ...audioOptions,
        '-f', format,
        `icecast://${settings.username}:${settings.sourcepassword}@${settings.icecastHost}:${settings.icecastPort}/${settings.mountpoint}`
    ];

    console.log("🚀 Starting FFmpeg with:\n", ffmpegArgs.join(' '));

    try {
        ffmpegProcess = spawn(`${ffmpegPath}`, ffmpegArgs);
        isStreaming = true;

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
                return;
            }
        
            // Special handling for common auth failure
            if (msg.includes('401 Unauthorized') || msg.includes('authorization failed')) {
                sendLog('Invalid Username Or Password');
            }
        
            // ✅ Catch-all for any message with "error" that hasn't been handled
            if (/error/i.test(msg)) {
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
        global.streamActive = true;
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

        if (respond) {
            respond('start-recording-response', 'Failed to load settings');
        } else if (event) {
            event.reply('start-recording-response', 'Failed to load settings');
        }
        return;
    }

    if (isRecording) {
        console.error('⚠️ Recording is already in progress');
        if (respond) {
            respond('start-recording-response', 'Recording is already running');
        } else if (event) {
            event.reply('start-recording-response', 'Recording is already running');
        }
        return;
    }

    if (!fs.existsSync(settings.recordingPath)) {
        console.error('❌ No valid recording path specified');
        if (respond) {
            respond('start-recording-response', 'No valid recording path specified');
        } else if (event) {
            event.reply('start-recording-response', 'No valid recording path specified');
        }
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
            if (respond) {
                respond('start-recording-response', 'Unsupported encoding type');
            } else if (event) {
                event.reply('start-recording-response', 'Unsupported encoding type');
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
        if (respond) {
            respond('start-recording-response', 'Recording stopped, file already exists');
        } else if (event) {
            event.reply('start-recording-response', 'Recording stopped, file already exists');
        }
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
                isRecording = true
                recordingStarted = true;
                global.recordingActive = true;
                console.log('\n✅ FFmpeg recording confirmed live!');
                sendLog('✅ Recording started');

                startTimers();
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
        });

        // Handle FFmpeg process error
        ffmpegRecordingProcess.on('error', (err) => {
            console.error("❌ FFmpeg recording failed to start:", err);
            sendLog('❌ Recording Failed: ', err);

            isRecording = false;
            global.recordingActive = false;
            ffmpegRecordingProcess = null;
        });

        // Notify the renderer that recording started
        if (respond) {
            respond('start-recording-response', `Recording started: ${filePath}`);
        } else if (event) {
            event.reply('start-recording-response', `Recording started: ${filePath}`);
        }

    } catch (err) {
        console.error("❌ Error starting FFmpeg recording:", err);
        isRecording = false;
        ffmpegRecordingProcess = null;
        sendLog('❌ Recording Failed: ', err);

        if (respond) {
            respond('start-recording-response', 'Error starting recording');
        } else if (event) {
            event.reply('start-recording-response', 'Error starting recording');
        }
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

    ipcMain.once('settings-loaded', (settings) => {
        startStream({ settings, event });
    });

    ipcMain.emit('load-for-use', event);
});



// Handler for starting the recording
ipcMain.on('start-recording', (event) => {
    console.log("🎙️ Start recording request received...");

    // Listen for the settings to be loaded
    ipcMain.once('settings-loaded', (settings) => {
        startRecording({ settings, event });
    });

    // Request the settings before starting the recording process
    ipcMain.emit('load-for-use', event);
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
        return;
    }

    console.log('Stopping recording gracefully...');

    // Send the "q" command to FFmpeg through stdin to tell it to finish and exit gracefully
    ffmpegRecordingProcess.stdin.write('q\n'); // Sends the 'quit' command to FFmpeg to stop gracefully

    // Check if the application is in headless mode and if the API is connected
    if (isHeadless) {
        if (isApiConnected) {
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
        if (code === 0) {
            console.log(`Recording stopped gracefully with exit code: ${code}`);
            if (event) {
                event.reply('stop-recording-response', 'Recording stopped successfully');
            }
        } else {
            console.error(`FFmpeg exited with code: ${code}, signal: ${signal}`);
            if (event) {
                event.reply('stop-recording-response', 'Error stopping the recording');
            }
        }

        ffmpegRecordingProcess = null; // Clear the process reference
        isRecording = false; // Reset the recording state
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
        }
    }, 10000); // Wait for 10 seconds before forcefully killing the process
});




// Stop the streaming gracefully (using ipcMain.on) with headless and API connection checks
ipcMain.on('stop-stream', (event) => {
    if (!isStreaming) {
        console.error('No active stream to stop');

        if (event) {
            event.reply('stop-streaming-response', 'No active stream to stop');
        }

        if (isApiConnected) {
            sendToApi({ action: 'stop-stream-failed', message: 'No active stream to stop' });
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

        if (event) {
            event.reply('stop-streaming-response', message);
        }

        if (isApiConnected) {
            sendToApi({
                action: success ? 'stop-stream-success' : 'stop-stream-error',
                message,
            });
        }

        if (!isHeadless && mainWindow) {
            mainWindow.webContents.send('stop-stream-response', message);
        }

        ffmpegProcess = null;
        isStreaming = false;
    });


    // Optional timeout in case FFmpeg hangs and doesn't exit (can be adjusted as necessary)
    setTimeout(() => {
        if (isStreaming) {
            console.warn('Streaming stop timed out, forcing process termination');
            ffmpegProcess.kill(); // Forcefully kill the process if it takes too long
            isStreaming = false;
            event.reply('stop-streaming-response', 'Streaming stop timed out, process killed');
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

    if (isApiConnected) {
      ipcMain.emit('send-settings-to-api', mergedSettings);
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




ipcMain.on('open-settings-window', () => {
    openSettings(); // Open the settings window when requested
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
        encodingType: settings.encodingType || '',
        audioSourceId: settings.audioSourceId || '', // Store ID
        audioSourceName: settings.audioSourceName || '', // Store Name
        bitrate: settings.bitrate || 128, // Default bitrate (e.g., 128kbps)
        recordingPath: settings.recordingPath || '',
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
        if (isApiConnected) {
            ipcMain.emit('send-settings-to-api', settingsToSave);
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
        if (isApiConnected) {
            ipcMain.emit('send-settings-to-api', settings);  // Notify API to load settings
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
    
    if (!isDev) {
      console.log("Checking for updates...");
      setupAutoUpdater();  // Set up auto-updater if not in dev mode
    } else {
      console.log("Development mode, skipping update check...");
      initializeApp();  // Skip update check in dev mode and proceed with normal initialization
    }
  });
  





app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !isHeadless) { // Not on macOS and not in headless mode
        app.quit(); // Quit the app when the last window is closed
    }
});
