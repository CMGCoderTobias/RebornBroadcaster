const net = require('net');
const readline = require('readline');
const iconv = require('iconv-lite');

// Configurations
const HOST = 'localhost';
const PORT = 8010;
const PING_INTERVAL = 30 * 1000;  // 30 seconds ping interval

// Fallback encodings list
const encodings = ['utf-8', 'cp1252', 'iso-8859-1', 'windows-1250'];
let currentEncodingIndex = 0;
let currentEncoding = encodings[currentEncodingIndex];

// Variables
let isConnected = false;
let handshakeDone = false;
let socket;
let rl;
let heartbeatInterval;
let heartbeatCheckInterval;
let lastHeartbeat = Date.now();
let closeAppInitiated = false; // <-- NEW

// Create command line interface
rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Check if the server is listening
function checkIfServerIsAvailable(host, port, callback) {
  const tempSocket = new net.Socket();
  tempSocket.setTimeout(2000);

  tempSocket.on('connect', () => {
    console.log(`Server is ready at ${host}:${port}`);
    tempSocket.end();
    callback(true);
  });

  tempSocket.on('timeout', () => {
    console.log(`Server not ready at ${host}:${port}`);
    tempSocket.end();
    callback(false);
  });

  tempSocket.on('error', (err) => {
    console.log(`Connection error: ${err.message}`);
    tempSocket.end();
    callback(false);
  });

  tempSocket.connect(port, host);
}

// Create the TCP connection
function connectToServer() {
  checkIfServerIsAvailable(HOST, PORT, (isAvailable) => {
    if (isAvailable) {
      socket = new net.Socket();
      socket.connect(PORT, HOST, () => {
        console.log('Connected to server using encoding:', currentEncoding);
        isConnected = true;
        handshakeDone = false;
        sendHandshake();
        startPing();
        startHeartbeatCheck();
      });

      socket.on('data', (data) => {
        handleServerResponse(data);
        lastHeartbeat = Date.now();
      });

      socket.on('error', (err) => {
        console.error(`Error with encoding ${currentEncoding}:`, err.message);
        tryNextEncoding();
      });

      socket.on('close', () => {
        console.log('Connection closed');
        isConnected = false;
        clearInterval(heartbeatInterval);
        clearInterval(heartbeatCheckInterval);
        if (!closeAppInitiated) {
          promptForAction();
        }
      });
    } else {
      console.log('Server is not available. Please try again later.');
      promptForAction();
    }
  });
}

// Attempt to try the next encoding
function tryNextEncoding() {
  if (currentEncodingIndex < encodings.length - 1) {
    currentEncodingIndex++;
    currentEncoding = encodings[currentEncodingIndex];
    console.log(`Attempting to reconnect with ${currentEncoding} encoding...`);
    connectToServer();
  } else {
    console.error('Connection failed. No supported encoding could be used.');
    promptForAction();
  }
}

// Send handshake to server
function sendHandshake() {
  const handshakeMessage = `ENCODING:${currentEncoding}\n`;
  socket.write(handshakeMessage, 'ascii', () => {
    console.log('Handshake sent');
  });
}

// Handle server response
function handleServerResponse(response) {
  let decodedResponse;
  try {
    decodedResponse = iconv.decode(response, currentEncoding);

    if (!handshakeDone) {
      console.log(`Received during handshake:`, decodedResponse);
      if (decodedResponse.startsWith("Server encoding set to:")) {
        handshakeDone = true;
        console.log('Handshake completed. Now processing messages...');
      } else {
        console.warn('❌ Handshake missing or invalid.');
      }
    } else {
      try {
        const jsonResponse = JSON.parse(decodedResponse);
        console.log('Received JSON response:', jsonResponse);
        processMessage(jsonResponse);
      } catch (jsonErr) {
        console.log(decodedResponse);
      }
    }
  } catch (err) {
    console.warn(`Failed to decode with ${currentEncoding}:`, err.message);
    tryNextEncoding();
  }
}

// Process server messages
function processMessage(message) {
  if (message.type === 'disconnect' && message.reason === 'graceful') {
    console.log('Server has gracefully disconnected.');
    isConnected = false;
    clearInterval(heartbeatInterval);
    clearInterval(heartbeatCheckInterval);
    socket.end();

    if (closeAppInitiated) {
      console.log('App requested shutdown confirmed. Exiting now.');
      rl.close();
      process.exit(0);
    } else {
      promptForAction();
    }
  } else {
    console.log('Received message:', message);
  }
}

// Send command to server
function sendCommand(command) {
  if (isConnected) {
    if (command === 'close-app') {
      closeAppInitiated = true;
    }
    socket.write(`${command}\n`, 'ascii');
    console.log(`Sent command: ${command}`);
  } else {
    console.log('API disconnected. Please reconnect first.');
  }
}

// Start sending PINGs
function startPing() {
  heartbeatInterval = setInterval(() => {
    if (isConnected) {
      socket.write("PING\n", 'ascii');
    }
  }, PING_INTERVAL);
}

// Start checking heartbeat timeout
function startHeartbeatCheck() {
  heartbeatCheckInterval = setInterval(() => {
    if (Date.now() - lastHeartbeat > 70000) {
      console.warn('💀 Heartbeat timeout. Retrying dead socket.');
      if (socket) socket.destroy();
    }
  }, 35000);
}

// Reconnect if connection lost
function reconnect() {
  console.log('Attempting to reconnect...');
  setTimeout(connectToServer, 2000);
}

// Prompt the user for action after disconnect
function promptForAction() {
  rl.question('API disconnected. Type "quit" to exit or "reconnect" to reconnect: ', (answer) => {
    const command = answer.trim().toLowerCase();
    if (command === 'quit') {
      if (isConnected) {
        console.log('Waiting for server to gracefully disconnect...');
        socket.on('close', () => {
          console.log('Exiting...');
          rl.close();
          process.exit(0);
        });
        socket.end();
      } else {
        console.log('Exiting...');
        rl.close();
        process.exit(0);
      }
    } else if (command === 'reconnect') {
      reconnect();
    } else {
      console.log('Invalid command. Type "quit" or "reconnect".');
      promptForAction();
    }
  });
}

// Main interactive mode
function startInteractiveMode() {
  rl.on('line', (input) => {
    const command = input.trim().toLowerCase();
    if (command === 'quit') {
      if (isConnected) {
        console.log('Waiting for server to gracefully disconnect...');
        socket.on('close', () => {
          console.log('Exiting...');
          rl.close();
          process.exit(0);
        });
        socket.end();
      } else {
        console.log('Exiting...');
        rl.close();
        process.exit(0);
      }
    } else if (command === 'reconnect') {
      reconnect();
    } else {
      sendCommand(command);
    }
  });
}

// Start connection
connectToServer();
startInteractiveMode();
