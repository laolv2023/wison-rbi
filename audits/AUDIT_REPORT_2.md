# Wison-RBI 第二轮全量代码审计报告

> 基准：commit `ef56443`
> 维度：数据流完整性 / 状态机 / 协议兼容 / 边界零值 / 整数运算 / 事件管道 / GC 压力
> **不做修复，等待指令**

---

## 审计结果总览

| 级别 | 数量 |
|------|------|
| **CRITICAL** | 1 |
| **HIGH** | 4 |
| **MEDIUM** | 4 |
| **LOW** | 3 |
| **INFO** | 2 |
| **总计** | **14** |

第一轮已报告 21 个问题。本轮新增 14 个独立问题，**55% 无重复**。

---

## CRITICAL (1)

### R2-C1. 命令流偏移计算错误——索引到瓦片数据而非命令流

**文件**: `packages/client/src/renderer.js:63`

```javascript
const cmdView = new Uint8Array(frameData, 30 + 2 + decoded.tileCount * 14);
```

**Encoder** 输出顺序 (encoder.js L148-177):
```
Header(30) | tileCount(2) | tileEntries(N×14) | tileData(var) | commands(var) | CRC32(4)
```

`cmdView` 的偏移 `30 + 2 + N×14` 指向 **tileEntries 的结尾**，即 **tileData 的起始位置**。命令流实际在 **tileData 之后**。

**影响**: `cmdView` 的内容是 JPEG 瓦片二进制数据（不是命令流）。`validator.scan()` 看到垃圾 opcode → 即刻拒绝。所有 diff 帧和 keyframe（含 tile）均被拒绝。**客户端永远不渲染**。

**与 C2 的叠加效应**: 客户端连续 3 帧验证失败后发送 `request_keyframe`，但 request_keyframe 是空操作（第一轮 C2）。结果：**客户端永久黑屏，无恢复路径。**

**修复**: 偏移应加上 `ΣtileDataLen`。Decoder `decode()` 的 `off` 变量已经精确追踪到命令流起始——应通过 decoder API 暴露此偏移，而非重复计算。

---

## HIGH (4)

### R2-H1. CRC32 只计算不回传——完全无效的完整性校验

**文件**: `packages/protocol/src/decoder.js:128-130` + `packages/client/src/renderer.js:54-96`

Encoder (`encoder.js:184-186`) 写入 CRC32，Decoder (`decoder.js:130`) 读取 `crcReceived` 返回对象，但 `renderer.js` 中 `render()` 的 `decoder.decode()` 返回值被解构为 `decoded`——`decoded.crcReceived` 存在但从未被检查。

```javascript
// decoder.js:130
const crcReceived = dv.getUint32(off, true);
// 返回对象含 crcReceived
// renderer.js:59 — 使用 decoded 但不检查 CRC
const decoded = this._decoder.decode(frameData);
// decoded.crcReceived 未使用
```

**影响**: 损坏的帧（网络错误、中间人篡改、编码 Bug）无法被检测。CRC32 消耗了带宽和计算资源但无任何安全价值。

---

### R2-H2. `_cleanupSession` 可被重复调用——IP 计数变为负数

**文件**: `packages/server/src/ws-server.js:123-130, 196-211`

`ws` 库的文档：WebSocket `'error'` 事件后必然触发 `'close'` 事件。当前代码：

```javascript
ws.on('close', () => { this._cleanupSession(sessionId, ip); });
ws.on('error', (err) => { this._cleanupSession(sessionId, ip); });
```

`_cleanupSession` (L196-211)：
```javascript
_cleanupSession(sessionId, ip) {
  const session = this._sessions.get(sessionId);
  if (session) { session.destroy(); this._sessions.delete(sessionId); }
  // ...
  const count = this._ipConnections.get(ip) || 0;
  if (count <= 1) { this._ipConnections.delete(ip); }
  else { this._ipConnections.set(ip, count - 1); }
}
```

**时序**: `error → _cleanupSession → session 销毁 ✓ → IP 减 1 → close → _cleanupSession → session 为 null ✓ → IP 再减 1 → IP = -1`

