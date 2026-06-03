/**
 * @wison/client/frame-buffer — 帧环形缓冲区 (v1.6)
 *
 * 存储最近 N 帧的元数据，用于 HID 坐标转换。
 * 使用固定大小环形缓冲区，不受 frame_id uint32 回绕影响。
 */

'use strict';

class FrameBuffer {
  /**
   * @param {number} maxSize - 最大保留帧数 (默认 64)
   */
  constructor(maxSize = 64) {
    this._maxSize = maxSize;
    this._buffer = new Array(maxSize);
    this._writePos = 0;
    this._totalWritten = 0;
  }

  /** 添加帧元数据。 */
  push(meta) {
    this._buffer[this._writePos] = {
      frameId: meta.frameId,
      timestampMs: meta.timestampMs,
      scrollX: meta.scrollX,
      scrollY: meta.scrollY,
      viewportW: meta.viewportW,
      viewportH: meta.viewportH,
      canvasW: meta.canvasW,
      canvasH: meta.canvasH,
      addedAt: Date.now(),
    };
    this._writePos = (this._writePos + 1) % this._maxSize;
    this._totalWritten++;
  }

  /**
   * 根据 frame_id 查找帧元数据。O(n), n≤64。
   * @returns {object|null}
   */
  findByFrameId(frameId) {
    const count = Math.min(this._totalWritten, this._maxSize);
    for (let i = 0; i < count; i++) {
      const idx = this._totalWritten <= this._maxSize
        ? i
        : (this._writePos + i) % this._maxSize;
      if (this._buffer[idx] && this._buffer[idx].frameId === frameId) {
        return this._buffer[idx];
      }
    }
    return null;
  }

  /** 获取最新帧。 */
  latest() {
    if (this._totalWritten === 0) return null;
    const idx = this._totalWritten <= this._maxSize
      ? this._totalWritten - 1
      : (this._writePos - 1 + this._maxSize) % this._maxSize;
    return this._buffer[idx] || null;
  }

  /** 清空缓冲区。 */
  clear() {
    this._buffer = new Array(this._maxSize);
    this._writePos = 0;
    this._totalWritten = 0;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FrameBuffer };
}
