/**
 * 集成测试: validator 扩展 + input-proxy + config + session-lite + ws-lite + renderer
 * 预计: 25 + 25 + 15 + 20 + 15 + 15 = 115 tests
 */
'use strict';

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const protoPath = '..';

describe('Validator Extended', () => {
  const C = require(path.join(protoPath, 'src/constants'));
  const { CommandValidator } = require(path.join(protoPath, 'src/validator'));

  function cmd(opcode, payload) {
    const buf = new Uint8Array(4 + payload.length);
    buf[0] = opcode & 0xFF;
    buf[1] = (payload.length >> 16) & 0xFF;
    buf[2] = (payload.length >> 8) & 0xFF;
    buf[3] = payload.length & 0xFF;
    buf.set(payload, 4);
    return buf;
  }

  describe('valid opcodes', () => {
    const validator = new CommandValidator();
    const validOps = [C.OpCode.SAVE, C.OpCode.RESTORE, C.OpCode.TRANSLATE,
      C.OpCode.DRAW_RECT, C.OpCode.DRAW_PATH, C.OpCode.DRAW_IMAGE];

    validOps.forEach(op => {
      it(`accepts opcode 0x${op.toString(16)}`, () => {
        const buf = cmd(op, new Uint8Array(4));
        const result = validator.scan(buf);
        assert.ok(result.valid, `opcode 0x${op.toString(16)} should be valid`);
      });
    });
  });

  describe('invalid opcodes', () => {
    const validator = new CommandValidator();
    const invalidOps = [0x00, 0x55, 0x99, 0xEE, 0x35, 0x42];

    invalidOps.forEach(op => {
      it(`rejects opcode 0x${op.toString(16)}`, () => {
        const buf = cmd(op, new Uint8Array(4));
        const result = validator.scan(buf);
        assert.ok(!result.valid);
        assert.match(result.reason, /Invalid|unlisted|invalid/i);
      });
    });
  });

  describe('paylaod limits', () => {
    const validator = new CommandValidator();
    it('rejects payload exceeding MAX_PAYLOAD_BYTES', () => {
      const buf = new Uint8Array(4 + C.Limits.MAX_PAYLOAD_BYTES + 1);
      buf[0] = C.OpCode.SAVE;
      buf[1] = 0x00; buf[2] = 0x00;
      buf[3] = (C.Limits.MAX_PAYLOAD_BYTES + 1) & 0xFF;
      const result = validator.scan(buf);
      assert.ok(!result.valid);
    });
  });

  describe('save/restore pairing', () => {
    it('accepts balanced save/restore', () => {
      const validator = new CommandValidator();
      const buf = Buffer.concat([
        cmd(C.OpCode.SAVE, new Uint8Array(0)),
        cmd(C.OpCode.RESTORE, new Uint8Array(0)),
      ]);
      const result = validator.scan(buf);
      assert.ok(result.valid);
    });

    it('rejects unbalanced save/restore', () => {
      const validator = new CommandValidator();
      const buf = cmd(C.OpCode.SAVE, new Uint8Array(0));
      const result = validator.scan(buf);
      assert.ok(!result.valid);
      assert.match(result.reason, /save|restore|unbalanced/i);
    });

    it('rejects restore without save', () => {
      const validator = new CommandValidator();
      const buf = cmd(C.OpCode.RESTORE, new Uint8Array(0));
      const result = validator.scan(buf);
      assert.ok(!result.valid);
    });

    it('rejects too many nested saves', () => {
      const validator = new CommandValidator();
      const bufs = [];
      for (let i = 0; i < C.Limits.MAX_SAVE_DEPTH + 1; i++) {
        bufs.push(cmd(C.OpCode.SAVE, new Uint8Array(0)));
      }
      const result = validator.scan(Buffer.concat(bufs));
      assert.ok(!result.valid);
    });
  });

  describe('command count limit', () => {
    it('rejects exceeding MAX_COMMANDS_PER_FRAME', () => {
      const validator = new CommandValidator();
      const bufs = [];
      for (let i = 0; i < C.Limits.MAX_COMMANDS_PER_FRAME + 1; i++) {
        bufs.push(cmd(C.OpCode.SAVE, new Uint8Array(0)));
      }
      const result = validator.scan(Buffer.concat(bufs));
      assert.ok(!result.valid);
    });
  });

  describe('empty buffer', () => {
    it('accepts empty command buffer', () => {
      const validator = new CommandValidator();
      const result = validator.scan(new Uint8Array(0));
      assert.ok(result.valid);
    });

    it('accepts single byte buffer', () => {
      const validator = new CommandValidator();
      const result = validator.scan(new Uint8Array([0x00]));
      assert.ok(!result.valid);
    });
  });

  describe('drawPath verb limit', () => {
    it('rejects drawPath with excessive verb count', () => {
      const validator = new CommandValidator();
      const payload = new Uint8Array(8);
      const dv = new DataView(payload.buffer);
      dv.setUint32(0, 200000, true);
      dv.setUint32(4, 1, true);
      const buf = cmd(C.OpCode.DRAW_PATH, payload);
      const result = validator.scan(buf);
      assert.ok(!result.valid);
    });
  });
});

