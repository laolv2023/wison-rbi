/**
 * @wison/client/hid-capture — HID 事件捕获与编码
 *
 * 监听 Canvas 上的鼠标/键盘/滚轮/触摸事件，编码为二进制 HID 消息。
 */

'use strict';

const HID_TYPE = {
  MOUSE_MOVE: 0x10,
  MOUSE_DOWN: 0x11,
  MOUSE_UP: 0x12,
  MOUSE_WHEEL: 0x13,
  KEY_DOWN: 0x14,
  KEY_UP: 0x15,
  TOUCH_START: 0x16,
  TOUCH_MOVE: 0x17,
  TOUCH_END: 0x18,
};

class HIDCapture {
  // ════════════════════════════════════════════════════════════
  // HID 事件捕获 —— 浏览器原生事件 → 二进制 HID 消息
  //
  // 监听事件:
  //   mousemove/mousedown/mouseup/wheel → 鼠标事件 (0x10-0x13)
  //   keydown/keyup → 键盘事件 (0x14-0x15)
  //   touchstart/touchmove/touchend → 触屏事件 (0x16-0x18)
  //   paste → 文本注入 (0x20)
  //
  // 坐标变换:
  //   _canvasToViewport(e) → 浏览器 pageX/Y → 画布内坐标
  //   考虑 devicePixelRatio 和 canvas.clientWidth/clientHeight
  //
  // HID 消息格式: [type:1][JSON_payload:N]
  // payload 包含: {x,y,button,modifiers,frame_id}
  // frame_id 用于服务端关联当前显示帧 (为未来 scroll 补偿保留)
  // ════════════════════════════════════════════════════════════

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} options
   * @param {Function} options.onEvent - (arrayBuffer) => void
   * @param {Function} options.getCurrentFrameId - () => number
   * @param {object} options.viewport - { width, height }
   */
  constructor(canvas, options = {}) {
    this._canvas = canvas;
    this._onEvent = options.onEvent || (() => {});
    this._getCurrentFrameId = options.getCurrentFrameId || (() => 0);
    this._viewport = options.viewport || { width: 1280, height: 720 };

    this._attach();
  }

  _attach() {
    const c = this._canvas;
    c.addEventListener('mousemove', this._onMouse.bind(this));
    c.addEventListener('mousedown', this._onMouse.bind(this));
    c.addEventListener('mouseup', this._onMouse.bind(this));
    c.addEventListener('wheel', this._onWheel.bind(this), { passive: false });
    c.addEventListener('keydown', this._onKey.bind(this));
    c.addEventListener('keyup', this._onKey.bind(this));
    c.addEventListener('touchstart', this._onTouch.bind(this), { passive: false });
    c.addEventListener('touchmove', this._onTouch.bind(this), { passive: false });
    c.addEventListener('touchend', this._onTouch.bind(this), { passive: false });
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.tabIndex = 0;
  }

  /** Canvas 坐标 → Viewport 坐标。 */
  _canvasToViewport(e) {
    const rect = this._canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 }; // v1.7: 防 NaN
    return {
      x: Math.round((e.clientX - rect.left) * (this._viewport.width / rect.width)),
      y: Math.round((e.clientY - rect.top) * (this._viewport.height / rect.height)),
    };
  }

  _encode(type, payload) {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const buf = new Uint8Array(1 + json.length);
    buf[0] = type;
    buf.set(json, 1);
    return buf.buffer;
  }

  _send(type, payload) {
    payload.frame_id = this._getCurrentFrameId();
    if (type >= 0x11 && type <= 0x12) { payload.timestamp = Date.now(); }  // v1.14: 双击检测时间戳
    this._onEvent(this._encode(type, payload));
  }

  _onMouse(e) {
    e.preventDefault();
    if (e.type === 'wheel') return;
    const pos = this._canvasToViewport(e);
    const btn = { 0: 'left', 1: 'middle', 2: 'right' }[e.button] || 'left';
    let type;
    if (e.type === 'mousemove') type = HID_TYPE.MOUSE_MOVE;
    else if (e.type === 'mousedown') type = HID_TYPE.MOUSE_DOWN;
    else type = HID_TYPE.MOUSE_UP;
    this._send(type, { x: pos.x, y: pos.y, button: btn, buttons: e.buttons });
  }

  _onWheel(e) {
    e.preventDefault();
    this._send(HID_TYPE.MOUSE_WHEEL, { x: 0, y: 0, deltaX: e.deltaX, deltaY: e.deltaY });
  }

  _onKey(e) {
    e.preventDefault();
    const type = e.type === 'keydown' ? HID_TYPE.KEY_DOWN : HID_TYPE.KEY_UP;
    this._send(type, { key: e.key, code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey });
  }

  _onTouch(e) {
    e.preventDefault();
    const touch = e.touches[0] || e.changedTouches[0];
    if (!touch) return;
    const pos = this._canvasToViewport(touch);
    let type;
    if (e.type === 'touchstart') type = HID_TYPE.TOUCH_START;
    else if (e.type === 'touchmove') type = HID_TYPE.TOUCH_MOVE;
    else type = HID_TYPE.TOUCH_END;
    this._send(type, { x: pos.x, y: pos.y });
  }

  /** 更新视口尺寸。 */
  updateViewport(viewport) {
    this._viewport = { ...this._viewport, ...viewport };
  }

  /** 销毁事件监听。 */
  detach() {
    // 简化：假设 canvas 被替换
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HIDCapture };
}
