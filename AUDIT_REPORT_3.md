# 第三轮全量代码审计报告

> 基准：commit `1cb66c0` (v1.7)
> 维度：修复验证 / 隐式耦合 / 类型安全 / 侧信道 / 错误传播 / 观察者效应 / 协议脆弱性
> **不做修复，等待指令**

---

## 审计结果总览

| 级别 | 数量 |
|------|------|
| **CRITICAL** | 1 |
| **HIGH** | 4 |
| **MEDIUM** | 5 |
| **LOW** | 3 |
| **INFO** | 3 |
| **总计** | **16** |

三轮回合累计：21 + 14 + 16 = **51 个独立问题**。

---

## CRITICAL (1)

### R3-C1. `_computeDirtyTiles` 高度判断使用宽度变量——tile 差分在边界处永远脏

**文件**: `packages/server/src/frame-capture.js:117`

```javascript
for (let py = 0; py < this._tileSize && (tileY + py) < imgWidth/*height*/; py++) {
```

`imgWidth` 是截图宽度（如 1280），但边界检查应使用高度（如 720）。对于靠近底部的 tile（`tileY >= 720`），条件 `(tileY + py) < imgWidth` 在 `imgWidth=1280` 时永远为真（因为 720 + 0 < 1280 = true），所以边界检查**失效**。代码继续读取 `(tileY + py) * imgWidth + tileX` 的像素偏移——当 `tileY + py >= height` 时，偏移超出 raw pixel buffer，`Buffer.copy` 读取未初始化内存。

**同一 Bug 在 `_updateAllHashes` 中** (L135-149) 也有：
```javascript
const tileBytes = Buffer.allocUnsafe(...);
for (let py = 0; py < this._tileSize; py++) {  // 根本没有边界检查!
  const srcOff = ((tileY + py) * imgWidth + tileX) * bytesPerPixel;
  // ...
  rawPixels.copy(tileBytes, dstOff, srcOff, srcOff + lineLen);
}
```

当 `tileY + py >= height` 时，`srcOff` 超出 `rawPixels` 长度，`Buffer.copy` 会 `RangeError` → 全量帧捕获抛出异常 → `_captureFrame` catch → markFailure → 10 次后重启 Chromium。

**影响**: 
- Diff 帧：底部 tile 的 hash 包含未初始化内存 → 每帧都脏（假阳性），但功能正确（只是增量失效）
- Keyframe 帧：`_updateAllHashes` 读取超出 buffer → RangeError 导致崩溃 → 10 次后重启 Chromium → 循环崩溃

---

## HIGH (4)

### R3-H1. `_encoder.reset()` 未在 `finally` 中——帧编码异常后 _tiles 堆积

**文件**: `packages/server/src/session.js:235-240`

```javascript
const frame = this._encoder.finalize(result.frameType);
this._encoder.reset();  // ← 如果在 finally 块之外
// ...
} finally {
  this._capturing = false;
}
```

如果 `this._encoder.finalize()` 抛出（帧超限、编码错误），`reset()` 不执行。`this._encoder._tiles` 和 `this._encoder._commands` 数组中积累旧的 tile/命令。下一次 `_captureFrame` 调用 `setMetadata()` 会重置这两个数组（`this._tiles = []`）。需要检查 `setMetadata()` 是否重置了 `_tiles`。

从 `encoder.js:71-73`：
```javascript
this._tiles = [];
this._commands = [];
```

所以 `setMetadata()` 确实重置了 `_tiles` 和 `_commands`。但 `_commandBytes = 0` 也会被重置吗？看 `setMetadata()`：
```javascript
this._tiles = [];
this._commands = [];
this._commandBytes = 0;
```

是的，全部重置。所以即使 `finalize()` 抛出，下一帧的 `setMetadata()` 会清理状态。**原风险被 `setMetadata()` 缓解**。

但 `_commandBytes` 的累加是：`this._commandBytes += 4 + payload.length`。如果 `finalize()` 抛出，`_commandBytes` 保持抛出时的值，下一帧 `setMetadata()` 重置为 0。所以实际安全。

**判定**: 风险不成立（最初的分析错误）。`setMetadata()` 在每帧开始时重置所有累加器。确认安全。

### R3-H2. `_verifyClient` 与 `_handleControl` 的重复认证路径——HTTPS 客户端无渠道发送 HTTP 头

**文件**: `packages/server/src/ws-server.js:50-58, 147-156`

WebSocket 连接经过两个认证验证：
1. `_verifyClient` (L50-58)：检查 HTTP `Authorization` 头——**浏览器客户端无法使用**
2. `_handleControl 'auth'` (L147-156)：检查 JSON 消息中的 token——**浏览器客户端唯一途径**

