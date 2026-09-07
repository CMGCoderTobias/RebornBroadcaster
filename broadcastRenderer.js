let liveActive = false;
let streamTimer = 0;
let recordingTimer = 0;
let currentSettings = {};
const goLiveButton = document.getElementById('goLiveButton');

// Load settings when the page is loaded
window.electron.loadSettings().then((settings) => {
    currentSettings = settings;
    console.log('✅ Loaded settings:', currentSettings);
    logToUI('✅ Settings loaded');
}).catch((err) => {
    console.error('❌ Error loading settings:', err);
    logToUI(`❌ Error loading settings: ${err?.message || err}`);
});

// Keep settings in sync when main pushes updates
window.electron.on('load-settings', (event, settings) => {
    currentSettings = settings || {};
    console.log('✅ Settings updated:', currentSettings);
    logToUI('✅ Settings updated');
});

// Timer updates from main
window.electron.onTimerUpdate((event, data) => {
    console.log("📨 Received timer update from main:", data);

    if (typeof data.streamTime !== 'number' || typeof data.recordingTime !== 'number') {
        console.error("❌ Invalid timer data received:", data);
        return;
    }

    streamTimer = data.streamTime;
    recordingTimer = data.recordingTime;

    updateStatus();
});

// STREAM: Start/Stop
document.getElementById('startStreamButton').addEventListener('click', () => {
    const isStreamActive = streamTimer > 0;

    if (isStreamActive) {
        stopStream();
    } else {
        const required = ['mountpoint', 'sourcepassword', 'bitrate', 'encodingType', 'audioSourceId', 'audioSourceName'];
        const missing = required.filter(f => !currentSettings?.[f]);

        if (missing.length) {
            const msg = `❌ Missing stream settings: ${missing.join(', ')}`;
            console.error(msg);
            logToUI(msg);
            return;
        }

        logToUI('🟢 Starting stream…');
        console.log("🟢 Starting stream with:", currentSettings);
        window.electron.startStream().then((response) => {
            logToUI(`✅ Stream started: ${response?.message || 'OK'}`);
            console.log("📬 Stream started:", response);
        }).catch((err) => {
            logToUI(`❌ Stream failed: ${err?.message || err}`);
            console.error('⚠️ Failed to start stream:', err);
        });
    }
});

// RECORDING: Start/Stop
document.getElementById('startRecordingButton').addEventListener('click', () => {
    const isRecordingActive = recordingTimer > 0;

    if (isRecordingActive) {
        stopRecording();
    } else {
        const required = ['bitrate', 'audioSourceId', 'audioSourceName', 'encodingType', 'recordingPath'];
        const missing = required.filter(f => !currentSettings?.[f]);

        if (missing.length) {
            const msg = `❌ Missing recording settings: ${missing.join(', ')}`;
            console.error(msg);
            logToUI(msg);
            return;
        }

        logToUI('🎙️ Starting recording…');
        console.log("🎙️ Starting recording with:", currentSettings);
        window.electron.startRecording().then((response) => {
            logToUI(`✅ Recording started: ${response?.message || 'OK'}`);
            console.log("📬 Recording started:", response);
        }).catch((err) => {
            logToUI(`❌ Recording failed: ${err?.message || err}`);
            console.error('⚠️ Failed to start recording:', err);
        });
    }
});

// Stop Stream / Recording
function stopStream() {
    logToUI('🛑 Stopping stream…');
    window.electron.stopStream()
        .then((res) => {
            logToUI(`✅ Stream stopped: ${res?.message || res || 'OK'}`);
            console.log("🛑 Stream stopped:", res);
        })
        .catch((err) => {
            logToUI(`❌ Stop stream failed: ${err?.message || err}`);
            console.error("❌ Error stopping stream:", err);
        });
}

function stopRecording() {
    logToUI('🛑 Stopping recording…');
    window.electron.stopRecording()
        .then((res) => {
            logToUI(`✅ Recording stopped: ${res?.message || res || 'OK'}`);
            console.log("🛑 Recording stopped:", res);
        })
        .catch((err) => {
            logToUI(`❌ Stop recording failed: ${err?.message || err}`);
            console.error("❌ Error stopping recording:", err);
        });
}

