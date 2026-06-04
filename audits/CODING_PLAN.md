# Wison-RBI 生产级编码方案

> 基于设计文档 v1.6，目标：生产级（安全、可靠、健壮）

---

## 1. 模块划分

```
wison-rbi/
├── packages/
│   ├── protocol/                # @wison/protocol — 共享协议库
│   │   ├── src/
│   │   │   ├── constants.js     # OpCode 枚举、限制常量、Magic 值
│   │   │   ├── types.js         # JSDoc 类型定义
│   │   │   ├── encoder.js       # Frame → ArrayBuffer (服务端)
│   │   │   ├── decoder.js       # ArrayBuffer → Frame (客户端)
│   │   │   └── validator.js     # CommandValidator — 安全边界 (客户端)
│   │   └── tests/
│   │       ├── validator.test.js
│   │       ├── encoder.test.js
│   │       └── fuzz.test.js
│   │
│   ├── server/                  # @wison/server — Node.js 服务端
│   │   ├── src/
│   │   │   ├── index.js         # 入口：CLI + 启动
│   │   │   ├── ws-server.js     # WebSocket 服务器
│   │   │   ├── session.js       # 会话生命周期管理
│   │   │   ├── cdp-client.js    # Chrome DevTools Protocol 客户端
│   │   │   ├── frame-capture.js # 帧捕获 + 差分引擎
│   │   │   ├── input-proxy.js   # HID → CDP Input.dispatchXxx
│   │   │   └── config.js        # 配置管理 + 环境变量
│   │   └── tests/
│   │       └── session.test.js
│   │
│   └── client/                  # @wison/client — 浏览器端
│       ├── src/
│       │   ├── index.js         # 入口 + CanvasKit 初始化
│       │   ├── connection.js    # WebSocket 连接 + 重连
│       │   ├── renderer.js      # 命令分发 + CanvasKit 渲染
│       │   ├── hid-capture.js   # 鼠标/键盘/触摸/滚轮捕获
│       │   └── frame-buffer.js  # 帧环形缓冲区
│       └── index.html           # 单文件入口
│
├── package.json                 # Monorepo 根
└── README.md
```

## 2. 关键接口设计

### 2.1 Protocol 层

```typescript
// constants.js — 不可变冻结对象
const OpCode = Object.freeze({ SAVE: 0x01, RESTORE: 0x02, ..., DRAW_SHADOW: 0x36 });
const FrameType = Object.freeze({ KEYFRAME: 1, DIFF: 2 });
const Limits = Object.freeze({ MAX_PAYLOAD_BYTES: 1<<20, MAX_BYTES_PER_FRAME: 64<<20, ... });

// encoder.js — 服务端使用
class FrameEncoder {
  constructor(version = 1);
  setMetadata({ frameId, timestamp, scroll, viewport, canvasSize }): void;
  addCommand(opcode, payload): void;          // 追加绘制命令
  addTile(x, y, w, h, jpegData): void;        // 追加瓦片
  finalize(frameType): ArrayBuffer;           // 冻结 → 二进制帧
}

// decoder.js — 客户端使用
class FrameDecoder {
  decode(buffer: ArrayBuffer): DecodedFrame;  // 二进制 → 结构化帧
}

// validator.js — 客户端安全边界 (v1.6 全部修复)
class CommandValidator {
  scan(commandsBuffer: ArrayBuffer): ScanResult;
  // 内部: 白名单 + payload子结构 + 帧级字节上限 + save/restore配对
}
```

### 2.2 Server 层

```typescript
// session.js
class Session {
  constructor(config, onFrame, onStatus);
  async start(targetUrl): void;     // 启动 Chromium + 导航
  async navigate(url): void;        // 导航
  async injectHID(event): void;     // HID → CDP
  async resize(w, h): void;         // 调整视口
  async destroy(): void;            // 优雅销毁
}

// ws-server.js
class WsServer {
  constructor(httpServer, config);
  // 每连接 = 新 Session
  // 心跳: 15s 无响应 → 销毁
  // 限流: 每 IP 最大并发 3 会话
}
```

