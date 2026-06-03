/**
 * @wison/protocol/decoder — 帧解码器 (客户端使用)
 *
 * 将二进制帧解码为结构化对象。
 * 每一处偏移运算均包含边界检查，防止缓冲区越界读。
 */

'use strict';

const isNode = typeof module !== 'undefined' && module.exports;
const C = isNode ? require('./constants') : window.WisonProtocol;

class DecodeError extends Error {
  constructor(message, offset) {
    super(message);
    this.name = 'DecodeError';
    this.offset = offset;
  }
}

class FrameDecoder {
  /**
   * 解码二进制帧。
   * @param {ArrayBuffer|Uint8Array} buffer
   * @returns {DecodedFrame}
   * @throws {DecodeError} 帧格式不合法
   */
  decode(buffer) {
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let off = 0;

    const check = (n, what) => {
      if (off + n > data.length) {
        throw new DecodeError(`Truncated frame at offset ${off}: expected ${n} bytes for ${what}, only ${data.length - off} remaining`, off);
      }
    };

    // ── Header (30 bytes) ──
    check(C.FRAME_HEADER_SIZE, 'header');

    const version = data[off++];
    if (version !== C.PROTOCOL_VERSION) {
      throw new DecodeError(`Unsupported protocol version: ${version} (expected ${C.PROTOCOL_VERSION})`, off - 1);
    }

    const flags = data[off++]; // reserved for future use

    const frameId = dv.getUint32(off, true); off += 4;
    const timestampMs = Number(dv.getBigInt64(off, true)); off += 8;
    const scrollX = dv.getInt32(off, true); off += 4;
    const scrollY = dv.getInt32(off, true); off += 4;
    const viewportW = dv.getUint16(off, true); off += 2;
    const viewportH = dv.getUint16(off, true); off += 2;
    const canvasW = dv.getUint16(off, true); off += 2;
    const canvasH = dv.getUint16(off, true); off += 2;

    // ── Tile entries ──
    check(2, 'tileCount');
    const tileCount = dv.getUint16(off, true); off += 2;

    if (tileCount > C.Limits.MAX_TILES) {
      throw new DecodeError(`Tile count ${tileCount} exceeds MAX_TILES ${C.Limits.MAX_TILES}`, off - 2);
    }

    const tileEntriesSize = tileCount * C.TILE_ENTRY_SIZE;
    check(tileEntriesSize, 'tile entries');

    const tiles = [];
    for (let i = 0; i < tileCount; i++) {
      const x = dv.getUint16(off, true); off += 2;
      const y = dv.getUint16(off, true); off += 2;
      const w = dv.getUint16(off, true); off += 2;
      const h = dv.getUint16(off, true); off += 2;
      const encoding = dv.getUint16(off, true); off += 2;
      const dataLen = dv.getUint32(off, true); off += 4;

      // Validate encoding
      if (encoding !== C.TileEncoding.JPEG && encoding !== C.TileEncoding.PNG) {
        throw new DecodeError(`Invalid tile encoding: ${encoding}`, off - 6);
      }

      tiles.push({ x, y, w, h, encoding, dataLen, dataOffset: -1 });
    }

    // ── Tile data ──
    for (let i = 0; i < tileCount; i++) {
      check(tiles[i].dataLen, `tile[${i}] data`);
      tiles[i].dataOffset = off;
      off += tiles[i].dataLen;
    }

    // ── Commands ──
    const cmdStart = off;
    const maxCmdEnd = data.length - 4; // reserve 4 bytes for CRC32
    const commands = [];
    let cmdBytes = 0;

    while (off < maxCmdEnd) {
      check(4, 'command header');
      const opcode = data[off++];
      const payLen = (data[off] << 16) | (data[off + 1] << 8) | data[off + 2];
      off += 3;

      if (payLen > C.Limits.MAX_PAYLOAD_BYTES) {
        throw new DecodeError(`Command payload ${payLen} exceeds MAX_PAYLOAD_BYTES`, off - 3);
      }

      check(payLen, `command payload (opcode 0x${opcode.toString(16)})`);

      commands.push({
        opcode,
        payloadSize: payLen,
        payloadOffset: off,
      });

      off += payLen;
      cmdBytes += 4 + payLen;

      if (commands.length > C.Limits.MAX_COMMANDS_PER_FRAME) {
        throw new DecodeError(`Command count exceeds MAX_COMMANDS_PER_FRAME`, off);
      }
      if (cmdBytes > C.Limits.MAX_BYTES_PER_FRAME) {
        throw new DecodeError(`Command bytes ${cmdBytes} exceeds MAX_BYTES_PER_FRAME`, off);
      }
    }

    // ── CRC32 ──
    check(4, 'CRC32');
    const crcReceived = dv.getUint32(off, true);

    return {
      version,
      flags,
      frameId,
      timestampMs,
      scrollX, scrollY,
      viewportW, viewportH,
      canvasW, canvasH,
      tileCount,
      tiles,
      data, // reference to raw buffer for lazy tile/command extraction
      commands,
      crcReceived,
    };
  }

  /**
   * 从解码帧中提取命令 payload。
   * 延迟提取以减少 GC 压力——仅在实际分发命令时调用。
   */
  extractCommandPayload(decodedFrame, cmdIndex) {
    const cmd = decodedFrame.commands[cmdIndex];
    if (!cmd) throw new DecodeError(`Command index ${cmdIndex} out of range`, -1);
    return new Uint8Array(
      decodedFrame.data.buffer,
      decodedFrame.data.byteOffset + cmd.payloadOffset,
      cmd.payloadSize
    );
  }

  /**
   * 从解码帧中提取瓦片数据。
   */
  extractTileData(decodedFrame, tileIndex) {
    const tile = decodedFrame.tiles[tileIndex];
    if (!tile) throw new DecodeError(`Tile index ${tileIndex} out of range`, -1);
    return new Uint8Array(
      decodedFrame.data.buffer,
      decodedFrame.data.byteOffset + tile.dataOffset,
      tile.dataLen
    );
  }
}

if (isNode) {
  module.exports = { FrameDecoder, DecodeError };
} else {
  window.WisonProtocol = window.WisonProtocol || {};
  window.WisonProtocol.FrameDecoder = FrameDecoder;
  window.WisonProtocol.DecodeError = DecodeError;
}
