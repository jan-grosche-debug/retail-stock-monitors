// Minimal Discord Gateway client over the built-in global WebSocket (Node 18+).
//
// Just enough to receive INTERACTION_CREATE events for a slash-command bot:
//   - connect, HELLO → heartbeat loop, IDENTIFY (intents 0 — interactions are
//     delivered regardless of gateway intents),
//   - track sequence + session for RESUME,
//   - auto-reconnect (resume when possible, else re-identify).
//
// Emits 'interaction' (the d payload of INTERACTION_CREATE) and 'ready'.

const { EventEmitter } = require('events');

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };

class Gateway extends EventEmitter {
  constructor(token, opts = {}) {
    super();
    this.token = token;
    this.intents = opts.intents ?? 0;
    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.hb = null;
    this.acked = true;
    this.closed = false;
    this.reconnectDelay = 1000;
  }

  connect() {
    this.closed = false;
    const url = this.resumeUrl ? `${this.resumeUrl}/?v=10&encoding=json` : GATEWAY_URL;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    ws.addEventListener('close', (ev) => this._onClose(ev.code));
    ws.addEventListener('error', () => { /* close handler drives reconnect */ });
  }

  destroy() {
    this.closed = true;
    this._stopHeartbeat();
    try { this.ws && this.ws.close(1000); } catch (_) { /* ignore */ }
  }

  _send(obj) {
    try { this.ws && this.ws.readyState === 1 && this.ws.send(JSON.stringify(obj)); } catch (_) { /* ignore */ }
  }

  _startHeartbeat(interval) {
    this._stopHeartbeat();
    this.acked = true;
    const beat = () => {
      if (!this.acked) { try { this.ws.close(4000); } catch (_) { /* ignore */ } return; }
      this.acked = false;
      this._send({ op: OP.HEARTBEAT, d: this.seq });
    };
    // jitter the first beat per Discord guidance
    this.hb = setTimeout(() => { beat(); this.hb = setInterval(beat, interval); }, Math.floor(interval * 0.5));
  }

  _stopHeartbeat() { if (this.hb) { clearTimeout(this.hb); clearInterval(this.hb); this.hb = null; } }

  _identify() {
    this._send({
      op: OP.IDENTIFY,
      d: { token: this.token, intents: this.intents, properties: { os: process.platform, browser: 'online-monitor', device: 'online-monitor' } }
    });
  }

  _resume() {
    this._send({ op: OP.RESUME, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
  }

  _onMessage(raw) {
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    if (msg.s != null) this.seq = msg.s;
    switch (msg.op) {
      case OP.HELLO:
        this._startHeartbeat(msg.d.heartbeat_interval);
        if (this.sessionId && this.resumeUrl) this._resume(); else this._identify();
        break;
      case OP.HEARTBEAT:
        this._send({ op: OP.HEARTBEAT, d: this.seq });
        break;
      case OP.HEARTBEAT_ACK:
        this.acked = true;
        break;
      case OP.RECONNECT:
        try { this.ws.close(4001); } catch (_) { /* ignore */ }
        break;
      case OP.INVALID_SESSION:
        // d===true → resumable; otherwise wipe session and re-identify fresh
        if (!msg.d) { this.sessionId = null; this.resumeUrl = null; }
        setTimeout(() => { if (this.sessionId) this._resume(); else this._identify(); }, 1500);
        break;
      case OP.DISPATCH:
        this._onDispatch(msg.t, msg.d);
        break;
      default: break;
    }
  }

  _onDispatch(t, d) {
    if (t === 'READY') {
      this.sessionId = d.session_id;
      this.resumeUrl = d.resume_gateway_url || null;
      this.reconnectDelay = 1000;
      this.emit('ready', d.user);
    } else if (t === 'RESUMED') {
      this.reconnectDelay = 1000;
    } else if (t === 'INTERACTION_CREATE') {
      this.emit('interaction', d);
    } else if (t === 'GUILD_CREATE') {
      this.emit('guild', d);
    }
  }

  _onClose(code) {
    this._stopHeartbeat();
    if (this.closed) return;
    // 4004/4010-4014 are fatal config errors → don't loop forever
    if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) {
      this.emit('fatal', new Error(`gateway closed with fatal code ${code}`));
      return;
    }
    // codes that invalidate the session → can't resume
    if (code === 4007 || code === 4009 || code === 1000) { this.sessionId = null; this.resumeUrl = null; }
    const delay = Math.min(30000, this.reconnectDelay);
    this.reconnectDelay = Math.min(30000, this.reconnectDelay * 2);
    setTimeout(() => { if (!this.closed) this.connect(); }, delay);
  }
}

module.exports = { Gateway };