### 2.3 Client 层

```typescript
// connection.js
class Connection {
  constructor(url, options);
  connect(): Promise<void>;          // 连接 + 自动重连 (指数退避, max 5次)
  sendFrame(frameId): void;          // 发送 HID 事件（带 frame_id 锚定）
  sendControl(msg): void;            // 发送控制消息
  onFrame(callback): void;           // 注册帧回调
  close(): void;
}

// renderer.js
class Renderer {
  constructor(canvas, canvasKit);
  render(decodedFrame): void;        // 分发到 CanvasKit
  requestKeyframe(): void;           // 安全拒绝后请求全量帧
}
```

## 3. 技术选型

| 层 | 技术 | 理由 |
|----|------|------|
| 运行时 | Node.js 20 LTS | 稳定、async/await、WebSocket 生态成熟 |
| WebSocket | `ws` (npm) | 最广泛使用的 Node.js WS 库，生产验证 |
| CDP | `chrome-remote-interface` | 标准 CDP 客户端 |
| 图像处理 | `sharp` | libvips 绑定，比 Jimp/Canvas 快 5-10x |
| 测试 | Node.js 内置 `node:test` + `node:assert` | 零依赖，v20 内置 |
| 客户端 | 原生 WebSocket + CanvasKit WASM | 零构建工具，浏览器原生支持 |
| 包管理 | npm workspaces (monorepo) | 共享 protocol 包 |

## 4. 错误处理策略

```
每个模块的错误分为三类：

CRITICAL: 不可恢复 → 进程退出 (clean shutdown) + 告警
  - 端口占用
  - 无法启动 Chromium

RECOVERABLE: 可恢复 → 重试 + 降级
  - WebSocket 断开 → 自动重连 (指数退避)
  - Chromium 崩溃 → 重启实例 + 通知客户端
  - CDP 超时 → 重试 3 次后标记失败

EXPECTED: 预期内 → 忽略 + 记录
  - 帧 CRC 不匹配 → 丢弃 + 等待下一帧
  - 白名单拒绝 → 丢弃 + 告警 + request_keyframe
  - frame_id 非单调 → 接受 + 记录
```

## 5. 文件清单

| 文件 | 行数估计 | 关键复杂度 |
|------|---------|-----------|
| `protocol/constants.js` | ~80 | 低 |
| `protocol/encoder.js` | ~150 | 中 — 二进制打包 |
| `protocol/decoder.js` | ~120 | 中 — 二进制解包 + 边界检查 |
| `protocol/validator.js` | ~250 | 高 — 白名单 + 子结构 + 帧级限制 |
| `server/index.js` | ~60 | 低 |
| `server/ws-server.js` | ~180 | 中 — 连接管理 + 限流 + 心跳 |
| `server/session.js` | ~200 | 高 — Chromium 生命周期 |
| `server/cdp-client.js` | ~120 | 中 — CDP 协议交互 |
| `server/frame-capture.js` | ~200 | 高 — 截图 + 瓦片差分 |
| `server/input-proxy.js` | ~100 | 低 |
| `server/config.js` | ~60 | 低 |
| `client/index.html` | ~300 | 中 — UI + 入口 |
| `client/index.js` | ~80 | 低 |
| `client/connection.js` | ~150 | 中 — 重连状态机 |
| `client/renderer.js` | ~200 | 高 — CanvasKit 命令分发 |
| `client/hid-capture.js` | ~120 | 中 — 事件归一化 |
| `client/frame-buffer.js` | ~80 | 低 — 环形缓冲 |
| `protocol/tests/validator.test.js` | ~200 | 高 — 安全测试 |
| `protocol/tests/encoder.test.js` | ~100 | 中 |
| `protocol/tests/fuzz.test.js` | ~80 | 中 |
| **总计** | **~2700** | |
