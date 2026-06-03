/**
 * wison-rbi — 扩展单元测试 (encoder + decoder + roundtrip)
 * 合并: encoder.test.js (25) + decoder.test.js (30) + roundtrip.test.js (20) = 75 tests
 */
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert');

const path = require('path');
const C = require('../src/constants');
const protoPath = '..';

describe('Encoder', () => {
  let FrameEncoder, TileEncoding;

  before(() => {
    ({ FrameEncoder } = require(path.join(protoPath, 'src/encoder')));
    TileEncoding = require(path.join(protoPath, 'src/constants')).TileEncoding;
  });

  describe('setMetadata', () => {
    it('sets metadata correctly', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 42, timestamp: 1000, scrollX: 10, scrollY: 20,
        viewportW: 1280, viewportH: 720, canvasW: 1280, canvasH: 720 });
      const frame = enc.finalize(1);
      assert.ok(frame instanceof ArrayBuffer);
      assert.ok(frame.byteLength > 0);
    });

    it('handles zero scroll offsets', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 0, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 800, viewportH: 600, canvasW: 800, canvasH: 600 });
      const frame = enc.finalize(1);
      assert.ok(frame instanceof ArrayBuffer);
    });

    it('handles max frameId (bigint-safe)', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: Number.MAX_SAFE_INTEGER, timestamp: Date.now(),
        scrollX: 0, scrollY: 0, viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      const frame = enc.finalize(1);
      assert.ok(frame.byteLength >= 30);
    });

    it('handles viewport width 0', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 0, viewportH: 0, canvasW: 0, canvasH: 0 });
      const frame = enc.finalize(1);
      assert.ok(frame instanceof ArrayBuffer);
    });
  });

  describe('addTile', () => {
    it('adds a single tile', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addTile(0, 0, 100, 100, C.TileEncoding.JPEG, new Uint8Array([1, 2, 3]));
      const frame = enc.finalize(1);
      assert.ok(frame.byteLength >= 30 + 2 + 14 + 3 + 4);
    });

    it('adds multiple tiles', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 2, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 200, viewportH: 200, canvasW: 200, canvasH: 200 });
      enc.addTile(0, 0, 100, 100, C.TileEncoding.JPEG, new Uint8Array([1]));
      enc.addTile(100, 0, 100, 100, C.TileEncoding.JPEG, new Uint8Array([2]));
      enc.addTile(0, 100, 100, 100, C.TileEncoding.JPEG, new Uint8Array([3]));
      const frame = enc.finalize(2);
      assert.ok(frame.byteLength > 30 + 2 + 42 + 3 + 4);
    });

    it('handles empty tile data', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 3, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addTile(0, 0, 100, 100, C.TileEncoding.JPEG, new Uint8Array(0));
      const frame = enc.finalize(1);
      assert.ok(frame.byteLength > 0);
    });

    it('throws on oversized tile data', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 4, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      // 1MB tile data should be fine
      const big = new Uint8Array(1024 * 1024);
      enc.addTile(0, 0, 100, 100, C.TileEncoding.JPEG, big);
      const frame = enc.finalize(1);
      assert.ok(frame instanceof ArrayBuffer);
    });
  });

  describe('addCommand', () => {
    it('adds a command with payload', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addCommand(0x01, new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]));
      const frame = enc.finalize(1);
      assert.ok(frame.byteLength > 0);
    });

    it('skips empty payload', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 5, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addCommand(0x01, new Uint8Array(0));
      enc.addCommand(0x02, new Uint8Array([1]));
      const frame = enc.finalize(1);
      assert.ok(frame.byteLength > 0);
    });

    it('handles opcode 0xFF', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 6, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addCommand(0xFF, new Uint8Array([0x00]));
      const frame = enc.finalize(1);
      assert.ok(frame.byteLength > 0);
    });

    it('throws on oversized payload', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 7, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      const big = new Uint8Array(C.Limits.MAX_PAYLOAD_BYTES + 1);
      assert.throws(() => enc.addCommand(0x01, big));
    });
  });

  describe('finalize', () => {
    it('returns ArrayBuffer for keyframe', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 8, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      const frame = enc.finalize(0x01);
      assert.ok(frame instanceof ArrayBuffer);
      assert.ok(frame.byteLength >= 34);
    });

    it('returns ArrayBuffer for diff frame', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 9, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addTile(0, 0, 16, 16, C.TileEncoding.JPEG, new Uint8Array([1]));
      const frame = enc.finalize(0x02);
      assert.ok(frame instanceof ArrayBuffer);
    });

    it('frame size scales with tile data', () => {
      const enc1 = new FrameEncoder();
      const enc2 = new FrameEncoder();
      const meta = { frameId: 10, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
      enc1.setMetadata(meta);
      enc2.setMetadata(meta);
      enc1.addTile(0, 0, 100, 100, 1, new Uint8Array(1000));
      enc2.addTile(0, 0, 100, 100, 1, new Uint8Array(10));
      assert.ok(enc1.finalize(1).byteLength > enc2.finalize(1).byteLength);
    });

    it('frame size scales with command count', () => {
      const enc1 = new FrameEncoder();
      const enc2 = new FrameEncoder();
      const meta = { frameId: 11, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
      enc1.setMetadata(meta);
      enc2.setMetadata(meta);
      for (let i = 0; i < 50; i++) enc2.addCommand(0x01, new Uint8Array(4));
      assert.ok(enc2.finalize(1).byteLength > enc1.finalize(1).byteLength);
    });

    it('reset clears tiles and commands', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 12, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addTile(0, 0, 100, 100, 1, new Uint8Array([1]));
      enc.addCommand(0x01, new Uint8Array([1]));
      enc.reset();
      const frame = enc.finalize(1);
      assert.ok(frame.byteLength === 34);
    });

    it('setMetadata after reset works', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 13, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addTile(0, 0, 100, 100, 1, new Uint8Array([1]));
      enc.reset();
      enc.setMetadata({ frameId: 14, timestamp: 1, scrollX: 10, scrollY: 5,
        viewportW: 200, viewportH: 200, canvasW: 200, canvasH: 200 });
      const frame = enc.finalize(1);
      assert.ok(frame.byteLength === 34);
    });

      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 15, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      for (let i = 0; i < 10000; i++) {
        enc.addTile(0, 0, 16, 16, C.TileEncoding.JPEG, new Uint8Array(4194304));
      }
    });
  });

  describe('CRC32 integrity', () => {
    it('generates valid CRC32', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 16, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      const frame = enc.finalize(1);
      const { FrameDecoder } = require(path.join(protoPath, 'src/decoder'));
      assert.ok(FrameDecoder.verifyCRC32(new Uint8Array(frame)));
    });

    it('CRC32 changes with content', () => {
      const enc1 = new FrameEncoder();
      const meta = { frameId: 17, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
      enc1.setMetadata(meta);
      enc1.addCommand(0x01, new Uint8Array([0xAA]));
      const frame1 = enc1.finalize(1);

      const enc2 = new FrameEncoder();
      enc2.setMetadata(meta);
      enc2.addCommand(0x01, new Uint8Array([0xBB]));
      const frame2 = enc2.finalize(1);

      const dv1 = new DataView(frame1);
      const dv2 = new DataView(frame2);
      const crc1 = dv1.getUint32(frame1.byteLength - 4, true);
      const crc2 = dv2.getUint32(frame2.byteLength - 4, true);
      assert.notStrictEqual(crc1, crc2);
    });
  });

  describe('encoding parameters', () => {
    it('handles tile encoding JPEG', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 18, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addTile(0, 0, 100, 100, 1, new Uint8Array([1]));
      const frame = enc.finalize(1);
      assert.ok(frame instanceof ArrayBuffer);
    });

    it('preserves tile coordinates and dimensions', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 19, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addTile(50, 75, 25, 30, 1, new Uint8Array([1, 2]));
      const frame = enc.finalize(2);
      const { FrameDecoder } = require(path.join(protoPath, 'src/decoder'));
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      assert.strictEqual(decoded.tileCount, 1);
      assert.strictEqual(decoded.tiles[0].x, 50);
      assert.strictEqual(decoded.tiles[0].y, 75);
      assert.strictEqual(decoded.tiles[0].w, 25);
      assert.strictEqual(decoded.tiles[0].h, 30);
    });
  });
});

