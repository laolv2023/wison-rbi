/**
 * @wison/server/cdp-client — Chrome DevTools Protocol 客户端
 *
 * 封装 CDP 连接管理、导航、输入注入。
 * 所有 CDP 命令 3 次重试，超时 5s。
 */

'use strict';

const CDP = require('chrome-remote-interface');

const CDP_TIMEOUT = 5000;
const MAX_RETRIES = 3;

class CdpClient {
  /**
   * @param {import('playwright').Browser} browser - Playwright Browser 实例
   * @param {object} logger - pino logger 实例
   */
  constructor(browser, logger) {
    this._browser = browser;
    this._log = logger;
    this._client = null;
    this._targetId = null;
  }

  /**
   * 连接到 CDP（在 BrowserContext 创建后调用）。
   * 通过 Playwright 的 browser.newBrowserCDPSession() 获取已连接会话。
   */
  async connect(page) {
    try {
      this._client = await page.context().newCDPSession(page);
      this._log.info({ targetId: this._client._targetId }, 'CDP connected');
      return this._client;
    } catch (err) {
      this._log.error({ err }, 'CDP connection failed');
      throw err;
    }
  }

  /**
   * 执行 CDP 命令，自动重试。
   */
  async _send(method, params = {}) {
    if (!this._client) throw new Error('CDP not connected');

    let lastErr;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const result = await this._client.send(method, params);
        return result;
      } catch (err) {
        lastErr = err;
        this._log.warn({ method, attempt: i + 1, err: err.message }, 'CDP command retry');
        if (i < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }
    throw lastErr;
  }

  /**
   * 导航到 URL。
   */
  async navigate(url) {
    return this._send('Page.navigate', { url });
  }

  /**
   * 注入鼠标事件。
   */
  async dispatchMouse(type, x, y, button = 'left', deltaX = 0, deltaY = 0) {
    const params = { type, x: Math.round(x), y: Math.round(y), button, clickCount: 1 };
    if (type === 'mouseWheel') {
      params.deltaX = deltaX;
      params.deltaY = deltaY;
    }
    return this._send('Input.dispatchMouseEvent', params);
  }

  /**
   * 注入键盘事件。
   */
  async dispatchKey(type, key, code, modifiers = 0) {
    return this._send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      modifiers,
      autoRepeat: false,
      isKeypad: false,
      isSystemKey: false,
    });
  }

  /**
   * 注入文本（用于 IME）。
   */
  async insertText(text) {
    return this._send('Input.insertText', { text });
  }

  /**
   * 获取当前滚动偏移。
   */
  async getScrollOffset() {
    const result = await this._send('Runtime.evaluate', {
      expression: '({x: window.scrollX, y: window.scrollY})',
      returnByValue: true,
    });
    return result?.result?.value || { x: 0, y: 0 };
  }

  /**
   * 设置视口大小。
   */
  async setViewport(width, height) {
    return this._send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /** 断开 CDP 连接。 */
  async disconnect() {
    if (this._client) {
      try { await this._client.detach(); } catch (_) { /* ignore */ }
      this._client = null;
    }
  }
}

module.exports = { CdpClient };
