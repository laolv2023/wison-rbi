# Wison-RBI 架构设计文档

> v1.12 | 2026-06

## 1. 概述

Wison-RBI 是一个**远程浏览器隔离** (Remote Browser Isolation) 系统。它在服务端运行无头 Chromium，将页面内容实时编码为高效的二进制帧协议推送到客户端浏览器。用户交互事件 (鼠标/键盘/触摸) 反向注入到 Chromium，形成完整闭环。

```
┌─────────────────────────────────────────────────────┐
│                    客户端 (浏览器)                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ HIDCapture│  │ Renderer │  │  Connection (WS) │  │
│  │ 事件捕获  │  │ CanvasKit│  │  WebSocket 客户端│  │
│  └────┬─────┘  └────┬─────┘  └────────┬─────────┘  │
│       │              │                 │            │
└───────┼──────────────┼─────────────────┼────────────┘
        │  HID 事件    │  帧数据          │
        ▼              │                 │
┌──────────────────────┼─────────────────┼────────────┐
│              服务端 (Node.js)           │            │
│  ┌──────────┐  ┌────┴────┐  ┌─────────┴──────────┐ │
│  │InputProxy│  │Encoder  │  │   WsServer         │ │
│  │ 令牌桶  │  │帧编码   │  │   认证/限流/路由    │ │
│  └────┬─────┘  └────┬────┘  └────────────────────┘ │
│       │              │                              │
│  ┌────┴──────────────┴───────────────────────────┐ │
│  │              Session                           │ │
│  │  ┌──────────┐  ┌──────────┐  ┌─────────────┐ │ │
│  │  │CdpClient │  │Capture   │  │ Playwright   │ │ │
│  │  │ CDP 协议 │  │截图+差分 │  │ Chromium     │ │ │
│  │  └──────────┘  └──────────┘  └─────────────┘ │ │
│  └───────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────┘
```

## 2. 核心设计决策

### 2.1 瓦片级差分传输

传统远程桌面使用全帧视频编码 (H.264/H.265)，延迟高、带宽大。Wison-RBI 采用 **16×16 像素瓦片差分**:

- 截图为 raw RGBA 像素 (1280×720 = 3.7MB)
- 分割为 80×45 = 3600 个瓦片
- 每瓦片计算 MD5 哈希，与上一帧对比
- 仅变化瓦片重新 JPEG 编码 → 传输

**优势**: 静态页面带宽接近 0，动态内容高效压缩。

### 2.2 自定义二进制帧协议

不使用 WebRTC 或标准视频编码，而是定义专用帧格式:

```
[version:1][flags:1][frameId:4][timestamp:8][scrollX:4][scrollY:4]
[viewportW:2][viewportH:2][canvasW:2][canvasH:2]
[tileCount:2][TileEntry×N][TileData×N]
[Command×M][CRC32:4]
```

**优势**: 极低开销 (30 字节帧头)、可控粒度、CanvasKit 原生渲染。

### 2.3 CanvasKit 客户端渲染

客户端使用 Skia 的 WASM 版本 (CanvasKit) 直接渲染:
- JPEG 瓦片解码 → SkCanvas.drawImage()
- 绘制命令流 → 逐 opcode 分发到 CanvasKit API

**优势**: GPU 加速 (WebGL Canvas)、像素级精确、无需视频解码器。

### 2.4 三层安全防线

| 层 | 机制 | 位置 |
|----|------|------|
| 传输层 | CRC32 完整性校验 | decoder.js → renderer.js |
| 协议层 | 命令白名单 + 子结构校验 | validator.js |
| 传输层 | WSS + Token 认证 | ws-server.js |

## 3. 关键技术选择

| 选择 | 理由 |
|------|------|
| **Playwright** 而非 Puppeteer | 更好的 API、自动浏览器管理、CDP 连接稳定性 |
| **sharp** 而非纯 JS JPEG 编码 | libvips C 扩展，性能 10-50x |
| **CanvasKit 0.39.1** | 稳定 API、WebGL 支持、unpkg CDN 可用 |
| **pino** 而非 winston | 极低开销的结构化日志 |
| **ws** 而非 socket.io | 原生二进制帧支持、低开销 |
| **node:test** 而非 jest | 零依赖、原生支持 |

## 4. 数据流详解

### 4.1 帧推送管道 (服务端→客户端)