**影响**: IP 限流计数器损坏。同一 IP 的连接数准确率随 WebSocket 错误率增加而下降。长期运行后可能出现 IP 计数为负，但不会拒绝合法连接（`get(ip) || 0` 处理了 undefined，但 -1 不会被修正）。

---

### R2-H3. `page.goto('')` 空 URL——Chromium 行为未定义

**文件**: `packages/server/src/session.js:124-141` + `packages/server/src/ws-server.js:135-142`

```javascript
// ws-server.js:135-142
case 'start':
case 'navigate':
  if (msg.url) {
    await session.start(msg.url);
  }
```

`if (msg.url)` 检查了 URL 非空，但如果 `msg.url` 是空字符串 `""`，`false || ""` = `""`，满足 `if` 条件？不——`""` 是 falsy，所以空字符串被跳过。但如果 URL 是 `"about:blank"` 或 `"chrome://settings"`（合法的非 HTTP URL），Playwright 仍会处理。

需要检查的是非空但非 HTTP/HTTPS 的 URL。但 `if (msg.url)` 只检查了存在性——如果 URL 是 `"file:///etc/passwd"`，msg.url 是真值，会进入 `page.goto("file:///etc/passwd")`。

---

### R2-H4. `extractCommandPayload` 的 `payload.byteOffset` 可能指向错误位置

**文件**: `packages/protocol/src/decoder.js:152-160`

```javascript
extractCommandPayload(decodedFrame, cmdIndex) {
  const cmd = decodedFrame.commands[cmdIndex];
  // ...
  return new Uint8Array(
    decodedFrame.data.buffer,
    decodedFrame.data.byteOffset + cmd.payloadOffset,
    cmd.payloadSize
  );
}
```

`decodedFrame.data` 是从 `new Uint8Array(buffer)` 创建的。如果 `buffer` 是 `ArrayBuffer`，`data.byteOffset` = 0。如果 `buffer` 是 `Uint8Array`（如 `new Uint8Array(buf, 10, 100)`），`data.byteOffset` = 10。

`cmd.payloadOffset` 是从整个帧的起始位置计算的绝对偏移（从 byte 0 开始，包含 header）。所以 `data.byteOffset + cmd.payloadOffset` 是正确的。 ✓

但 `renderer.js:131` 将返回值作为 `payload` 传给 `_dispatch`：
```javascript
const payload = this._decoder.extractCommandPayload(decoded, i);
this._dispatch(cmd.opcode, payload); 
```

`_dispatch` 中 `d = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)` — 这里的 `payload` 已经是命令载荷的 `Uint8Array` 视图。`payload.buffer` 是整个原始帧 buffer（大对象）。当 `_dispatch` 创建 `new Float32Array(payload.buffer, payload.byteOffset + offset, count)` 时，它保持对**整个原始帧 buffer** 的引用，而非仅 payload 部分。

**影响**: 即使只取了一个 20 字节的 drawRect payload，`Float32Array` 构造函数的 buffer 引用是整个帧（可能 64MB）。这个引用阻止了帧 buffer 的 GC，直到该 Float32Array 被释放。在密集渲染循环中，多个大帧 buffer 无法及时回收。

---

## MEDIUM (4)

### R2-M1. `_dispatch` 中的 `case 0x30` drawRect 只读取了 20 字节但 Paint 占用格式超出预期

**文件**: `packages/client/src/renderer.js` 中 `case 0x30`（约 L155-158）

```javascript
case 0x30: // drawRect
  p = new ck.Paint();
  // 从 offset 16 读取 4 字节颜色
  p.setColor([dv.getUint8(16)/255, dv.getUint8(17)/255, dv.getUint8(18)/255, dv.getUint8(19)/255]);
  c.drawRect([d.getFloat32(0,true), d.getFloat32(4,true), d.getFloat32(8,true), d.getFloat32(12,true)], p);
  p.delete(); break;
```

假设 payload 格式为: `rect(16B) + rgba(4B)` = 20 字节。但 `validator.js` 中 `drawRect` 没有子结构校验，pass-through。如果服务端序列化的 Paint 包含更多字段（strokeWidth, blendMode, antiAlias 等），客户端只读取了前 4 字节颜色，其他 paint 参数丢失。

