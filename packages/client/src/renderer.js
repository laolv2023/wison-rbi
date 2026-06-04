/**
 * @wison/client/renderer — CanvasKit 命令分发渲染器
 *
 * 解码帧 → 分发绘制命令 → CanvasKit 渲染。
 * v1.6: 连续 3 帧验证失败 → request_keyframe。
 */

'use strict';

class Renderer {
  // ════════════════════════════════════════════════════════════
  // 客户端渲染器 —— 帧解码 + 命令校验 + CanvasKit 渲染
  //
  // 渲染管道 (每帧):
  //   1. CRC32 完整性校验 → 不通过则拒绝
  //   2. FrameDecoder.decode() → 解析帧结构
  //   3. CommandValidator.scan(cmdView) → 白名单+深度+边界检查
  //   4. _renderTiles() → JPEG 解码 → drawImage 到 SkCanvas
  //   5. _dispatchCommands() → 逐个命令发送到 CanvasKit API
  //
  // 安全层:
  //   - CRC32: 防止传输损坏/中间人篡改
  //   - Validator: 防止恶意命令执行 (白名单+参数限制)
  //   - rejectionCount: 连续 N 帧校验失败 → request_keyframe
  //
  // CanvasKit 初始化:
  //   - WebGL Canvas (GPU 加速) → MakeWebGLCanvasSurface()
  //   - 降级: 软件渲染 → MakeSWCanvasSurface()
  //   - 全部失败 → _skCanvas=null → 所有帧返回 {rendered:false}
  // ════════════════════════════════════════════════════════════

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} canvasKit - CanvasKit WASM 实例
   * @param {object} options
   */
  constructor(canvas, canvasKit, options = {}) {
    this._canvas = canvas;
    this._ck = canvasKit;
    this._surface = null;
    this._skCanvas = null;

    this._decoder = new window.WisonProtocol.FrameDecoder();
    this._validator = new window.WisonProtocol.CommandValidator();

    this._rejectionCount = 0;
    this._maxRejections = 3;
    this._onRequestKeyframe = options.onRequestKeyframe || null;

    this._currentFrameId = 0;
    this._frameCount = 0;

    // v2.1: 滚动优化状态
    this._scrollX = 0;
    this._scrollY = 0;
    this._scrollOptimizeThreshold = 4;  // 最小优化滚动量 (px)

    this._initSurface();
  }

  // ── 初始化 ────────────────────────────────────────────

  _initSurface() {
    this._surface = this._ck.MakeWebGLCanvasSurface(this._canvas);
    if (!this._surface) {
      this._surface = this._ck.MakeSWCanvasSurface(this._canvas);
    }
    if (this._surface) {
      this._skCanvas = this._surface.getCanvas();
    }
  }

  // ── 渲染帧 ────────────────────────────────────────────

  /**
   * 渲染一帧。
   * @param {ArrayBuffer} frameData - 二进制帧
   * @returns {{ rendered: boolean, reason?: string }}
   */
  render(frameData) {
    if (!this._skCanvas) {
      // v1.10: SkCanvas 失败计入 rejection，触发 request_keyframe
      this._rejectionCount++;
      if (this._rejectionCount >= this._maxRejections && this._onRequestKeyframe) {
        this._onRequestKeyframe();
        this._rejectionCount = 0;
      }
      return { rendered: false, reason: 'No SkCanvas' };
    }

    try {
      // Step 1: 解码
      const decoded = this._decoder.decode(frameData);

      // Step 2: CRC32 完整性校验 (v1.7)
      if (!FrameDecoder.verifyCRC32(
        frameData instanceof Uint8Array ? frameData : new Uint8Array(frameData)
      )) {
        console.warn('[wison] Frame CRC32 mismatch');
        this._rejectionCount++;  // v1.14: CRC32 失败计入 rejection
        if (this._rejectionCount >= this._maxRejections && this._onRequestKeyframe) {
          this._onRequestKeyframe();
          this._rejectionCount = 0;
        }
        return { rendered: false, reason: 'CRC32 mismatch' };
      }

      // Step 3: 校验 (安全边界)
      // 从帧中提取命令流部分（使用 decoder 提供的精确偏移）
      const cmdView = new Uint8Array(
        frameData,
        decoded.commandOffset,
        frameData.byteLength - decoded.commandOffset - 4 // 减去 CRC32
      );
      const result = this._validator.scan(cmdView);

      if (!result.valid) {
        this._rejectionCount++;
        console.warn(`[wison] Frame rejected: ${result.reason} (${this._rejectionCount}/${this._maxRejections})`);

        if (this._rejectionCount >= this._maxRejections && this._onRequestKeyframe) {
          this._onRequestKeyframe();
          this._rejectionCount = 0;
        }
        return { rendered: false, reason: result.reason };
      }

      this._rejectionCount = 0;

      // Step 3: 渲染瓦片 (先渲染瓦片作为背景)
      this._renderTiles(decoded);

      // Step 4: 分发命令
      this._dispatchCommands(decoded);

      // Step 5: 提交
      this._surface.flush();

      this._currentFrameId = decoded.frameId;
      this._frameCount++;

      return { rendered: true, meta: decoded };
    } catch (err) {
      console.error('[wison] Render error:', err.message);
      this._rejectionCount++;  // v1.14: decode 异常计入 rejection
      if (this._rejectionCount >= this._maxRejections && this._onRequestKeyframe) {
        this._onRequestKeyframe();
        this._rejectionCount = 0;
      }
      return { rendered: false, reason: err.message };
    }
  }

  // ── 瓦片渲染 (v2.1: 滚动优化) ─────────────────────────

  _renderTiles(decoded) {
    const { tiles, tileCount, scrollX, scrollY } = decoded;

    if (tileCount === 0) return;

    // Keyframe: 单瓦片全画布
    if (tileCount === 1 && tiles[0].w === decoded.viewportW) {
      this._scrollX = scrollX;
      this._scrollY = scrollY;
      this._drawKeyframe(decoded);
      return;
    }

    // 计算滚动增量
    const dx = scrollX - this._scrollX;
    const dy = scrollY - this._scrollY;

    // v2.1: 滚动优化——平移整个画布内容，再覆盖新边缘瓦片
    if (Math.abs(dx) >= this._scrollOptimizeThreshold ||
        Math.abs(dy) >= this._scrollOptimizeThreshold) {
      this._renderScrollOptimized(decoded, dx, dy);
    } else {
      // 微小增量或首次帧：直接逐瓦片渲染
      this._renderDirect(decoded);
    }

    this._scrollX = scrollX;
    this._scrollY = scrollY;
  }

  /**
   * v2.1: 滚动优化渲染
   *
   * 原理: 快照当前画布 → 平移快照到新位置 → 在新暴露区域绘制增量瓦片
   * 开销: WebGL makeImageSnapshot ~1-3ms, 软件 ~0.1ms
   * 降级: 快照失败 → 回退到 _renderDirect
   */
  _renderScrollOptimized(decoded, dx, dy) {
    const { tiles, tileCount } = decoded;
    const c = this._skCanvas;
    const ck = this._ck;

    // Step 1: 快照当前画布
    const snapshot = this._surface.makeImageSnapshot();
    if (!snapshot) {
      this._renderDirect(decoded);
      return;
    }

    // Step 2: 清空画布
    c.clear(ck.TRANSPARENT);

    // Step 3: 平移快照 (注意: 平移方向与服务端滚动方向相反)
    // 服务端 scrollY += 16 → 内容上移 → 客户端 translate(0, -16)
    c.save();
    c.translate(-dx, -dy);
    c.drawImage(snapshot, 0, 0);
    c.restore();

    // Step 4: 在新暴露区域叠加新瓦片
    for (const tile of tiles) {
      const raw = new Uint8Array(decoded.data, tile.dataOffset, tile.dataLen);
      const img = ck.MakeImageFromEncoded(raw);
      if (img) {
        c.drawImage(img, tile.x, tile.y);
        img.delete();
      }
    }

    // Step 5: 释放快照
    snapshot.delete();
  }

  /**
   * v2.1: 直接渲染 (无滚动或微小滚动)
   */
  _renderDirect(decoded) {
    const { tiles, tileCount } = decoded;
    const c = this._skCanvas;
    const ck = this._ck;

    for (const tile of tiles) {
      const raw = new Uint8Array(decoded.data, tile.dataOffset, tile.dataLen);
      const img = ck.MakeImageFromEncoded(raw);
      if (img) {
        c.drawImage(img, tile.x, tile.y);
        img.delete();
      }
    }
  }

  /**
   * v2.1: 关键帧渲染 (清空画布 + 全幅绘制)
   */
  _drawKeyframe(decoded) {
    const { tiles } = decoded;
    const c = this._skCanvas;
    const ck = this._ck;

    const raw = new Uint8Array(decoded.data, tiles[0].dataOffset, tiles[0].dataLen);
    const img = ck.MakeImageFromEncoded(raw);
    if (img) {
      c.clear(ck.TRANSPARENT);
      c.drawImage(img, 0, 0);
      img.delete();
    }
  }

  // ── 命令分发 ──────────────────────────────────────────

  _dispatchCommands(decoded) {
    for (let i = 0; i < decoded.commands.length; i++) {
      const cmd = decoded.commands[i];
      const payload = this._decoder.extractCommandPayload(decoded, i);
      this._dispatch(cmd.opcode, payload);
    }
  }

  _dispatch(opcode, payload) {
    const ck = this._ck;
    const c = this._skCanvas;
    const d = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let p, off, verbCount, ptCount, verbs, pts, path, count, i;

    switch (opcode) {
      // ── State (0x01-0x0F) ──
      case 0x01: c.save(); break;
      case 0x02: c.restore(); break;
      case 0x03: // saveLayer(bounds, paint, flags)
        p = new ck.Paint();
        const b = [d.getFloat32(0,true), d.getFloat32(4,true), d.getFloat32(8,true), d.getFloat32(12,true)];
        const f = d.getUint32(16, true);
        c.saveLayer(p, b, null, f);
        p.delete(); break;

      // ── Transform (0x10-0x1F) ──
      case 0x10: c.concat(new Float32Array(payload.buffer, payload.byteOffset, 9)); break;
      case 0x11: c.translate(d.getFloat32(0,true), d.getFloat32(4,true)); break;
      case 0x12: c.scale(d.getFloat32(0,true), d.getFloat32(4,true)); break;
      case 0x13: c.rotate(d.getFloat32(0,true)); break;

      // ── Clip (0x20-0x2F) ──
      case 0x20: // clipRect(rect, op, aa)
        c.clipRect([d.getFloat32(0,true), d.getFloat32(4,true), d.getFloat32(8,true), d.getFloat32(12,true)], d.getUint8(16), !!d.getUint8(17)); break;
      case 0x21: // clipRRect(rrect, op, aa) — simplified as rect clip
        c.clipRect([d.getFloat32(0,true), d.getFloat32(4,true), d.getFloat32(8,true), d.getFloat32(12,true)], d.getUint8(16), !!d.getUint8(17)); break;
      case 0x22: // clipPath(path, op, aa)
        verbCount = d.getUint32(0, true);
        verbs = new Uint8Array(payload.buffer, payload.byteOffset + 4, verbCount);
        ptCount = d.getUint32(4 + verbCount, true);
        pts = new Float32Array(payload.buffer, payload.byteOffset + 8 + verbCount, ptCount * 2);
        path = ck.Path.MakeFromVerbsPointsWeights(verbs, pts, null);
        off = 8 + verbCount + ptCount * 8;
        c.clipPath(path, d.getUint8(off), !!d.getUint8(off + 1));
        path.delete(); break;

      // ── Shapes (0x30-0x3F) ──
      case 0x30: // drawRect
        p = new ck.Paint(); this._readPaintColor(p, d, 16);
        c.drawRect([d.getFloat32(0,true), d.getFloat32(4,true), d.getFloat32(8,true), d.getFloat32(12,true)], p);
        p.delete(); break;
      case 0x31: // drawRRect — fallback to drawRect
        p = new ck.Paint(); this._readPaintColor(p, d, 20);
        c.drawRect([d.getFloat32(0,true), d.getFloat32(4,true), d.getFloat32(8,true), d.getFloat32(12,true)], p);
        p.delete(); break;
      case 0x32: // drawOval
        p = new ck.Paint(); this._readPaintColor(p, d, 16);
        c.drawOval([d.getFloat32(0,true), d.getFloat32(4,true), d.getFloat32(8,true), d.getFloat32(12,true)], p);
        p.delete(); break;
      case 0x33: // drawArc(oval, startAngle, sweepAngle, useCenter, paint)
        p = new ck.Paint(); this._readPaintColor(p, d, 25);
        c.drawArc([d.getFloat32(0,true), d.getFloat32(4,true), d.getFloat32(8,true), d.getFloat32(12,true)], d.getFloat32(16,true), d.getFloat32(20,true), !!d.getUint8(24), p);
        p.delete(); break;
      case 0x34: // drawPath
        verbCount = d.getUint32(0, true);
        verbs = new Uint8Array(payload.buffer, payload.byteOffset + 4, verbCount);
        ptCount = d.getUint32(4 + verbCount, true);
        pts = new Float32Array(payload.buffer, payload.byteOffset + 8 + verbCount, ptCount * 2);
        path = ck.Path.MakeFromVerbsPointsWeights(verbs, pts, null);
        p = new ck.Paint(); this._readPaintColor(p, d, 8 + verbCount + ptCount * 8);
        c.drawPath(path, p);
        path.delete(); p.delete(); break;
      case 0x35: // drawPoints(mode, count, pts, paint) — simplified: skip for now
        break;
      case 0x36: // drawShadow(path, zParams, lightPos, radius, ambient, spot, flags)
        verbCount = d.getUint32(0, true);
        verbs = new Uint8Array(payload.buffer, payload.byteOffset + 4, verbCount);
        ptCount = d.getUint32(4 + verbCount, true);
        pts = new Float32Array(payload.buffer, payload.byteOffset + 8 + verbCount, ptCount * 2);
        path = ck.Path.MakeFromVerbsPointsWeights(verbs, pts, null);
        off = 8 + verbCount + ptCount * 8;
        c.drawShadow(path, [d.getFloat32(off,true), d.getFloat32(off+4,true), d.getFloat32(off+8,true)], [d.getFloat32(off+12,true), d.getFloat32(off+16,true), d.getFloat32(off+20,true)], d.getFloat32(off+24,true), d.getUint32(off+28,true), d.getUint32(off+32,true), d.getUint32(off+36,true));
        path.delete(); break;

      // ── Images (0x40-0x4F) ──
      case 0x40: // drawImage(img, x, y, sampling, paint)
        { const imgX = d.getFloat32(0,true), imgY = d.getFloat32(4,true);
          const imgData = this._readImageData(payload, 8);
          if (imgData) { p = new ck.Paint(); this._readPaintColor(p, d, 8 + imgData.bytesRead); c.drawImageOptions(imgData.img, imgX, imgY, ck.FilterMode.Linear, ck.MipmapMode.Linear, p); p.delete(); imgData.img.delete(); } }
        break;
      case 0x41: // drawImageRect(src, dst, sampling, constraint, img, paint)
        { const imgData = this._readImageData(payload, 33);
          if (imgData) { p = new ck.Paint(); this._readPaintColor(p, d, 33 + imgData.bytesRead); c.drawImageRectOptions(imgData.img, [d.getFloat32(0,true), d.getFloat32(4,true), d.getFloat32(8,true), d.getFloat32(12,true)], [d.getFloat32(16,true), d.getFloat32(20,true), d.getFloat32(24,true), d.getFloat32(28,true)], ck.FilterMode.Linear, ck.MipmapMode.Linear, p); p.delete(); imgData.img.delete(); } }
        break;
      case 0x42: // drawAtlas — simplified: skip complex atlas for now
        break;

      // ── Text (0x50-0x5F) ──
      case 0x50: // drawTextBlob — simplified: draw placeholder rect
        p = new ck.Paint(); p.setColor([0, 0, 0, 1]);
        c.drawRect([d.getFloat32(0,true), d.getFloat32(4,true) - 12, d.getFloat32(0,true) + 100, d.getFloat32(4,true) + 4], p);
        p.delete(); break;
      case 0x51: // glyphRunList — same simplified placeholder
        p = new ck.Paint(); p.setColor([0, 0, 0, 1]);
        c.drawRect([0, 0, 100, 16], p);
        p.delete(); break;

      // ── Paint (0x60-0x6F) ──
      case 0x60: // drawPaint
        p = new ck.Paint(); this._readPaintColor(p, d, 0); c.drawPaint(p); p.delete(); break;
      case 0x61: // drawColor(r,g,b,a, mode)
        c.drawColor([d.getUint8(0)/255, d.getUint8(1)/255, d.getUint8(2)/255, d.getUint8(3)/255], d.getUint8(4)); break;

      // ── Placeholder ──
      case 0x7F: break; // SkDrawable placeholder — intentionally skipped

      default: console.debug(`[wison] Unknown opcode: 0x${opcode.toString(16)}`);
    }
  }

  // ── Helpers ──

  _readPaintColor(paint, dv, offset) {
    paint.setColor([dv.getUint8(offset)/255, dv.getUint8(offset+1)/255, dv.getUint8(offset+2)/255, dv.getUint8(offset+3)/255]);
  }

  _readImageData(payload, offset) {
    const d = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset);
    const flag = d.getUint8(0);
    if (flag === 0x00) { // inline
      const size = d.getUint32(1, true);
      const bytes = new Uint8Array(payload.buffer, payload.byteOffset + offset + 5, size);
      const img = this._ck.MakeImageFromEncoded(bytes);
      return img ? { img, bytesRead: 5 + size } : null;
    }
    return null; // hash-ref not implemented in phase 1
  }

  /** 请求服务端发送全量 Keyframe。 */
  requestKeyframe() {
    if (this._onRequestKeyframe) this._onRequestKeyframe();
  }

  get currentFrameId() { return this._currentFrameId; }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Renderer };
}