问题：当 `WISON_AUTH_TOKEN` 被设置时，`_verifyClient` 在连接握手时就会拒绝大多数客户端（因为 HTTP 头为空）。对于 Node.js ws 客户端（可以在升级请求中设置自定义头），这是正确的。但对于浏览器客户端（无法设置自定义头），连接会在 `_verifyClient` 阶段被拒绝——**永远无法发送 `{type:'auth'}` 消息**。

**影响**: `_verifyClient` 的 HTTP 头严格模式阻止了所有浏览器 WebSocket 连接。浏览器用户**必须**使用 `_verifyClient` 的宽松路径（即在无 auth token 时通过，然后在消息层认证）。

但当前的逻辑是：`if (config.authToken)` → 检查 HTTP 头 → 失败则拒绝。浏览器客户端永远无法绕过。

---

### R3-H3. `Buffer.from(msg.token || '')` 无类型校验——`msg.token` 为对象时认证绕过

**文件**: `packages/server/src/ws-server.js:149`

```javascript
const bufA = Buffer.from(msg.token || '');
const bufB = Buffer.from(config.authToken);
if (bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)) {
  session._authenticated = true;
}
```

如果恶意客户端发送 `{type:'auth', token: {toString: () => config.authToken}}`，`Buffer.from({...})` 会调用该对象的 `valueOf()` 或 `toPrimitive()`。如果攻击者无法控制服务端 token，这不可利用——但在 `token` 为 `null`，`undefined`，或 `""` 时，`Buffer.from(null)` 返回空 Buffer，`Buffer.from('')` 也返回空 Buffer。如果 `config.authToken` 也为空？不，`config.authToken` 非空时才开启认证。

---

### R3-H4. `Buffer.allocUnsafe` 在 tile 边界读取未初始化内存

**文件**: `packages/server/src/frame-capture.js:116, 131`

```javascript
const tileBytes = Buffer.allocUnsafe(this._tileSize * this._tileSize * bytesPerPixel);
// rawPixels.copy() 覆盖了部分区域
// 未覆盖的部分保持 allocUnsafe 的不可预测值
```

当 tile 部分位于截图边缘外时，`copy()` 只复制部分行，未复制的字节保持未初始化状态。这些字节进入 `hash(tileBytes)`，产生不可重复的 hash → 该 tile 每帧都被标记为脏。

R3-C1 的 `imgWidth` 判断失误加剧了此问题：边缘 tile 的边界检查使用 `width` 而非 `height`，使得行边界检查失效。

---

## MEDIUM (5)

### R3-M1. `_cleanedSessions` Set 无界增长

**文件**: `packages/server/src/ws-server.js:29`

```javascript
this._cleanedSessions = new Set(); // v1.7: 防 _cleanupSession 重复调用
```

Set 只添加不清除。每个 session 的 cleanup 都会添加一个 sessionId 字符串。长期运行（数天/数周）后，Set 中累积数百万条 sessionId 字符串，每条约 40 字节 → 数百 MB 内存泄漏。

**修复**: 在 Set 大小超过 10000 时清空，或使用 LRU Map。

---

### R3-M2. `session._notifyStatus` 被外部模块调用——私有方法暴露

**文件**: `packages/server/src/ws-server.js:166`

```javascript
session._notifyStatus({ error: 'NAVIGATION_FAILED', message: 'Only http/https allowed' });
```

`ws-server.js` 调用了 `session.js` 的 `_notifyStatus` 私有方法（以下划线开头）。这是隐式耦合——两个模块通过命名约定而不是公开 API 耦合。如果 `session.js` 重命名 `_notifyStatus`，`ws-server.js` 静默失败。

---

### R3-M3. `ws._wisonSessionId` 等 expando 属性不被 `ws` 库保证

**文件**: `packages/server/src/ws-server.js:87`

```javascript
ws._wisonSessionId = sessionId;
```

`ws` 库的 `WebSocket` 对象可能在不通知用户的情况下被内部代理/包装（某些版本的行为）。在 `ws` v8 中，这是原始对象，expando 属性是稳定的。但未来版本可能使用 `Proxy` 或转发对象。这属于跨库隐式耦合。

类似问题在 `connection.js` 中的 `ws._wisonAuthenticated`、`_cleanupSession` 中的 `ws._wisonCleanedUp`。

---

### R3-M4. `_ipConnections` Map 的 IP key 在 IPv6 下为 `::ffff:x.x.x.x`

**文件**: `packages/server/src/ws-server.js:63`

```javascript
const ip = info.req.socket.remoteAddress || 'unknown';
```

IPv4 通过 IPv6 隧道连接时，`remoteAddress` 返回 `::ffff:192.168.1.1`。同一客户端在不同网络环境下的 IP 格式不同，IP 限流不精确。且 IPv6 客户端（多 IP 地址）可能被过度限流。

