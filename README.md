# Wison-RBI — 远程浏览器隔离系统

> 轻量级 Remote Browser Isolation | Node.js + Playwright + CanvasKit

Wison-RBI 在服务端运行无头 Chromium，通过 JPEG 瓦片差分编码将页面实时传输到客户端浏览器。用户交互反向注入，形成完整闭环。

```
服务端 (Node.js)                    客户端 (浏览器)
┌─────────────────┐              ┌─────────────────┐
│ Chromium        │              │ CanvasKit       │
│   ↓ screenshot  │   JPEG tiles │   ↓ drawImage   │
│ sharp MD5 diff  │──────────────│ 滚动平移优化     │
│   ↓ JPEG encode │   WebSocket  │   ↓ 显示        │
│ FrameEncoder    │              │ HIDCapture      │
└─────────────────┘              └─────────────────┘
        ↑                              │
        │       HID events             │
        └──────────────────────────────┘
```

## 特性

- **零带宽静态页面** — 瓦片 MD5 差分，无变化不传输
- **滚动平移优化** — `makeImageSnapshot` + `canvas.translate`，消除撕裂
- **三层安全** — CRC32 完整性 + 命令白名单 + Token 认证
- **零 Chromium 修改** — 标准 Playwright，`npm install` 即用
- **渐进增强** — WebGL GPU → 软件 Canvas 自动降级

## 快速开始

```bash
git clone https://github.com/laolv2023/wison-rbi.git
cd wison-rbi && npm install
npx playwright install chromium
node packages/server/src/index.js
# 浏览器打开 http://localhost:8080
```

## 项目结构

```
packages/
├── protocol/        共享协议 (Node + 浏览器)
│   └── src/         constants / encoder / decoder / validator
├── server/          服务端
│   └── src/         ws-server / session / frame-capture / cdp-client / input-proxy
└── client/          客户端 (纯静态)
    └── src/         connection / renderer / hid-capture
docs/                设计 + 开发 + 部署 + 使用文档
```

## 文档

| 文档 | 说明 |
|------|------|
| [DESIGN.md](docs/DESIGN.md) | 架构设计、数据流、安全模型 |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | 环境搭建、开发工作流 |
| [DEPLOY.md](docs/DEPLOY.md) | Docker/裸机部署、Nginx、监控 |
| [CONFIG.md](docs/CONFIG.md) | 全部环境变量参考 |
| [USAGE.md](docs/USAGE.md) | 客户端操作指南 |
| [TROUBLESHOOT.md](docs/TROUBLESHOOT.md) | 排障手册 |
| [TEST.md](docs/TEST.md) | 测试套件说明 |

## 技术栈

| 层 | 选择 | 理由 |
|----|------|------|
| 浏览器引擎 | Playwright + Chromium | 自动管理、CDP 连接稳定 |
| 图像处理 | sharp (libvips) | C 扩展，10-50× 快于纯 JS |
| 客户端渲染 | CanvasKit 0.39.1 (Skia WASM) | WebGL/GPU 加速 + 软件降级 |
| 传输 | ws (WebSocket) | 原生二进制帧、低开销 |
| 日志 | pino | 极低开销结构化日志 |
| 测试 | node:test | 零依赖 |

## 许可证

MIT
