/**
 * @wison/server/ws-server — WebSocket 服务器
 *
 * 每连接一个 Session。包含：
 *   - Token 认证
 *   - IP 限流 (每 IP 最大 3 连接)
 *   - 心跳检测 (15s 超时)
 *   - 优雅关闭
 */

'use strict';

const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { Session } = require('./session');
const config = require('./config');
const { Limits } = config;

class WsServer {
  /**
   * @param {import('http').Server} httpServer
   * @param {object} logger
   */
  constructor(httpServer, logger) {
    this._log = logger.child({ component: 'ws-server' });
    this._sessions = new Map();     // sessionId → Session
    this._ipConnections = new Map(); // ip → count
    this._heartbeats = new Map();   // sessionId → lastPing
    this._cleanedSessions = new Set(); // v1.7: 防 _cleanupSession 重复调用

    this._wss = new WebSocketServer({
      server: httpServer,
      maxPayload: config.wsMaxPayload,
      verifyClient: (info, cb) => this._verifyClient(info, cb),
    });

    this._wss.on('connection', (ws, req) => this._onConnection(ws, req));
    this._wss.on('error', (err) => this._log.error({ err }, 'WebSocket server error'));

    // 心跳定时器
    this._heartbeatTimer = setInterval(() => this._checkHeartbeats(), config.heartbeatIntervalMs);

    // 空闲回收定时器
    this._idleTimer = setInterval(() => this._reapIdleSessions(), 60000);

    // v1.8: _cleanedSessions 定期清理（防止无限增长）
    this._cleanupTimer = setInterval(() => {
      if (this._cleanedSessions.size > 10000) this._cleanedSessions.clear();
    }, 300000).unref();

    this._log.info({ maxSessions: config.maxSessions }, 'WebSocket server ready');
  }

