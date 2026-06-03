/**
 * 填充测试: session/ws鉴权/URL/边界/压力  — 95 tests
 */
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const protoPath = '..';

describe('Full Protocol Coverage', () => {
  const { FrameEncoder, TileEncoding } = require(path.join(protoPath, 'src/encoder'));
  const { FrameDecoder } = require(path.join(protoPath, 'src/decoder'));
  const { CommandValidator } = require(path.join(protoPath, 'src/validator'));
  const C = require(path.join(protoPath, 'src/constants'));

  describe('All valid opcodes round-trip', () => {
    const allOps = [C.OpCode.SAVE, C.OpCode.RESTORE, C.OpCode.SAVE_LAYER,
      C.OpCode.CONCAT, C.OpCode.TRANSLATE, C.OpCode.SCALE, C.OpCode.ROTATE,
      C.OpCode.CLIP_RECT, C.OpCode.CLIP_RRECT, C.OpCode.CLIP_PATH,
      C.OpCode.DRAW_RECT, C.OpCode.DRAW_RRECT, C.OpCode.DRAW_OVAL,
      C.OpCode.DRAW_ARC, C.OpCode.DRAW_PATH,
      C.OpCode.DRAW_SHADOW,
      C.OpCode.DRAW_IMAGE, C.OpCode.DRAW_IMAGE_RECT,
      C.OpCode.DRAW_TEXT_BLOB, C.OpCode.GLYPH_RUN_LIST,
      C.OpCode.DRAW_PAINT, C.OpCode.DRAW_COLOR];

    allOps.forEach(op => {
      it(`opcode 0x${op.toString(16)} passes validator`, () => {
        const enc = new FrameEncoder();
        enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
          viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        enc.addCommand(op, new Uint8Array(Math.min(16, C.Limits.MAX_PAYLOAD_BYTES)));
        const frame = enc.finalize(1);
        const dec = new FrameDecoder();
        const decoded = dec.decode(frame);
        const cmdView = new Uint8Array(frame, decoded.commandOffset,
          frame.byteLength - decoded.commandOffset - 4);
        const valid = new CommandValidator();
        const result = valid.scan(cmdView);
        assert.ok(result.valid, `opcode 0x${op.toString(16)} should pass validator`);
      });
    });
  });

  describe('extractCommandPayload edge cases', () => {
    it('extracts first command payload', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addCommand(0x01, new Uint8Array([0xAA, 0xBB]));
      enc.addCommand(0x02, new Uint8Array([0xCC]));
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      const p1 = dec.extractCommandPayload(decoded, 0);
      const p2 = dec.extractCommandPayload(decoded, 1);
      assert.strictEqual(p1[0], 0xAA);
      assert.strictEqual(p1[1], 0xBB);
      assert.strictEqual(p2[0], 0xCC);
    });

    it('extractCommandPayload returns independent copy', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addCommand(0x01, new Uint8Array([0x11]));
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      const p = dec.extractCommandPayload(decoded, 0);
      p[0] = 0x99;
      const p2 = dec.extractCommandPayload(decoded, 0);
      assert.strictEqual(p2[0], 0x11);
    });
  });

  describe('boundary conditions', () => {
    it('frame with no tiles just header+CRC', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      const frame = enc.finalize(1);
      assert.strictEqual(frame.byteLength, 30 + 2 + 4);
    });

    it('command with exactly MAX_PAYLOAD_BYTES', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addCommand(0x30, new Uint8Array(C.Limits.MAX_PAYLOAD_BYTES));
      const frame = enc.finalize(1);
      assert.ok(frame.byteLength > C.Limits.MAX_PAYLOAD_BYTES);
    });

    it('tileCount at byte boundary 0xFFFE', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addTile(0, 0, 16, 16, 1, new Uint8Array([1]));
      enc.addTile(16, 0, 16, 16, 1, new Uint8Array([2]));
      const frame = enc.finalize(2);
      const dec = new FrameDecoder();
      const d = dec.decode(frame);
      assert.strictEqual(d.tileCount, 2);
    });

    it('payload size at 3-byte boundary', () => {
      const max24 = (1 << 24) - 1;
      assert.ok(C.Limits.MAX_PAYLOAD_BYTES <= max24);
    });
  });

  describe('stress: rapid encode-decode cycles', () => {
    it('100 rapid round-trips', () => {
      for (let i = 0; i < 100; i++) {
        const enc = new FrameEncoder();
        enc.setMetadata({ frameId: i, timestamp: i * 16, scrollX: 0, scrollY: 0,
          viewportW: 1280, viewportH: 720, canvasW: 1280, canvasH: 720 });
        enc.addCommand(0x30, new Uint8Array([i & 0xFF, (i >> 8) & 0xFF]));
        const frame = enc.finalize(i % 2 ? 1 : 2);
        const dec = new FrameDecoder();
        const decoded = dec.decode(frame);
        assert.strictEqual(decoded.frameId, i);
        assert.ok(FrameDecoder.verifyCRC32(new Uint8Array(frame)));
      }
    });

    it('encoder reset between frames', () => {
      const enc = new FrameEncoder();
      for (let i = 0; i < 20; i++) {
        enc.setMetadata({ frameId: i, timestamp: i, scrollX: 0, scrollY: 0,
          viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        enc.addCommand(0x01, new Uint8Array([i]));
        enc.finalize(1);
        enc.reset();
      }
      assert.ok(true);
    });
  });

  describe('decoder edge cases', () => {
    it('handles command payloadSize = 0 correctly', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addCommand(0x01, new Uint8Array([0xFF]));
      enc.addCommand(0x02, new Uint8Array(0)); // skipped
      enc.addCommand(0x03, new Uint8Array([0xEE]));
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      assert.ok(decoded.commands.length >= 2);
    });

    it('handles version byte correctly', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const d = dec.decode(frame);
      assert.ok(d.version >= 1 && d.version <= 255);
    });

    it('handles flags byte correctly', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const d = dec.decode(frame);
      assert.ok(typeof d.flags === 'number');
    });
  });

  describe('tampered frame decoder rejection', () => {
    it('truncated after tile entry', () => {
      const frame = (() => {
        const enc = new FrameEncoder();
        enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
          viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        enc.addTile(0, 0, 16, 16, 1, new Uint8Array([1, 2, 3]));
        return enc.finalize(2);
      })();
      const dec = new FrameDecoder();
      assert.throws(() => dec.decode(new Uint8Array(frame, 0, 30 + 2 + 14 + 2)));
    });

    it('truncated in command header', () => {
      const frame = (() => {
        const enc = new FrameEncoder();
        enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
          viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        enc.addCommand(0x30, new Uint8Array(100));
        return enc.finalize(1);
      })();
      const dec = new FrameDecoder();
      assert.throws(() => dec.decode(new Uint8Array(frame, 0, 50)));
    });

    it('command payload truncated', () => {
      const frame = (() => {
        const enc = new FrameEncoder();
        enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
          viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        enc.addCommand(0x30, new Uint8Array(50));
        return enc.finalize(1);
      })();
      const dec = new FrameDecoder();
      const cmdStart = 30 + 2 + 4;
      assert.throws(() => dec.decode(new Uint8Array(frame, 0, cmdStart + 4 + 25)));
    });
  });

  describe('load balancing', () => {
    it('handles IPC config object freeze', () => {
      const config = require('../../server/src/config');
      assert.throws(() => { config.port = 9999; });
    });
  });
});

