# 35 项问题修复方案

## 修复优先级排序（按致命度→影响面→改动代价）

### ⚡ 请求人工确认 (2 项)
| ID | 问题 | 改动范围 | 风险 |
|----|------|---------|------|
| ❓R2-M1 | renderer.js Paint 只解析 4 字节颜色→需解析完整 SkPaint (strokeWidth/blendMode/antiAlias等 ~10字段) | renderer.js `_dispatch` 中所有 shape case (~60行) | 高：涉及 CanvasKit Paint API，参数顺序/默认值与 Skia 序列化格式需精确对应 |
| ❓H1 | tile 差分完全失效→需逐 tile 做真实 hash 对比 | frame-capture.js `_computeDirtyTiles` (~20行) | 中：算法重写，但输入输出接口不变 |

### 第一批：CRITICAL (3 项，必须修)
| ID | 文件 | 改动行数 | 修复方式 |
|----|------|---------|---------|
| R2-C1 | renderer.js:63 | 1行 | 偏移添加 `ΣtileDataLen` |
| C2 | ws-server.js + session.js + frame-capture.js | ~10行 | 增加 `forceKeyframe()` API；_handleControl 调用 |
| C1 | ws-server.js | ~5行 | _handleControl 增加 `case 'auth'` |

### 第二批：HIGH (6 项)
| ID | 文件 | 改动行数 | 修复方式 |
|----|------|---------|---------|
| H2 | (合并到 C2) | — | — |
| H3 | session.js | ~3行 | _captureFrame 增加 `_running` 检查 |
| H4 | ws-server.js | ~10行 | URL scheme/host 白名单校验 |
| H5 | frame-capture.js | ~2行 | sharp import 移到模块顶部 |
| R2-H1 | renderer.js | ~5行 | decode 后校验 CRC32 |
| R2-H2 | ws-server.js | ~5行 | _cleanupSession 增加 `_cleanupInvoked` 标记 |
| R2-H4 | decoder.js | ~3行 | extractCommandPayload 返回独立 buffer 副本 |

### 第三批：MEDIUM (9 项)
| ID | 文件 | 修复方式 |
|----|------|---------|
| M1 | ws-server.js | `crypto.timingSafeEqual` |
| M2 | ws-server.js | `crypto.randomUUID()` |
| M3 | ws-server.js | _checkHeartbeats 操作副本 |
| M4 | ws-server.js | _reapIdleSessions 改为 await destroy |
| M5 | ws-server.js | ws.send() 套 try/catch |
| M6 | input-proxy.js | payload 字段类型校验 |
| M7 | (嵌套在 R2-C1) | — |
| R2-M3 | session.js | _captureFrame 增加互斥锁 |
| R2-M4 | ws-server.js | ws.send 套 try/catch (合并到 M5) |

### 第四批：LOW / INFO (8 项)
| ID | 文件 | 修复方式 |
|----|------|---------|
| L1 | renderer.js | diff 前 canvas.clear() |
| L2 | renderer.js | Paint 在 restore 后 delete |
| L3 | ws-server.js | terminate→close |
| L4 | index.html | 接入 frame-buffer 到 HID 坐标转换 |
| R2-L1 | ws-server.js | 遍历 _wss.clients 前复制到数组 |
| R2-L2 | hid-capture.js | rect 零值检查 |
| I1 | docker-compose.yml | 注释说明 |
| I2 | index.html | 添加 SRI integrity |

## 不改的项目 (5 项)
| ID | 原因 |
|----|------|
| R2-M2 | BigInt→Number 精度已验证 OK |
| R2-L3 | latest() 已正确处理 |
| R2-I1 | 伪差分是 H1 的同一问题 |
| R2-I2 | 与 H1 相同根因 |
| R2-H3 | 与 H4 重复 |
