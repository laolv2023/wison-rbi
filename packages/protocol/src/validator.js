/**
 * @wison/protocol/validator — 命令白名单校验器 (客户端安全边界)
 *
 * 这是客户端唯一的安全防线。所有来自服务端的命令必须通过此校验器。
 *
 * v1.5 修复:
 *   - Payload 子结构深度校验 (drawPath/drawPoints/drawAtlas/textBlob/glyphRunList)
 * v1.6 修复:
 *   - 帧级总字节上限 MAX_BYTES_PER_FRAME（防组合攻击）
 *
 * 设计原则:
 *   - 永不抛出异常——所有非法输入返回 { valid: false, reason }
 *   - 永不分配可变大小数组——所有 OOM 向量被 count*size <= payLen 拦截
 *   - 白名单优先——不在列表中的 opcode 一律拒绝
 */

'use strict';

const isNode = typeof module !== 'undefined' && module.exports;
const C = isNode ? require('./constants') : window.WisonProtocol;

class CommandValidator {
  constructor() {
    // 合法 opcode 白名单 (v1.6: 增加 DRAW_SHADOW 0x36)
    this.VALID_OPCODES = new Set([
      // State
      C.OpCode.SAVE, C.OpCode.RESTORE, C.OpCode.SAVE_LAYER,
      // Transform
      C.OpCode.CONCAT, C.OpCode.TRANSLATE, C.OpCode.SCALE, C.OpCode.ROTATE,
      // Clip
      C.OpCode.CLIP_RECT, C.OpCode.CLIP_RRECT, C.OpCode.CLIP_PATH,
      // Shapes
      C.OpCode.DRAW_RECT, C.OpCode.DRAW_RRECT, C.OpCode.DRAW_OVAL,
      C.OpCode.DRAW_ARC, C.OpCode.DRAW_PATH, C.OpCode.DRAW_POINTS,
      C.OpCode.DRAW_SHADOW,
      // Images
      C.OpCode.DRAW_IMAGE, C.OpCode.DRAW_IMAGE_RECT, C.OpCode.DRAW_ATLAS,
      // Text
      C.OpCode.DRAW_TEXT_BLOB, C.OpCode.GLYPH_RUN_LIST,
      // Paint
      C.OpCode.DRAW_PAINT, C.OpCode.DRAW_COLOR,
    ]);

    this.LIMITS = C.Limits;
  }

  /**
   * 扫描命令缓冲区，返回校验结果。
   *
   * @param {ArrayBuffer|Uint8Array} commandsBuffer — 帧中的命令流部分
   * @returns {{ valid: boolean, commandCount?: number, reason?: string, index?: number }}
   */
  scan(commandsBuffer) {
    const buf = commandsBuffer instanceof Uint8Array
      ? commandsBuffer
      : new Uint8Array(commandsBuffer);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    let offset = 0;
    let cmdCount = 0;
    let totalBytes = 0;         // v1.6: 帧级字节累加器
    let saveDepth = 0;

    while (offset < buf.length) {
      // ── 命令数上限 ──
      if (cmdCount >= this.LIMITS.MAX_COMMANDS_PER_FRAME) {
        return { valid: false, index: cmdCount, reason: `Too many commands (max ${this.LIMITS.MAX_COMMANDS_PER_FRAME})` };
      }

      // ── 命令头边界 ──
      if (offset + 4 > buf.length) {
        return { valid: false, index: cmdCount, reason: `Truncated command header at offset ${offset}` };
      }

      const opcode = view.getUint8(offset);
      const payLen = (view.getUint8(offset + 1) << 16) |
                     (view.getUint8(offset + 2) << 8) |
                     view.getUint8(offset + 3);

      // ── 校验 1: opcode 白名单 ──
      if (!this.VALID_OPCODES.has(opcode)) {
        return { valid: false, index: cmdCount, reason: `Invalid opcode: 0x${opcode.toString(16)}` };
      }

      // ── 校验 2: 单条 payload 大小 ──
      if (payLen > this.LIMITS.MAX_PAYLOAD_BYTES) {
        return { valid: false, index: cmdCount, reason: `Payload too large: ${payLen} > ${this.LIMITS.MAX_PAYLOAD_BYTES}` };
      }

      // ── 校验 2b: 帧级总字节 ──
      totalBytes += 4 + payLen;
      if (totalBytes > this.LIMITS.MAX_BYTES_PER_FRAME) {
        return { valid: false, index: cmdCount, reason: `Frame total bytes ${totalBytes} exceeds ${this.LIMITS.MAX_BYTES_PER_FRAME}` };
      }

      // ── 校验 3: payload 边界 ──
      if (offset + 4 + payLen > buf.length) {
        return { valid: false, index: cmdCount, reason: `Payload overflows buffer at offset ${offset + 4}` };
      }

      // ── 校验 4: save/restore 配对 ──
      if (opcode === C.OpCode.SAVE) saveDepth++;
      if (opcode === C.OpCode.RESTORE) {
        saveDepth--;
        if (saveDepth < 0) {
          return { valid: false, index: cmdCount, reason: 'Unbalanced restore (no matching save)' };
        }
      }

      // ── 校验 5: payload 子结构深度检查 (v1.5) ──
      if (payLen > 0) {
        const subResult = this._validatePayloadSubstructure(
          opcode, payLen, new DataView(buf.buffer, buf.byteOffset + offset + 4, payLen)
        );
        if (!subResult.valid) {
          return { valid: false, index: cmdCount, reason: subResult.reason };
        }
      }

      offset += 4 + payLen;
      cmdCount++;
    }

    // ── 最终检查: save/restore 平衡 ──
    if (saveDepth !== 0) {
      return { valid: false, index: cmdCount, reason: `Unbalanced save (depth=${saveDepth} at end of frame)` };
    }

    return { valid: true, commandCount: cmdCount };
  }