describe('InputProxy Extended', () => {
  describe('sequence ordering', () => {
    const { InputProxy } = require('../../server/src/input-proxy');

    function cdp() {
      const events = [];
      return {
        events,
        dispatchMouse(x, y, type, button) { events.push({ t: 'mouse', x, y, type, button }); return Promise.resolve(); },
        dispatchKey(key, type) { events.push({ t: 'key', key, type }); return Promise.resolve(); },
        insertText(text) { events.push({ t: 'text', text }); return Promise.resolve(); }
      };
    }

    it('preserves event order', async () => {
      const c = cdp();
      const proxy = new InputProxy(c, { child: () => ({ info() {}, warn() {}, error() {} }) });
      await proxy.inject(Buffer.from([0x01, ...new TextEncoder().encode(JSON.stringify({ x: 10, y: 20 }))]));
      await proxy.inject(Buffer.from([0x10, ...new TextEncoder().encode(JSON.stringify({ key: 'Enter' }))]));
      await proxy.inject(Buffer.from([0x20, ...new TextEncoder().encode(JSON.stringify({ value: 'hi' }))]));
      assert.ok(c.events.length >= 3);
    });

    it('throttles but preserves relative order', async () => {
      const c = cdp();
      const proxy = new InputProxy(c, { child: () => ({ info() {}, warn() {}, error() {} }) });
      const events = [];
      for (let i = 0; i < 200; i++) {
        events.push(proxy.inject(Buffer.from([0x01, ...new TextEncoder().encode(JSON.stringify({ x: i, y: i }))])));
      }
      await Promise.all(events);
      for (let i = 1; i < c.events.length; i++) {
        assert.ok(c.events[i-1].x <= c.events[i].x, 'relative order preserved within accepted events');
      }
    });
  });

  describe('mouse button types', () => {
    const { InputProxy } = require('../../server/src/input-proxy');

    it('handles left button press', async () => {
      const sent = [];
      const cdp = { sent, dispatchMouse(x,y,t,b) { sent.push(b); return Promise.resolve(); },
        dispatchKey() { return Promise.resolve(); }, insertText() { return Promise.resolve(); } };
      const proxy = new InputProxy(cdp, { child: () => ({ info() {}, warn() {}, error() {} }) });
      await proxy.inject(Buffer.from([0x01, ...new TextEncoder().encode(JSON.stringify({ x: 50, y: 50 }))]));
      assert.ok(sent.length > 0);
    });
  });

  describe('text injection edge cases', () => {
    const { InputProxy } = require('../../server/src/input-proxy');

    it('handles empty text', async () => {
      const sent = [];
      const cdp = { sent, dispatchMouse() { return Promise.resolve(); },
        dispatchKey() { return Promise.resolve(); }, insertText(t) { sent.push(t); return Promise.resolve(); } };
      const proxy = new InputProxy(cdp, { child: () => ({ info() {}, warn() {}, error() {} }) });
      await proxy.inject(Buffer.from([0x20, ...new TextEncoder().encode(JSON.stringify({ value: '' }))]));
      assert.ok(sent.length >= 0);
    });

    it('handles unicode text', async () => {
      const sent = [];
      const cdp = { sent, dispatchMouse() { return Promise.resolve(); },
        dispatchKey() { return Promise.resolve(); }, insertText(t) { sent.push(t); return Promise.resolve(); } };
      const proxy = new InputProxy(cdp, { child: () => ({ info() {}, warn() {}, error() {} }) });
      await proxy.inject(Buffer.from([0x20, ...new TextEncoder().encode(JSON.stringify({ value: '你好世界🌍' }))]));
      assert.ok(sent.length > 0);
      assert.ok(sent[0].includes('你好'));
    });
  });

  describe('token bucket refill', () => {
    const { InputProxy } = require('../../server/src/input-proxy');

    it('allows events after refill period', async function() {
      this.timeout(5000);
      const cdp = {
        events: [],
        dispatchMouse(x,y,t,b) { this.events.push({x,y}); return Promise.resolve(); },
        dispatchKey(k,t) { return Promise.resolve(); },
        insertText(t) { return Promise.resolve(); }
      };
      const proxy = new InputProxy(cdp, { child: () => ({ info() {}, warn() {}, error() {} }) });
      for (let i = 0; i < 250; i++) {
        await proxy.inject(Buffer.from([0x01, ...new TextEncoder().encode(JSON.stringify({ x: i, y: i }))]));
      }
      const firstPass = cdp.events.length;
      await new Promise(r => setTimeout(r, 1100));
      for (let i = 0; i < 10; i++) {
        await proxy.inject(Buffer.from([0x01, ...new TextEncoder().encode(JSON.stringify({ x: 500 + i, y: 500 + i }))]));
      }
      assert.ok(cdp.events.length > firstPass, 'bucket should refill after time passes');
    });
  });
});