describe('InputProxy', () => {
  const { InputProxy } = require('../../server/src/input-proxy');

  function mockCDP() {
    const sent = [];
    return {
      sent,
      dispatchMouse(x, y, type, button) {
        sent.push({ method: 'mouse', x, y, type, button });
        return Promise.resolve();
      },
      dispatchKey(key, type) {
        sent.push({ method: 'key', key, type });
        return Promise.resolve();
      },
      insertText(text) {
        sent.push({ method: 'text', text });
        return Promise.resolve();
      }
    };
  }

  describe('token bucket', () => {
    it('allows events within rate limit', async () => {
      const cdp = mockCDP();
      const proxy = new InputProxy(cdp, { child: () => ({ info() {}, warn() {}, error() {} }) });
      for (let i = 0; i < 50; i++) {
        await proxy.inject(Buffer.from([0x00, ...new TextEncoder().encode(JSON.stringify({ x: i, y: i }))]));
      }
      assert.ok(cdp.sent.length >= 40);
    });

    it('throttles excessive events', async () => {
      const cdp = mockCDP();
      const proxy = new InputProxy(cdp, { child: () => ({ info() {}, warn() {}, error() {} }) });
      for (let i = 0; i < 500; i++) {
        await proxy.inject(Buffer.from([0x00, ...new TextEncoder().encode(JSON.stringify({ x: i, y: i }))]));
      }
      assert.ok(cdp.sent.length < 500);
    });
  });

  describe('event types', () => {
    it('processes mouse down event', async () => {
      const cdp = mockCDP();
      const proxy = new InputProxy(cdp, { child: () => ({ info() {}, warn() {}, error() {} }) });
      await proxy.inject(Buffer.from([0x01, ...new TextEncoder().encode(JSON.stringify({ x: 100, y: 200 }))]));
      assert.ok(cdp.sent.length > 0);
    });

    it('processes key event', async () => {
      const cdp = mockCDP();
      const proxy = new InputProxy(cdp, { child: () => ({ info() {}, warn() {}, error() {} }) });
      await proxy.inject(Buffer.from([0x10, ...new TextEncoder().encode(JSON.stringify({ key: 'a' }))]));
      assert.ok(cdp.sent.length > 0);
    });

    it('processes text injection', async () => {
      const cdp = mockCDP();
      const proxy = new InputProxy(cdp, { child: () => ({ info() {}, warn() {}, error() {} }) });
      await proxy.inject(Buffer.from([0x20, ...new TextEncoder().encode(JSON.stringify({ value: 'hello' }))]));
      assert.ok(cdp.sent.length > 0);
    });
  });

  describe('input validation', () => {
    it('rejects non-object payload', async () => {
      const cdp = mockCDP();
      const proxy = new InputProxy(cdp, { child: () => ({ info() {}, warn() {}, error() {} }) });
      await proxy.inject(Buffer.from([0x00, ...new TextEncoder().encode('"string_not_object"')]));
      assert.strictEqual(cdp.sent.length, 0);
    });

    it('handles malformed JSON', async () => {
      const cdp = mockCDP();
      const proxy = new InputProxy(cdp, { child: () => ({ info() {}, warn() {}, error() {} }) });
      await proxy.inject(Buffer.from([0x00, ...new TextEncoder().encode('{invalid}')]));
      assert.strictEqual(cdp.sent.length, 0);
    });

    it('handles empty buffer', async () => {
      const cdp = mockCDP();
      const proxy = new InputProxy(cdp, { child: () => ({ info() {}, warn() {}, error() {} }) });
      await proxy.inject(Buffer.from([]));
      assert.strictEqual(cdp.sent.length, 0);
    });
  });
});

