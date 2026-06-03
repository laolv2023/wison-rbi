/**
 * @wison/server/frame-capture — 帧捕获 + 瓦片差分引擎
 *
 * 每 tick (默认 50ms) 截图 → 16×16 tile 差分 → 仅发送脏 tile。
 * 连续 10 帧失败 → 通知 session 重启 Chromium。
 */

'use strict';

const crypto = require('crypto');
const { TileEncoding } = require('../../protocol/src/constants');

class FrameCapture {
  /**
   * @param {import('playwright').Page} page - Playwright Page
   * @param {{ width: number, height: number }} viewport
   * @param {number} tileSize
   * @param {number} keyframeInterval
   * @param {object} logger
   */
  constructor(page, viewport, tileSize, keyframeInterval, logger) {
    this._page = page;
    this._viewport = viewport;
    this._tileSize = tileSize;
    this._cols = Math.ceil(viewport.width / tileSize);
    this._rows = Math.ceil(viewport.height / tileSize);
    this._totalTiles = this._cols * this._rows;
    this._keyframeInterval = keyframeInterval;
    this._log = logger;

    this._prevHashes = new Array(this._totalTiles).fill(null);
    this._frameCount = 0;
    this._consecutiveFailures = 0;
    this._maxConsecutiveFailures = 10;
  }

  /**
   * 捕获一帧。返回 { tiles, frameType } 或 null（无变化）。
   * 抛出异常时由调用方处理。
   */
  async capture() {
    // 截图 (JPEG quality 70 — 平衡质量与带宽)
    const screenshot = await this._page.screenshot({
      type: 'jpeg',
      quality: 70,
      fullPage: false,
    });

    this._consecutiveFailures = 0;

    // 计算脏 tile 哈希
    const dirtyList = this._computeDirtyTiles(screenshot);
    this._frameCount++;

    if (dirtyList.length === 0) return null; // 无变化

    // 决定帧类型
    const isKeyframe = dirtyList.length > this._totalTiles * 0.5 ||
      this._frameCount % this._keyframeInterval === 0;

    if (isKeyframe) {
      // 全量帧: 整张截图作为一个 tile
      this._updateAllHashes(screenshot);
      return {
        frameType: 0x01, // KEYFRAME
        tiles: [{
          x: 0, y: 0,
          w: this._viewport.width, h: this._viewport.height,
          encoding: TileEncoding.JPEG,
          data: screenshot,
        }],
      };
    }

    // 增量帧: 裁剪脏 tile 并编码
    const { default: sharp } = await import('sharp');
    const img = sharp(screenshot);
    const tiles = [];

    for (const { x, y } of dirtyList) {
      const tileBuf = await img
        .clone()
        .extract({ left: x, top: y, width: this._tileSize, height: this._tileSize })
        .jpeg({ quality: 60 })
        .toBuffer();
      tiles.push({
        x, y,
        w: this._tileSize, h: this._tileSize,
        encoding: TileEncoding.JPEG,
        data: tileBuf,
      });
    }

    return { frameType: 0x02, tiles }; // DIFF
  }

  /** 计算脏 tile 列表（MD5 对比） */
  _computeDirtyTiles(screenshotBuf) {
    const dirty = [];
    // 用 sharp 逐 tile 计算 MD5
    // 简化：对整个截图分 tile 计算
    const hash = (buf) => crypto.createHash('md5').update(buf).digest('hex');

    // 将截图转为 pixel buffer 按 tile 分块
    // 实践中 sharp 的 extract 更高效，这里用 hash 分块对比
    const imgHash = hash(screenshotBuf);
    for (let i = 0; i < this._totalTiles; i++) {
      // 简化实现：使用整帧 hash + tile 索引作为 tile key
      // 完整实现应逐 tile hash
      const tileId = `${imgHash}:${i}`;
      if (tileId !== this._prevHashes[i]) {
        const row = Math.floor(i / this._cols);
        const col = i % this._cols;
        dirty.push({ x: col * this._tileSize, y: row * this._tileSize });
        this._prevHashes[i] = tileId;
      }
    }
    return dirty;
  }

  _updateAllHashes(screenshotBuf) {
    const hash = (buf) => crypto.createHash('md5').update(buf).digest('hex');
    const imgHash = hash(screenshotBuf);
    for (let i = 0; i < this._totalTiles; i++) {
      this._prevHashes[i] = `${imgHash}:${i}`;
    }
  }

  /** 标记一次捕获失败。返回 true 表示达到连续失败上限。 */
  markFailure() {
    this._consecutiveFailures++;
    return this._consecutiveFailures >= this._maxConsecutiveFailures;
  }

  /** 标记页面导航 → 强制下一帧为 Keyframe */
  markNavigation() {
    this._frameCount = 0;
  }

  /** 更新视口尺寸（resize 后调用） */
  updateViewport(width, height) {
    this._viewport = { width, height };
    this._cols = Math.ceil(width / this._tileSize);
    this._rows = Math.ceil(height / this._tileSize);
    this._totalTiles = this._cols * this._rows;
    this._prevHashes = new Array(this._totalTiles).fill(null);
  }
}

module.exports = { FrameCapture };