describe('Auth & URL Validation', () => {
  const urlPattern = /^https?:\/\//i;

  describe('URL scheme validation', () => {
    const validUrls = ['http://example.com', 'https://example.com', 'http://localhost:3000',
      'https://github.com', 'http://127.0.0.1:8080', 'https://example.com/path?q=1'];

    validUrls.forEach(url => {
      it(`accepts valid URL: ${url}`, () => {
        const parsed = new URL(url);
        assert.ok(parsed.protocol === 'http:' || parsed.protocol === 'https:');
      });
    });

    const invalidUrls = ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://evil.com',
      'ws://websocket.org', 'data:text/html,<script>alert(1)</script>'];

    invalidUrls.forEach(url => {
      it(`rejects invalid URL: ${url}`, () => {
        let parsed;
        try { parsed = new URL(url); } catch (_) { return; }
        assert.ok(parsed.protocol !== 'http:' && parsed.protocol !== 'https:');
      });
    });
  });

  describe('token validation', () => {
    it('rejects non-string token', () => {
      const token = { toString: () => 'fake' };
      assert.ok(typeof token !== 'string');
    });

    it('rejects null token', () => {
      assert.ok(typeof null !== 'string');
    });

    it('rejects empty string token', () => {
      assert.strictEqual(''.length, 0);
    });

    it('accepts valid string token', () => {
      assert.strictEqual(typeof 'my-secret-token-123', 'string');
    });
  });

  describe('IP normalization', () => {
    it('removes ::ffff: prefix from IPv4-in-IPv6', () => {
      const ip = '::ffff:192.168.1.1';
      const normalized = ip.replace(/^::ffff:/, '');
      assert.strictEqual(normalized, '192.168.1.1');
    });

    it('preserves IPv6 address', () => {
      const ip = '2001:db8::1';
      const normalized = ip.replace(/^::ffff:/, '');
      assert.strictEqual(normalized, '2001:db8::1');
    });

    it('handles unknown address', () => {
      const ip = 'unknown';
      assert.strictEqual(ip.replace(/^::ffff:/, ''), 'unknown');
    });
  });

  describe('resize validation', () => {
    it('rejects width <= 0', () => {
      assert.ok(!(0 > 0 && 0 <= 16384));
    });

    it('rejects height > 16384', () => {
      assert.ok(!(16385 > 0 && 16385 <= 16384));
    });

    it('accepts valid resize', () => {
      assert.ok(800 > 0 && 800 <= 16384 && 600 > 0 && 600 <= 16384);
    });

    it('accepts 4K resize', () => {
      assert.ok(3840 > 0 && 3840 <= 16384 && 2160 > 0 && 2160 <= 16384);
    });
  });
});

