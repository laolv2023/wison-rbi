# PaintOp Remote Browser — 原型验证

基于 Chromium cc 层拦截的远程浏览器隔离系统最小可测试原型。

## 一句话

> 打开 `http://容器IP:8080`，从网站选择器里挑一个网站，远端 Chromium 启动、渲染画面通过 WebSocket 传回来，交互像本地。

## 用户流程

```
┌───────────────────────────────────────────────────────┐
│                                                       │
│  ① 打开 http://容器IP:8080                         │
│     ┌───────────────────────────────────────────────┐ │
│     │         PaintOp Remote Browser                │ │
│     │                                               │ │
│     │  [🔍 输入网址或点击下方快捷入口...]  [启动]    │ │
│     │                                               │ │
│     │  常用网站                                      │ │
│     │  ┌────────┐ ┌────────┐ ┌────────┐            │ │
│     │  │ Google │ │ GitHub │ │ 百度   │ ...        │ │
│     │  └────────┘ └────────┘ └────────┘            │ │
│     │                                               │ │
│     │  技术开发                                      │ │
│     │  ┌────────┐ ┌────────┐ ┌────────┐            │ │
│     │  │  MDN   │ │  npm   │ │ Docker │ ...        │ │
│     │  └────────┘ └────────┘ └────────┘            │ │
│     └───────────────────────────────────────────────┘ │
│                                                       │
│  ② 选择网站（输入 URL 或点击快捷卡片）                 │
│                                                       │
│  ③ 门户页收起，浏览器界面展开                          │
│     ┌───────────────────────────────────────────────┐ │
│     │ [⌂] [◀] [▶] [↻] [https://github.com    ] [→] │ │
│     ├───────────────────────────────────────────────┤ │
│     │                                               │ │
│     │         远端 Chromium 实时画面                  │ │
│     │         (Canvas，可交互)                       │ │
│     │                                               │ │
│     ├───────────────────────────────────────────────┤ │
│     │ ● 已连接 | github.com | FPS: 18 | BW: 42 KB/s │ │
│     └───────────────────────────────────────────────┘ │
│                                                       │
│  ④ 点击、滚动、键盘输入——与本地浏览器无差别            │
│                                                       │
│  ⑤ 点击 ⌂ 回到门户页，选择下一个网站                  │
│                                                       │
└───────────────────────────────────────────────────────┘
```

## 架构 (单容器模式)

```
你的浏览器 (任意IP)
      │
      │  HTTP GET  /        → index.html (网站选择器 → 浏览器界面)
      │  WS       /ws       → PaintOp 帧 + HID 事件
      ▼
┌──────────────────────────────────┐
│       Docker: paintop-test       │
│         (容器IP:8080)            │
│                                  │
│  Python (aiohttp) :8080          │
│  ├─ HTTP static (client HTML)    │
│  ├─ WebSocket /ws                │
│  ├─ Session Manager              │
│  │   └─ 按需启动: 首次 navigate │
│  │       才创建 Chromium         │
│  ├─ Chromium Manager             │
│  │   └─ Playwright → Chromium    │
│  └─ Frame Diff Engine            │
│      └─ 16×16 tile 增量传输      │
└──────────────────────────────────┘
```

## 快速开始

### 前置条件

- Docker 20.10+
- 4GB 可用内存

### 一键启动

```bash
cd paintop-prototype
docker compose up --build
```

等待约 30 秒（首次构建需下载 Chromium）。

### 使用

1. 浏览器打开 **http://容器IP:8080**
2. 看到网站选择器——输入 URL 或点击任意快捷卡片（Google、GitHub、MDN 等）
3. 点击「启动」（或直接点卡片）
4. 门户页收起，浏览器界面出现，远端 Chromium 启动中
5. Canvas 中出现目标页面，开始交互

### 切换网站

- 在浏览器界面的 URL 栏输入新网址 → 回车
- 或点击左上角 ⌂ 按钮 → 回到网站选择器 → 重新选择

## 测试核心功能

| 功能 | 操作 | 预期结果 |
|------|------|----------|
| **网站选择器** | 点击快捷卡片（如 GitHub） | 自动填入 URL 并启动会话 |
| **手动输入** | URL 栏输入 `https://httpbin.org` → 启动 | 远端 Chromium 导航到该网站 |
| **滚动** | Canvas 内鼠标滚轮 | 页面滚动，增量 tile 传输 (BW < 全帧) |
| **点击链接** | Canvas 内点击链接 | 页面导航，新页面渲染 |
| **文本输入** | 点击输入框，键盘打字 | 文本出现在远端 Chromium |
| **右键菜单** | Canvas 内右键 | 弹出 Chromium 原生右键菜单 |
| **粘贴** | Canvas 聚焦后 Ctrl+V | 文本粘贴到远端 |
| **返回门户** | 点击工具栏 ⌂ 按钮 | 回到网站选择器，Chromium 销毁 |
| **断开重连** | `docker stop/start paintop-test` | 断开时红色横幅，重启后点击重连 |

## 观察指标 (状态栏)

- **FPS**: 远端 Chromium 截图帧率 (目标 18-20fps)
- **BW**: 下行带宽 (KB/s)。增量模式下远低于全帧
- **帧类型**: `KEYFRAME` (全量) / `DIFF` (增量)
- **RTT**: WebSocket 往返延迟 (~5s 更新一次)

## 项目结构

```
paintop-prototype/
├── Dockerfile
├── docker-compose.yml
├── README.md
├── server/
│   ├── server.py              # aiohttp HTTP + WS 服务器 (延迟启动)
│   ├── protocol.py            # PaintOp 二进制协议编解码
│   ├── chromium_manager.py    # Playwright 控制 + 帧差引擎
│   └── requirements.txt
├── client/
│   └── index.html             # 单文件 (门户页 + 浏览器 双模式)
└── docs/
    ├── websocket-vs-webrtc.md    # 通信协议决策
    └── architecture-test-mode.md # 测试部署架构
```

## 关键设计决策

### Chromium 按需启动

WebSocket 连接建立时 **不会** 自动启动 Chromium。客户端先展示网站选择器，用户选定网站后发送 `{"type":"navigate","url":"..."}` 指令，服务端才启动 Chromium。

好处：
- 资源利用率——只有真正需要浏览时才占用 500MB+ 的 Chromium 进程
- 用户体验——用户可以浏览门户页，不必等 Chromium 冷启动

### 协议摘要

```
单条 WebSocket (wss://host/ws)

Binary: PaintOp 帧 (S→C)     — Magic "PS" + Header + Tile[] + Data
Binary: HID 事件  (C→S)      — Type + JSON payload
Text:   控制消息  (双向)      — {"type":"navigate","url":"..."}
```

## 当前限制 (原型阶段)

- 音频不支持 (Chromium headless 限制)
- 视频播放帧率有限 (截图瓶颈，非 cc 层拦截)
- 单用户 (一个 WebSocket = 一个 Chromium)
- 无身份认证
- CanvasKit/WebGPU 客户端渲染未接入

## 下一步

1. 将 `chromium_manager.py` 的截图替换为真实的 `cc::DisplayItemList::Finalize()` 拦截
2. 客户端接入 CanvasKit WASM (像素级 Skia 回放)
3. 引入 WebGPU 路径 (高性能 GPU 渲染)
4. 多会话池化 + 身份认证
