const { contextBridge, ipcRenderer } = require('electron');

// Expose methods to the renderer process
contextBridge.exposeInMainWorld('electron', {
  loadSettings: () => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for load-settings response')), 50000); // 10s timeout
      ipcRenderer.once('load-settings-response', (event, settings) => {
        clearTimeout(timeout);
        resolve(settings);
      });
      ipcRenderer.send('load-settings'); // Request settings from main
    });
  },

  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),

  logMessage: (callback) => ipcRenderer.on('log-message', (_, message) => callback(message)),


  getCachedAudioSources: () => ipcRenderer.send('get-audio-sources'),
  

  startStream: () =>
    new Promise((resolve, reject) => {
        console.log("🟢 Sending start-stream request to main process");

        const timeout = setTimeout(() => {
            console.error('⚠️ Timeout waiting for start-stream response');
            reject(new Error('Timeout waiting for start-stream response'));
        }, 15000);

        ipcRenderer.once('start-stream-response', (event, response) => {
            clearTimeout(timeout);
            console.log("⚡ Received start-stream response:", response);
            if (response.success) {
                resolve(response);
            } else {
                reject(new Error(response.error || 'Unknown error starting stream'));
            }
        });

        ipcRenderer.send('start-stream');
    }),




  stopStream: () =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for stop-stream response')), 15000); // 5s timeout
      ipcRenderer.once('stop-stream-response', (event, response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      ipcRenderer.send('stop-stream');
    }),

  startRecording: (event, response) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for start-recording response')), 5000); // 5s timeout
      ipcRenderer.once('start-recording-response', (event, response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      ipcRenderer.send('start-recording');
    }),

  stopRecording: () =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for stop-recording response')), 5000); // 5s timeout
      ipcRenderer.once('stop-recording-response', (event, response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      ipcRenderer.send('stop-recording');
    }),

  openSettings: () => ipcRenderer.send('open-settings-window'),

  StreamStatus: () =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for get-stream-status response')), 5000); // 5s timeout
      ipcRenderer.once('get-stream-status-response', (event, status) => {
        clearTimeout(timeout);
        resolve(status);
      });
      ipcRenderer.send('get-stream-status');
    }),

  RecordingStatus: () =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for get-recording-status response')), 5000); // 5s timeout
      ipcRenderer.once('get-recording-status-response', (event, status) => {
        clearTimeout(timeout);
        resolve(status);
      });
      ipcRenderer.send('get-recording-status');
    }),

    OpenFolder: () => ipcRenderer.invoke('open-folder-dialog'),
    downloadconf: () => ipcRenderer.invoke('open-save-folder-dialog'),
    uploadconf: () => ipcRenderer.invoke('open-config-file-dialog'),



  startStreamTimer: () => ipcRenderer.send('start-stream-timer'),
  stopStreamTimer: () => ipcRenderer.send('stop-stream-timer'),
  startRecordingTimer: () => ipcRenderer.send('start-recording-timer'),
  stopRecordingTimer: () => ipcRenderer.send('stop-recording-timer'),

  on: (channel, callback) => ipcRenderer.on(channel, callback),
  onTimerUpdate: (callback) => ipcRenderer.on('timer-update', callback),
  onStandby: (callback) => ipcRenderer.on('standby', callback),

  // Adding event listener for stream and recording status updates
  onStreamStatusUpdate: (callback) => ipcRenderer.on('get-stream-status-response', callback),
  onRecordingStatusUpdate: (callback) => ipcRenderer.on('get-recording-status-response', callback),
  onListenerCountUpdate: (callback) => ipcRenderer.on('listener-count-updated', (event, count) => callback(count)),

  onStreamStatusUpdate: (callback) => ipcRenderer.on('stream-status-updated', (event, status) => callback(status)),
  requestAppClose: (callType = 'Warning') => {
    ipcRenderer.send('request-app-close', {
        sender: 'Renderer',
        callType
    });
},

onConfirmClose: (callback) => {
    ipcRenderer.on('confirm-app-close', (event, data) => {
        callback(data);
    });
},

respondToWarning: (confirmed) => {
    ipcRenderer.send('confirm-close-response', confirmed);
}
});


contextBridge.exposeInMainWorld('api', {
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close')
});