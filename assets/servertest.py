import socket
import time
import logging
import locale
import threading
import sys

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

HOST = 'localhost'
PORT = 8010

ENCODING = locale.getpreferredencoding().lower()
PING_INTERVAL = 50  # Time between ping attempts (50 seconds)

# Connection state
is_connected = False
socket_lock = threading.Lock()
stop_event = threading.Event()
s = None  # Global socket reference
handshake_done = False  # Flag to track handshake status

def connect_to_server():
    global s
    try:
        logging.info(f"Connecting to {HOST}:{PORT}...")
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.connect((HOST, PORT))
        logging.info("Connected to server")
        return s
    except Exception as e:
        logging.error(f"Failed to connect: {e}")
        return None

def send_handshake(s):
    try:
        with socket_lock:
            # Send the initial handshake
            s.sendall(f"ENCODING:{ENCODING}\n".encode('ascii'))
    except Exception as e:
        logging.error(f"Handshake error: {e}")
        return False
    return True

def receive_data():
    global handshake_done
    try:
        while True:
            # Receive data from the server
            response = s.recv(1024).decode(ENCODING).strip()
            if response:
                logging.info(f"Server response: {response}")
                # Check for the handshake response
                if not handshake_done and response.startswith("Server encoding set to:"):
                    handshake_done = True
                    logging.info(f"Handshake completed: {response}")
                elif handshake_done:
                    # Handle other messages after handshake
                    logging.info(f"Received after handshake: {response}")
    except Exception as e:
        logging.error(f"Error receiving data: {e}")
        stop_event.set()

def send_ping(s):
    try:
        with socket_lock:
            s.sendall("PING\n".encode(ENCODING))
            response = s.recv(1024).decode(ENCODING)
            if response.strip() == "PONG":
                logging.info("Received PONG")
            else:
                logging.warning(f"Unexpected response: {response.strip()}")
    except Exception as e:
        logging.error(f"Ping failed: {e}")
        return False
    return True

def send_command(s, command):
    try:
        with socket_lock:
            s.sendall(f"{command}\n".encode(ENCODING))
            logging.info(f"Sent command: {command}")
            # Don't read the response here, the receive_data thread will handle that
    except Exception as e:
        logging.error(f"Command send failed: {e}")

def is_socket_connected(socket):
    try:
        # Try sending a no-op request (empty byte) to see if the socket is still connected
        socket.send(b"")
        return True
    except (socket.error, OSError):
        return False

def reconnect():
    global is_connected
    s.close()  # Close the current socket
    time.sleep(2)  # Wait before reconnecting
    s = connect_to_server()

    if s:
        is_connected = True
        send_handshake(s)  # Send handshake again after reconnection
        logging.info("Reconnected to server!")

def monitor_connection(s):
    global is_connected
    while not stop_event.is_set():
        time.sleep(PING_INTERVAL)
        if is_connected:
            if not send_ping(s):
                logging.error("Lost connection to server. Stopping ping monitor.")
                is_connected = False
                stop_event.set()
                break

def main():
    global is_connected
    s = connect_to_server()
    if not s:
        return

    if not send_handshake(s):
        s.close()
        return

    # Start the receiving thread for handshake and server messages
    receive_thread = threading.Thread(target=receive_data, daemon=True)
    receive_thread.start()

    is_connected = True

    monitor_thread = threading.Thread(target=monitor_connection, args=(s,), daemon=True)
    monitor_thread.start()

    try:
        while is_connected:
            command = input("Enter command: ").strip()

            if command.lower() == "quit":
                logging.info("Exiting program...")
                break
            elif command.lower() == "close-app":
                logging.info("Sending close-app command...")
                send_command(s, "close-app")
                break
            elif command.lower() in ['start-stream', 'stop-stream', 'status', 'get-settings']:
                send_command(s, command)
            else:
                logging.warning(f"Invalid command: {command}")
    except KeyboardInterrupt:
        logging.info("Exiting program by KeyboardInterrupt.")
    finally:
        is_connected = False
        stop_event.set()
        try:
            s.shutdown(socket.SHUT_RDWR)
        except:
            pass
        s.close()
        logging.info("Socket closed.")

if __name__ == "__main__":
    main()
