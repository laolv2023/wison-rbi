/**
 * @wison/server/frame-capture — 帧捕获 + 瓦片差分引擎
 *
 * 每 tick (默认 50ms) 截图 → 16×16 tile 差分 → 仅发送脏 tile。
 * 连续 10 帧失败 → 通知 session 重启 Chromium。
 */

'use strict';

const crypto = require('crypto');
const sharp = require('sharp');  // v1.7: 移至模块顶层，首次加载失败即 fast-fail
const { TileEncoding } = require('../../protocol/src/constants');

class FrameCapture {
  // ════════════════════════════════════════════════════════════
  // 帧捕获引擎 —— 截图 + 差分 + JPEG 编码
  //
  // 工作流程:
  //   1. page.screenshot({type:'png'}) → 全量 PNG 截图
  //   2. sharp 解码为 raw RGBA pixels
  //   3. _computeDirtyTiles() → 16×16 瓦片级 hash 差分 (MD5)
  //   4. 脏瓦片 → sharp JPEG 编码 → 返回 {tiles:[...]}
  //
  // 关键帧策略:
  //   - 每 300 帧强制全量 (config.keyframeInterval)
  //   - 脏瓦片 > 总数 50% → 自动升级为关键帧
  //   - 导航后 → 强制关键帧 (markNavigation)
  //   - 客户端请求 → forceKeyframe()
  //
  // ⚠️ 性能敏感: sharp 的 raw→JPEG 编码是 CPU 密集型操作
  //   使用 libvips 线程池 (默认 4 线程)，多 session 时注意争用
  // ════════════════════════════════════════════════════════════

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
    this._forceNextKeyframe = false;  // v1.7
  }

  /**
   * 捕获一帧。返回 { tiles, frameType } 或 null（无变化）。
   * 抛出异常时由调用方处理。
   */
  async capture() {
    // v1.7: 截图使用 PNG（无损，支持逐 tile 像素哈希）
    const screenshotPng = await this._page.screenshot({
      type: 'png',
      fullPage: false,
    });

    this._consecutiveFailures = 0;

    // 解码为 raw RGBA pixels
    const { data: rawPixels, info: { width, height } } = await sharp(screenshotPng)
      .raw()
      .toBuffer({ resolveWithObject: true });

    // 计算脏 tile 列表（基于 raw pixel hash）
    const dirtyList = this._computeDirtyTiles(rawPixels, width, height);
    this._frameCount++;

    if (dirtyList.length === 0) return null;

    const isKeyframe = this._forceNextKeyframe ||
      dirtyList.length > this._totalTiles * 0.5 ||
      this._frameCount % this._keyframeInterval === 0;

    if (this._forceNextKeyframe) this._forceNextKeyframe = false;

    if (isKeyframe) {
      // Keyframe: 整帧 JPEG（带宽优于 PNG）
      const screenshotJpeg = await this._page.screenshot({
        type: 'jpeg', quality: 70, fullPage: false,
      });
      this._updateAllHashes(rawPixels, width, height);
      return {
        frameType: 0x01,
        tiles: [{
          x: 0, y: 0,
          w: this._viewport.width, h: this._viewport.height,
          encoding: TileEncoding.JPEG,
          data: screenshotJpeg,
        }],
      };
    }

    // Diff: 从 PNG 裁剪脏 tile → JPEG 编码
    const tiles = [];
    for (const { x, y } of dirtyList) {
      const tileBuf = await sharp(screenshotPng)
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
    return { frameType: 0x02, tiles };
  }

  /** v1.7: 基于 raw pixel 的逐 tile 哈希对比
   *
   * 算法: 对每个 16×16 瓦片提取 RGBA 像素，计算 MD5 哈希。
   * 与上一帧哈希对比 → 不同的瓦片标记为"脏"→ 需重新编码和发送。
   *
   * 边界处理 (v1.9 修复):
   *   - 行边界: (tileY + py) < imgHeight (非 imgWidth!)
   *   - 列边界: Math.min(tileSize, imgWidth - tileX) 处理右边缘半瓦片
   *
   * 性能: 每帧 3600 个 MD5 哈希 × 16×16×4 字节 = 3.7MB 哈希数据量
   */
  _computeDirtyTiles(rawPixels, imgWidth, imgHeight) {
    const dirty = [];
    const hash = (buf) => crypto.createHash('md5').update(buf).digest('hex');
    const bytesPerPixel = 4; // RGBA

    for (let tileIdx = 0; tileIdx < this._totalTiles; tileIdx++) {
      const row = Math.floor(tileIdx / this._cols);
      const col = tileIdx % this._cols;
      const tileX = col * this._tileSize;
      const tileY = row * this._tileSize;

      // 提取 tile 区域的像素行
      const tileBytes = Buffer.allocUnsafe(this._tileSize * this._tileSize * bytesPerPixel);
      for (let py = 0; py < this._tileSize && (tileY + py) < imgHeight; py++) {
        const srcOff = ((tileY + py) * imgWidth + tileX) * bytesPerPixel;
        const dstOff = py * this._tileSize * bytesPerPixel;
        const lineLen = Math.min(this._tileSize, imgWidth - tileX) * bytesPerPixel;
        rawPixels.copy(tileBytes, dstOff, srcOff, srcOff + lineLen);
      }

      const tileHash = hash(tileBytes);
      if (tileHash !== this._prevHashes[tileIdx]) {
        dirty.push({ x: tileX, y: tileY });
        this._prevHashes[tileIdx] = tileHash;
      }
    }
    return dirty;
  }

  _updateAllHashes(rawPixels, imgWidth, imgHeight) {
    const hash = (buf) => crypto.createHash('md5').update(buf).digest('hex');
    const bytesPerPixel = 4;
    for (let tileIdx = 0; tileIdx < this._totalTiles; tileIdx++) {
      const row = Math.floor(tileIdx / this._cols);
      const col = tileIdx % this._cols;
      const tileX = col * this._tileSize;
      const tileY = row * this._tileSize;
      const tileBytes = Buffer.allocUnsafe(this._tileSize * this._tileSize * bytesPerPixel);
      for (let py = 0; py < this._tileSize && (tileY + py) < imgHeight; py++) {
        const srcOff = ((tileY + py) * imgWidth + tileX) * bytesPerPixel;
        const dstOff = py * this._tileSize * bytesPerPixel;
        const lineLen = Math.min(this._tileSize, imgWidth - tileX) * bytesPerPixel;
        rawPixels.copy(tileBytes, dstOff, srcOff, srcOff + lineLen);
      }
      this._prevHashes[tileIdx] = hash(tileBytes);
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

  /** v1.7: 外部强制 Keyframe（客户端 request_keyframe） */
  forceKeyframe() {
    this._forceNextKeyframe = true;
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