  /**
   * Payload 子结构深度校验 (v1.5)。
   *
   * 攻击场景: payLen=500KB 合法，但内部 pointCount=10亿
   * → 客户端 new Float32Array(2×10亿) → OOM。
   * 本方法对包含数组计数的 opcode 提取 count 并验证
   * count × element_size + header ≤ payLen。
   */
  _validatePayloadSubstructure(opcode, payLen, payload) {
    const p = payload;

    switch (opcode) {
      // ── drawPath (0x34): verbCount(4) + pointCount(4) + verbs(N) + points(N*8) ──
      case C.OpCode.DRAW_PATH: {
        if (payLen < 8) return this._reject('drawPath: payload too short for counts');
        const verbCount = p.getUint32(0, true);
        const pointCount = p.getUint32(4, true);
        if (verbCount > this.LIMITS.MAX_PATH_VERBS) return this._reject(`drawPath: verbCount ${verbCount} > ${this.LIMITS.MAX_PATH_VERBS}`);
        if (pointCount > this.LIMITS.MAX_PATH_VERBS) return this._reject(`drawPath: pointCount ${pointCount} > ${this.LIMITS.MAX_PATH_VERBS}`);
        if (8 + verbCount + pointCount * 8 > payLen) return this._reject(`drawPath: sub-structure overflows payLen (${8 + verbCount + pointCount * 8} > ${payLen})`);
        break;
      }
      // ── drawPoints (0x35): mode(1) + count(4) + points(N*8) ──
      case C.OpCode.DRAW_POINTS: {
        if (payLen < 5) return this._reject('drawPoints: payload too short');
        const count = p.getUint32(1, true);
        if (count > this.LIMITS.MAX_PATH_VERBS) return this._reject(`drawPoints: count ${count} > ${this.LIMITS.MAX_PATH_VERBS}`);
        if (5 + count * 8 > payLen) return this._reject(`drawPoints: sub-structure overflows payLen`);
        break;
      }
      // ── drawShadow (0x36): path(...) + shadowRec(40) ──
      case C.OpCode.DRAW_SHADOW: {
        if (payLen < 48) return this._reject('drawShadow: payload too short');
        // Recurse into path validation
        const verbCount = p.getUint32(0, true);
        const pointCount = p.getUint32(4, true);
        if (verbCount > this.LIMITS.MAX_PATH_VERBS) return this._reject(`drawShadow: verbCount ${verbCount} > ${this.LIMITS.MAX_PATH_VERBS}`);
        if (pointCount > this.LIMITS.MAX_PATH_VERBS) return this._reject(`drawShadow: pointCount ${pointCount} > ${this.LIMITS.MAX_PATH_VERBS}`);
        const pathBytes = 8 + verbCount + pointCount * 8;
        if (pathBytes + 40 > payLen) return this._reject(`drawShadow: path+shadowRec overflows payLen`);
        break;
      }
      // ── drawAtlas (0x42): count(4) + ... ──
      case C.OpCode.DRAW_ATLAS: {
        if (payLen < 4) return this._reject('drawAtlas: payload too short');
        const count = p.getUint32(0, true);
        if (count > this.LIMITS.MAX_PATH_VERBS) return this._reject(`drawAtlas: count ${count} > ${this.LIMITS.MAX_PATH_VERBS}`);
        // Rough lower bound: count × (xform 16 + tex 16 + color 4) + sampling
        if (4 + count * 36 > payLen) return this._reject(`drawAtlas: sub-structure overflows payLen`);
        break;
      }
      // ── drawTextBlob (0x50): tx(4)+ty(4)+glyphCount(4)+glyphs(2N)+pos(8N) ──
      case C.OpCode.DRAW_TEXT_BLOB: {
        if (payLen < 12) return this._reject('drawTextBlob: payload too short');
        const glyphCount = p.getUint32(8, true);
        if (glyphCount > this.LIMITS.MAX_TEXT_BLOB_GLYPHS) return this._reject(`drawTextBlob: glyphCount ${glyphCount} > ${this.LIMITS.MAX_TEXT_BLOB_GLYPHS}`);
        if (12 + glyphCount * 10 > payLen) return this._reject(`drawTextBlob: sub-structure overflows payLen`);
        break;
      }
      // ── glyphRunList (0x51): 保守校验首字段 ──
      case C.OpCode.GLYPH_RUN_LIST: {
        if (payLen >= 4) {
          const gc = p.getUint32(0, true);
          if (gc > this.LIMITS.MAX_TEXT_BLOB_GLYPHS) return this._reject(`glyphRunList: glyphCount ${gc} > ${this.LIMITS.MAX_TEXT_BLOB_GLYPHS}`);
        }
        break;
      }
      // ── saveLayer (0x03): bounds rect(16) ──
      case C.OpCode.SAVE_LAYER: {
        if (payLen < 16) return this._reject('saveLayer: payload too short for bounds rect');
        break;
      }
    }

    return { valid: true };
  }

  _reject(reason) {
    return { valid: false, reason };
  }
}

if (isNode) {
  module.exports = { CommandValidator };
} else {
  window.WisonProtocol = window.WisonProtocol || {};
  window.WisonProtocol.CommandValidator = CommandValidator;
}
