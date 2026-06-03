/**
 * @wison/protocol/tests — 安全测试套件
 *
 * 覆盖:
 *   1. CommandValidator: 白名单、子结构校验、帧级限制、边界条件
 *   2. FrameEncoder ↔ FrameDecoder: 往返一致性
 *   3. 模糊测试: 随机字节 → 不应崩溃
 *
 * 运行: node --test protocol/tests/*.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { CommandValidator } = require('../src/validator');
const { FrameEncoder } = require('../src/encoder');
const { FrameDecoder, DecodeError } = require('../src/decoder');
const C = require('../src/constants');

// ═══════════════════════════════════════════
//  CommandValidator Tests
// ═══════════════════════════════════════════

describe('CommandValidator', () => {
  const validator = new CommandValidator();

  function cmd(opcode, payload = new Uint8Array(0)) {
    const buf = new Uint8Array(4 + payload.length);
    buf[0] = opcode;
    buf[1] = (payload.length >> 16) & 0xFF;
    buf[2] = (payload.length >> 8) & 0xFF;
    buf[3] = payload.length & 0xFF;
    buf.set(payload, 4);
    return buf.buffer;
  }

  // ── 1. Valid commands ──
  it('accepts valid save/restore pair', () => {
    const buf = new Uint8Array([
      ...new Uint8Array(cmd(C.OpCode.SAVE)),
      ...new Uint8Array(cmd(C.OpCode.RESTORE)),
    ]);
    const result = validator.scan(buf);
    assert.ok(result.valid);
    assert.equal(result.commandCount, 2);
  });

  it('accepts valid drawRect', () => {
    const payload = new Uint8Array(32); // 16 bytes rect + 16 bytes paint
    const result = validator.scan(cmd(C.OpCode.DRAW_RECT, payload));
    assert.ok(result.valid);
  });

  // ── 2. Unknown opcode ──
  it('rejects unknown opcode', () => {
    const result = validator.scan(cmd(0xFF));
    assert.ok(!result.valid);
    assert.match(result.reason, /Invalid opcode/);
  });

  it('rejects opcode 0x7F placeholder', () => {
    const result = validator.scan(cmd(0x7F));
    assert.ok(!result.valid);
  });

  // ── 3. Payload size limits ──
  it('rejects payload exceeding MAX_PAYLOAD_BYTES', () => {
    // payLen=MAX_PAYLOAD_BYTES + 1 (exceeds limit)
    const payLen = C.Limits.MAX_PAYLOAD_BYTES + 1;
    const buf = new Uint8Array(4);
    buf[0] = C.OpCode.DRAW_RECT;
    buf[1] = (payLen >> 16) & 0xFF;
    buf[2] = (payLen >> 8) & 0xFF;
    buf[3] = payLen & 0xFF;
    const result = validator.scan(buf.buffer);
    assert.ok(!result.valid);
    assert.match(result.reason, /Payload too large/);
  });

  // ── 4. Save/restore balance ──
  it('rejects unbalanced restore', () => {
    const result = validator.scan(cmd(C.OpCode.RESTORE));
    assert.ok(!result.valid);
    assert.match(result.reason, /Unbalanced restore/);
  });

  it('rejects unbalanced save at end', () => {
    const result = validator.scan(cmd(C.OpCode.SAVE));
    assert.ok(!result.valid);
    assert.match(result.reason, /Unbalanced save/);
  });

  // ── 5. Sub-structure validation (v1.5) ──
  it('rejects drawPath with excessive pointCount', () => {
    // verbCount=1, pointCount=10亿 (OOM attack)
    const payload = new Uint8Array(16);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, 1, true);                  // verbCount = 1 (valid)
    dv.setUint32(4, 0x40000000, true);          // pointCount = 1B (should be rejected)
    // payLen = 16 bytes (valid), but pointCount × 8 = 8GB → rejection expected
    const buf = cmd(C.OpCode.DRAW_PATH, payload);
    const result = validator.scan(buf);
    assert.ok(!result.valid);
    assert.match(result.reason, /pointCount/);
  });

  it('rejects drawTextBlob with excessive glyphCount', () => {
    const payload = new Uint8Array(20);
    const dv = new DataView(payload.buffer);
    dv.setFloat32(0, 0, true);          // tx
    dv.setFloat32(4, 0, true);          // ty
    dv.setUint32(8, 9999999, true);     // glyphCount > MAX_TEXT_BLOB_GLYPHS
    const buf = cmd(C.OpCode.DRAW_TEXT_BLOB, payload);
    const result = validator.scan(buf);
    assert.ok(!result.valid);
    assert.match(result.reason, /glyphCount/);
  });

  it('rejects drawAtlas with excessive count', () => {
    const payload = new Uint8Array(12);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, 200000, true);       // count > MAX_PATH_VERBS
    const buf = cmd(C.OpCode.DRAW_ATLAS, payload);
    const result = validator.scan(buf);
    assert.ok(!result.valid);
    assert.match(result.reason, /count/);
  });

  // ── 6. Frame-level byte limit (v1.6) ──
  it('rejects frame exceeding MAX_BYTES_PER_FRAME', () => {
    // Use multiple valid commands that collectively exceed 64MB frame limit
    // but individually are under 1MB per-command limit
    const payload = new Uint8Array(500000); // 500KB per command
    const cmdSize = 4 + payload.length;
    // Need: 64MB / 500KB ≈ 130 commands (well under MAX_COMMANDS_PER_FRAME=50K)
    const numCmds = 140;
    const buf = new Uint8Array(numCmds * cmdSize);
    let off = 0;
    for (let i = 0; i < numCmds; i++) {
      buf[off++] = C.OpCode.DRAW_RECT;
      buf[off++] = (payload.length >> 16) & 0xFF;
      buf[off++] = (payload.length >> 8) & 0xFF;
      buf[off++] = payload.length & 0xFF;
      buf.set(payload, off);
      off += payload.length;
    }
    const result = validator.scan(buf.buffer);
    assert.ok(!result.valid);
    assert.match(result.reason, /total bytes/);
  });

  // ── 7. Truncated input ──
  it('rejects truncated command header', () => {
    const buf = new Uint8Array(2); // less than 4 bytes
    buf[0] = C.OpCode.SAVE;
    const result = validator.scan(buf);
    assert.ok(!result.valid);
    assert.match(result.reason, /Truncated/);
  });

  it('rejects payload overflow', () => {
    // opcode + payLen=100, but buffer is only 10 bytes
    const buf = new Uint8Array(10);
    buf[0] = C.OpCode.SAVE;
    buf[1] = 0;
    buf[2] = 0;
    buf[3] = 100; // payLen=100, but only 6 bytes remain
    const result = validator.scan(buf);
    assert.ok(!result.valid);
    assert.match(result.reason, /overflows/);
  });

  // ── 8. drawShadow (v1.5: independent opcode) ──
  it('accepts valid drawShadow', () => {
    // path(8+1+0) + shadowRec(40) = 49 bytes minimum
    const payload = new Uint8Array(49);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, 1, true);    // verbCount=1
    dv.setUint32(4, 0, true);    // pointCount=0
    // rest zeroed (shadowRec)
    const result = validator.scan(cmd(C.OpCode.DRAW_SHADOW, payload));
    assert.ok(result.valid);
  });
});

// ═══════════════════════════════════════════
//  Encoder ↔ Decoder Round-trip Tests
// ═══════════════════════════════════════════

describe('Encoder-Decoder round-trip', () => {
  it('empty keyframe round-trip', () => {
    const encoder = new FrameEncoder();
    encoder.setMetadata({
      frameId: 42,
      timestamp: Date.now(),
      scrollX: 0, scrollY: 100,
      viewportW: 1280, viewportH: 720,
      canvasW: 1280, canvasH: 720,
    });
    encoder.addTile(0, 0, 1280, 720, C.TileEncoding.JPEG, new Uint8Array([1, 2, 3]));
    const frame = encoder.finalize(C.FrameType.KEYFRAME);

    const decoder = new FrameDecoder();
    const decoded = decoder.decode(frame);

    assert.equal(decoded.frameId, 42);
    assert.equal(decoded.scrollY, 100);
    assert.equal(decoded.viewportW, 1280);
    assert.equal(decoded.viewportH, 720);
    assert.equal(decoded.tileCount, 1);
    assert.equal(decoded.tiles[0].w, 1280);
    assert.equal(decoded.tiles[0].h, 720);
  });

  it('diff frame with multiple tiles', () => {
    const encoder = new FrameEncoder();
    encoder.setMetadata({
      frameId: 100, timestamp: 0, scrollX: 0, scrollY: 0,
      viewportW: 800, viewportH: 600, canvasW: 800, canvasH: 600,
    });
    encoder.addTile(0, 0, 16, 16, C.TileEncoding.JPEG, new Uint8Array(10));
    encoder.addTile(16, 0, 16, 16, C.TileEncoding.JPEG, new Uint8Array(20));
    const frame = encoder.finalize(C.FrameType.DIFF);

    const decoder = new FrameDecoder();
    const decoded = decoder.decode(frame);

    assert.equal(decoded.tileCount, 2);
    assert.equal(decoded.tiles[0].x, 0);
    assert.equal(decoded.tiles[1].x, 16);
  });

  it('decoder rejects truncated frame', () => {
    const buf = new Uint8Array(10); // less than header size
    const decoder = new FrameDecoder();
    assert.throws(() => decoder.decode(buf), DecodeError);
  });

  it('decoder rejects wrong version', () => {
    const encoder = new FrameEncoder();
    encoder.setMetadata({ frameId: 0, timestamp: 0, scrollX: 0, scrollY: 0, viewportW: 100, viewportH: 100, canvasW: 100, canvasH: 100 });
    const frame = encoder.finalize(C.FrameType.KEYFRAME);

    // Corrupt the version byte
    const corrupted = new Uint8Array(frame);
    corrupted[0] = 0xFF;
    const decoder = new FrameDecoder();
    assert.throws(() => decoder.decode(corrupted.buffer), DecodeError);
  });
});

// ═══════════════════════════════════════════
//  Fuzz Tests
// ═══════════════════════════════════════════

describe('Fuzz resilience', () => {
  const validator = new CommandValidator();
  const decoder = new FrameDecoder();

  it('validator handles random bytes without throwing', () => {
    for (let size of [0, 1, 10, 100, 1000, 10000]) {
      const buf = new Uint8Array(size);
      for (let i = 0; i < size; i++) buf[i] = Math.floor(Math.random() * 256);
      const result = validator.scan(buf);
      assert.equal(typeof result.valid, 'boolean');
      // 可能 valid=false（预期），但绝不抛出异常
    }
  });

  it('decoder handles random bytes without hanging', () => {
    for (let size of [0, 1, 50, 500]) {
      const buf = new Uint8Array(size);
      try {
        decoder.decode(buf);
      } catch (e) {
        assert.ok(e instanceof DecodeError);
      }
    }
  });

  it('validator does not allocate excessive memory', () => {
    // 构造一个 payLen=1 但内部 count 字段巨大的命令
    const payload = new Uint8Array(8);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, 1, true);       // verbCount=1
    dv.setUint32(4, 0x7FFFFFFF, true); // pointCount = max int32
    const buf = new Uint8Array(4 + 8);
    buf[0] = C.OpCode.DRAW_PATH;
    buf[1] = 0;
    buf[2] = 0;
    buf[3] = 8;
    buf.set(payload, 4);

    const memBefore = process.memoryUsage().heapUsed;
    const result = validator.scan(buf);
    const memAfter = process.memoryUsage().heapUsed;

    assert.ok(!result.valid);
    assert.match(result.reason, /pointCount/);
    // 内存增长应极小（<1MB）
    assert.ok(memAfter - memBefore < 1024 * 1024,
      `Memory increased by ${memAfter - memBefore} bytes`);
  });
});