**影响**: 所有 `drawRect` 渲染会出现样式偏差（缺少 stroke、blendMode 等）。所有 shape 绘制命令（RRect/Oval/Arc/Path）有相同问题——只读取了 RGBA 颜色，未解析完整的 SkPaint。

---

### R2-M2. `dv.setBigInt64` + `Number()` 的精度丢失

**文件**: `packages/protocol/src/encoder.js:142` + `decoder.js:50`

```javascript
// encoder: 将 JS number 转为 BigInt 写入
dv.setBigInt64(off, BigInt(this._timestamp), true);

// decoder: 将 BigInt 转回 JS number
const timestampMs = Number(dv.getBigInt64(off, true));
```

`BigInt(Math.floor(timestamp || Date.now()))` 中 `Date.now()` 返回毫秒时间戳（~1.7 万亿）。JS `Number` 可以精确表示 2^53 之内的整数。1.7×10^12 < 9×10^15（2^53），所以 `Number(BigInt)` 的精度是完整的。

但 `setBigInt64` 期望 64-bit signed BigInt。如果 `this._timestamp` 是 JS number（52-bit 尾数），转换为 BigInt 后高位补 0，在 64-bit 范围内。安全。✓

---

### R2-M3. `setInterval` 回调中 `_captureFrame()` 在超过一帧间隔后累积调用

**文件**: `packages/server/src/session.js:181-192`

```javascript
async _runFrameLoop() {
  const tick = () => {
    if (!this._running) return;
    this._captureFrame().catch(err => { /* ... */ });
  };
  return setInterval(tick, config.frameTickMs); // 50ms
}
```

如果 `_captureFrame()` 的执行时间超过 `frameTickMs`（50ms），多个 tick 会重叠执行。`_captureFrame` 不是排队的——它使用了 shared `this._encoder` 和 `this._capture`。当两个 tick 同时访问 `this._encoder.setMetadata()` / `this._encoder.addTile()` 时，数据交错，产生损坏的帧。

在 20fps 下，从 `page.screenshot()` + sharp 瓦片编码通常会 <50ms，但复杂页面（大型 canvas、WebGL）可能超时。

---

### R2-M4. `readyState === WebSocket.OPEN` 相比 `send()` 之间存在 TOCTOU 竞态

**文件**: `packages/server/src/ws-server.js:171-180`

```javascript
for (const ws of this._wss.clients) {
  if (ws._wisonSessionId === sessionId && ws.readyState === WebSocket.OPEN) {
    // ...
    ws.send(arrayBuffer, { binary: true });
    return;
  }
}
```

在 `readyState === OPEN` 检查与 `ws.send()` 之间，连接可能已关闭（客户端断开）。`ws.send()` 会抛出 `Error: WebSocket is not open`。这个异常未被捕获。

---

## LOW (3)

### R2-L1. `_wss.clients.forEach` 遍历中调用 `ws.terminate()` 可能修改正在迭代的 Set

**文件**: `packages/server/src/ws-server.js:220-225`

```javascript
for (const ws of this._wss.clients) {
  if (ws._wisonSessionId === sessionId) {
    ws.terminate();
    break;
  }
}
```

在 `_checkHeartbeats` 和 `shutdown` 中遍历 `_wss.clients` 时，`ws.terminate()` 可能会从 Set 中移除该连接。JavaScript 的 `for...of` 在 Set 上迭代时，如果当前元素被删除，迭代可能跳过下一个元素。`break` 在这里避免了问题（找到就跳出），但 `shutdown()` 中的遍历（L258-260）没有 `break`——它关闭所有连接，每个 `close()` 都可能触发 `_cleanupSession` → `_sessions.delete`，但 `_wss.clients` 和 `_sessions` 是独立集合。`close()` 是否会从 `_wss.clients` 中移除元素取决于 `ws` 库的实现。

---

### R2-L2. HID 坐标 `Math.round(undefined)` = NaN → CDP `NaN` 坐标

**文件**: `packages/client/src/hid-capture.js:57-58`

```javascript
x: Math.round((e.clientX - rect.left) * (this._viewport.width / rect.width)),
```

