/**
 * @wison/server — 入口
 *
 * 启动 HTTP + WebSocket 服务器，注册健康检查和指标端点。
 *
 * 用法:
 *   node index.js
 *   WISON_PORT=9090 WISON_AUTH_TOKEN=xxx node index.js
 */

'use strict';

const http = require('http');
const { WsServer } = require('./ws-server');
const config = require('./config');

// ── 日志 ────────────────────────────────────────────────
let logger;
try {
  const pino = require('pino');
  logger = pino({
    level: config.logLevel,
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  });
} catch (_) {
  // pino 不可用时回退到 console
  logger = {
    info: (...args) => console.log('[INFO]', ...args),
    warn: (...args) => console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
    debug: (...args) => console.log('[DEBUG]', ...args),
    trace: () => {},
    child: () => logger,
  };
}

// ── 指标 ────────────────────────────────────────────────
const metrics = {
  sessionsCreated: 0,
  sessionsDestroyed: 0,
  framesSent: 0,
  bytesSent: 0,
  errorsTotal: 0,
  startTime: Date.now(),
};

// ── HTTP 路由 ───────────────────────────────────────────
function requestListener(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: '0.1.0',
      uptime: Math.round((Date.now() - metrics.startTime) / 1000),
      sessions: wsServer?._sessions?.size || 0,
      memory: process.memoryUsage(),
    }));
    return;
  }

  // GET /metrics (Prometheus 格式)
  if (config.metricsEnabled && req.method === 'GET' && url.pathname === '/metrics') {
    const lines = [
      '# HELP wison_sessions_active Active sessions',
      '# TYPE wison_sessions_active gauge',
      `wison_sessions_active ${wsServer?._sessions?.size || 0}`,
      '# HELP wison_frames_sent_total Total frames sent',
      '# TYPE wison_frames_sent_total counter',
      `wison_frames_sent_total ${metrics.framesSent}`,
      '# HELP wison_bytes_sent_total Total bytes sent',
      '# TYPE wison_bytes_sent_total counter',
      `wison_bytes_sent_total ${metrics.bytesSent}`,
      '# HELP wison_errors_total Total errors',
      '# TYPE wison_errors_total counter',
      `wison_errors_total ${metrics.errorsTotal}`,
    ];
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(lines.join('\n') + '\n');
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

// ── 启动 ────────────────────────────────────────────────
const httpServer = http.createServer(requestListener);
let wsServer;

httpServer.listen(config.port, config.host, () => {
  logger.info({ port: config.port, host: config.host, auth: !!config.authToken }, 'Wison-RBI server started');
  wsServer = new WsServer(httpServer, logger);
});

// ── 优雅关闭 ───────────────────────────────────────────
async function gracefulShutdown(signal) {
  logger.info({ signal }, 'Shutting down gracefully...');
  if (wsServer) await wsServer.shutdown();
  httpServer.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  // 强制退出 (5s 后)
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── 未捕获异常 ─────────────────────────────────────────
process.on('uncaughtException', (err) => {
  metrics.errorsTotal++;
  logger.error({ err }, 'Uncaught exception');
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  metrics.errorsTotal++;
  logger.error({ err: reason }, 'Unhandled rejection');
});