  /** 客户端连接验证 */
  _verifyClient(info, cb) {
    // v1.8: 认证全量移至消息层（_handleControl 'auth'），浏览器兼容

    // IP 限流
    const ip = (info.req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const current = this._ipConnections.get(ip) || 0;
    if (current >= config.ipMaxPerConn) {
      this._log.warn({ ip, current }, 'IP connection limit reached');
      cb(false, 429, 'Too Many Connections');
      return;
    }

    // 会话上限
    if (this._sessions.size >= config.maxSessions) {
      this._log.warn({ current: this._sessions.size, max: config.maxSessions }, 'Session limit reached');
      cb(false, 503, 'Server Full');
      return;
    }

    cb(true);
  }

  /** 新 WebSocket 连接 */
  _onConnection(ws, req) {
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ip = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');

    // 标记 WebSocket 所属会话
    ws._wisonSessionId = sessionId;

    // 更新 IP 计数
    this._ipConnections.set(ip, (this._ipConnections.get(ip) || 0) + 1);

    // 心跳记录
    this._heartbeats.set(sessionId, Date.now());

    // 创建 Session（不自动启动 Chromium）
    const session = new Session(
      sessionId,
      (id, frame) => this._sendFrame(id, frame),
      (id, status) => this._sendStatus(id, status),
      this._log
    );
    this._sessions.set(sessionId, session);

    this._log.info({ sessionId, ip }, 'WebSocket connected');

    ws.on('message', (data, isBinary) => {
      this._heartbeats.set(sessionId, Date.now());

      // v1.7: 非认证消息在认证完成前一律拒绝
      if (!session._authenticated && config.authToken) {
        if (!isBinary && data.toString().startsWith('{"type":"auth"')) {
          // 允许 auth 消息通过
        } else {
          return; // 拒绝
        }
      }

      if (isBinary) {
        // HID 事件
        session.injectHID(data).catch(err =>
          this._log.warn({ err: err.message }, 'HID injection error')
        );
      } else {
        // 控制消息 (JSON)
        try {
          const msg = JSON.parse(data.toString());
          this._handleControl(session, msg);
        } catch (_) {
          // 非 JSON 文本，忽略
        }
      }
    });

    ws.on('close', () => {
      this._cleanupSession(sessionId, ip);
    });

    ws.on('error', (err) => {
      this._log.warn({ sessionId, err: err.message }, 'WebSocket error');
      this._cleanupSession(sessionId, ip);
    });
  }

  /** 处理控制消息 */
  async _handleControl(session, msg) {
    switch (msg.type) {
      case 'auth':  // v1.8: 统一消息层认证（浏览器+API 兼容）
        if (!config.authToken) { session._authenticated = true; break; }
        if (typeof msg.token !== 'string' || msg.token.length === 0) {
          this._log.warn({ sessionId: session.id }, 'Auth token invalid type');
          this._closeSession(session.id);
          break;
        }
        const bufA = Buffer.from(msg.token);
        const bufB = Buffer.from(config.authToken);
        if (bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)) {
          session._authenticated = true;
        } else {
          this._log.warn({ sessionId: session.id }, 'Auth token rejected');
          this._closeSession(session.id);
        }
        break;
      case 'start':
      case 'navigate':
        // v1.7: URL scheme 校验（仅允许 http/https）
        if (msg.url) {
          let parsed;
          try { parsed = new URL(msg.url); } catch (_) { return; }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            this._log.warn({ url: msg.url }, 'Blocked non-HTTP(S) URL');
            session.notifyStatus({ error: 'NAVIGATION_FAILED', message: 'Only http/https allowed' });
            return;
          }
          await session.start(msg.url).catch(err =>
            this._log.error({ err }, 'Session start/navigate failed')
          );
        }
        break;
      case 'resize':
        if (msg.width > 0 && msg.width <= 16384 && msg.height > 0 && msg.height <= 16384) {
          await session.resize(msg.width, msg.height);
        }
        break;
      case 'text':
        if (msg.value) {
          await session.injectText(msg.value);
        }
        break;
      case 'request_keyframe':
        // v1.7: 强制下一帧为全量 Keyframe
        session.forceKeyframe();
        break;
      case 'ping':
        // 心跳请求——等待 pong 响应在 ws 层自动处理
        break;
    }
  }

  /** 发送帧到客户端 */
  _sendFrame(sessionId, arrayBuffer) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    // 找到该 session 对应的 WebSocket
    for (const ws of this._wss.clients) {
      if (ws._wisonSessionId === sessionId && ws.readyState === WebSocket.OPEN) {
        // 背压检查
        if (ws.bufferedAmount > 1024 * 1024) {
          this._log.trace({ sessionId, buffered: ws.bufferedAmount }, 'Backpressure, skipping frame');
          session._framesSkipped = (session._framesSkipped || 0) + 1;  // v1.10
          return;
        }
        ws.send(arrayBuffer, { binary: true }, (err) => {
          if (err) this._log.warn({ err: err.message, sessionId }, 'Frame send failed');
        });
        return;
      }
    }
  }

  /** 发送状态到客户端 */
  _sendStatus(sessionId, msg) {
    for (const ws of this._wss.clients) {
      if (ws._wisonSessionId === sessionId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg), (err) => {
          if (err) this._log.warn({ err: err.message, sessionId }, 'Status send failed');
        });
        return;
      }
    }
  }

  /** v1.7: 主动关闭指定会话 */
  _closeSession(sessionId) {
    for (const ws of this._wss.clients) {
      if (ws._wisonSessionId === sessionId) {
        ws.close(4001, 'Auth failed');
        return;
      }
    }
  }
  _cleanupSession(sessionId, ip) {
    if (this._cleanedSessions.has(sessionId)) return;  // v1.7: 防重入
    this._cleanedSessions.add(sessionId);
    const session = this._sessions.get(sessionId);
    if (session) {
      session.destroy().catch(() => {});
      this._sessions.delete(sessionId);
    }
    this._heartbeats.delete(sessionId);

    const count = this._ipConnections.get(ip) || 0;
    if (count <= 1) {
      this._ipConnections.delete(ip);
    } else {
      this._ipConnections.set(ip, count - 1);
    }

    this._log.info({ sessionId, ip }, 'WebSocket disconnected');
  }

  /** 心跳检测 */
  _checkHeartbeats() {
    const now = Date.now();
    for (const [sessionId, lastPing] of this._heartbeats) {
      if (now - lastPing > Limits.HEARTBEAT_TIMEOUT_MS) {
        this._log.warn({ sessionId }, 'Heartbeat timeout');
        // 关闭关联的 WebSocket
        for (const ws of this._wss.clients) {
          if (ws._wisonSessionId === sessionId) {
            ws.close(1001, 'Heartbeat timeout');
            break;
          }
        }
        this._sessions.get(sessionId)?.destroy().catch(() => {});
        this._sessions.delete(sessionId);
        this._heartbeats.delete(sessionId);
      }
    }
  }

  /** 空闲会话回收 */
  _reapIdleSessions() {
    for (const [sessionId, session] of this._sessions) {
      if (session.isIdle()) {
        this._log.info({ sessionId }, 'Reaping idle session');
        for (const ws of this._wss.clients) {
          if (ws._wisonSessionId === sessionId) {
            ws.close(1000, 'Idle timeout');
            break;
          }
        }
        session.destroy().catch(() => {});
        this._sessions.delete(sessionId);
        this._heartbeats.delete(sessionId);
      }
    }
  }

  /** 优雅关闭 */
  async shutdown() {
    clearInterval(this._heartbeatTimer);
    clearInterval(this._idleTimer);
    clearInterval(this._cleanupTimer);

    for (const ws of this._wss.clients) {
      ws.close(1001, 'Server shutting down');
    }

    const promises = [];
    for (const session of this._sessions.values()) {
      promises.push(session.destroy().catch(() => {}));
    }
    await Promise.all(promises);
    this._sessions.clear();

    this._log.info('WebSocket server shut down');
  }

  /** v1.8: 获取当前活跃会话数 */
  getSessionCount() {
    return this._sessions.size;
  }
}

module.exports = { WsServer };