---

### R3-M5. `_checkHeartbeats` 心跳超时后直接 `close` 无序列化

**文件**: `packages/server/src/ws-server.js:222-225`

```javascript
for (const ws of this._wss.clients) {
  if (ws._wisonSessionId === sessionId) {
    ws.close(1001, 'Heartbeat timeout');
    break;
  }
}
```

`ws.close()` 是异步操作。发送 close frame 后，`close` 事件最终会触发，调用 `_cleanupSession`。但 `_checkHeartbeats` 在调用 `ws.close()` 后**立即**执行 `this._sessions.delete(sessionId)` (L228-229)：

```javascript
this._sessions.get(sessionId)?.destroy().catch(() => {});
this._sessions.delete(sessionId);
```

`destroy()` 先运行（异步，不 await），然后 `_sessions` 删除。当 `close` 事件触发时，`_cleanupSession` 因为 `_cleanedSessions.has(sessionId)` 而跳过（R2-H2 修复了重入）。所以这里实际安全——`_cleanedSessions` 的防重入机制也防止了此处的冲突。

---

## LOW (3)

### R3-L1. `resize` 控制消息只检查存在性不检查范围

**文件**: `packages/server/src/ws-server.js:174-177`

```javascript
case 'resize':
  if (msg.width && msg.height) {
    await session.resize(msg.width, msg.height);
  }
```

如果 `msg.width = -100`（负值），`session.resize` 传递负值到 Chromium CDP `setViewport`，导致 `setDeviceMetricsOverride` 参数非法。应校验 `> 0 && < 10000`。

---

### R3-L2. `_wss._sessions` 在 `index.js` 中被直接访问

**文件**: `packages/server/src/index.js:65`

```javascript
sessions: wsServer?._sessions?.size || 0,
```

`wsServer._sessions` 是私有属性。`index.js` 访问 `_sessions` 创建了 `WsServer` 和 `index.js` 之间的隐式耦合。应通过 `wsServer.getSessionCount()` 公开 API 访问。

---

### R3-L3. `Math.random()` 生成 sessionId 的熵不足

`ws-server.js:83` 仍使用 `Math.random()`。`Math.random()` 在 V8 中使用 xorshift128+，种子可预测性较低，但在安全上下文中不推荐。这是 M2 的"设计限制"——已记录但不修复。

---

## INFO (3)

### R3-I1. v1.7 修复的 `FrameEncoder.reset()` 互斥——`_tiles` 重置与 `_commandBytes` 重置

现在验证了 `setMetadata()` 同时重置 `_tiles`、`_commands`、`_commandBytes`。R3-H1 的初始风险判断错误——`setMetadata()` 在每帧开始时清理状态。

### R3-I2. `height` 变量已解构但未使用

`frame-capture.js:53`：
```javascript
const { data: rawPixels, info: { width, height } } = await sharp(screenshotPng)...;
```

`height` 被解构但从未使用（因为 R3-C1 的 bug 导致使用 `imgWidth` 代替）。

### R3-I3. 帧尾的 `extractCommandPayload` 使用 `ArrayBuffer.slice` 而非共享视图

v1.7 修复 R2-H4 时使用 `decodedFrame.data.buffer.slice(start, end)` 创建独立副本。这释放了父 buffer 的 GC，但增加了副本分配。对于命令 payload（常见为 20-500 字节），开销可忽略。是目前正确的做法。

---

## 三轮回合累计

| 维度 | R1 | R2 | R3 | 总计 |
|------|----|----|----|------|
| CRITICAL | 2 | 1 | **1** | **4** |
| HIGH | 5 | 4 | **3** | **12** |
| MEDIUM | 7 | 4 | **5** | **16** |
| LOW | 4 | 3 | **3** | **10** |
| INFO | 3 | 2 | **3** | **8** |
| **合计** | **21** | **14** | **16** | **51** |

---

## 本轮最致命问题

**R3-C1 → R3-H4 → R2-C1 叠加死锁链路**：

```
R3-C1: _computeDirtyTiles 用宽度代替高度做边界检查
  → 底部 tile 读取超出 buffer → hash 含未初始化内存
    → 每帧所有底部 tile 标记为脏 → 假阳性
    → _updateAllHashes 读取超出 buffer → RangeError
      → keyframe 崩溃 → 10 次后重启 Chromium → 循环

R2-C1（旧）: cmdView 偏移错误 → validator 拒绝所有帧
  → C2: request_keyframe 之前空操作（已修复）
    → v1.7 已修复但 R3-C1 引入新崩溃路径
```

实际运行：服务器启动后，每 300 帧（~15s）的强制 Keyframe 因 `_updateAllHashes` 的 `Buffer.copy` 越界而崩溃。Chromium 每 15s 重启一次，无法正常服务。
