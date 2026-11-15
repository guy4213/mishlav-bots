// A minimal SIP user agent over UDP: registers as a Zadarma SIP line (or PBX extension), answers incoming
// calls and dials out. Digest auth, UDP retransmissions, public address discovery behind NAT (received/rport).
// Ported from gemini-live-agent/phone/sip.js (used on real Zadarma calls).
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const UA_NAME = 'Mishlav-Bot/1.0';
const ALLOW = 'INVITE, ACK, CANCEL, BYE, OPTIONS, UPDATE, INFO';
const T1 = 500; // SIP-over-UDP retransmission timers
const T2 = 4000;

const md5 = (s) => createHash('md5').update(s).digest('hex');
const rnd = (bytes = 6) => randomBytes(bytes).toString('hex');
const newBranch = () => `z9hG4bK${rnd(8)}`;

/* ---------------- Parsing ---------------- */

const COMPACT = { v: 'via', f: 'from', t: 'to', i: 'call-id', m: 'contact', l: 'content-length', c: 'content-type', k: 'supported' };
const LISTS = new Set(['via', 'record-route', 'route', 'contact']); // headers that may hold several comma-separated values

/** Splits a header value on commas that are not inside quotes or <>. */
function splitList(value) {
  const out = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle++;
    else if (!quoted && ch === '>') angle--;
    if (ch === ',' && !quoted && angle === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseSip(buf) {
  const text = buf.toString('utf8');
  const sep = text.indexOf('\r\n\r\n');
  const head = (sep >= 0 ? text.slice(0, sep) : text).replace(/\r\n[ \t]+/g, ' ');
  const lines = head.split('\r\n');
  const msg = { headers: new Map(), body: sep >= 0 ? text.slice(sep + 4) : '' };
  let m = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/.exec(lines[0]);
  if (m) {
    msg.status = Number(m[1]);
    msg.reason = m[2];
  } else {
    m = /^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/.exec(lines[0]);
    if (!m) return null;
    msg.method = m[1];
    msg.uri = m[2];
  }
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    let name = line.slice(0, i).trim().toLowerCase();
    name = COMPACT[name] ?? name;
    const value = line.slice(i + 1).trim();
    const list = msg.headers.get(name) ?? [];
    list.push(...(LISTS.has(name) ? splitList(value) : [value]));
    msg.headers.set(name, list);
  }
  const len = Number(msg.headers.get('content-length')?.[0]);
  if (Number.isFinite(len)) msg.body = Buffer.from(msg.body, 'utf8').subarray(0, len).toString('utf8');
  return msg;
}

const hdr = (msg, name) => msg.headers.get(name)?.[0];
const hdrs = (msg, name) => msg.headers.get(name) ?? [];
const tagOf = (value = '') => /;\s*tag=([^;>\s,]+)/i.exec(value)?.[1];
const paramOf = (value = '', name) => new RegExp(`;\\s*${name}=([^;,\\s>]+)`, 'i').exec(value)?.[1];
export const uriOf = (value = '') => (/<([^>]+)>/.exec(value)?.[1] ?? value.split(';')[0]).trim();
const cseqOf = (msg) => {
  const [num, method] = (hdr(msg, 'cseq') ?? '').split(/\s+/);
  return { num: Number(num), method };
};

function buildMessage(startLine, headers, body = '') {
  const lines = [startLine];
  for (const h of headers) if (h && h[1] != null) lines.push(`${h[0]}: ${h[1]}`);
  lines.push(`Content-Length: ${Buffer.byteLength(body)}`, '', body);
  return lines.join('\r\n');
}

/* ---------------- Digest auth ---------------- */

function parseChallenge(value = '') {
  const out = {};
  for (const m of value.replace(/^Digest\s+/i, '').matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3];
  }
  return out;
}

