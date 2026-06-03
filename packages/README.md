# Wison-RBI — 生产级实现

基于 Chromium Compositor 层拦截的浏览器隔离系统。

## 项目状态

| 指标 | 状态 |
|------|------|
| 设计文档 | v1.6 (两轮安全审计通过) |
| 代码行数 | ~2700 JS |
| 测试 | 21/21 通过 |
| 测试覆盖 | Protocol 层 100% (validator + encoder/decoder + fuzz) |

## 快速开始

```bash
# 安装依赖
cd packages/server && npm install

# 启动 (需要 Chromium)
WISON_AUTH_TOKEN=my-secret-token node src/index.js

# 运行测试
node --test packages/protocol/tests/validator.test.js
```

## 架构

```
packages/
├── protocol/       # 共享协议库 (双环境: Node.js + 浏览器)
│   ├── constants   # OpCode/限制/错误码
│   ├── encoder     # Frame → ArrayBuffer
│   ├── decoder     # ArrayBuffer → Frame (带边界检查)
│   └── validator   # 命令白名单安全校验器
│
├── server/         # Node.js 服务端
│   ├── ws-server   # WebSocket + 认证 + 限流 + 心跳
│   ├── session     # Chromium 会话生命周期
│   ├── cdp-client  # CDP 客户端 (3次重试)
│   ├── frame-capture # 帧捕获 + 16×16 瓦片差分
│   └── input-proxy # HID → CDP (令牌桶限流 125Hz)
│
└── client/         # 浏览器客户端
    ├── connection  # WebSocket + 指数退避重连
    ├── renderer    # CanvasKit 命令分发
    ├── hid-capture # 鼠标/键盘/触摸事件
    └── frame-buffer # 环形帧缓冲 (v1.6)
```

## 安全特性

- CommandValidator: 白名单 + 子结构深度校验 + 帧级字节上限
- WebSocket: Token 认证 + IP 限流 + 最大 payload
- HID: 令牌桶限流 125Hz + burst 250Hz
- CDP: 强制 localhost-only 绑定
- CRC32: 帧完整性校验
- gzip bomb: 三层防护 (压缩大小/输出缓冲/压缩比)

## 可靠性

- WebSocket 断线: 指数退避自动重连 (1s→2s→4s→8s→16s)
- Chromium 崩溃: 自动检测 + 重启 + 恢复会话
- CDP 超时: 3 次重试 (500ms)
- 帧捕获失败: 连续 10 次 → 重启 Chromium
- 优雅关闭: SIGTERM → 关闭所有 Chromium → 关闭 WS → 退出

## 可观测性

- `GET /health` — 健康检查
- `GET /metrics` — Prometheus 格式指标
- 结构化日志 (pino)
- 12-Factor 配置 (环境变量)

## License

MIT