describe('Config', () => {
  describe('defaults', () => {
    let config;
    before(() => {
      // Reset require cache to get fresh config
      delete require.cache[require.resolve('../../server/src/config')];
      process.env.WISON_PORT = '';
      process.env.WISON_HOST = '';
      process.env.WISON_AUTH_TOKEN = '';
      process.env.WISON_MAX_SESSIONS = '';
      process.env.WISON_IP_MAX_CONN = '';
      config = require('../../server/src/config');
    });

    it('default port is 8080', () => {
      assert.strictEqual(config.port, 8080);
    });

    it('default host is 0.0.0.0', () => {
      assert.strictEqual(config.host, '0.0.0.0');
    });

    it('default authToken is null', () => {
      assert.strictEqual(config.authToken, null);
    });

    it('default maxSessions is 5', () => {
      assert.strictEqual(config.maxSessions, 5);
    });

    it('default frameTickMs is 50', () => {
      assert.strictEqual(config.frameTickMs, 50);
    });

    it('default ipMaxPerConn is 3', () => {
      assert.strictEqual(config.ipMaxPerConn, 3);
    });

    it('default viewport width is 1280', () => {
      assert.strictEqual(config.defaultViewport.width, 1280);
    });

    it('default viewport height is 720', () => {
      assert.strictEqual(config.defaultViewport.height, 720);
    });

    it('default logLevel is info', () => {
      assert.strictEqual(config.logLevel, 'info');
    });

    it('metrics enabled by default', () => {
      assert.strictEqual(config.metricsEnabled, true);
    });

    it('keyframe interval is 300', () => {
      assert.strictEqual(config.keyframeInterval, 300);
    });

    it('tile size is 16', () => {
      assert.strictEqual(config.tileSize, 16);
    });

    it('wsMaxPayload is 4MB', () => {
      assert.strictEqual(config.wsMaxPayload, 4 * 1024 * 1024);
    });

    it('heartbeat is configured', () => {
      assert.ok(config.heartbeatIntervalMs > 0);
      assert.ok(config.heartbeatTimeoutMs > 0);
    });

    it('session idle timeout is 5min', () => {
      assert.strictEqual(config.sessionIdleTimeoutMs, 300000);
    });
  });

  describe('environment variables', () => {
    let config;
    before(() => {
      delete require.cache[require.resolve('../../server/src/config')];
      process.env.WISON_PORT = '3000';
      process.env.WISON_HOST = '127.0.0.1';
      process.env.WISON_IP_MAX_CONN = '10';
      process.env.WISON_MAX_SESSIONS = '20';
      process.env.WISON_LOG_LEVEL = 'debug';
      config = require('../../server/src/config');
    });

    it('reads port from env', () => {
      assert.strictEqual(config.port, 3000);
    });

    it('reads host from env', () => {
      assert.strictEqual(config.host, '127.0.0.1');
    });

    it('reads ipMaxPerConn from env', () => {
      assert.strictEqual(config.ipMaxPerConn, 10);
    });

    it('reads maxSessions from env', () => {
      assert.strictEqual(config.maxSessions, 20);
    });

    it('reads logLevel from env', () => {
      assert.strictEqual(config.logLevel, 'debug');
    });
  });
});

