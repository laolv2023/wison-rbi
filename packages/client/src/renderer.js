/**
 * @wison/client/renderer — CanvasKit 命令分发渲染器
 *
 * 解码帧 → 分发绘制命令 → CanvasKit 渲染。
 * v1.6: 连续 3 帧验证失败 → request_keyframe。
 */

'use strict';

class Renderer {
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
    if (!this._skCanvas) return { rendered: false, reason: 'No SkCanvas' };

    try {
      // Step 1: 解码
      const decoded = this._decoder.decode(frameData);

      // Step 2: 校验 (安全边界)
      // 从帧中提取命令流部分进行校验
      const cmdView = new Uint8Array(frameData, 30 + 2 + decoded.tileCount * 14);
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
      return { rendered: false, reason: err.message };
    }
  }

  // ── 瓦片渲染 ──────────────────────────────────────────

  _renderTiles(decoded) {
    const { tiles, tileCount } = decoded;
    if (tileCount === 0) return;

    // Keyframe: 单瓦片全画布
    if (tileCount === 1 && tiles[0].w === decoded.viewportW) {
      const raw = new Uint8Array(decoded.data, tiles[0].dataOffset, tiles[0].dataLen);
      const img = this._ck.MakeImageFromEncoded(raw);
      if (img) {
        this._skCanvas.drawImage(img, 0, 0);
        img.delete();
      }
      return;
    }

    // Diff: 逐瓦片绘制
    for (const tile of tiles) {
      const raw = new Uint8Array(decoded.data, tile.dataOffset, tile.dataLen);
      const img = this._ck.MakeImageFromEncoded(raw);
      if (img) {
        this._skCanvas.drawImage(img, tile.x, tile.y);
        img.delete();
      }
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
    const canvas = this._skCanvas;
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

    switch (opcode) {
      case 0x01: canvas.save(); break;
      case 0x02: canvas.restore(); break;
      case 0x03: canvas.saveLayer(null, null); break; // simplified

      case 0x10: { // concat
        const m = new Float32Array(payload.buffer, payload.byteOffset, 9);
        canvas.concat(m); break;
      }
      case 0x11: canvas.translate(dv.getFloat32(0, true), dv.getFloat32(4, true)); break;
      case 0x12: canvas.scale(dv.getFloat32(0, true), dv.getFloat32(4, true)); break;
      case 0x13: canvas.rotate(dv.getFloat32(0, true)); break;

      case 0x30: { // drawRect
        const p = new ck.Paint();
        p.setColor([dv.getUint8(16)/255, dv.getUint8(17)/255, dv.getUint8(18)/255, dv.getUint8(19)/255]);
        canvas.drawRect([dv.getFloat32(0, true), dv.getFloat32(4, true), dv.getFloat32(8, true), dv.getFloat32(12, true)], p);
        p.delete(); break;
      }

      case 0x34: { // drawPath
        const verbCount = dv.getUint32(0, true);
        const verbs = new Uint8Array(payload.buffer, payload.byteOffset + 4, verbCount);
        const ptCount = dv.getUint32(4 + verbCount, true);
        const pts = new Float32Array(payload.buffer, payload.byteOffset + 8 + verbCount, ptCount * 2);
        const path = ck.Path.MakeFromVerbsPointsWeights(verbs, pts, null);
        const p = new ck.Paint();
        const po = 8 + verbCount + ptCount * 8;
        p.setColor([dv.getUint8(po)/255, dv.getUint8(po+1)/255, dv.getUint8(po+2)/255, dv.getUint8(po+3)/255]);
        canvas.drawPath(path, p);
        path.delete(); p.delete(); break;
      }

      // 其他 opcode 的 CanvasKit 映射在此处扩展
      // (drawImage, drawTextBlob, drawShadow 等)
      default:
        console.debug(`[wison] Unimplemented opcode: 0x${opcode.toString(16)}`);
    }
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
