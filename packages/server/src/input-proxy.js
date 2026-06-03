/**
 * @wison/server/input-proxy — HID 事件 → CDP 输入注入
 *
 * v1.6: 限流 125Hz（正常）+ 250Hz burst。
 * 超出限制的事件被静默丢弃（保护 Chromium 不被输入洪水压垮）。
 */

'use strict';

const { HIDType, Limits } = require('../../protocol/src/constants');

class InputProxy {
  /**
   * @param {import('./cdp-client').CdpClient} cdp
   * @param {object} logger
   */
  constructor(cdp, logger) {
    this._cdp = cdp;
    this._log = logger;

    // 令牌桶限流器
    this._tokens = Limits.HID_BURST_LIMIT;
    this._maxTokens = Limits.HID_BURST_LIMIT;
    this._refillRate = Limits.HID_RATE_LIMIT_HZ; // tokens/s
    this._lastRefill = Date.now();
  }

  /**
   * 注入 HID 事件。超出限流则静默丢弃。
   * @param {ArrayBuffer} data - 二进制 HID 事件
   */
  async inject(data) {
    if (!this._consumeToken()) return; // 限流丢弃

    const view = new DataView(data);
    const type = view.getUint8(0);
    const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 1)));
    // v1.7: 运行时字段校验
    if (!payload || typeof payload !== 'object') return;

    try {
      switch (type) {
        case HIDType.MOUSE_MOVE:
          await this._cdp.dispatchMouse('mouseMoved', payload.x, payload.y);
          break;
        case HIDType.MOUSE_DOWN:
          await this._cdp.dispatchMouse('mousePressed', payload.x, payload.y, payload.button || 'left');
          break;
        case HIDType.MOUSE_UP:
          await this._cdp.dispatchMouse('mouseReleased', payload.x, payload.y, payload.button || 'left');
          break;
        case HIDType.MOUSE_WHEEL:
          await this._cdp.dispatchMouse('mouseWheel', payload.x || 0, payload.y || 0, 'left', payload.deltaX || 0, payload.deltaY || 0);
          break;
        case HIDType.KEY_DOWN:
          await this._cdp.dispatchKey('keyDown', payload.key, payload.code);
          break;
        case HIDType.KEY_UP:
          await this._cdp.dispatchKey('keyUp', payload.key, payload.code);
          break;
        case HIDType.TOUCH_START:
        case HIDType.TOUCH_MOVE:
        case HIDType.TOUCH_END:
          // Touch: 模拟为 mouse 事件（Phase 1 简化实现）
          await this._cdp.dispatchMouse(
            type === HIDType.TOUCH_START ? 'mousePressed' :
            type === HIDType.TOUCH_MOVE ? 'mouseMoved' : 'mouseReleased',
            payload.x, payload.y
          );
          break;
        default:
          this._log.warn({ type }, 'Unknown HID event type');
      }
    } catch (err) {
      this._log.warn({ err: err.message, type }, 'HID injection failed');
    }
  }

  /**
   * 注入文本（IME 输入）。
   */
  async injectText(text) {
    if (!this._consumeToken()) return;
    try {
      await this._cdp.insertText(text);
    } catch (err) {
      this._log.warn({ err: err.message }, 'Text injection failed');
    }
  }

  /** 令牌桶：消耗一个令牌。返回 true 表示允许通过。 */
  _consumeToken() {
    const now = Date.now();
    const elapsed = Math.max(0, (now - this._lastRefill) / 1000);  // v1.10: 防系统时钟后退
    this._tokens = Math.min(this._maxTokens, this._tokens + elapsed * this._refillRate);
    this._lastRefill = now;

    if (this._tokens >= 1) {
      this._tokens -= 1;
      return true;
    }
    this._log.trace('HID rate limit exceeded');
    return false;
  }
}

module.exports = { InputProxy };