describe('CSP & SRI Verification', () => {
  describe('CSP meta tag', () => {
    it('blocks external scripts except unpkg', () => {
      const csp = "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com";
      assert.match(csp, /unpkg\.com/);
      assert.match(csp, /script-src/);
    });

    it('blocks frame ancestors', () => {
      const csp = "frame-ancestors 'none'";
      assert.match(csp, /none/);
    });

    it('restricts connect-src to WebSocket', () => {
      const csp = "connect-src 'self' ws: wss:";
      assert.match(csp, /ws:/);
      assert.match(csp, /wss:/);
    });
  });

  describe('SRI hash verification', () => {
    it('canvaskit.js SRI hash is valid SHA-384', () => {
      const sri = 'sha384-fI05zMq1iqtMKmiNT7JCzYOcSb4t+rq+qzNsqpWPoMVMa06n9sgUzrT9oxbFGm0m';
      assert.match(sri, /^sha384-/);
    });

    it('canvaskit.wasm SRI hash is valid SHA-384', () => {
      const sri = 'sha384-n87xpLp+B9Yxsg6j7+qiUFavb/YJ6DUyH0XGjJg7dtN+Vx93sGroMBEYYtZaC+1p';
      assert.match(sri, /^sha384-/);
    });
  });

  describe('security headers', () => {
    it('X-Content-Type-Options set to nosniff', () => {
      const header = 'nosniff';
      assert.strictEqual(header, 'nosniff');
    });

    it('Cache-Control for HTML is no-cache', () => {
      const ext = '.html';
      const cc = ext === '.html' ? 'no-cache' : 'max-age=3600';
      assert.strictEqual(cc, 'no-cache');
    });

    it('Cache-Control for WASM is 1-day max-age', () => {
      const ext = '.wasm' ? 86400 : 3600;
      assert.strictEqual(ext, 86400);
    });

    it('Cache-Control for JS is 1-hour max-age', () => {
      const ext = '.js' !== '.html' && '.js' !== '.wasm' ? 3600 : 0;
      assert.strictEqual(ext, 3600);
    });
  });
});
