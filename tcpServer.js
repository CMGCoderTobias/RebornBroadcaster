const net = require('net');
const { ipcMain } = require('electron');
const iconv = require('iconv-lite');
const fs = require('fs');

const tcpPort = 8010;
let isApiConnected = false;
let apiSocket = null;

// Create and start the TCP server
const server = net.createServer((socket) => {
    console.log('📡 API Client connected via TCP');
    isApiConnected = true;
    apiSocket = socket;

    let clientEncoding = 'utf8'; // Default encoding until handshake
    let handshakeDone = false;
    let lastHeartbeat = Date.now();

    // 💓 Heartbeat monitor
    const heartbeatInterval = setInterval(() => {
        if (Date.now() - lastHeartbeat > 70000) { // 35 seconds without any data
            console.warn('💀 Heartbeat timeout. retrying dead socket.');
            socket.destroy(); // Forcefully close
        }
    }, 35000); // Check every 10 seconds

    socket.on('data', async (data) => {
        lastHeartbeat = Date.now();

        try {
            // 🔥 Protect entire handler inside try-catch

            // Initial handshake (ASCII only)
            if (!handshakeDone) {
                const header = data.toString('ascii').trim();
                if (header.startsWith('ENCODING:')) {
                    socket.clientEncoding = header.split(':')[1].trim().toLowerCase();
                    clientEncoding = socket.clientEncoding;
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

            // Handle special commands first
            if (raw.startsWith('save-settings:')) {
                ipcMain.emit('api-save-settings', null, raw.slice('save-settings:'.length).trim());
                response = 'Settings saved.';
            } else if (raw === 'get-settings') {
                ipcMain.emit('api-request-get-settings');
                response = 'Requested settings.';
            } else {
                // Switch command handling
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
                        break;
                    case 'open-app':
                        ipcMain.emit('open-renderer');
                        response = 'Opening app.';
                        break;
                    default:
                        response = 'Unknown command.';
                }
            }

            // ✅ Always send back response (even if empty)
            socket.write(iconv.encode(`${response}\n`, clientEncoding));
        } catch (error) {
            console.error('🔥 Fatal error in TCP handler:', error);

            try {
                socket.write(iconv.encode(`❌ Internal server error: ${error.message}\n`, clientEncoding));
            } catch (sendErr) {
                console.error('❌ Failed to send error back to client:', sendErr);
            }
        }
    });

    socket.on('end', () => {
        console.log('🔌 API Client disconnected');
        clearInterval(heartbeatInterval); // Stop the heartbeat interval
        isApiConnected = false;
        apiSocket = null;
    });

    socket.on('error', (err) => {
        console.error('⚠️ TCP Socket error:', err);
        clearInterval(heartbeatInterval); // Stop the heartbeat interval
        isApiConnected = false;
        apiSocket = null;
    });

    socket.on('close', (hadError) => {
        if (hadError) {
            console.error('Connection closed with error');
        } else {
            console.log('Connection closed cleanly');
        }

        // Optionally send a "goodbye" message before closing
        socket.write('Server closing the connection.\n');
        socket.end(); // Gracefully close the server-side connection
    });
});

// Start TCP server listening on specified port
function startTCPServer() {
    server.listen(tcpPort, () => {
        console.log(`✅ TCP server listening on port ${tcpPort}`);
    });
}

// Exports for external interactions
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