```
page.screenshot(PNG)
  → sharp() → raw RGBA pixels
  → _computeDirtyTiles() → 脏瓦片列表 (MD5 hash diff)
  → sharp JPEG encode per tile
  → FrameEncoder: setMetadata + addTile + finalize
  → CRC32 append
  → ws.send(ArrayBuffer)
  → 客户端: FrameDecoder.decode → CRC32 verify → Validator.scan
  → CanvasKit drawImage(tiles) + dispatchCommands
```

### 4.2 事件注入管道 (客户端→服务端)

```
浏览器原生事件 (mousemove/keydown/...)
  → HIDCapture._canvasToViewport() → 坐标归一化
  → JSON encode payload {x,y,type,button,frame_id}
  → [type:1][JSON_payload:N] 二进制消息
  → ws.send() → 服务端接收
  → InputProxy._consumeToken() → 令牌桶限流
  → CDP Input.dispatchMouseEvent/dispatchKeyEvent
```

## 5. 安全模型

```
┌──────────────────────────────────────────────┐
│           威胁模型 (Threat Model)              │
├──────────────────────────────────────────────┤
│ 攻击面 1: 恶意客户端注入 CDP 命令             │
│   → 防御: Token 认证 + 消息层鉴权             │
│                                              │
│ 攻击面 2: 恶意服务端发送恶意帧                │
│   → 防御: Validator 白名单 + 子结构校验       │
│                                              │
│ 攻击面 3: 帧传输中间人篡改                    │
│   → 防御: CRC32 校验 + 推荐 WSS              │
│                                              │
│ 攻击面 4: HTTP 静态文件 XSS/CSRF              │
│   → 防御: CSP meta + X-Content-Type-Options  │
│                                              │
│ 攻击面 5: CDN 供应链攻击                     │
│   → 防御: SRI integrity hash (CanvasKit)     │
│                                              │
│ 攻击面 6: Chromium 沙箱逃逸                  │
│   → 防御: --no-sandbox 仅容器内使用           │
│                                              │
│ 攻击面 7: 拒绝服务 (帧洪水/HID洪水)           │
│   → 防御: 令牌桶限流 + 背压检测 + 帧大小上限  │
└──────────────────────────────────────────────┘
```

## 6. 性能模型

| 阶段 | 耗时 (1280×720) | 说明 |
|------|----------------|------|
| page.screenshot | ~15ms | Playwright 内置，可能硬件加速 |
| raw→dirty tiles | ~8ms | 3600×MD5 + Buffer.allocUnsafe |
| JPEG encode/tile | ~2ms×N | N = 脏瓦片数 (典型 10-50) |
| CRC32 | ~0.5ms | 全帧校验 |
| 服务端总计 | **25-50ms** | 依赖脏瓦片比例 |
| WebSocket 传输 | ~2ms | LAN 环境，4MB 帧 |
| 客户端解码 | ~2ms | CRC32 + 瓦片解码 |
| CanvasKit 渲染 | ~5ms | WebGL (硬件加速) |
| 端到端延迟 | **30-60ms** | ≈ 1-2 帧 |

## 7. 目录结构

```
wison-rbi/
├── packages/
│   ├── protocol/           # 共享协议 (Node + 浏览器)
│   │   ├── src/
│   │   │   ├── constants.js   # 常量/OpCode/Limits
│   │   │   ├── encoder.js     # 帧编码器 (服务端)
│   │   │   ├── decoder.js     # 帧解码器 (客户端)
│   │   │   └── validator.js   # 命令白名单校验 (客户端)
│   │   └── tests/             # 协议测试
│   ├── server/             # 服务端
│   │   ├── src/
│   │   │   ├── index.js       # 入口 + HTTP 服务
│   │   │   ├── ws-server.js   # WebSocket 服务
│   │   │   ├── session.js     # 会话生命周期
│   │   │   ├── frame-capture.js # 帧捕获 + 差分
│   │   │   ├── cdp-client.js  # CDP 协议客户端
│   │   │   ├── input-proxy.js # HID→CDP 代理
│   │   │   └── config.js      # 12-Factor 配置
│   │   └── tests/
│   ├── client/             # 客户端 (纯浏览器)
│   │   ├── index.html         # 客户端 HTML 入口
│   │   └── src/
│   │       ├── connection.js  # WebSocket 连接
│   │       ├── renderer.js    # CanvasKit 渲染
│   │       ├── hid-capture.js # 事件捕获
│   │       └── frame-buffer.js # 帧历史 (预留)
│   └── README.md
├── docs/                   # 文档
│   ├── DESIGN.md
│   ├── DEVELOPMENT.md
│   ├── DEPLOY.md
│   ├── CONFIG.md
│   ├── USAGE.md
│   └── TROUBLESHOOT.md
└── Dockerfile
```