export function digestResponse({ user, password, realm, nonce, method, uri, qop, nc, cnonce }) {
  const ha1 = md5(`${user}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  return qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
}

/* ---------------- SDP ---------------- */

const CODEC_NAMES = { 8: 'PCMA/8000', 0: 'PCMU/8000' };

/** Audio SDP: G.711 (PCMA/PCMU) and DTMF. */
export function buildSdp({ ip, port, payloadTypes = [8, 0], sessionId = Date.now() }) {
  return [
    'v=0',
    `o=- ${sessionId} ${sessionId} IN IP4 ${ip}`,
    's=Mishlav',
    `c=IN IP4 ${ip}`,
    't=0 0',
    `m=audio ${port} RTP/AVP ${[...payloadTypes, 101].join(' ')}`,
    ...payloadTypes.map((pt) => `a=rtpmap:${pt} ${CODEC_NAMES[pt]}`),
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-16',
    'a=ptime:20',
    'a=sendrecv',
    '',
  ].join('\r\n');
}

export function parseSdp(body = '') {
  let sessionIp = null;
  let mediaIp = null;
  let port = null;
  let payloads = [];
  let inAudio = false;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      const parts = line.slice(2).trim().split(/\s+/);
      inAudio = parts[0] === 'audio';
      if (inAudio) {
        port = Number(parts[1]);
        payloads = parts.slice(3).map(Number);
      }
    } else if (line.startsWith('c=')) {
      const ip = line.trim().split(/\s+/)[2];
      if (inAudio) mediaIp = ip;
      else if (port == null) sessionIp = ip;
    }
  }
  return { ip: mediaIp ?? sessionIp, port, payloads };
}

/** The first codec the other side offered that we support (PCMA or PCMU). */
export const pickCodec = (payloads = []) => payloads.find((pt) => pt === 8 || pt === 0) ?? null;

/** The local address traffic to the server leaves from (right with several NICs or a VPN too). */
async function localAddressFor(ip, port) {
  const s = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => s.connect(port, ip, (err) => (err ? reject(err) : resolve())));
    return s.address().address;
  } finally {
    s.close();
  }
}

/* ---------------- The user agent ---------------- */

/**
 * Events:
 *  'incoming' (SipCall)   an incoming call: call.answer(sdp) or call.reject()
 *  'registered' ({ expires, publicIp, publicPort })
 *  'error' (Error)
 */
export class SipUA extends EventEmitter {
  constructor({ server = 'sip.zadarma.com', port = 5060, user, password, domain, log = () => {} }) {
    super();
    this.server = server;
    this.serverPort = port;
    this.user = user;
    this.password = password;
    this.domain = domain ?? server;
    this.log = log;
    this.calls = new Map(); // Call-ID -> SipCall
    this.registered = false;
    this._txs = new Map(); // `${branch}|${method}` -> transaction waiting for its response
    this._handled = new Map(); // requests already answered (answer a retransmission the same way)
    this._regCseq = 0;
  }

  async start() {
    this.serverIp = (await dns.lookup(this.server, { family: 4 })).address;
    this.localIp = await localAddressFor(this.serverIp, this.serverPort);
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (buf, rinfo) => this._onPacket(buf, rinfo));
    this.sock.on('error', (err) => this.emit('error', err));
    await new Promise((resolve) => this.sock.bind(0, resolve));
    this.localPort = this.sock.address().port;
    this.publicIp = this.localIp;
    this.publicPort = this.localPort;
    const reg = await this.register();
    // Keeps the NAT mapping open so incoming calls reach us
    this._keepalive = setInterval(() => this._sendTo(this.serverIp, this.serverPort, '\r\n\r\n'), 20000);
    return reg;
  }

  async stop() {
    clearInterval(this._keepalive);
    clearTimeout(this._refresh);
    await Promise.allSettled([...this.calls.values()].map((call) => call.hangup()));
    if (this.registered) await this.register(0).catch(() => {});
    try {
      this.sock?.close();
    } catch {}
  }

  /** Registers with the server (expires=0 unregisters). */
  async register(expires = 300) {
    this._regCallId ??= `${rnd(10)}@${this.localIp}`;
    this._regTag ??= rnd(4);
    let auth = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const branch = newBranch();
      const contact = `<sip:${this.user}@${this.publicIp}:${this.publicPort}>`;
      const text = buildMessage(`REGISTER sip:${this.domain} SIP/2.0`, [
        ['Via', `SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=${branch};rport`],
        ['Max-Forwards', '70'],
        ['From', `<sip:${this.user}@${this.domain}>;tag=${this._regTag}`],
        ['To', `<sip:${this.user}@${this.domain}>`],
        ['Call-ID', this._regCallId],
        ['CSeq', `${++this._regCseq} REGISTER`],
        ['Contact', contact],
        ['Expires', String(expires)],
        auth,
        ['Allow', ALLOW],
        ['User-Agent', UA_NAME],
      ]);
      const res = await this._transact(text, { branch, method: 'REGISTER' });
      const moved = this._learnAddress(res);
      if (res.status === 401 || res.status === 407) {
        if (auth && !moved) throw new Error('the SIP line password was not accepted (401)');
        auth = this._authHeader(res, 'REGISTER', `sip:${this.domain}`);
        continue;
      }
      if (res.status >= 200 && res.status < 300) {
        // The server sees us at another address (NAT): register again with the address it sees
        if (moved && expires > 0) {
          auth = null;
          continue;
        }
        this.registered = expires > 0;
        clearTimeout(this._refresh);
        if (!this.registered) return null;
        const ours = hdrs(res, 'contact').find((c) => uriOf(c) === uriOf(contact));
        const granted = Number(paramOf(ours, 'expires')) || Number(hdr(res, 'expires')) || expires;
        this._refresh = setTimeout(
          () => this.register(expires).catch((err) => this.emit('error', err)),
          Math.max(30, granted * 0.8) * 1000,
        );
        const info = { expires: granted, publicIp: this.publicIp, publicPort: this.publicPort };
        this.emit('registered', info);
        return info;
      }
      throw new Error(`registration failed: ${res.status} ${res.reason}`);
    }
    throw new Error('registration failed: too many attempts');
  }

  /** Dials a number. Returns the call at once; call.answered resolves on answer (with the other side's SDP). */
  invite(number, sdp, { displayName } = {}) {
    const call = new SipCall(this, { direction: 'out', number, sdp, displayName });
    this.calls.set(call.callId, call);
    call._dial();
    return call;
  }

  /* ---- internals ---- */

  _sendTo(address, port, text) {
    this._debug('→', `${address}:${port}`, text);
    this.sock?.send(Buffer.from(text), port, address);
  }

  /** SIP_DEBUG=1: logs every SIP message (without the long SDP body), to diagnose the connection. */
  _debug(dir, where, text) {
    if (!process.env.SIP_DEBUG || text.length <= 4) return;
    const [head, body = ''] = text.split('\r\n\r\n');
    const keep = /^(via|from|to|cseq|contact|record-route|www-authenticate|proxy-authenticate|expires|content-type|user-agent|server):/i;
    const lines = head.split('\r\n');
    const shown = [lines[0], ...lines.slice(1).filter((l) => keep.test(l))].map((l) => `   ${l}`).join('\n');
    const sdp = body.split(/\r?\n/).filter((l) => /^(c=|m=)/.test(l)).join(' | ');
    console.log(`[sip ${dir} ${where}]\n${shown}${sdp ? `\n   SDP: ${sdp}` : ''}`);
  }

  /** Sends a request and waits for the final response. Over UDP it resends until a response arrives. */
  _transact(text, { branch, method, to = [this.serverIp, this.serverPort], onProvisional }) {
    const invite = method === 'INVITE';
    const key = `${branch}|${method}`;
    return new Promise((resolve, reject) => {
      const tx = { resolve, onProvisional, provisional: false, done: false };
      this._txs.set(key, tx);
      const send = () => this._sendTo(to[0], to[1], text);
      let interval = T1;
      const again = () => {
        if (tx.done || (invite && tx.provisional)) return;
        send();
        interval = invite ? interval * 2 : Math.min(interval * 2, T2);
        tx.timer = setTimeout(again, interval);
      };
      send();
      tx.timer = setTimeout(again, interval);
      tx.timeout = setTimeout(
        () => {
          if (tx.done) return;
          tx.done = true;
          this._txs.delete(key);
          clearTimeout(tx.timer);
          reject(new Error(`no response from the server to ${method}`));
        },
        invite ? 180000 : 32000,
      );
    });
  }

  _onPacket(buf, rinfo) {
    if (buf.length <= 4) return; // keepalive
    this._debug('←', `${rinfo.address}:${rinfo.port}`, buf.toString('utf8'));
    let msg;
    try {
      msg = parseSip(buf);
    } catch {
      return;
    }
    if (!msg) return;
    if (msg.status) this._onResponse(msg);
    else this._onRequest(msg, rinfo);
  }

  _onResponse(res) {
    const branch = paramOf(hdr(res, 'via'), 'branch');
    const { method } = cseqOf(res);
    const tx = this._txs.get(`${branch}|${method}`);
    if (!tx) {
      // A resent 200 OK (our ACK was lost): ACK again
      if (method === 'INVITE' && res.status >= 200 && res.status < 300) this.calls.get(hdr(res, 'call-id'))?._resendAck();
      return;
    }
    if (res.status < 200) {
      tx.provisional = true;
      tx.onProvisional?.(res);
      return;
    }
    tx.done = true;
    clearTimeout(tx.timer);
    clearTimeout(tx.timeout);
    this._txs.delete(`${branch}|${method}`);
    tx.resolve(res);
  }

  /** received/rport in a response = our public address as the server sees it. */
  _learnAddress(res) {
    const via = hdr(res, 'via');
    const ip = paramOf(via, 'received');
    const port = Number(paramOf(via, 'rport'));
    let moved = false;
    if (ip && ip !== this.publicIp) {
      this.publicIp = ip;
      moved = true;
    }
    if (port && port !== this.publicPort) {
      this.publicPort = port;
      moved = true;
    }
    return moved;
  }

  _authHeader(res, method, uri) {
    const proxy = res.status === 407;
    const ch = parseChallenge(hdr(res, proxy ? 'proxy-authenticate' : 'www-authenticate'));
    const qop = ch.qop?.split(',').map((s) => s.trim()).includes('auth') ? 'auth' : null;
    const nc = '00000001';
    const cnonce = rnd(8);
    const response = digestResponse({ user: this.user, password: this.password, realm: ch.realm, nonce: ch.nonce, method, uri, qop, nc, cnonce });
    let value = `Digest username="${this.user}", realm="${ch.realm}", nonce="${ch.nonce}", uri="${uri}", response="${response}", algorithm=MD5`;
    if (qop) value += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    if (ch.opaque) value += `, opaque="${ch.opaque}"`;
    return [proxy ? 'Proxy-Authorization' : 'Authorization', value];
  }

  /** Response to a request we received. Sent to the address the request came from (rport). */
  _reply(req, rinfo, status, reason, { toTag, headers = [], body = '' } = {}) {
    let to = hdr(req, 'to');
    if (toTag && !tagOf(to)) to += `;tag=${toTag}`;
    const dialog = req.method === 'INVITE' && status > 100 && status < 300;
    const text = buildMessage(`SIP/2.0 ${status} ${reason}`, [
      ...hdrs(req, 'via').map((v) => ['Via', v]),
      ...(dialog ? hdrs(req, 'record-route').map((r) => ['Record-Route', r]) : []),
      ['From', hdr(req, 'from')],
      ['To', to],
      ['Call-ID', hdr(req, 'call-id')],
      ['CSeq', hdr(req, 'cseq')],
      ...headers,
      ['Server', UA_NAME],
    ], body);
    this._sendTo(rinfo.address, rinfo.port, text);
    return text;
  }

  _onRequest(req, rinfo) {
    const callId = hdr(req, 'call-id');
    const { num } = cseqOf(req);
    const key = `${callId}|${num}|${req.method}|${paramOf(hdr(req, 'via'), 'branch')}`;
    // A retransmission of a request we already answered: send the same answer again
    if (req.method !== 'ACK' && this._handled.has(key)) {
      const last = this._handled.get(key);
      if (last) this._sendTo(rinfo.address, rinfo.port, last);
      return;
    }
    const remember = (text) => {
      this._handled.set(key, text);
      setTimeout(() => this._handled.delete(key), 40000).unref?.();
    };
    const call = this.calls.get(callId);

    switch (req.method) {
      case 'INVITE': {
        if (call) {
          // re-INVITE mid-call (e.g. a session refresh): keep the same audio
          remember(call._answerAgain(req, rinfo));
          return;
        }
        const incoming = new SipCall(this, { direction: 'in', req, rinfo, handledKey: key });
        this.calls.set(callId, incoming);
        remember(this._reply(req, rinfo, 100, 'Trying'));
        this.emit('incoming', incoming);
        return;
      }
      case 'ACK':
        call?._onAck();
        return;
      case 'BYE':
        remember(this._reply(req, rinfo, 200, 'OK'));
        call?._ended('bye');
        return;
      case 'CANCEL':
        remember(this._reply(req, rinfo, 200, 'OK'));
        call?._onCancel();
        return;
      case 'OPTIONS':
        remember(this._reply(req, rinfo, 200, 'OK', { headers: [['Allow', ALLOW], ['Accept', 'application/sdp']] }));
        return;
      case 'UPDATE':
        remember(
          call && req.body
            ? this._reply(req, rinfo, 200, 'OK', { headers: [['Content-Type', 'application/sdp']], body: call.localSdp })
            : this._reply(req, rinfo, 200, 'OK'),
        );
        return;
      default:
        remember(this._reply(req, rinfo, 200, 'OK'));
    }
  }
}

/* ---------------- A call ---------------- */

/**
 * Events:
 *  'ringing' (status, sdp|null)   (outbound) the other side is ringing
 *  'confirmed'                    (inbound) the ACK arrived after we answered
 *  'ended' (reason)               the call ended: 'bye' (the other side hung up), 'local', 'cancel', 'failed …'
 */
export class SipCall extends EventEmitter {
  constructor(ua, { direction, req, rinfo, handledKey, number, sdp, displayName }) {
    super();
    this.ua = ua;
    this.direction = direction;
    this.state = 'new';
    this.localTag = rnd(4);
    this.localCseq = 0;
    if (direction === 'in') {
      this.invite = req;
      this.peer = rinfo; // in-dialog requests go to the server the call came from
      this._handledKey = handledKey;
      this.callId = hdr(req, 'call-id');
      this.localUri = hdr(req, 'to');
      this.remoteUri = hdr(req, 'from');
      this.remoteTarget = uriOf(hdrs(req, 'contact')[0] ?? hdr(req, 'from'));
      this.routeSet = hdrs(req, 'record-route');
      this.remoteSdp = parseSdp(req.body);
      this.number = /^sips?:\+?([^@;]+)/i.exec(uriOf(hdr(req, 'from')))?.[1] ?? 'unknown';
    } else {
      this.callId = `${rnd(10)}@${ua.localIp}`;
      this.number = number;
      this.localSdp = sdp;
      this.requestUri = `sip:${number}@${ua.domain}`;
      this.localUri = `${displayName ? `"${displayName}" ` : ''}<sip:${ua.user}@${ua.domain}>`;
      this.remoteUri = `<${this.requestUri}>`;
      this.routeSet = [];
      this.answered = new Promise((resolve, reject) => {
        this._resolveAnswer = resolve;
        this._rejectAnswer = reject;
      });
      this.answered.catch(() => {}); // whoever awaits the answer handles the failure
    }
  }

  get established() {
    return this.state === 'answered' || this.state === 'confirmed';
  }

  /* ---- inbound ---- */

  ringing() {
    if (this.direction !== 'in' || this.state !== 'new') return;
    this.state = 'ringing';
    this.ua._handled.set(this._handledKey, this.ua._reply(this.invite, this.peer, 180, 'Ringing', { toTag: this.localTag }));
  }

  answer(sdp) {
    if (this.direction !== 'in' || this.state === 'ended') return;
    this.localSdp = sdp;
    this.state = 'answered';
    this._ok = this.ua._reply(this.invite, this.peer, 200, 'OK', {
      toTag: this.localTag,
      headers: [['Contact', this._contact()], ['Allow', ALLOW], ['Content-Type', 'application/sdp']],
      body: sdp,
    });
    this.ua._handled.set(this._handledKey, this._ok);
    // Resend the 200 OK until the ACK arrives
    let interval = T1;
    let elapsed = 0;
    const again = () => {
      if (this.state !== 'answered') return;
      if (elapsed > 32000) {
        this.hangup();
        return;
      }
      this.ua._sendTo(this.peer.address, this.peer.port, this._ok);
      elapsed += interval;
      interval = Math.min(interval * 2, T2);
      this._okTimer = setTimeout(again, interval);
    };
    this._okTimer = setTimeout(again, interval);
  }

  reject(status = 486, reason = 'Busy Here') {
    if (this.direction !== 'in' || this.established || this.state === 'ended') return;
    this.ua._handled.set(this._handledKey, this.ua._reply(this.invite, this.peer, status, reason, { toTag: this.localTag }));
    this._ended(`rejected ${status}`);
  }

  _answerAgain(req, rinfo) {
    return this.ua._reply(req, rinfo, 200, 'OK', {
      toTag: this.localTag,
      headers: [['Contact', this._contact()], ['Allow', ALLOW], ['Content-Type', 'application/sdp']],
      body: this.localSdp ?? '',
    });
  }

  _onAck() {
    if (this.state !== 'answered') return;
    this.state = 'confirmed';
    clearTimeout(this._okTimer);
    this.emit('confirmed');
  }

  _onCancel() {
    if (this.direction !== 'in' || this.established || this.state === 'ended') return;
    this.ua._reply(this.invite, this.peer, 487, 'Request Terminated', { toTag: this.localTag });
    this._ended('cancel');
  }

  /* ---- outbound ---- */

  async _dial() {
    const ua = this.ua;
    let auth = null;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const branch = newBranch();
        const cseq = ++this.localCseq;
        const text = buildMessage(`INVITE ${this.requestUri} SIP/2.0`, [
          ['Via', `SIP/2.0/UDP ${ua.localIp}:${ua.localPort};branch=${branch};rport`],
          ['Max-Forwards', '70'],
          ['From', `${this.localUri};tag=${this.localTag}`],
          ['To', this.remoteUri],
          ['Call-ID', this.callId],
          ['CSeq', `${cseq} INVITE`],
          ['Contact', this._contact()],
          auth,
          ['Allow', ALLOW],
          ['User-Agent', UA_NAME],
          ['Content-Type', 'application/sdp'],
        ], this.localSdp);
        this._inviteTx = { branch, cseq };
        if (this.state === 'new') this.state = 'calling';
        const res = await ua._transact(text, {
          branch,
          method: 'INVITE',
          onProvisional: (p) => {
            if (p.status === 180 || p.status === 183) {
              if (this.state === 'calling') this.state = 'ringing';
              this.emit('ringing', p.status, p.body ? parseSdp(p.body) : null);
            }
          },
        });
        if (res.status >= 200 && res.status < 300) {
          this._onAnswered(res, cseq);
          return;
        }
        this._ackFailure(res);
        if ((res.status === 401 || res.status === 407) && !auth && this.state !== 'cancelling') {
          auth = ua._authHeader(res, 'INVITE', this.requestUri);
          continue;
        }
        throw Object.assign(new Error(`${res.status} ${res.reason}`), { status: res.status });
      }
      throw new Error('too many attempts');
    } catch (err) {
      this._ended(this.state === 'cancelling' ? 'cancel' : `failed ${err.status ?? ''}`.trim());
      this._rejectAnswer(err);
    }
  }

  _onAnswered(res, cseq) {
    this.remoteUri = hdr(res, 'to');
    this.remoteTarget = uriOf(hdrs(res, 'contact')[0] ?? this.requestUri);
    this.routeSet = [...hdrs(res, 'record-route')].reverse();
    this.remoteSdp = parseSdp(res.body);
    this._ack = buildMessage(`ACK ${this.remoteTarget} SIP/2.0`, [
      ['Via', `SIP/2.0/UDP ${this.ua.localIp}:${this.ua.localPort};branch=${newBranch()};rport`],
      ['Max-Forwards', '70'],
      ...this.routeSet.map((r) => ['Route', r]),
      ['From', `${this.localUri};tag=${this.localTag}`],
      ['To', this.remoteUri],
      ['Call-ID', this.callId],
      ['CSeq', `${cseq} ACK`],
      ['User-Agent', UA_NAME],
    ]);
    this._resendAck();
    const cancelled = this.state === 'cancelling';
    this.state = 'confirmed';
    if (cancelled) {
      this.hangup(); // answered just as we cancelled: hang up
      this._rejectAnswer(new Error('cancelled'));
      return;
    }
    this._resolveAnswer(this.remoteSdp);
  }

  _resendAck() {
    if (this._ack) this.ua._sendTo(...this._nextHop(), this._ack);
  }

  /** ACK for a non-2xx final response (part of the INVITE transaction). */
  _ackFailure(res) {
    const ua = this.ua;
    ua._sendTo(ua.serverIp, ua.serverPort, buildMessage(`ACK ${this.requestUri} SIP/2.0`, [
      ['Via', `SIP/2.0/UDP ${ua.localIp}:${ua.localPort};branch=${this._inviteTx.branch};rport`],
      ['Max-Forwards', '70'],
      ['From', `${this.localUri};tag=${this.localTag}`],
      ['To', hdr(res, 'to')],
      ['Call-ID', this.callId],
      ['CSeq', `${this._inviteTx.cseq} ACK`],
      ['User-Agent', UA_NAME],
    ]));
  }

  /* ---- both ---- */

  /** Hangs up: BYE on a live call, CANCEL on an outbound call still ringing, reject on an unanswered inbound call. */
  async hangup() {
    if (this.state === 'ended' || this.state === 'cancelling') return;
    if (this.direction === 'in' && !this.established) return this.reject(480, 'Temporarily Unavailable');
    if (this.direction === 'out' && !this.established) return this._cancel();
    this._ended('local');
    const ua = this.ua;
    let auth = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const branch = newBranch();
      const text = buildMessage(`BYE ${this.remoteTarget} SIP/2.0`, [
        ['Via', `SIP/2.0/UDP ${ua.localIp}:${ua.localPort};branch=${branch};rport`],
        ['Max-Forwards', '70'],
        ...this.routeSet.map((r) => ['Route', r]),
        ['From', tagOf(this.localUri) ? this.localUri : `${this.localUri};tag=${this.localTag}`],
        ['To', this.remoteUri],
        ['Call-ID', this.callId],
        ['CSeq', `${++this.localCseq} BYE`],
        auth,
        ['User-Agent', UA_NAME],
      ]);
      const res = await ua._transact(text, { branch, method: 'BYE', to: this._nextHop() }).catch(() => null);
      if (res && (res.status === 401 || res.status === 407) && !auth) {
        auth = ua._authHeader(res, 'BYE', this.remoteTarget);
        continue;
      }
      return;
    }
  }

  async _cancel() {
    if (!this._inviteTx || (this.state !== 'calling' && this.state !== 'ringing')) return;
    this.state = 'cancelling';
    const ua = this.ua;
    const text = buildMessage(`CANCEL ${this.requestUri} SIP/2.0`, [
      ['Via', `SIP/2.0/UDP ${ua.localIp}:${ua.localPort};branch=${this._inviteTx.branch};rport`],
      ['Max-Forwards', '70'],
      ['From', `${this.localUri};tag=${this.localTag}`],
      ['To', this.remoteUri],
      ['Call-ID', this.callId],
      ['CSeq', `${this._inviteTx.cseq} CANCEL`],
      ['User-Agent', UA_NAME],
    ]);
    await ua._transact(text, { branch: this._inviteTx.branch, method: 'CANCEL' }).catch(() => null);
  }

  _contact() {
    return `<sip:${this.ua.user}@${this.ua.publicIp}:${this.ua.publicPort}>`;
  }

  _nextHop() {
    return this.direction === 'in' ? [this.peer.address, this.peer.port] : [this.ua.serverIp, this.ua.serverPort];
  }

  _ended(reason) {
    if (this.state === 'ended') return;
    this.state = 'ended';
    clearTimeout(this._okTimer);
    this.ua.calls.delete(this.callId);
    this.emit('ended', reason);
  }
}
