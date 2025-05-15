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

    let clientEncoding = 'utf8';
    let handshakeDone = false;
    let lastHeartbeat = Date.now();

    // 💓 Heartbeat monitor
    const heartbeatInterval = setInterval(() => {
        if (Date.now() - lastHeartbeat > 70000) {
            console.warn('💀 Heartbeat timeout. Killing dead socket.');
            cleanupSocket();
        }
    }, 35000);

    // 🧹 Cleanup handler
    function cleanupSocket() {
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
    }

    // 📩 Data handler
    socket.on('data', async (data) => {
        lastHeartbeat = Date.now();

        try {
            if (!handshakeDone) {
                const header = data.toString('ascii').trim();
                if (header.startsWith('ENCODING:')) {
                    clientEncoding = header.split(':')[1].trim().toLowerCase();
                    socket.clientEncoding = clientEncoding;
                    handshakeDone = true;
                    socket.write(`Server encoding set to: ${clientEncoding}\n`, 'ascii');
                    console.log(`[Electron] Client encoding: ${clientEncoding}`);
                    return;
                } else {
                    console.warn('❌ Handshake missing or invalid. Defaulting to utf8.');
                }
            }

            const raw = iconv.decode(data, clientEncoding).trim();

            if (raw === 'PING') {
                socket.write(iconv.encode('PONG\n', clientEncoding));
                console.log('Ping, Pong');
                return;
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
                    case 'close-app':
                        ipcMain.emit('request-app-close', null, {
                            sender: 'Api',
                            callType: 'Warning'
                        });

                        response = 'Closing app.';

                        // Graceful disconnect
                        if (socket && !socket.destroyed && socket.writable) {
                            socket.write(iconv.encode('Server closing the connection.\n', clientEncoding));
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

            if (response && socket.writable && !socket.destroyed) {
                socket.write(iconv.encode(`${response}\n`, clientEncoding));
            }
        } catch (error) {
            console.error('🔥 Error in TCP handler:', error);
            try {
                if (socket && !socket.destroyed && socket.writable) {
                    socket.write(iconv.encode(`❌ Server error: ${error.message}\n`, clientEncoding));
                }
            } catch (_) {}
        }
    });

    // Cleanup on disconnects or errors
    socket.on('end', () => {
        console.log('🔌 Client ended connection');
        cleanupSocket();
    });

    socket.on('error', (err) => {
        console.error('⚠️ TCP Socket error:', err);
        cleanupSocket();
    });

    socket.on('close', (hadError) => {
        console.log(hadError ? '💥 Socket closed with error' : '👋 Socket closed cleanly');
        cleanupSocket();
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
