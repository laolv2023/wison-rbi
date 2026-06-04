# 第三轮全量代码审计方案

> 目标：审计未覆盖的 **跨界耦合 × 修复验证 × 类型安全 × 错误传播 × 协议脆弱性**
> 确保修复不引入回归，且发现前两轮盲区。

## 新七维度（与前两轮正交矩阵确认）

| 维度 | 第一轮 | 第二轮 | 第三轮 | 正交性 |
|------|--------|--------|--------|--------|
| 输入校验 | ✅ | — | — | 不重复 |
| 认证授权 | ✅ | — | — | 不重复 |
| 资源管理 | ✅ | — | — | 不重复 |
| 数据流完整性 | — | ✅ | — | 不重复 |
| 状态机 | — | ✅ | — | 不重复 |
| 协议兼容性 | — | ✅ | — | 不重复 |
| **1. 修复验证 (Fix Verification)** | — | — | ✅ | 全新 |
| **2. 隐式耦合 (Implicit Coupling)** | — | — | ✅ | 全新 |
| **3. 类型安全 (Type Safety)** | — | — | ✅ | 全新 |
| **4. 侧信道 (Side Channel)** | — | — | ✅ | 全新 |
| **5. 错误传播 (Error Propagation)** | — | — | ✅ | 全新 |
| **6. 观察者效应 (Observer Effect)** | — | — | ✅ | 全新 |
| **7. 协议脆弱性 (Protocol Fragility)** | — | — | ✅ | 全新 |

---

## 维度说明

### V1: 修复验证 (Fix Verification)
检测 v1.7 的 28 项修复是否正确、完整、无回归。

- [ ] `commandOffset` 是否在 decoder 的 decode 中被正确追踪（确认 off 在命令起始处）
- [ ] `verifyCRC32` 对空帧、损坏帧的行为
- [ ] `forceKeyframe` 是否在 `_reapIdleSessions` 或 session 重启后正确重置
- [ ] `_cleanedSessions` 是否会在长时间运行中无限增长
- [ ] `_capturing` 互斥锁是否在异常路径下正确释放
- [ ] `Buffer.slice()` 在 `extractCommandPayload` 中是否引入额外内存压力
- [ ] URL 校验是否在 `start()` 中也有一层防御
- [ ] token 认证后 session 创建前是否有竞态（认证通过 → 创建 session 之间）

### V2: 隐式耦合 (Implicit Coupling)
检测模块间的隐含依赖——一个模块对另一个模块内部状态的假设。

- [ ] `ws-server.js` 访问 `session._authenticated` ——模块边界是否被突破？
- [ ] `ws-server.js` 访问 `session._capture` （通过 session.forceKeyframe）
- [ ] `session.js` 通过 `require('../../protocol/src/encoder')` 引用 protocol——硬编码路径
- [ ] `index.js` 访问 `wsServer._sessions` ——私有属性暴露
- [ ] FrameCapture 和 Renderer 通过 `TileEncoding` 常量耦合——两者必须升级同步
- [ ] Session 构造函数参数 `onFrame` 回调类型——回调中调用 `_sendFrame` → `ws.send` → 回调链深层

### V3: 类型安全 (Type Safety)
JavaScript 弱类型导致的隐蔽缺陷。

- [ ] 所有 `=== 0` 检查——NaN 和 -0 的特殊行为
- [ ] `||` 默认值模式——`0 || 1280` 返回 1280（0 是合法值）
- [ ] `& 0xFFFF` 截断——合法值被截断为 0
- [ ] `Math.round(undefined)` → NaN
- [ ] `Array(length)` 负值参数——`new Array(-1)` 抛出 RangeError
- [ ] `@` 类型注释与实际类型不匹配（JSDoc 与实际值）
- [ ] `sessionId` 从 `Math.random()` 改为 `crypto.randomUUID()` 的兼容性
- [ ] `typeof module !== 'undefined'` 与 UMD 导出的一致性

### V4: 侧信道 (Side Channel)
- [ ] auth token 比较使用 `timingSafeEqual` ——若两个 buffer 长度不同呢？
- [ ] 日志是否记录敏感信息（token、sessionId、用户 URL 中的认证信息）
- [ ] `_computeDirtyTiles` 的 tile hash 是否暴露页面内容指纹
- [ ] WebSocket 的帧大小/时间暴露浏览行为模式
- [ ] CanvasKit 渲染时间是否暴露秘密（像素差异）

### V5: 错误传播 (Error Propagation)
追踪每个错误从源到最终处理的全路径。

- [ ] decoder `decode()` 抛出 `DecodeError` → `renderer.render()` try/catch → 返回 `{rendered: false}` → 被谁处理？
- [ ] validator `scan()` 返回 `{valid: false}` → renderer 增加 rejectionCount → 达到阈值 → request_keyframe → 谁处理这个响应？
- [ ] encoder `finalize()` 抛出 Error → `_captureFrame()` .catch → markFailure → 重启 Chromium
- [ ] `session.start()` 抛出错误 → `_handleControl` catch → 只日志，不通知客户端
- [ ] `CDP` 连接失败 → client.send() 超时 → 谁捕获并恢复？
- [ ] `page.screenshot()` 在 page 关闭后抛出 → 仅 `.catch` 在 tick 中 → 可能 `unhandledRejection`
- [ ] `sharp.toBuffer()` 失败 → capture() 抛出 → tick.catch → markFailure → 10次后重启

### V6: 观察者效应 (Observer Effect)
监控/日志/指标是否改变了系统行为。

- [ ] `ws._wisonSessionId` —— 附加属性是否被 `ws` 库清理
- [ ] `ws._wisonCleanedUp` / `ws._wisonAuthenticated` —— 同上
- [ ] `_cleanedSessions` Set 无界增长（只添加不清除）
- [ ] `_ipConnections` Map 中 key 的存活期
- [ ] `_heartbeats` Map 中已销毁会话的清理

### V7: 协议脆弱性 (Protocol Fragility)
协议版本不兼容场景。

- [ ] 版本字段是否真的会被检查（decoder 检查了，然后呢？）
- [ ] 协议演进策略：服务端升级后，旧客户端连接会怎样
- [ ] 客户端升级后，旧服务端帧会被怎样处理
- [ ] 帧头 `flags` 字段全零——预留位未来的扩展兼容性
- [ ] HID 协议无版本号——客户端 HID 格式变更后，服务端如何处理

---

## 文件清单 (23 个源文件)

| 文件 | 变化 | 审计重点 |
|------|------|---------|
| `protocol/decoder.js` | 新增 commandOffset+CRC32 | V1 修复验证 |
| `client/renderer.js` | cmdView+CRC32 验证 | V1 修复验证 |
| `server/frame-capture.js` | PNG+tilehash+sharp顶置 | V1+V2 |
| `server/session.js` | _capturing+forceKeyframe | V1+V5 |
| `server/ws-server.js` | auth+request_keyframe+_cleanedSessions | V1+V2+V6 |
| `server/input-proxy.js` | payload 校验 | V1 |
| `server/index.js` | 静态文件 + logger | V2+V4 |
| `server/cdp-client.js` | CDP 重试 | V5 |
| `client/hid-capture.js` | NaN 防护 | V3 |
| `client/connection.js` | auth + 重连 | V2+V3 |
| `client/index.html` | CanvasKit CDN | V4 |
| `protocol/constants.js` | 全部常量 | V3+V7 |
| `protocol/encoder.js` | 无变化 | V2+V3 |
| `protocol/validator.js` | 无变化 | V3 |
| 配置/工程文件 | package.json/Docker | V2 |
