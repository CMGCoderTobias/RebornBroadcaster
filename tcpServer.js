const net = require('net');
const { ipcMain } = require('electron');
const iconv = require('iconv-lite');
const fs = require('fs');

const tcpPort = 8010;
let isApiConnected = false;
let apiSocket = null;

// Start the TCP server
const server = net.createServer((socket) => {
    console.log('📡 API Client connected via TCP');
    isApiConnected = true;
    apiSocket = socket;
    ipcMain.emit('api-connected');

    let clientEncoding = 'utf8';
    let handshakeDone = false;
    let lastHeartbeat = Date.now();
    let textBuffer = '';

    // 💓 Heartbeat monitor
    const heartbeatInterval = setInterval(() => {
        if (Date.now() - lastHeartbeat > 70000) {
            console.warn('💀 Heartbeat timeout. Killing dead socket.');
            cleanupSocket();
        }
    }, 35000);

    // 🧹 Cleanup handler
    function cleanupSocket(reason = 'disconnect') {
        if (socket && !socket.destroyed) {
            try {
                socket.destroy();
            } catch (_) {
                // ignore
            }
        }

        clearInterval(heartbeatInterval);
        isApiConnected = false;
        apiSocket = null;

        console.log('🧹 Cleaned up socket connection');
        ipcMain.emit('api-disconnected', null, { reason });
    }

    function writeResponse(line) {
        if (!socket || socket.destroyed || !socket.writable) return;
        try {
            socket.write(iconv.encode(`${line}\n`, clientEncoding));
        } catch (_) {
            // ignore
        }
    }

    function handleCommand(rawLine) {
        const raw = String(rawLine || '').trim();
        if (!raw) return;

        if (raw === 'PING') {
            writeResponse('PONG');
            console.log('Ping, Pong');
            return;
        }

        // JSON command support (newline-delimited)
        if (raw.startsWith('{') && raw.endsWith('}')) {
            try {
                const msg = JSON.parse(raw);
                const type = String(msg?.type || msg?.command || '').trim();

                if (type === 'save-settings' && msg?.settings) {
                    ipcMain.emit('api-save-settings', null, JSON.stringify(msg.settings));
                    writeResponse('Settings saved.');
                    return;
                }

                if (type === 'get-settings') {
                    ipcMain.emit('api-request-get-settings');
                    writeResponse('Requested settings.');
                    return;
                }

                if (type === 'request-state' || type === 'get-state') {
                    ipcMain.emit('api-request-state', null, { id: msg?.id });
                    writeResponse('Requested state.');
                    return;
                }

                if (type === 'export-config') {
                    ipcMain.emit('api-export-config', null, { filePath: msg?.filePath, includeSecrets: !!msg?.includeSecrets, id: msg?.id });
                    writeResponse('Exporting config.');
                    return;
                }

                if (type === 'import-config') {
                    ipcMain.emit('api-import-config', null, { filePath: msg?.filePath, merge: msg?.merge !== false, id: msg?.id });
                    writeResponse('Importing config.');
                    return;
                }

                if (type) {
                    ipcMain.emit(type); // e.g. start-stream, stop-stream, start-recording...
                    writeResponse(`OK: ${type}`);
                    return;
                }
            } catch (err) {
                console.warn('⚠️ Invalid JSON command, falling back to plain text:', err?.message || err);
            }
        }

        console.log('📨 Received command from API:', raw);

        let response = '';

        if (raw.startsWith('save-settings:')) {
            ipcMain.emit('api-save-settings', null, raw.slice('save-settings:'.length).trim());
            response = 'Settings saved.';
        } else if (raw === 'get-settings') {
            ipcMain.emit('api-request-get-settings');
            response = 'Requested settings.';
        } else {
            switch (raw) {
                case 'start-stream':
                    ipcMain.emit('start-stream');
                    response = 'Starting stream...';
                    break;
                case 'stop-stream':
                    ipcMain.emit('stop-stream');
                    response = 'Stopping stream...';
                    break;
                case 'start-recording':
                    ipcMain.emit('start-recording');
                    response = 'Starting recording...';
                    break;
                case 'stop-recording':
                    ipcMain.emit('stop-recording');
                    response = 'Stopping recording...';
                    break;
                case 'status':
                    response = `Stream: ${global.streamActive ? 'ON' : 'OFF'} | Recording: ${global.recordingActive ? 'ON' : 'OFF'}`;
                    break;
                case 'get-state':
                    ipcMain.emit('api-request-state', null, {});
                    response = 'Requested state.';
                    break;
                case 'close-app':
                    ipcMain.emit('request-app-close', null, {
                        sender: 'Api',
                        callType: 'Warning'
                    });

                    response = 'Closing app.';

                    // Graceful disconnect
                    if (socket && !socket.destroyed && socket.writable) {
                        writeResponse('Server closing the connection.');
                        setTimeout(() => {
                            try {
                                if (!socket.destroyed) socket.end(); // Graceful end
                            } catch (_) {
                                // Ignore
                            }
                        }, 500);
                    }

                    break;
                case 'open-app':
                    ipcMain.emit('open-renderer');
                    response = 'Opening app.';
                    break;
                default:
                    response = 'Unknown command.';
                    break;
            }
        }

        if (response) writeResponse(response);
    }

    // 📩 Data handler (newline-delimited)
    socket.on('data', async (data) => {
        lastHeartbeat = Date.now();

        try {
            // Optional handshake: first line can be "ENCODING:utf8" (ASCII).
            let dataToDecode = data;
            if (!handshakeDone) {
                const nlIndex = data.indexOf(0x0A); // \n
                const headerBuf = nlIndex === -1 ? data : data.slice(0, nlIndex);
                const headerText = headerBuf.toString('ascii').trim();

                if (headerText.startsWith('ENCODING:')) {
                    clientEncoding = headerText.split(':')[1].replace(/[\s\r\n]+/g, '').toLowerCase();
                    socket.clientEncoding = clientEncoding;
                    handshakeDone = true;
                    socket.write(`Server encoding set to: ${clientEncoding}\n`, 'ascii');
                    console.log(`[Electron] Client encoding: ${clientEncoding}`);

                    dataToDecode = nlIndex === -1 ? Buffer.alloc(0) : data.slice(nlIndex + 1);
                } else {
                    handshakeDone = true; // allow legacy clients without a handshake
                    dataToDecode = data;
                }
            }

            const decoded = iconv.decode(dataToDecode, clientEncoding);
            textBuffer += decoded;

            let newlineIndex;
            while ((newlineIndex = textBuffer.indexOf('\n')) !== -1) {
                const line = textBuffer.slice(0, newlineIndex).replace(/\r$/, '');
                textBuffer = textBuffer.slice(newlineIndex + 1);
                handleCommand(line);
            }
        } catch (error) {
            console.error('🔥 Error in TCP handler:', error);
            try {
                writeResponse(`❌ Server error: ${error.message}`);
            } catch (_) {}
        }
    });

    // Cleanup on disconnects or errors
    socket.on('end', () => {
        console.log('🔌 Client ended connection');
        cleanupSocket('end');
    });

    socket.on('error', (err) => {
        console.error('⚠️ TCP Socket error:', err);
        cleanupSocket('error');
    });

    socket.on('close', (hadError) => {
        console.log(hadError ? '💥 Socket closed with error' : '👋 Socket closed cleanly');
        cleanupSocket(hadError ? 'close-error' : 'close');
    });
});

// Start the server
function startTCPServer() {
    server.listen(tcpPort, () => {
        console.log(`✅ TCP server listening on port ${tcpPort}`);
    });
}

// Export functions
function getApiSocket() {
    return apiSocket;
}

function getIsApiConnected() {
    return isApiConnected;
}

function getClientEncoding() {
    return apiSocket?.clientEncoding || 'utf8';
}

module.exports = {
    startTCPServer,
    getApiSocket,
    getIsApiConnected,
    getClientEncoding
};
