/**
 * @wison/server/session — 会话生命周期管理
 *
 * 每个 WebSocket 连接对应一个 Session。
 * Session 管理一个 Chromium 实例的完整生命周期：
 *   创建 → 导航 → 帧捕获 → 输入注入 → 销毁
 *
 * v1.6: Chromium 按需启动（首次 navigate 时）。
 *       连续 10 帧捕获失败 → 自动重启 Chromium。
 */

'use strict';

const { FrameEncoder } = require('../../protocol/src/encoder');
const { CdpClient } = require('./cdp-client');
const { FrameCapture } = require('./frame-capture');
const { InputProxy } = require('./input-proxy');
const config = require('./config');

class Session {
  /**
   * @param {string} sessionId - 唯一会话 ID
   * @param {Function} onFrame - 帧回调 (sessionId, arrayBuffer) => void
   * @param {Function} onStatus - 状态回调 (sessionId, statusMsg) => void
   * @param {object} logger
   */
  constructor(sessionId, onFrame, onStatus, logger) {
    this.id = sessionId;
    this._onFrame = onFrame;
    this._onStatus = onStatus;
    this._log = logger.child({ sessionId });

    this._started = false;
    this._running = false;
    this._currentUrl = 'about:blank';
    this._viewport = { ...config.defaultViewport };

    // 子组件 (延迟初始化)
    this._browser = null;
    this._page = null;
    this._cdp = null;
    this._capture = null;
    this._input = null;
    this._encoder = null;

    // 帧循环
    this._frameLoop = null;
    this._frameSeq = 0;
    this._capturing = false;  // v1.7: 帧循环互斥锁

    // 统计
    this._createdAt = Date.now();
    this._framesSent = 0;
    this._bytesSent = 0;
    this._lastActivity = Date.now();
  }

  // ── 生命周期 ─────────────────────────────────────────

  /**
   * 启动 Chromium 并导航到目标 URL。
   * v1.6: 仅首次 navigate 时调用。
   */
  async start(targetUrl) {
    if (this._started) {
      await this.navigate(targetUrl);
      return;
    }

    this._started = true;
    this._log.info({ url: targetUrl }, 'Session starting');

    try {
      const { chromium } = require('playwright');
      const playwright = await chromium.launch({
        headless: true,
        args: config.chromiumArgs,
        executablePath: config.chromiumPath,
      });

      this._browser = playwright;
      const context = await playwright.newContext({
        viewport: this._viewport,
        deviceScaleFactor: 1,
      });
      this._page = await context.newPage();

      // 监听崩溃
      this._page.on('crash', () => this._onChromiumCrash());

      // CDP 连接
      this._cdp = new CdpClient(playwright, this._log);
      await this._cdp.connect(this._page);

      // 帧捕获
      this._capture = new FrameCapture(
        this._page, this._viewport,
        config.tileSize, config.keyframeInterval,
        this._log
      );

      // 输入代理
      this._input = new InputProxy(this._cdp, this._log);

      // 帧编码器
      this._encoder = new FrameEncoder();

      // 导航
      await this.navigate(targetUrl);

      // 启动帧循环
      this._running = true;
      this._frameLoop = this._runFrameLoop();

      this._notifyStatus({ url: targetUrl, loading: false, title: '' });
      this._log.info({ url: targetUrl }, 'Session started');
    } catch (err) {
      this._log.error({ err }, 'Session start failed');
      this._started = false;
      throw err;
    }
  }

  /** 导航到新 URL。 */
  async navigate(url) {
    if (!this._page) return;
    this._currentUrl = url;
    this._lastActivity = Date.now();

    try {
      await this._page.goto(url, { wait_until: 'domcontentloaded', timeout: 30000 });
      if (this._capture) this._capture.markNavigation();
      this._frameSeq = 0;
      this._notifyStatus({ url, loading: false, title: await this._page.title() });
    } catch (err) {
      if (err.message?.includes('Timeout')) {
        this._notifyStatus({ url, loading: false, title: '', error: 'PAGE_TIMEOUT' });
      } else {
        this._notifyStatus({ url, loading: false, title: '', error: 'NAVIGATION_FAILED' });
      }
      this._log.warn({ err: err.message, url }, 'Navigation failed');
    }
  }

  /** 调整视口。 */
  async resize(width, height) {
    this._viewport = { width, height };
    if (this._cdp) await this._cdp.setViewport(width, height);
    if (this._capture) this._capture.updateViewport(width, height);
  }

