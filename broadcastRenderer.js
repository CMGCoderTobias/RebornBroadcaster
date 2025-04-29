let streamTimer = 0;
let recordingTimer = 0;
let currentSettings = {};

// Load settings when the page is loaded
window.electron.loadSettings().then((settings) => {
    currentSettings = settings;
    console.log('✅ Loaded settings:', currentSettings);
}).catch((err) => {
    console.error('❌ Error loading settings:', err);
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
            console.error(`❌ Missing stream settings: ${missing.join(', ')}`);
            return;
        }

        console.log("🟢 Starting stream with:", currentSettings);
        window.electron.startStream(
            currentSettings.mountpoint,
            currentSettings.sourcepassword,
            currentSettings.bitrate,
            currentSettings.audioSourceId,
            currentSettings.encodingType
        ).then((response) => {
            console.log("📬 Stream started:", response);
        }).catch((err) => {
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
            console.error(`❌ Missing recording settings: ${missing.join(', ')}`);
            return;
        }

        console.log("🎙️ Starting recording with:", currentSettings);
        window.electron.startRecording(
            currentSettings.bitrate,
            currentSettings.audioSourceId,
            currentSettings.audioSourceName,
            currentSettings.encodingType,
            currentSettings.recordingPath
        ).then((response) => {
            console.log("📬 Recording started:", response);
        }).catch((err) => {
            console.error('⚠️ Failed to start recording:', err);
        });
    }
});

// Stop Stream / Recording
function stopStream() {
    window.electron.stopStream()
        .then((res) => console.log("🛑 Stream stopped:", res))
        .catch((err) => console.error("❌ Error stopping stream:", err));
}

function stopRecording() {
    window.electron.stopRecording()
        .then((res) => console.log("🛑 Recording stopped:", res))
        .catch((err) => console.error("❌ Error stopping recording:", err));
}

// Open settings window
document.getElementById('settingsButton').addEventListener('click', () => {
    window.electron.openSettings();
});

function updateStatus() {
    const statusDisplay = document.getElementById('statusDisplay');
    const timerDisplay = document.getElementById('timerDisplay');
    const streamButton = document.getElementById('startStreamButton');
    const recordButton = document.getElementById('startRecordingButton');

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

if (window.electron?.logMessage) {
    window.electron.logMessage((msg) => {
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
    if (el) el.textContent = status; // Show "Offline" or listener count
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