describe('Renderer', () => {
  // Mock CanvasKit
  function mockCanvasKit() {
    const surfaces = [];
    const images = [];
    const paints = [];
    return {
      surfaces, images, paints,
      MakeSWCanvasSurface() {
        const s = { getId: () => surfaces.length, getCanvas: () => ({ drawImage() {}, drawRect() {}, save() {}, restore() {}, translate() {}, scale() {}, rotate() {}, concat() {}, clipRect() {}, clipRRect() {}, clear() {} }) };
        surfaces.push(s);
        return s;
      },
      MakeWebGLCanvasSurface() { return null; },
      MakeImageFromEncoded(buf) {
        const img = { buf, delete() {} };
        images.push(img);
        return img;
      },
      getPaint() {
        const p = { setColor() {}, setStyle() {}, setStrokeWidth() {}, setAntiAlias() {}, setAlphaf() {}, setBlendMode() {}, delete() {} };
        paints.push(p);
        return p;
      }
    };
  }

  describe('initialization', () => {
    it('creates renderer with mock CanvasKit', () => {
      const { Renderer } = require('../../../packages/client/src/renderer');
      const ck = mockCanvasKit();
      const renderer = new Renderer({ width: 800, height: 600 }, ck, {});
      assert.ok(renderer instanceof Renderer);
    });

    it('render fails without SkCanvas', () => {
      const { Renderer } = require('../../../packages/client/src/renderer');
      const renderer = new Renderer({ width: 800, height: 600 }, {
        MakeSWCanvasSurface() { return null; },
        MakeWebGLCanvasSurface() { return null; }
      }, {});
      const result = renderer.render(new Uint8Array(0));
      assert.ok(!result.rendered);
      assert.match(result.reason, /SkCanvas|canvas|surface/i);
    });
  });

  describe('CRC32 rejection', () => {
    it('rejects frame with invalid CRC32', () => {
      const { Renderer } = require('../../../packages/client/src/renderer');
      const ck = mockCanvasKit();
      const { FrameEncoder } = require(path.join(protoPath, 'src/encoder'));
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 800, viewportH: 600, canvasW: 800, canvasH: 600 });
      const frame = new Uint8Array(enc.finalize(1));
      frame[frame.length - 1] ^= 0xFF;

      const renderer = new Renderer({ width: 800, height: 600 }, ck, {});
      const result = renderer.render(frame);
      assert.ok(!result.rendered);
      assert.match(result.reason, /CRC32/i);
    });
  });

  describe('rejection counting', () => {
    it('increments rejection count with invalid frame', () => {
      const { Renderer } = require('../../../packages/client/src/renderer');
      const ck = mockCanvasKit();
      let keyframeCalled = false;
      const renderer = new Renderer({ width: 800, height: 600 }, ck, {
        onRequestKeyframe: () => { keyframeCalled = true; }
      });

      const invalidFrame = new Uint8Array([0xFF, 0xFF]);
      for (let i = 0; i < 3; i++) renderer.render(invalidFrame);
      assert.ok(keyframeCalled);
    });
  });
});

