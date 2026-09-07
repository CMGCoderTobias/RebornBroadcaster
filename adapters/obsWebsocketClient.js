const crypto = require('crypto');

function sha256Base64(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('base64');
}

function makeObsAuth(password, salt, challenge) {
  const secret = sha256Base64(String(password) + String(salt));
  return sha256Base64(String(secret) + String(challenge));
}

class ObsWebsocketClient {
  constructor({ host = '127.0.0.1', port = 4455, password = '' } = {}) {
    this.host = host;
    this.port = port;
    this.password = password;

    this.ws = null;
    this.rpcVersion = 1;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.connected = false;

    this.streaming = false;
    this.recording = false;
  }

  _url() {
    return `ws://${this.host}:${this.port}`;
  }

  _send(op, d) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('OBS websocket not connected');
    this.ws.send(JSON.stringify({ op, d }));
  }

  request(requestType, requestData = {}) {
    const requestId = String(this.nextRequestId++);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`OBS request timeout: ${requestType}`));
      }, 6000);

      this.pending.set(requestId, { resolve, reject, timeout, requestType });
      this._send(6, { requestType, requestId, requestData });
    });
  }

  async connect({ timeoutMs = 5000 } = {}) {
    if (this.ws && this.ws.readyState === 1) return;

    const WS = global.WebSocket || WebSocket;
    if (!WS) throw new Error('WebSocket not available in this runtime');

    this.close();

    this.ws = new WS(this._url());

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('OBS connect timeout')), timeoutMs);
      this.ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      this.ws.onerror = () => {
        clearTimeout(t);
        reject(new Error('OBS connect failed'));
      };
    });

    const hello = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('OBS hello timeout')), timeoutMs);
      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data || ''));
          if (msg && msg.op === 0) {
            clearTimeout(t);
            resolve(msg);
          }
        } catch (_) {}
      };
    });

    this.rpcVersion = hello?.d?.rpcVersion || 1;

    const auth = hello?.d?.authentication;
    const identify = { rpcVersion: this.rpcVersion, eventSubscriptions: 0 };

    if (auth && this.password) {
      identify.authentication = makeObsAuth(this.password, auth.salt, auth.challenge);
    }

    // Switch to multiplexer handler
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data || ''));
      } catch (_) {
        return;
      }

      if (!msg) return;

      // Identified
      if (msg.op === 2) {
        this.connected = true;
        return;
      }

      // Request response
      if (msg.op === 7 && msg.d && msg.d.requestId) {
        const pending = this.pending.get(msg.d.requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(msg.d.requestId);

        if (msg.d.requestStatus && msg.d.requestStatus.result === false) {
          pending.reject(new Error(msg.d.requestStatus.comment || 'OBS request failed'));
        } else {
          pending.resolve(msg.d.responseData || {});
        }
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      for (const [id, p] of this.pending.entries()) {
        clearTimeout(p.timeout);
        p.reject(new Error('OBS disconnected'));
      }
      this.pending.clear();
    };

    // Identify and wait for identified state to flip
    this._send(1, identify);

    await new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (this.connected) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error('OBS identify timeout'));
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  close() {
    try { this.ws?.close?.(); } catch (_) {}
    this.ws = null;
    this.connected = false;
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timeout);
      p.reject(new Error('OBS closed'));
    }
    this.pending.clear();
  }

  async test() {
    await this.connect();
    const v = await this.request('GetVersion');
    return { ok: true, version: v?.obsVersion, websocket: v?.obsWebSocketVersion, rpc: v?.rpcVersion };
  }

  async startStream() {
    await this.connect();
    await this.request('StartStream');
    this.streaming = true;
  }

  async stopStream() {
    await this.connect();
    await this.request('StopStream');
    this.streaming = false;
  }

  async startRecord() {
    await this.connect();
    await this.request('StartRecord');
    this.recording = true;
  }

  async stopRecord() {
    await this.connect();
    await this.request('StopRecord');
    this.recording = false;
  }
}

module.exports = { ObsWebsocketClient };