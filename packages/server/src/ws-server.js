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

    this._log.info({ maxSessions: config.maxSessions }, 'WebSocket server ready');
  }

  /** 客户端连接验证 */
  _verifyClient(info, cb) {
    // Token 认证
    if (config.authToken) {
      const authHeader = info.req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (token !== config.authToken) {
        this._log.warn({ ip: info.req.socket.remoteAddress }, 'Auth failed');
        cb(false, 401, 'Unauthorized');
        return;
      }
    }

    // IP 限流
    const ip = info.req.socket.remoteAddress || 'unknown';
    const current = this._ipConnections.get(ip) || 0;
    if (current >= 3) {
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
    const ip = req.socket.remoteAddress || 'unknown';

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
      case 'start':
      case 'navigate':
        if (msg.url) {
          await session.start(msg.url).catch(err =>
            this._log.error({ err }, 'Session start/navigate failed')
          );
        }
        break;
      case 'resize':
        if (msg.width && msg.height) {
          await session.resize(msg.width, msg.height);
        }
        break;
      case 'text':
        if (msg.value) {
          await session.injectText(msg.value);
        }
        break;
      case 'request_keyframe':
        // v1.6: 客户端检测到连续验证失败，请求强制 Keyframe
        this._log.warn({ sessionId: session.id }, 'Client requested keyframe');
        // 下一个帧循环自然产生 Keyframe（frameCount 重置在 navigate 中）
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
          // 客户端跟不上，跳过非关键帧
          this._log.trace({ sessionId, buffered: ws.bufferedAmount }, 'Backpressure, skipping frame');
          return;
        }
        ws.send(arrayBuffer, { binary: true });
        return;
      }
    }
  }

  /** 发送状态到客户端 */
  _sendStatus(sessionId, msg) {
    for (const ws of this._wss.clients) {
      if (ws._wisonSessionId === sessionId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        return;
      }
    }
  }

  /** 清理会话 */
  _cleanupSession(sessionId, ip) {
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
            ws.terminate();
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

    // 关闭所有连接
    for (const ws of this._wss.clients) {
      ws.close(1001, 'Server shutting down');
    }

    // 销毁所有会话
    const promises = [];
    for (const session of this._sessions.values()) {
      promises.push(session.destroy().catch(() => {}));
    }
    await Promise.all(promises);
    this._sessions.clear();

    this._log.info('WebSocket server shut down');
  }
}

module.exports = { WsServer };
