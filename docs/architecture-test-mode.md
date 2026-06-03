# 最小测试部署 — 单容器架构

## 设计目标

- **一键启动**: `docker compose up`
- **零外部依赖**: 所有组件在一个容器内
- **浏览器即客户端**: 打开 `http://容器IP:8080` 即可使用
- **完整功能闭环**: 浏览 → 渲染 → 交互 → 反馈

## 容器内部拓扑

```
┌──────────────────────────────────────────────────────────────┐
│                    Docker Container                          │
│                    (paintop-test:latest)                     │
│                                                              │
│  Port 8080 ──────────────────────────────────────────────    │
│       │                                                     │
│  ┌────┴──────────────────────────────────────────────────┐  │
│  │              Python aiohttp Server                     │  │
│  │                                                       │  │
│  │  GET  /          →  client/index.html (静态文件)       │  │
│  │  GET  /health    →  {"status":"ok", ...}              │  │
│  │  WS   /ws        →  WebSocket endpoint                │  │
│  │                                                       │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │           Session Manager                       │  │  │
│  │  │  • 每 WS 连接 → 一个 Chromium 实例              │  │  │
│  │  │  • 生命周期: 连接建立 → 启动 Chromium           │  │  │
│  │  │              连接断开 → 销毁 Chromium           │  │  │
│  │  └──────────────────────┬──────────────────────────┘  │  │
│  │                         │                              │  │
│  │  ┌──────────────────────┴──────────────────────────┐  │  │
│  │  │           Chromium Manager (Playwright)          │  │  │
│  │  │                                                 │  │  │
│  │  │  headless Chromium ──CDP──▶ 截图 (每 50ms)      │  │  │
│  │  │                           ▶ 鼠标/键盘注入       │  │  │
│  │  │                           ▶ URL 导航            │  │  │
│  │  └──────────────────────┬──────────────────────────┘  │  │
│  │                         │                              │  │
│  │  ┌──────────────────────┴──────────────────────────┐  │  │
│  │  │           Frame Diff Engine                      │  │  │
│  │  │                                                 │  │  │
│  │  │  当前帧 vs 上一帧  →  16×16 tile 对比            │  │  │
│  │  │  → 仅发送脏 tile (JPEG 编码)                    │  │  │
│  │  │  → 每 N 帧强制全量关键帧                        │  │  │
│  │  └──────────────────────┬──────────────────────────┘  │  │
│  │                         │                              │  │
│  │  ┌──────────────────────┴──────────────────────────┐  │  │
│  │  │           Protocol Codec                         │  │  │
│  │  │                                                 │  │  │
│  │  │  帧编码: Magic + Header + Tile[] + Data          │  │  │
│  │  │  HID 解码: 二进制 → Playwright 动作              │  │  │
│  │  └──────────────────────┬──────────────────────────┘  │  │
│  │                         │                              │  │
│  └─────────────────────────┼──────────────────────────────┘  │
│                            │                                 │
│                     WebSocket                                │
│                   wss://host:8080/ws                         │
└────────────────────────────┼─────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              │      用户浏览器              │
              │                              │
              │  ┌────────────────────────┐  │
              │  │ URL Bar + Canvas + HID │  │
              │  └────────────────────────┘  │
              └──────────────────────────────┘
```

## WebSocket 协议帧格式

### Server → Client: PaintOp 帧 (Binary)

```
┌──────┬───────┬──────┬───────┬──────────┐
│ Magic│Version│ Type │Tiles  │ Tile[]   │
│ 2B   │ 1B    │ 1B   │ 2B    │ N×(14B)  │
└──────┴───────┴──────┴───────┴──────────┘
                                    │
                    ┌───────────────┘
                    ▼
              ┌──────┬──────┬──────┬──────┬────────┬──────────┐
              │  X   │  Y   │  W   │  H   │Encode  │ DataLen  │  Data...
              │ 2B   │ 2B   │ 2B   │ 2B   │ 2B     │ 4B       │  N bytes
              └──────┴──────┴──────┴──────┴────────┴──────────┘

Magic:   0x50 0x53  ("PS")
Version: 0x01
Type:    0x01 = Keyframe (全量), 0x02 = Diff (增量)
Tiles:   本帧包含的 tile 数量
Encode:  0x01 = JPEG, 0x02 = PNG
```

### Client → Server: HID 事件 (Binary)

```
┌──────┬──────────┐
│ Type │ Payload  │
│ 1B   │ JSON     │
└──────┴──────────┘

Type: 0x10 = MouseMove
      0x11 = MouseDown
      0x12 = MouseUp
      0x13 = MouseWheel
      0x14 = KeyDown
      0x15 = KeyUp
      0x16 = Touch (预留)
```

### 双向: 控制消息 (Text/JSON)

```json
// S→C: 状态同步
{"type":"status","url":"https://example.com","loading":false,"title":"Example"}

// C→S: 导航
{"type":"navigate","url":"https://example.com"}

// C→S: 调整视口
{"type":"resize","width":1280,"height":720}

// 双向: 心跳
{"type":"ping"}
{"type":"pong"}

// C→S: 文本输入 (用于 IME 等复杂输入)
{"type":"text","value":"你好世界"}
```

## 帧差算法（核心增量逻辑）

```
Viewport: 1280×720, Tile: 16×16
Grid: 80×45 = 3600 tiles

每轮:
  1. Chromium.screenshot() → PIL Image (当前帧)
  2. 与上一帧逐 tile 比较像素哈希
  3. 标记脏 tile
  4. 脏 tile > 50% → 发送 Keyframe (全量 JPEG)
  5. 脏 tile ≤ 50% → 发送 Diff (仅脏 tile JPEG)
  6. 每 300 帧强制 Keyframe (抗误差累积)
```

## 依赖

```
Python 3.12+
├── aiohttp          (HTTP + WebSocket)
├── playwright       (Chromium 控制)
└── Pillow           (图像处理/帧差)

Chromium (Playwright 自动下载)
```
