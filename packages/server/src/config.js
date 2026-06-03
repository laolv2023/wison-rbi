/**
 * @wison/server/config — 配置管理 (12-Factor)
 *
 * 所有配置从环境变量读取，有合理默认值。
 */

'use strict';

const config = {
  // ── 网络 ──
  port: parseInt(process.env.WISON_PORT || '8080', 10),
  host: process.env.WISON_HOST || '0.0.0.0',

  // ── 认证 ──
  authToken: process.env.WISON_AUTH_TOKEN || null, // null = 无认证

  // ── Chromium ──
  chromiumPath: process.env.WISON_CHROMIUM_PATH || undefined, // undefined = Playwright 自动查找
  chromiumArgs: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--remote-debugging-address=127.0.0.1', // v1.6: 仅本地 CDP
  ],

  // ── 视口 ──
  defaultViewport: {
    width: parseInt(process.env.WISON_VIEWPORT_W || '1280', 10),
    height: parseInt(process.env.WISON_VIEWPORT_H || '720', 10),
  },

  // ── 帧 ──
  frameTickMs: parseInt(process.env.WISON_FRAME_TICK_MS || '50', 10), // 20fps
  tileSize: 16,
  keyframeInterval: 300, // 每 300 帧强制关键帧

  // ── 会话 ──
  maxSessions: parseInt(process.env.WISON_MAX_SESSIONS || '5', 10),
  sessionIdleTimeoutMs: parseInt(process.env.WISON_SESSION_IDLE_MS || '300000', 10),

  // ── WebSocket ──
  wsMaxPayload: 4 * 1024 * 1024, // 4MB
  heartbeatIntervalMs: 5000,
  heartbeatTimeoutMs: 15000,

  // ── 日志 ──
  logLevel: process.env.WISON_LOG_LEVEL || 'info',

  // ── 监控 ──
  metricsEnabled: process.env.WISON_METRICS_ENABLED !== 'false',
};

// 冻结配置对象，防止运行时修改
Object.freeze(config);
Object.values(config).forEach(v => {
  if (typeof v === 'object' && v !== null) Object.freeze(v);
});

module.exports = config;
