/**
 * @wison/client/connection — WebSocket 连接管理
 *
 * 自动重连 (指数退避)、心跳、背压检测。
 */

'use strict';

class Connection {
  /**
   * @param {string} url - WebSocket URL (ws:// 或 wss://)
   * @param {object} options
   * @param {string} options.authToken - 认证令牌
   * @param {number} options.reconnectBaseMs - 重连基础间隔 (默认 1000)
   * @param {number} options.reconnectMaxMs - 最大重连间隔 (默认 30000)
   * @param {number} options.reconnectMaxAttempts - 最大重连次数 (默认 5)
   */
  constructor(url, options = {}) {
    this._url = url;
    this._authToken = options.authToken || null;
    this._reconnectBaseMs = options.reconnectBaseMs || 1000;
    this._reconnectMaxMs = options.reconnectMaxMs || 30000;
    this._reconnectMaxAttempts = options.reconnectMaxAttempts || 5;

    this._ws = null;
    this._connected = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._intentionalClose = false;

    this._onFrameCb = null;
    this._onStatusCb = null;
    this._onDisconnectCb = null;
    this._onReconnectCb = null;
  }

  // ── 事件注册 ──────────────────────────────────────────

  onFrame(cb) { this._onFrameCb = cb; }
  onStatus(cb) { this._onStatusCb = cb; }
  onDisconnect(cb) { this._onDisconnectCb = cb; }
  onReconnect(cb) { this._onReconnectCb = cb; }

  // ── 连接 ──────────────────────────────────────────────

  connect() {
    this._intentionalClose = false;

    const wsUrl = this._authToken
      ? this._url // 浏览器 WebSocket 不支持自定义头，token 通过首个消息发送
      : this._url;

    this._ws = new WebSocket(wsUrl);
    this._ws.binaryType = 'arraybuffer';

    this._ws.onopen = () => {
      this._connected = true;
      this._reconnectAttempt = 0;
      this._log('connected');

      // 认证（通过首个消息）
      if (this._authToken) {
        this._ws.send(JSON.stringify({ type: 'auth', token: this._authToken }));
      }

      if (this._onReconnectCb) this._onReconnectCb();
    };

    this._ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        if (this._onFrameCb) this._onFrameCb(event.data);
      } else {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'status' && this._onStatusCb) {
            this._onStatusCb(msg);
          }
        } catch (_) { /* ignore */ }
      }
    };

    this._ws.onclose = () => {
      this._connected = false;
      if (!this._intentionalClose) {
        this._log('disconnected, will reconnect');
        if (this._onDisconnectCb) this._onDisconnectCb();
        this._scheduleReconnect();
      }
    };

    this._ws.onerror = () => {
      // onclose 会紧随其后触发
    };
  }

  // ── 发送 ──────────────────────────────────────────────

  /** 发送 HID 事件 (二进制)。 */
  sendHID(buffer) {
    if (!this._connected || !this._ws) return;
    // 背压检查
    if (this._ws.bufferedAmount > 512 * 1024) {
      this._log('backpressure, dropping HID event');
      return;
    }
    this._ws.send(buffer);
    this._keepAlive();
  }

  /** 发送控制消息。 */
  sendControl(msg) {
    if (!this._connected || !this._ws) return;
    this._ws.send(JSON.stringify(msg));
    this._keepAlive();
  }

  /** 发送心跳请求。 */
  sendPing() {
    this.sendControl({ type: 'ping' });
  }

  // ── 关闭 ──────────────────────────────────────────────

  close() {
    this._intentionalClose = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close(1000, 'Client closing');
      this._ws = null;
    }
    this._connected = false;
  }

  get isConnected() { return this._connected; }

  // ── 内部 ──────────────────────────────────────────────

  _scheduleReconnect() {
    if (this._reconnectAttempt >= this._reconnectMaxAttempts) {
      this._log('max reconnect attempts reached');
      return;
    }

    const delay = Math.min(
      this._reconnectBaseMs * Math.pow(2, this._reconnectAttempt),
      this._reconnectMaxMs
    );
    this._reconnectAttempt++;

    this._log(`reconnecting in ${delay}ms (attempt ${this._reconnectAttempt})`);
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  _keepAlive() {
    // reset any idle timer if needed
  }

  _log(msg) {
    if (typeof console !== 'undefined') {
      console.debug(`[wison:connection] ${msg}`);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Connection };
}
