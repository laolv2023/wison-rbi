# 配置参考

> v1.12 | 所有配置通过环境变量注入

## 环境变量一览

### 网络

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WISON_PORT` | `8080` | HTTP/WebSocket 监听端口 |
| `WISON_HOST` | `0.0.0.0` | 监听地址 (生产建议 `127.0.0.1`) |

### 认证

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WISON_AUTH_TOKEN` | `null` | 认证令牌。`null` = 无认证 (仅开发环境！) |

### Chromium

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WISON_CHROMIUM_PATH` | `undefined` | Chromium 可执行文件路径 (Playwright 自动查找) |

### 视口

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WISON_VIEWPORT_W` | `1280` | 默认视口宽度 (px) |
| `WISON_VIEWPORT_H` | `720` | 默认视口高度 (px) |

### 帧

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WISON_FRAME_TICK_MS` | `50` | 帧捕捉间隔 (ms)，50 = 20fps |

### 会话

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WISON_MAX_SESSIONS` | `5` | 最大并发会话数 |
| `WISON_SESSION_IDLE_MS` | `300000` | 空闲超时 (ms)，默认 5 分钟 |
| `WISON_IP_MAX_CONN` | `3` | 每 IP 最大连接数 |

### 日志

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WISON_LOG_LEVEL` | `info` | 日志级别: `trace` / `debug` / `info` / `warn` / `error` |

### 监控

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WISON_METRICS_ENABLED` | `true` | 启用 Prometheus 指标端点 |

---

## 内部常量 (不可配置)

| 常量 | 值 | 说明 |
|------|------|------|
| `tileSize` | 16 | 瓦片边长 (px) |
| `keyframeInterval` | 300 | 强制关键帧间隔 (帧数) |
| `wsMaxPayload` | 4MB | WebSocket 最大消息 |
| `heartbeatIntervalMs` | 5000 | 心跳间隔 (ms) |
| `heartbeatTimeoutMs` | 15000 | 心跳超时 (ms) |

---

## 配置示例

### 开发环境

```bash
export WISON_PORT=8080
export WISON_LOG_LEVEL=debug
# 无认证
node index.js
```

### 生产环境

```bash
export WISON_PORT=8080
export WISON_HOST=127.0.0.1
export WISON_AUTH_TOKEN=$(openssl rand -hex 32)
export WISON_MAX_SESSIONS=10
export WISON_LOG_LEVEL=warn
export WISON_IP_MAX_CONN=5
node index.js
```

### Docker

```bash
docker run -e WISON_AUTH_TOKEN=my-token -e WISON_MAX_SESSIONS=3 wison-rbi
```

### systemd EnvironmentFile

```
WISON_PORT=8080
WISON_HOST=127.0.0.1
WISON_AUTH_TOKEN=a1b2c3d4e5f6...
WISON_MAX_SESSIONS=5
WISON_LOG_LEVEL=info
```