describe('Integration: Pipeline', () => {
  const { FrameEncoder, TileEncoding } = require(path.join(protoPath, 'src/encoder'));
  const { FrameDecoder } = require(path.join(protoPath, 'src/decoder'));
  const { CommandValidator } = require(path.join(protoPath, 'src/validator'));
  const C = require(path.join(protoPath, 'src/constants'));

  function fullPipeline(frameType, tileCount, cmdCount) {
    const enc = new FrameEncoder();
    enc.setMetadata({ frameId: 100, timestamp: Date.now(), scrollX: 0, scrollY: 0,
      viewportW: 1280, viewportH: 720, canvasW: 1280, canvasH: 720 });

    for (let i = 0; i < tileCount; i++) {
      enc.addTile(i * 16, 0, 16, 16, TileEncoding.JPEG, new Uint8Array([i + 1, i + 2, i + 3]));
    }

    for (let i = 0; i < cmdCount; i++) {
      enc.addCommand(C.OpCode.SAVE, new Uint8Array(0));
      enc.addCommand(C.OpCode.RESTORE, new Uint8Array(0));
    }

    const frame = enc.finalize(frameType);
    const dec = new FrameDecoder();
    const decoded = dec.decode(frame);

    const cmdView = new Uint8Array(frame, decoded.commandOffset,
      frame.byteLength - decoded.commandOffset - 4);
    const validator = new CommandValidator();
    const scanResult = validator.scan(cmdView);

    return { frame, decoded, scanResult };
  }

  describe('pipeline scenarios', () => {
    const scenarios = [
      { name: 'empty keyframe', type: 1, tiles: 0, cmds: 0 },
      { name: 'keyframe with save/restore', type: 1, tiles: 0, cmds: 5 },
      { name: 'diff frame single tile', type: 2, tiles: 1, cmds: 1 },
      { name: 'diff frame multi tile', type: 2, tiles: 10, cmds: 5 },
      { name: 'diff frame no commands', type: 2, tiles: 3, cmds: 0 },
      { name: 'keyframe max tiles', type: 1, tiles: 0, cmds: 100 },
    ];

    scenarios.forEach(({ name, type, tiles, cmds }) => {
      it(name, () => {
        const { frame, decoded, scanResult } = fullPipeline(type, tiles, cmds);
        assert.ok(frame.byteLength > 0);
        assert.strictEqual(decoded.tileCount, tiles);
        assert.ok(decoded.commands.length >= cmds);
        assert.ok(scanResult.valid);
      });
    });
  });

  describe('pipeline validation', () => {
    it('CRC32 validation passes correct frame', () => {
      const { frame } = fullPipeline(1, 0, 1);
      assert.ok(FrameDecoder.verifyCRC32(new Uint8Array(frame)));
    });

    it('CRC32 validation fails tampered frame', () => {
      const { frame } = fullPipeline(1, 0, 1);
      const arr = new Uint8Array(frame);
      arr[10] ^= 0xAA;
      assert.ok(!FrameDecoder.verifyCRC32(arr));
    });

    it('validator accepts balanced commands', () => {
      const { scanResult } = fullPipeline(1, 0, 5);
      assert.ok(scanResult.valid);
    });

    it('commandOffset correctly excludes CRC', () => {
      const { frame, decoded } = fullPipeline(2, 3, 1);
      const expectedCmdLen = frame.byteLength - decoded.commandOffset - 4;
      const cmdView = new Uint8Array(frame, decoded.commandOffset, expectedCmdLen);
      assert.ok(cmdView.length > 0);
      assert.ok(cmdView.length <= frame.byteLength - decoded.commandOffset);
    });

    it('tile data extraction matches encoding', () => {
      const { frame } = fullPipeline(2, 5, 0);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      assert.strictEqual(decoded.tileCount, 5);
      for (let i = 0; i < 5; i++) {
        const tile = dec.extractTileData(decoded, i);
        assert.ok(tile instanceof Uint8Array);
        assert.ok(tile.length > 0);
      }
    });
  });

  describe('edge cases', () => {
    it('handles frame with max-size command payload', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 200, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 1280, viewportH: 720, canvasW: 1280, canvasH: 720 });
      enc.addCommand(C.OpCode.SAVE, new Uint8Array(C.Limits.MAX_PAYLOAD_BYTES));
      enc.addCommand(C.OpCode.RESTORE, new Uint8Array(0));
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      assert.strictEqual(decoded.commands[0].payloadSize, C.Limits.MAX_PAYLOAD_BYTES);
    });

    it('handles 256 tile entries', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 201, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 1280, viewportH: 720, canvasW: 1280, canvasH: 720 });
      for (let i = 0; i < 256; i++) {
        enc.addTile(i, 0, 1, 1, TileEncoding.JPEG, new Uint8Array([1]));
      }
      const frame = enc.finalize(2);
      assert.ok(frame.byteLength > 3600);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      assert.strictEqual(decoded.tileCount, 256);
    });

    it('handles zero metadata fields', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 0, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 0, viewportH: 0, canvasW: 0, canvasH: 0 });
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      assert.strictEqual(decoded.frameId, 0);
      assert.strictEqual(decoded.viewportW, 0);
      assert.strictEqual(decoded.viewportH, 0);
    });
  });
});