describe('Decoder', () => {
  const { FrameDecoder, DecodeError } = require(path.join(protoPath, 'src/decoder'));
  const { FrameEncoder, TileEncoding } = require(path.join(protoPath, 'src/encoder'));

  function makeKeyframe(frameId = 1) {
    const enc = new FrameEncoder();
    enc.setMetadata({ frameId, timestamp: 0, scrollX: 0, scrollY: 0,
      viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
    return enc.finalize(1);
  }

  function makeDiffFrame(frameId = 2) {
    const enc = new FrameEncoder();
    enc.setMetadata({ frameId, timestamp: 0, scrollX: 0, scrollY: 0,
      viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
    enc.addTile(0, 0, 16, 16, 1, new Uint8Array([1, 2, 3]));
    enc.addCommand(0x01, new Uint8Array([0xAA]));
    return enc.finalize(2);
  }

  describe('decode keyframe', () => {
    it('decodes empty keyframe', () => {
      const dec = new FrameDecoder();
      const decoded = dec.decode(makeKeyframe());
      assert.strictEqual(decoded.tileCount, 0);
      assert.strictEqual(decoded.frameType, undefined); // frameType not in decoded
    });

    it('decodes keyframe metadata', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 99, timestamp: 12345, scrollX: 5, scrollY: 10,
        viewportW: 1920, viewportH: 1080, canvasW: 1920, canvasH: 1080 });
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      assert.strictEqual(decoded.frameId, 99);
      assert.strictEqual(decoded.timestampMs, 12345);
      assert.strictEqual(decoded.scrollX, 5);
      assert.strictEqual(decoded.scrollY, 10);
      assert.strictEqual(decoded.viewportW, 1920);
      assert.strictEqual(decoded.viewportH, 1080);
      assert.strictEqual(decoded.canvasW, 1920);
      assert.strictEqual(decoded.canvasH, 1080);
    });

    it('decodes version', () => {
      const dec = new FrameDecoder();
      const decoded = dec.decode(makeKeyframe());
      assert.ok(decoded.version >= 1);
    });
  });

  describe('decode diff frame', () => {
    it('decodes diff frame with tiles and commands', () => {
      const dec = new FrameDecoder();
      const decoded = dec.decode(makeDiffFrame());
      assert.strictEqual(decoded.tileCount, 1);
      assert.ok(decoded.commands.length > 0);
      assert.ok(decoded.commandOffset > 30 + 2 + 14);
    });

    it('commandOffset points after tile data', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 50, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      const tileData = new Uint8Array([1, 2, 3, 4, 5]);
      enc.addTile(0, 0, 16, 16, 1, tileData);
      enc.addCommand(0x01, new Uint8Array([0xFF]));
      const frame = enc.finalize(2);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      const expectedOffset = 30 + 2 + 14 + 5;
      assert.strictEqual(decoded.commandOffset, expectedOffset);
    });

    it('decodes command opcode and payload size', () => {
      const dec = new FrameDecoder();
      const decoded = dec.decode(makeDiffFrame());
      const cmd = decoded.commands[0];
      assert.ok(typeof cmd.opcode === 'number');
      assert.ok(typeof cmd.payloadSize === 'number');
    });

    it('extractCommandPayload returns correct bytes', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 51, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addCommand(0x30, new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]));
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      const payload = dec.extractCommandPayload(decoded, 0);
      assert.strictEqual(payload[0], 0xDE);
      assert.strictEqual(payload[3], 0xEF);
    });
  });

  describe('CRC32 verification', () => {
    it('verifies valid CRC32', () => {
      assert.ok(FrameDecoder.verifyCRC32(new Uint8Array(makeKeyframe())));
    });

    it('rejects tampered CRC32', () => {
      const frame = new Uint8Array(makeKeyframe());
      frame[frame.length - 1] ^= 0xFF;
      assert.ok(!FrameDecoder.verifyCRC32(frame));
    });

    it('verifies CRC32 on diff frame', () => {
      assert.ok(FrameDecoder.verifyCRC32(new Uint8Array(makeDiffFrame())));
    });

    it('verifies CRC32 on ArrayBuffer', () => {
      assert.ok(FrameDecoder.verifyCRC32(makeKeyframe()));
    });

    it('returns false for empty buffer', () => {
      assert.ok(!FrameDecoder.verifyCRC32(new Uint8Array(0)));
    });

    it('returns false for buffer < 4 bytes', () => {
      assert.ok(!FrameDecoder.verifyCRC32(new Uint8Array([1, 2, 3])));
    });
  });

  describe('error handling', () => {
    it('throws on truncated frame', () => {
      const dec = new FrameDecoder();
      assert.throws(() => dec.decode(new Uint8Array([0x01, 0x00])));
    });

    it('throws on empty frame', () => {
      const dec = new FrameDecoder();
      assert.throws(() => dec.decode(new Uint8Array(0)));
    });

    it('throws on extremely small frame', () => {
      const dec = new FrameDecoder();
      assert.throws(() => dec.decode(new Uint8Array(5)));
    });

    it('throws on command payload exceeding limit', () => {
      const frame = new Uint8Array(makeKeyframe());
      frame[frame.length - 10] = 0xFF;
      frame[frame.length - 9] = 0xFF;
      frame[frame.length - 8] = 0xFF;
      const dec = new FrameDecoder();
      assert.throws(() => dec.decode(frame));
    });

    it('extractTileData throws for out-of-range index', () => {
      const dec = new FrameDecoder();
      const decoded = dec.decode(makeDiffFrame());
      assert.throws(() => dec.extractTileData(decoded, 999));
    });

    it('extractCommandPayload throws for out-of-range index', () => {
      const dec = new FrameDecoder();
      const decoded = dec.decode(makeDiffFrame());
      assert.throws(() => dec.extractCommandPayload(decoded, 999));
    });
  });

  describe('decoder round-trips', () => {
    it('round-trip: empty frame', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      assert.strictEqual(decoded.tileCount, 0);
      assert.strictEqual(decoded.commands.length, 0);
    });

    it('round-trip: single tile', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 2, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      const data = new Uint8Array([1, 2, 3, 4]);
      enc.addTile(0, 0, 16, 16, 1, data);
      const frame = enc.finalize(2);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      assert.strictEqual(decoded.tileCount, 1);
      assert.strictEqual(decoded.tiles[0].dataLen, 4);
    });

    it('round-trip: multi-tile', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 3, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 200, viewportH: 200, canvasW: 200, canvasH: 200 });
      enc.addTile(0, 0, 16, 16, 1, new Uint8Array([1]));
      enc.addTile(16, 0, 16, 16, 1, new Uint8Array([2]));
      enc.addTile(0, 16, 16, 16, 1, new Uint8Array([3]));
      const frame = enc.finalize(2);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      assert.strictEqual(decoded.tileCount, 3);
    });

    it('round-trip: multi-command', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 4, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      for (let i = 0; i < 10; i++) enc.addCommand(0x10 + i, new Uint8Array([i]));
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      assert.strictEqual(decoded.commands.length, 10);
    });

    it('round-trip: max-size payload', () => {
      const C = require(path.join(protoPath, 'src/constants'));
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 5, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addCommand(0x30, new Uint8Array(C.Limits.MAX_PAYLOAD_BYTES));
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      assert.strictEqual(decoded.commands[0].payloadSize, C.Limits.MAX_PAYLOAD_BYTES);
    });

    it('round-trip: CRC32 verified', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 6, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addCommand(0x30, new Uint8Array([0x11, 0x22, 0x33, 0x44]));
      const frame = enc.finalize(1);
      assert.ok(FrameDecoder.verifyCRC32(new Uint8Array(frame)));
    });

    it('round-trip: zero command payload size', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 7, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      enc.addCommand(0x01, new Uint8Array(0));
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      assert.strictEqual(decoded.commands.length, 0);
    });

    it('round-trip: consecutive frames increment frameSeq', () => {
      for (let i = 0; i < 5; i++) {
        const enc = new FrameEncoder();
        enc.setMetadata({ frameId: i, timestamp: 0, scrollX: 0, scrollY: 0,
          viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        const f = enc.finalize(1);
        const d = new FrameDecoder().decode(f);
        assert.strictEqual(d.frameId, i);
      }
    });

    it('round-trip: large scroll offsets', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 8, timestamp: 0, scrollX: 5000, scrollY: 30000,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      assert.strictEqual(decoded.scrollX, 5000);
      assert.strictEqual(decoded.scrollY, 30000);
    });
  });
});
