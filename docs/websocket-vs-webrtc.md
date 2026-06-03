# WebSocket vs WebRTC — PaintOp Remote Browser 通信协议决策

## 结论：WebSocket 为主协议，WebRTC 为可选媒体扩展

```
         ┌──────────────────────────────────────────────┐
         │           单一 WebSocket 连接                  │
         │                                              │
         │  ┌──────────────────────────────────────┐    │
         │  │  Binary: PaintOp 帧流 (S→C)          │    │
         │  │  Binary: HID 事件 (C→S)              │    │
         │  │  Text:   控制指令 (双向)             │    │
         │  └──────────────────────────────────────┘    │
         │                                              │
         │  未来可选: 独立 WebRTC DataChannel            │
         │  ┌──────────────────────────────────────┐    │
         │  │  音视频流 (lossy, low-latency)        │    │
         │  └──────────────────────────────────────┘    │
         └──────────────────────────────────────────────┘
```

## 决策矩阵

| 维度 | WebSocket | WebRTC DataChannel | 结论 |
|------|-----------|-------------------|------|
| **可靠性** | ✅ TCP 保证送达 | ⚠️ SCTP 可选可靠模式 (默认可靠) | WebSocket 更简单 |
| **顺序性** | ✅ TCP 严格有序 | ⚠️ 可配置无序/部分可靠 (默认有序) | 打平 |
| **NAT 穿透** | ✅ 通过 HTTP Upgrade，天然过代理 | ❌ 需要 STUN/TURN 基础设施 | **WebSocket 胜出** |
| **部署复杂度** | ✅ 零配置 | ❌ STUN + TURN 服务器 | **WebSocket 胜出** |
| **二进制流效率** | ✅ 无额外开销 | ⚠️ SCTP 头 + DTLS 封装 | WebSocket 小幅领先 |
| **UDP 媒体流** | ❌ 不支持 | ✅ RTP 原生支持 | WebRTC 胜出，但非 PaintOp 所需 |
| **P2P 直连** | ❌ 不支持 | ✅ 可打洞直连 | 本场景服务端始终在，不需要 P2P |
| **拥塞控制** | ⚠️ TCP 内置，不可调 | ✅ 可配，有 GCC | 打平（PaintOp 用可靠通道都一样） |

## 核心论证：为什么 PaintOp 不需要 WebRTC

```
PaintOp 帧流的关键特性：

  帧 N        帧 N+1       帧 N+2
  ┌────┐     ┌────┐       ┌────┐
  │Op1 │     │Op1 │       │Op1 │
  │Op2 │ ──▶ │Op3 │ ────▶ │Op2 │
  │Op3 │     │Op4 │       │Op5 │
  └────┘     └────┘       └────┘
     │          │            │
     ▼          ▼            ▼
  如果丢了 Op2，整个帧的状态机就断了

  ❌ 不可丢帧，不可乱序
  ❌ 不需要 UDP 的低延迟特性（TCP 的延迟完全够用）
  ❌ 不需要 P2P（客户端-服务端就是 C/S 模型）
```

- PaintOp 是**有状态绘制指令流** —— DrawRect 之后才能 DrawText 在上面，丢失任何一个 Op 整帧错误。
- WebRTC 的优势在于 **UDP 媒体流**（丢几帧不影响观看），这对 PaintOp 没用。
- WebSocket 通过 HTTP/2 Upgrade 天然穿透企业代理，WebRTC 需要额外部署 STUN/TURN，运维成本高一个量级。

## 最终架构

```
┌─ 客户端 ─┐                                    ┌─ 服务端 ─┐
│           │  wss://server/ws                   │           │
│  Canvas   │◄═══ Binary: PaintOp 帧 ─══════════│ Chromium  │
│           │                                    │           │
│  HID 事件 │════ Binary: 鼠标/键盘/触摸 ═══════▶│ Playwright│
│           │                                    │           │
│  控制层   │◄═══ Text/JSON: navigate/resize ══▶│ 会话管理  │
│           │                                    │           │
└───────────┘                                    └───────────┘
          ▲                                            ▲
          └──────── 单条 WebSocket 连接 ───────────────┘
                (wss://, 二进制 + 文本帧混用)
```

**一句话**: PaintOp 流对可靠性的要求与 WebSocket 的 TCP 语义完美匹配，WebRTC 的 UDP/P2P 能力在本场景属于过度设计。
