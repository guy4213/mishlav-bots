// The audio of one call: RTP packets over UDP, 20 ms each, G.711.
// Sends at a steady pace (silence too, so the router keeps the address open); received audio is decoded to
// 8 kHz PCM. Ported from gemini-live-agent/phone/rtp.js.
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { decodeG711, encodeG711, FRAME_SAMPLES } from './audio.js';

const SILENCE = new Int16Array(FRAME_SAMPLES);

/**
 * Events:
 *  'audio' (Int16Array)   20 ms of the other side's audio (8 kHz)
 *  'error' (Error)
 */
export class RtpSession extends EventEmitter {
  /** @param {{ nextFrame?: () => Int16Array | null }} opts nextFrame returns 160 samples to send, or null for silence */
  constructor({ nextFrame } = {}) {
    super();
    this.nextFrame = nextFrame ?? (() => null);
    this.payloadType = 8; // from the SDP: 8 = PCMA, 0 = PCMU
    this.remote = null; // { address, port }
    this.port = 0;
    this.received = 0;
    this.sent = 0;
    this.lost = 0; // packets from the other side that never arrived (by sequence number)
    this.late = 0; // packets that arrived after a later one and were dropped (else the audio plays out of order)
    this._rxSsrc = null;
    this._rxSeq = null;
    this._sock = null;
    this._timer = null;
    this._seq = randomBytes(2).readUInt16BE();
    this._ts = randomBytes(4).readUInt32BE();
    this._ssrc = randomBytes(4).readUInt32BE();
    this._latched = false;
  }

  /** Opens an even UDP port for the audio. */
  async open() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const port = 40000 + 2 * Math.floor(Math.random() * 5000);
      const sock = dgram.createSocket('udp4');
      const ok = await new Promise((resolve) => {
        sock.once('error', () => resolve(false));
        sock.bind(port, () => resolve(true));
      });
      if (!ok) {
        sock.close();
        continue;
      }
      sock.on('error', (err) => this.emit('error', err));
      sock.on('message', (buf, rinfo) => this._onPacket(buf, rinfo));
      this._sock = sock;
      this.port = port;
      return port;
    }
    throw new Error('no free UDP port for the call audio');
  }

  /** Where to send (from the other side's SDP). */
  setRemote(address, port, payloadType) {
    if (!this._latched) this.remote = { address, port };
    if (payloadType != null) this.payloadType = payloadType;
  }

  /** Sends a frame every 20 ms. If the timer lags, sends the frames that are due to keep the pace. */
  start() {
    if (this._timer) return;
    const t0 = performance.now();
    let frames = 0;
    this._timer = setInterval(() => {
      const due = Math.floor((performance.now() - t0) / 20);
      if (due - frames > 10) frames = due - 1; // far behind: don't burst a second of audio at once
      while (frames < due) {
        this._send(this.nextFrame() ?? SILENCE);
        frames++;
      }
    }, 10);
  }

  close() {
    clearInterval(this._timer);
    this._timer = null;
    try {
      this._sock?.close();
    } catch {}
    this._sock = null;
  }

  _send(samples) {
    if (!this._sock || !this.remote) return;
    const payload = encodeG711(samples, this.payloadType);
    const header = Buffer.alloc(12);
    header[0] = 0x80; // RTP version 2
    header[1] = this.payloadType & 0x7f;
    header.writeUInt16BE(this._seq, 2);
    header.writeUInt32BE(this._ts >>> 0, 4);
    header.writeUInt32BE(this._ssrc >>> 0, 8);
    this._seq = (this._seq + 1) & 0xffff;
    this._ts = (this._ts + samples.length) >>> 0;
    this._sock.send(Buffer.concat([header, payload]), this.remote.port, this.remote.address);
    this.sent++;
  }

  _onPacket(buf, rinfo) {
    if (buf.length < 12 || buf[0] >> 6 !== 2) return;
    // Symmetric RTP: answer to the address the audio really comes from (matters behind NAT)
    if (!this._latched || this.remote?.address !== rinfo.address || this.remote?.port !== rinfo.port) {
      this.remote = { address: rinfo.address, port: rinfo.port };
      this._latched = true;
    }
    // Sequence: a new source (e.g. after the ringback) starts a new count
    const ssrc = buf.readUInt32BE(8);
    const seq = buf.readUInt16BE(2);
    if (ssrc !== this._rxSsrc) {
      this._rxSsrc = ssrc;
      this._rxSeq = seq;
    } else {
      const ahead = (seq - this._rxSeq) & 0xffff;
      if (ahead === 0) return; // duplicate
      if (ahead >= 0x8000) {
        this.late++;
        this.lost = Math.max(0, this.lost - 1); // was counted as lost when the next packet arrived
        return;
      }
      this.lost += ahead - 1;
      this._rxSeq = seq;
    }
    const pt = buf[1] & 0x7f;
    if (pt !== 0 && pt !== 8) return; // e.g. DTMF (telephone-event)
    let offset = 12 + 4 * (buf[0] & 0x0f); // CSRC
    if (buf[0] & 0x10) offset += 4 + 4 * buf.readUInt16BE(offset + 2); // extension
    let end = buf.length;
    if (buf[0] & 0x20) end -= buf[buf.length - 1]; // padding
    if (offset >= end) return;
    this.received++;
    this.emit('audio', decodeG711(buf.subarray(offset, end), pt));
  }
}