// Open settings window
document.getElementById('settingsButton').addEventListener('click', () => {
    window.electron.openSettings();
});

// Open about window
document.getElementById('aboutButton')?.addEventListener('click', () => {
    window.electron.openAbout();
});

function updateStatus() {
    const statusDisplay = document.getElementById('statusDisplay');
    const timerDisplay = document.getElementById('timerDisplay');
    const streamButton = document.getElementById('startStreamButton');
    const recordButton = document.getElementById('startRecordingButton');
    const goLiveButton = document.getElementById('goLiveButton');

    const streamActive = streamTimer > 0;
    const recordingActive = recordingTimer > 0;

    // ✅ Status text
    if (streamActive && recordingActive) {
        statusDisplay.textContent = "Stream & Recording Running";
    } else if (streamActive) {
        statusDisplay.textContent = "Stream Running";
    } else if (recordingActive) {
        statusDisplay.textContent = "Recording Running";
    } else {
        statusDisplay.textContent = "Status: Idle";
    }

    // ✅ Timer text
    if (!streamActive && !recordingActive) {
        timerDisplay.textContent = "Standby";
    } else {
        const streamText = `Stream Time: ${formatTime(streamTimer)}`;
        const recordingText = `Recording Time: ${formatTime(recordingTimer)}`;
        timerDisplay.textContent = `${streamText} | ${recordingText}`;
    }

    // ✅ Button text
    streamButton.textContent = streamActive ? "Stop Stream" : "Start Stream";
    recordButton.textContent = recordingActive ? "Stop Recording" : "Start Recording";
}

// Format seconds to mm:ss
function formatTime(seconds) {
    if (typeof seconds !== 'number' || isNaN(seconds)) return "00:00";
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs < 10 ? '0' + secs : secs}`;
}

function logToUI(message) {
    const logBox = document.getElementById('logBox');
    if (!logBox) return;

    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ${message}`;
    
    logBox.textContent += line + '\n';
    logBox.scrollTop = logBox.scrollHeight; // auto-scroll to bottom
}

if (window.electron?.onLogMessage) {
    window.electron.onLogMessage((msg) => {
        logToUI(msg);
    });
}

window.electron.onListenerCountUpdate((count) => {
    const el = document.getElementById('listenerCountDisplay');
    if (el) el.textContent = `Listeners: ${count}`;
});

// Listen for stream status update
window.electron.onStreamStatusUpdate((status) => {
    const el = document.getElementById('listenerCountDisplay');
    if (!el) return;
    if (status === 'Offline') {
        el.textContent = 'Offline';
    }
});



document.getElementById('minimizeBtn').addEventListener('click', () => {
    window.api.minimize();
});

document.getElementById('closeBtn').addEventListener('click', () => {
    window.api.close();
});


// Listen for the confirmation request from the main process
window.electron.onConfirmClose(({ from }) => {
    const confirmMsg = `${from} wants to close RebornBroadcaster. Proceed?`;
    const confirmed = confirm(confirmMsg);

    // Send the user's response back to main
    window.electron.respondToWarning(confirmed);
});

// Optional: Call this from your close button to initiate shutdown
function handleCloseButtonClick() {
    // You can pass 'Warning', 'Partial', or 'Total' here depending on context
    window.electron.requestAppClose('Warning');
}


// GO LIVE: Start/Stop Icecast + OBS based on toggles
if (goLiveButton) {
    goLiveButton.addEventListener('click', async () => {
        try {
            const streamActive = streamTimer > 0;
            const recordingActive = recordingTimer > 0;

            const isLive = liveActive || streamActive || recordingActive;

            if (!isLive) {
                logToUI('Go Live...');
                const res = await window.electron.goLive();
                liveActive = !!res?.success;
                logToUI(`Go Live: ${JSON.stringify(res?.result || {})}`);
            } else {
                logToUI('Stop Live...');
                const res = await window.electron.stopLive();
                if (res?.success) liveActive = false;
                logToUI(`Stop Live: ${JSON.stringify(res?.result || {})}`);
            }
        } catch (err) {
            logToUI(`Live failed: ${err?.message || err}`);
        }
    });
}