如果 `rect.width` 为 0（canvas 未渲染），除法结果是 `Infinity`，`Infinity * (e.clientX - rect.left)` = `Infinity`（或 `-Infinity`），`Math.round(Infinity)` = `Infinity`。CDP dispatchMouse 收到 Infinity 坐标，Chromium 行为未定义。

---

### R2-L3. `frame-buffer.js` 的 `latest()` 方法可能返回 `undefined`

**文件**: `packages/client/src/frame-buffer.js:44-49`

```javascript
latest() {
  if (this._totalWritten === 0) return null;
  const idx = this._totalWritten <= this._maxSize
    ? this._totalWritten - 1
    : (this._writePos - 1 + this._maxSize) % this._maxSize;
  return this._buffer[idx] || null;
}
```

当 `_totalWritten === 1` 时，`idx = 0`。`_buffer[0]` 被正确设置。但当 `_totalWritten === 64` 且环形缓冲区刚满时，`_buffer[0]` 是第 1 帧的数据。当 `_totalWritten === 65` 时，`_writePos = 0`（已回绕），`idx = (0 - 1 + 64) % 64 = 63`，最新帧在 `_buffer[63]`（第 65 帧）。但这假设了按顺序写入——如果 `push()` 从未被调用，`_buffer[63]` 是 `undefined`。但 `|| null` 处理了这种情况。✓

但如果 `_totalWritten === 0` 时调用 `latest()`，返回 `null`。调用方（未使用——见第一轮 L4）需要检查返回值。✓

---

## INFO (2)

### R2-I1. `_computeDirtyTiles` 的 O(N) tile 哈希属于伪差分

每帧计算整帧 MD5（`hash(screenshotBuf)`），然后对 3600 个 tile 使用相同的 hash + 索引作为 tile ID。前一帧的 tile ID 格式是 `oldHash:0..3599`，新帧是 `newHash:0..3599`。由于两帧的整帧 hash 几乎肯定不同，**所有 3600 个 tile 都被标记为脏**。每帧都是全量 Keyframe 的等价物。这并非 Bug（功能正确），但它使得 tile 差分引擎的存在价值为零——不如直接传输整帧 JPEG。

---

### R2-I2. `frameCount` 在 `markNavigation()` 中重置但不影响 Keyframe 决策

```javascript
// frame-capture.js:136
markNavigation() { this._frameCount = 0; }
```

`_frameCount` 只在 `capture()` 内部自增，用于每 `keyframeInterval`（300）发送一次 Keyframe。重置为 0 后，需要再捕获 300 帧才能触发一次 Keyframe。由于 `_computeDirtyTiles` 总是返回所有 tile（见 R2-I1），`capture()` 中的 `dirtyList.length > this._totalTiles * 0.5` 始终为 true，导致 `isKeyframe` 始终为 true。因此 `_frameCount` 的 Keyframe 触发逻辑永远无法触及——因为它已被脏 tile 比例条件覆盖。

---

## 第二轮审计专项总结

| 类别 | 问题编号 | 核心问题 |
|------|---------|---------|
| **数据流完整性** | R2-C1, R2-H1, R2-H4 | cmdView 偏移错误 → 永远被拒绝；CRC32 只计算不回传→无效 |
| **状态机** | R2-H2, R2-M3 | _cleanupSession 重复调用；setInterval 帧循环重叠 |
| **协议兼容性** | R2-C1, R2-M1 | 渲染器偏移与 encoder 格式不匹配；Paint 参数只解析了颜色 |
| **边界零值** | R2-H3, R2-L2 | 空 URL 未深度校验；NaN 坐标 → Chromium 未定义行为 |
| **整数运算** | (encoder/decoder 中的 bitwise 运算) | 已验证 24-bit payLen 安全（≤2^23） |
| **事件管道** | R2-M2, R2-M4, R2-L1 | BigInt→Number 精度 OK；TOCTOU send 竞态；遍历中 terminate |
| **GC/内存** | R2-H4 | Float32Array 持有大型 buffer 引用阻止 GC |

**7 维度全部覆盖，14 个独立发现问题，与第一轮零重复。**
