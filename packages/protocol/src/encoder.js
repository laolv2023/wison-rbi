/**
 * @wison/protocol/encoder — 帧编码器 (服务端使用)
 *
 * 将 DrawingCommand 列表和 Tile 列表编码为二进制帧格式。
 *
 * 帧格式 (v1.6):
 *   [version:1][flags:1][frame_id:4][timestamp:8][scroll_x:4][scroll_y:4]
 *   [viewport_w:2][viewport_h:2][canvas_w:2][canvas_h:2]
 *   [tileCount:2][TileEntry*N][TileData*N][CRC32:4]
 *
 * TileEntry: [x:2][y:2][w:2][h:2][encoding:2][dataLen:4]
 */

'use strict';

const isNode = typeof module !== 'undefined' && module.exports;
const C = isNode ? require('./constants') : window.WisonProtocol;

// CRC32 查找表 (IEEE 802.3)
const CRC32_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
    }
    table[i] = crc;
  }
  return table;
})();

function crc32(data, offset, length) {
  let crc = 0xFFFFFFFF;
  for (let i = offset; i < offset + length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0; // unsigned
}

class FrameEncoder {
  /**
   * @param {number} version - 协议版本 (默认 1)
   */
  constructor(version = C.PROTOCOL_VERSION) {
    this._version = version;
    this._frameId = 0;
    this._timestamp = 0;
    this._scrollX = 0;
    this._scrollY = 0;
    this._viewportW = 1280;
    this._viewportH = 720;
    this._canvasW = 1280;
    this._canvasH = 720;
    this._tiles = [];
    this._commands = [];
    this._commandBytes = 0;
  }

  /**
   * 设置帧元数据。每帧开始前必须调用。
   */
  setMetadata({ frameId, timestamp, scrollX, scrollY, viewportW, viewportH, canvasW, canvasH }) {
    this._frameId = frameId >>> 0;
    this._timestamp = Math.floor(timestamp || Date.now());
    this._scrollX = Math.round(scrollX || 0);
    this._scrollY = Math.round(scrollY || 0);
    this._viewportW = (viewportW || 1280) & 0xFFFF;
    this._viewportH = (viewportH || 720) & 0xFFFF;
    this._canvasW = (canvasW || this._viewportW) & 0xFFFF;
    this._canvasH = (canvasH || this._viewportH) & 0xFFFF;
    this._tiles = [];
    this._commands = [];
    this._commandBytes = 0;
  }

  /**
   * 添加绘制命令。
   * @param {number} opcode - OpCode 常量
   * @param {Uint8Array} payload - 命令 payload (已序列化)
   */
  addCommand(opcode, payload) {
    if (!payload || payload.length === 0) return;
    if (payload.length > C.Limits.MAX_PAYLOAD_BYTES) {
      throw new Error(`Command payload ${payload.length} exceeds MAX_PAYLOAD_BYTES`);
    }
    if (this._commandBytes + 4 + payload.length > C.Limits.MAX_BYTES_PER_FRAME) {
      throw new Error(`Frame would exceed MAX_BYTES_PER_FRAME (${C.Limits.MAX_BYTES_PER_FRAME})`);
    }
    this._commands.push({
      opcode: opcode & 0xFF,
      payload: new Uint8Array(payload),
    });
    this._commandBytes += 4 + payload.length;
  }

  /**
   * 添加瓦片。
   * @param {number} x - 瓦片 X 坐标 (px)
   * @param {number} y - 瓦片 Y 坐标 (px)
   * @param {number} w - 瓦片宽度
   * @param {number} h - 瓦片高度
   * @param {number} encoding - TileEncoding.JPEG 或 TileEncoding.PNG
   * @param {Uint8Array} data - 编码后的瓦片数据
   */
  addTile(x, y, w, h, encoding, data) {
    if (this._tiles.length >= C.Limits.MAX_TILES) {
      throw new Error(`Too many tiles: ${this._tiles.length} >= ${C.Limits.MAX_TILES}`);
    }
    this._tiles.push({
      x: (x & 0xFFFF), y: (y & 0xFFFF),
      w: (w & 0xFFFF), h: (h & 0xFFFF),
      encoding: encoding & 0xFFFF,
      data: new Uint8Array(data),
    });
  }

  /**
   * 完成帧编码，返回 ArrayBuffer。
   * @param {number} frameType - FrameType.KEYFRAME 或 FrameType.DIFF
   * @returns {ArrayBuffer}
   */
  finalize(frameType) {
    // ── 第一步: 计算帧总大小 ──
    // 帧头(30) + tileCount(2) + 瓦片条目(N×14) + 瓦片数据 + 命令(N×(4+payload)) + CRC32(4)
    let size = C.FRAME_HEADER_SIZE + 2;
    size += this._tiles.length * C.TILE_ENTRY_SIZE;
    for (const t of this._tiles) size += t.data.length;       // 瓦片二进制数据
    for (const c of this._commands) size += 4 + c.payload.length; // 4字节=opcode(1)+payLen(3)
    size += 4; // CRC32 校验和

    if (size > C.Limits.MAX_BYTES_PER_FRAME) {
      throw new Error(`Encoded frame ${size} exceeds MAX_BYTES_PER_FRAME`);
    }

    const buf = new Uint8Array(size);
    const dv = new DataView(buf.buffer);  // DataView 用于多字节整数写入 (统一小端)
    let off = 0;

    // ── 第二步: 写入帧头 (30 字节) ──
    buf[off++] = this._version;                              // offset 0: 协议版本
    buf[off++] = 0;                                          // offset 1: flags (预留，未来扩展)
    dv.setUint32(off, this._frameId, true);    off += 4;    // offset 2-5: 帧序号 (uint32 LE)
    dv.setBigInt64(off, BigInt(this._timestamp), true); off += 8; // offset 6-13: 时间戳 (int64 LE)
    dv.setInt32(off, this._scrollX, true);     off += 4;    // offset 14-17: 水平滚动偏移
    dv.setInt32(off, this._scrollY, true);     off += 4;    // offset 18-21: 垂直滚动偏移
    dv.setUint16(off, this._viewportW, true);  off += 2;    // offset 22-23: 视口宽度
    dv.setUint16(off, this._viewportH, true);  off += 2;    // offset 24-25: 视口高度
    dv.setUint16(off, this._canvasW, true);    off += 2;    // offset 26-27: 画布宽度 (WebGL 可能 > viewport)
    dv.setUint16(off, this._canvasH, true);    off += 2;    // offset 28-29: 画布高度

    // ── 第三步: 瓦片条目表 (tileCount + N×TileEntry) ──
    // TileEntry 格式: [x:2][y:2][w:2][h:2][encoding:2][dataLen:4] = 14 字节
    dv.setUint16(off, this._tiles.length, true); off += 2;   // 瓦片数量
    const tileDataStart = off + this._tiles.length * C.TILE_ENTRY_SIZE; // 瓦片数据区起始偏移

    for (const t of this._tiles) {
      dv.setUint16(off, t.x, true);        off += 2;          // 瓦片 X 坐标 (像素)
      dv.setUint16(off, t.y, true);        off += 2;          // 瓦片 Y 坐标 (像素)
      dv.setUint16(off, t.w, true);        off += 2;          // 瓦片宽度 (通常 16)
      dv.setUint16(off, t.h, true);        off += 2;          // 瓦片高度 (通常 16)
      dv.setUint16(off, t.encoding, true); off += 2;          // 编码类型 (JPEG=1/PNG=2)
      dv.setUint32(off, t.data.length, true); off += 4;       // 瓦片数据字节数
    }

    // ── 第四步: 瓦片二进制数据 ──
    // 直接拷贝原始 JPEG/PNG 字节，不做二次编码
    for (const t of this._tiles) {
      buf.set(t.data, off);
      off += t.data.length;
    }

    // ── 第五步: 命令流 ──
    // 命令格式: [opcode:1][payLen:3][payload:payLen]
    // payLen 使用 3 字节 big-endian (24-bit)，最大 16MB→实际限制 1MB
    for (const cmd of this._commands) {
      buf[off++] = cmd.opcode;                              // 操作码
      const payLen = cmd.payload.length;
      buf[off++] = (payLen >> 16) & 0xFF;                   // payload 长度高字节
      buf[off++] = (payLen >> 8) & 0xFF;                    // payload 长度中字节
      buf[off++] = payLen & 0xFF;                           // payload 长度低字节
      buf.set(cmd.payload, off);                            // payload 二进制数据
      off += payLen;
    }

    // ── 第六步: CRC32 校验和 ──
    // 校验范围: buf[0..off-1]，即 CRC 字段自身之前的所有数据
    // 使用 IEEE 802.3 标准 CRC32 多项式，小端写入
    const crc = crc32(buf, 0, off);
    dv.setUint32(off, crc, true);
    off += 4;

    // 返回 ArrayBuffer (slice 是为了确保精确长度，buf 可能预分配更大)
    return buf.buffer.slice(0, off);
  }

  /** 重置编码器（跨帧复用） */
  reset() {
    this._tiles = [];
    this._commands = [];
    this._commandBytes = 0;
  }
}

if (isNode) {
  module.exports = { FrameEncoder };
} else {
  window.WisonProtocol = window.WisonProtocol || {};
  window.WisonProtocol.FrameEncoder = FrameEncoder;
}
