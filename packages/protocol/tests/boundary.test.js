/**
 * 最后补充: 并发/压力/边界 — 21 tests
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const protoPath = '..';

describe('Stress & Edge', () => {
  const { FrameEncoder, TileEncoding } = require(path.join(protoPath, 'src/encoder'));
  const { FrameDecoder } = require(path.join(protoPath, 'src/decoder'));

  describe('many commands stress', () => {
    it('handles 1000 save/restore pairs', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 1280, viewportH: 720, canvasW: 1280, canvasH: 720 });
      for (let i = 0; i < 500; i++) {
        enc.addCommand(0x01, new Uint8Array(0));
        enc.addCommand(0x02, new Uint8Array(0));
      }
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const decoded = dec.decode(frame);
      assert.strictEqual(decoded.commands.length, 1000);
      assert.ok(FrameDecoder.verifyCRC32(new Uint8Array(frame)));
    });

    it('handles maximum tile count approximation', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 1280, viewportH: 720, canvasW: 1280, canvasH: 720 });
      for (let i = 0; i < 100; i++) {
        enc.addTile(0, 0, 1, 1, 1, new Uint8Array([1]));
      }
      enc.addCommand(0x01, new Uint8Array(0));
      const frame = enc.finalize(2);
      const dec = new FrameDecoder();
      const d = dec.decode(frame);
      assert.strictEqual(d.tileCount, 100);
    });

    it('many small payload commands', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 1280, viewportH: 720, canvasW: 1280, canvasH: 720 });
      for (let i = 0; i < 2000; i++) {
        enc.addCommand(0x10 + (i % 10), new Uint8Array(4));
      }
      const frame = enc.finalize(1);
      assert.ok(frame.byteLength > 0);
    });
  });

  describe('negative and zero edge', () => {
    it('handles viewport with width=1 height=1', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 1, viewportH: 1, canvasW: 1, canvasH: 1 });
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const d = dec.decode(frame);
      assert.strictEqual(d.viewportW, 1);
    });

    it('handles scroll with very large values', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 99999, scrollY: 99999,
        viewportW: 1280, viewportH: 720, canvasW: 1280, canvasH: 720 });
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const d = dec.decode(frame);
      assert.strictEqual(d.scrollX, 99999);
    });

    it('handles uint32 timestamp boundary', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0xFFFFFFFF, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      const frame = enc.finalize(1);
      assert.ok(frame.byteLength > 0);
    });
  });

  describe('decode rapid sequence', () => {
    it('decodes 50 frames in rapid succession', () => {
      const dec = new FrameDecoder();
      for (let i = 0; i < 50; i++) {
        const enc = new FrameEncoder();
        enc.setMetadata({ frameId: i, timestamp: i, scrollX: 0, scrollY: 0,
          viewportW: 1280, viewportH: 720, canvasW: 1280, canvasH: 720 });
        enc.addCommand(0x30, new Uint8Array([i & 0xFF]));
        const frame = enc.finalize(i % 2 ? 1 : 2);
        const d = dec.decode(frame);
        assert.strictEqual(d.frameId, i);
      }
    });
  });

  describe('opcode boundary values', () => {
    [0x00, 0x01, 0x0F, 0x10, 0x1F, 0x20, 0x2F, 0x30, 0x3F, 0x40, 0x4F, 0xFE, 0xFF].forEach(op => {
      it(`opcode 0x${op.toString(16)} as boundary test`, () => {
        const enc = new FrameEncoder();
        enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
          viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        enc.addCommand(op, new Uint8Array(4));
        const frame = enc.finalize(1);
        const dec = new FrameDecoder();
        const decoded = dec.decode(frame);
        assert.ok(decoded.commands.length >= 1);
      });
    });
  });

  describe('final edge cases', () => {
    it('encoder setMetadata then addTile then finalize with correct frameType 1', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 999, timestamp: 1234567890, scrollX: 0, scrollY: 0,
        viewportW: 800, viewportH: 600, canvasW: 800, canvasH: 600 });
      const frame = enc.finalize(1);
      const dec = new FrameDecoder();
      const d = dec.decode(frame);
      assert.strictEqual(d.frameId, 999);
    });

    it('CRC32 for zero-content frame is consistent', () => {
      const enc1 = new FrameEncoder();
      const meta = { frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 };
      enc1.setMetadata(meta);
      const f1 = enc1.finalize(1);
      const enc2 = new FrameEncoder();
      enc2.setMetadata(meta);
      const f2 = enc2.finalize(1);
      const dv1 = new DataView(f1);
      const dv2 = new DataView(f2);
      assert.strictEqual(dv1.getUint32(f1.byteLength - 4, true), dv2.getUint32(f2.byteLength - 4, true));
    });

    it('handler for type=0x03 frame', () => {
      const enc = new FrameEncoder();
      enc.setMetadata({ frameId: 1, timestamp: 0, scrollX: 0, scrollY: 0,
        viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
      const frame = enc.finalize(0x03);
      assert.ok(frame instanceof ArrayBuffer);
    });
  });

  describe('decode-once-edge', () => {
    it('decoder can be reused for multiple frames', () => {
      const dec = new FrameDecoder();
      for (let i = 0; i < 10; i++) {
        const enc = new FrameEncoder();
        enc.setMetadata({ frameId: i, timestamp: i, scrollX: 0, scrollY: 0,
          viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
        const frame = enc.finalize(1);
        const d = dec.decode(frame);
        assert.strictEqual(d.frameId, i);
      }
    });
  });
});