  /** 注入 HID 事件。 */
  async injectHID(data) {
    if (!this._input) return;
    this._lastActivity = Date.now();
    await this._input.inject(data);
  }

  /** 注入文本。 */
  async injectText(text) {
    if (!this._input) return;
    this._lastActivity = Date.now();
    await this._input.injectText(text);
  }

  /** 优雅销毁。 */
  async destroy() {
    this._running = false;
    if (this._frameLoop) clearInterval(this._frameLoop);
    if (this._cdp) await this._cdp.disconnect().catch(() => {});
    if (this._browser) await this._browser.close().catch(() => {});
    this._log.info({ duration: Date.now() - this._createdAt, frames: this._framesSent }, 'Session destroyed');
  }

  /** 检查是否空闲超时。 */
  isIdle() {
    return Date.now() - this._lastActivity > config.sessionIdleTimeoutMs;
  }

  /** v1.7: 强制下一帧为 Keyframe（客户端 request_keyframe） */
  forceKeyframe() {
    if (this._capture) this._capture.forceKeyframe();
  }

  // ── 帧循环 ───────────────────────────────────────────

  async _runFrameLoop() {
    const tick = () => {
      if (!this._running) return;
      this._captureFrame().catch(err => {
        this._log.warn({ err: err.message }, 'Frame capture error');
        if (this._capture && this._capture.markFailure()) {
          this._log.error('Too many consecutive capture failures, restarting Chromium');
          this._restartChromium().catch(() => {});
        }
      });
    };
    return setInterval(tick, config.frameTickMs);
  }

  async _captureFrame() {
    if (!this._running) return;  // v1.7: destroy 竞态保护
    if (this._capturing) return; // v1.7: 防止帧循环重叠
    if (!this._capture || !this._encoder) return;

    this._capturing = true;
    try {

    const result = await this._capture.capture();
    if (!result) return; // 无变化

    this._frameSeq++;

    // 获取滚动偏移
    let scroll = { x: 0, y: 0 };
    try {
      if (this._cdp) scroll = await this._cdp.getScrollOffset();
    } catch (_) { /* 使用默认值 */ }

    this._encoder.setMetadata({
      frameId: this._frameSeq,
      timestamp: Date.now(),
      scrollX: scroll.x,
      scrollY: scroll.y,
      viewportW: this._viewport.width,
      viewportH: this._viewport.height,
      canvasW: this._viewport.width,
      canvasH: this._viewport.height,
    });

    for (const t of result.tiles) {
      this._encoder.addTile(t.x, t.y, t.w, t.h, t.encoding, t.data);
    }

    const frame = this._encoder.finalize(result.frameType);
    this._encoder.reset();

    this._onFrame(this.id, frame);
    this._framesSent++;
    this._bytesSent += frame.byteLength;
    } finally {
      this._capturing = false;  // v1.7: 释放互斥锁
    }
  }

  // ── 内部 ─────────────────────────────────────────────

  async _onChromiumCrash() {
    this._log.error('Chromium crash detected');
    this._notifyStatus({ error: 'CHROMIUM_CRASH' });
    await this._restartChromium();
  }

  async _restartChromium() {
    this._log.info('Restarting Chromium...');
    try {
      await this._cdp?.disconnect().catch(() => {});
      await this._browser?.close().catch(() => {});

      const { chromium } = require('playwright');
      this._browser = await chromium.launch({
        headless: true,
        args: config.chromiumArgs,
        executablePath: config.chromiumPath,
      });

      const context = await this._browser.newContext({
        viewport: this._viewport,
        deviceScaleFactor: 1,
      });
      this._page = await context.newPage();
      this._page.on('crash', () => this._onChromiumCrash());

      this._cdp = new CdpClient(this._browser, this._log);
      await this._cdp.connect(this._page);

      this._capture = new FrameCapture(
        this._page, this._viewport,
        config.tileSize, config.keyframeInterval,
        this._log
      );

      this._input = new InputProxy(this._cdp, this._log);

      await this.navigate(this._currentUrl);
      this._notifyStatus({ url: this._currentUrl, loading: false });
      this._log.info('Chromium restarted');
    } catch (err) {
      this._log.error({ err }, 'Failed to restart Chromium');
    }
  }

  _notifyStatus(msg) {
    this._onStatus(this.id, { type: 'status', ...msg });
  }
}

module.exports = { Session };
