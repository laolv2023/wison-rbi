# Wison-RBI 全量代码审计报告

> 基准：commit `ef56443`，27 个源文件，~3000 行
> 方法：逐行静态分析 + 数据流追踪 + 边界条件测试
> 不修复，仅报告

---

## 审计结果总览

| 级别 | 数量 | 
|------|------|
| **CRITICAL** | 2 |
| **HIGH** | 5 |
| **MEDIUM** | 7 |
| **LOW** | 4 |
| **INFO** | 3 |
| **总计** | **21** |

---

## CRITICAL (2)

### C1. Token 认证完全失效——客户端发送 auth 但服务端不处理

**文件**: `packages/client/src/connection.js:62-64` + `packages/server/src/ws-server.js:104-121`

**客户端**连接后立即发送 `{ type: 'auth', token: '...' }`：
```javascript
// connection.js:62-64
if (this._authToken) {
  this._ws.send(JSON.stringify({ type: 'auth', token: this._authToken }));
}
```

**服务端** `_handleControl` 的 switch 中 **没有 `case 'auth'`**：
```javascript
// ws-server.js:134-162
switch (msg.type) {
  case 'start':
  case 'navigate': ...
  case 'resize': ...
  case 'text': ...
  case 'request_keyframe': ...
  case 'ping': ...
  // ⚠️ 没有 'auth' case！
}
```

同时 `_verifyClient` (L48-58) 从 HTTP Header 中读取 `Authorization`，但浏览器 WebSocket API **不支持设置自定义 HTTP 头**。客户端的 `this._authToken` 无法通过 HTTP 头传递。

**影响**: 两种认证路径全部不通——浏览器端无法通过 HTTP 头认证（API 限制），服务端不处理 `type:'auth'` 消息（代码缺失）。设置了 `WISON_AUTH_TOKEN` 的生产环境将拒绝所有浏览器连接。

---

### C2. 客户端 `request_keyframe` 是空操作

**文件**: `packages/server/src/ws-server.js:154-158`

```javascript
case 'request_keyframe':
  this._log.warn({ sessionId: session.id }, 'Client requested keyframe');
  // 下一个帧循环自然产生 Keyframe（frameCount 重置在 navigate 中）
  break;
```

**问题**: `request_keyframe` 的处理逻辑声称"下一个帧循环自然产生 Keyframe"，但 `markNavigation()` 只在上次 `navigate()` 时调用过。当前代码中：

1. `_captureFrame` (session.js:195-230) 调用 `this._capture.capture()` 获取脏 tile
2. `FrameCapture.capture()` **内部**决定是否发 Keyframe（仅当脏 tile >50% 或 keyframeInterval 到时）
3. `request_keyframe` handler 没有调用任何方法来强制下一帧为 Keyframe

**影响**: 当客户端连续 3 帧验证失败后请求 `request_keyframe`，服务端收到后**什么也不做**。客户端将持续收到被拒绝的帧，画面卡死/黑屏直到偶然的 keyframeInterval 触发（每 300 帧 × 50ms = 15 秒）。

---

## HIGH (5)

### H1. `_computeDirtyTiles` 使用整帧 MD5——瓦片差分完全失效

**文件**: `packages/server/src/frame-capture.js:97-119`

```javascript
_computeDirtyTiles(screenshotBuf) {
  const imgHash = hash(screenshotBuf);  // 整帧 MD5
  for (let i = 0; i < this._totalTiles; i++) {
    const tileId = `${imgHash}:${i}`;  // ← 每个 tile 包含相同 imgHash
    // ...
  }
}
```

`imgHash` 是整个截图的 MD5。每个 tile 的 key 是 `${imgHash}:${i}`。因为 `imgHash` 在每一帧内对所有 tile 都相同，而 上一帧的 `imgHash` 几乎一定不同，所以 **所有 3600 个 tile 每帧都被标记为脏**。增量传输完全失效，每帧都是全量 Keyframe。

---

### H2. `request_keyframe` 不强制 Keyframe（与 C2 关联但不同维度）

除了 C2 指出的空操作问题外，`FrameCapture` 类也**没有提供外部强制 Keyframe 的 API**。`caption()` 内部通过 `this._frameCount % this._keyframeInterval === 0` 或脏 tile 比例决策。Session 层无法从外部注入"下一帧必须是 Keyframe"的指令。

---

### H3. 帧循环销毁竞态——野指针访问已销毁的 page

**文件**: `packages/server/src/session.js:182-192 + 166-171`

```javascript
// destroy():
this._running = false;
clearInterval(this._frameLoop);
await this._cdp.disconnect();
await this._browser.close();

// tick (仍在运行的 setInterval):
const tick = () => {
  if (!this._running) return;
  this._captureFrame().catch(...)
};
```

时序窗口：
1. `destroy()` 设置 `_running = false`
2. 但 `_captureFrame()` 已开始执行（`_running` 检查在 tick 的开头，不是在 `_captureFrame` 内部）
3. `destroy()` 关闭 browser → `this._page` 失效
4. `_captureFrame` 中 `this._capture.capture()` 调用 `this._page.screenshot()` → **访问已关闭的 page** → 未捕获异常

`_captureFrame()` 内部虽然 try/catch 了 scroll offset 获取，但 `this._capture.capture()` 本身没有 try/catch——它依赖外层 tick 的 `.catch`，但如果 `capture()` 内部抛出同步异常，`.catch` 会捕获。但 Playwright 的 `page.screenshot()` 在 page 关闭后抛出的异常是异步的，可能逃逸到 unhandledRejection。

---

### H4. SSRF——无 URL 目标校验

**文件**: `packages/server/src/session.js:129-131`

```javascript
await this._page.goto(url, { wait_until: 'domcontentloaded', timeout: 30000 });
```

用户可导航到：
- `http://localhost:6379/` — 内部 Redis（若存在）
- `file:///etc/passwd` — 本地文件
- `http://169.254.169.254/latest/meta-data/` — AWS metadata

Chromium 运行在容器内，攻击面受容器网络隔离限制，但 **未做 URL scheme/目标 IP 校验** 仍然违反纵深防御原则。

---

### H5. `sharp` 动态 import 路径在 `setInterval` 内热加载

**文件**: `packages/server/src/frame-capture.js:85`

```javascript
const { default: sharp } = await import('sharp');
```

`sharp` 在 `capture()` 方法内部使用 `await import()`，这意味着：
1. 每次 diff 帧捕获时都走一次动态 import（虽然 Node.js 会缓存模块，但有额外开销）
2. 如果 `sharp` 模块加载失败，`capture()` 抛出异常 → `_captureFrame` 的 `.catch` 触发 → `markFailure()` 递增 → 连续 10 次后重启 Chromium——而不是降级为全量 Keyframe

---

## MEDIUM (7)

### M1. Token 比较非时序安全

**文件**: `packages/server/src/ws-server.js:53`

```javascript
if (token !== config.authToken) {
```

使用 `!==` 进行字符串比较，泄露时序信息。应使用 `crypto.timingSafeEqual`。

---

### M2. sessionId 生成使用 `Math.random()` 而非 `crypto.randomUUID()`

**文件**: `packages/server/src/ws-server.js:81`

```javascript
const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
```

`Math.random()` 是伪随机数生成器（V8 使用 xorshift128+），不适合安全场景。sessionId 作为会话令牌，应使用 `crypto.randomUUID()`。

---

### M3. `_heartbeats` Map 在 `_checkHeartbeats` 循环中被修改

**文件**: `packages/server/src/ws-server.js:217-231`

```javascript
for (const [sessionId, lastPing] of this._heartbeats) {
  // ...
  this._heartbeats.delete(sessionId); // ⚠️ 在迭代中删除当前元素
}
```

`Map` 允许在 `for...of` 迭代中安全删除当前元素，这里实际是正确的。但中间有 `ws.terminate()` + `session.destroy()` 的 async 调用（未 await），可能导致 `_heartbeats` 被并发修改。由于 `destroy()` 没有删除 `_heartbeats`（这项职责在 `_cleanupSession` 和 `_checkHeartbeats` 中）， 且 `destroy()` 不走 `_cleanupSession`，**可能导致已销毁 session 的心跳仍在 Map 中**。

---

### M4. `_reapIdleSessions` 中的 concurrent modification

**文件**: `packages/server/src/ws-server.js:235-249` + `session.js:166-171`

`_reapIdleSessions` 中 `session.destroy()` 后立即 `this._sessions.delete(sessionId)`，但 `destroy()` 内部是 async 操作（`await browser.close()`），`_reapIdleSessions` **没有 await session.destroy()**。Browser close 在后台运行，可能导致：
- 多次 destroy 同一个 session
- 如果 `_checkHeartbeats` 和 `_reapIdleSessions` 同时触发同一 session 的清理，会出现竞态

---

### M5. `_sendFrame` 中的 `ws.send` 未捕获发送失败

**文件**: `packages/server/src/ws-server.js:179`

```javascript
ws.send(arrayBuffer, { binary: true });
```

如果客户端在 `readyState === OPEN` 检查之后、`send()` 之前断开，`send()` 会抛出异常——但这里没有 try/catch。虽然 `ws` 库通常会吞掉这类错误，但行为取决于版本和选项。

---

### M6. HID `JSON.parse` 未校验 payload 结构

**文件**: `packages/server/src/input-proxy.js:37`

```javascript
const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 1)));
// 直接使用 payload.x, payload.y, payload.button 等——未校验字段存在性和类型
```

恶意客户端可发送 `{ x: "not_a_number", button: null }` 导致 `dispatchMouse` 失败或异常行为。应进行运行时类型校验。

---

### M7. 渲染器命令流边界硬编码 `30 + 2 + decoded.tileCount * 14`

**文件**: `packages/client/src/renderer.js:63`

```javascript
const cmdView = new Uint8Array(frameData, 30 + 2 + decoded.tileCount * 14);
```

此偏移计算重复了 decoder 中的布局逻辑。如果帧头格式变更（v1.6 已变更），这里需要同步更新。缺乏从 decoder 直接获取命令流偏移的 API。当前 decoder 的 `decode()` 返回 `data` 引用，但未暴露命令流的起始偏移。

---

## LOW (4)

### L1. `clearRect` 缺失——增量瓦片残留

在 `_renderTiles` 中，diff 帧直接逐瓦片 `drawImage`，但 Keyframe 路径才调用 `ctx.clearRect` (原先的客户端 HTML 中有，当前 renderer.js 中缺失)。diff 瓦片覆盖旧内容时，如果瓦片比上一帧小或不重叠，残留像素可能显示。

---

### L2. `saveLayer` 的 Paint 对象泄漏

**文件**: `packages/client/src/renderer.js:146-151`

```javascript
case 0x03:
  p = new ck.Paint();
  // ...
  c.saveLayer(p, b, null, f);
  p.delete(); break;
```

CanvasKit 的 `saveLayer` 可能持有 Paint 引用。在 `restore()` 之前删除 Paint 可能导致 use-after-free。应在 `restore()` 之后再删除。

---

### L3. 心跳超时使用 `ws.terminate()` 而非 `ws.close()`

**文件**: `packages/server/src/ws-server.js:223`

```javascript
ws.terminate();
```

`terminate()` 直接断开 TCP 连接，不发送 close frame。客户端收到的是异常断开，不会触发 `onclose` 的 1000 正常关闭码，可能导致重连逻辑误判。

---

### L4. `frame-buffer.js` 未被实际使用

**文件**: `packages/client/src/frame-buffer.js` + `packages/client/index.html`

`index.html` 中创建了 `frameBuf` (L108: `const frameBuf = new FrameBuffer(64)`)，但 **从未在 HID 坐标转换中使用**。`HIDCapture` 直接使用 `renderer.currentFrameId` 作为 frame_id 标签，但不通过 `frameBuf.findByFrameId()` 做 scroll offset 转换。v1.6 设计的环形帧缓冲用于精确的坐标转换——但这里完全没有接入。

---

## INFO (3)

### I1. `Dockerfile` 中的 `seccomp:unconfined` 降低容器安全

`docker-compose.yml` 中使用了 `seccomp:unconfined`，这意味着禁用 seccomp 过滤。Chromium 沙箱需要此配置，但应考虑使用自定义 seccomp profile 而非完全禁用。

---

### I2. CanvasKit 从 `unpkg.com` CDN 加载——无 SRI 校验

**文件**: `packages/client/index.html:95`

```html
const canvasKit = await CanvasKitInit({ locateFile: (f) => 'https://unpkg.com/canvaskit-wasm@0.39.1/bin/' + f });
```

无 Subresource Integrity hash，无法验证加载的 WASM 文件未被篡改。

---

### I3. `CODING_PLAN.md` 中引用的 O(N log N) tile 排序未实现为 O(N log N)

设计中提到 R-tree 空间索引，但 `frame-capture.js` 的 `_computeDirtyTiles` 使用 O(N) 线性扫描（N=3600 tiles）。当 tile 数量较少时这不是问题，但注释说"完整实现应逐 tile hash"——当前实现是 O(N) 但每个 tile 只是字符串拼接而非 hash，实际比注释声称的更简化。

---

## 审计方法附录

| 维度 | 覆盖 |
|------|------|
| 输入校验 | constants/encoder/decoder/validator/input-proxy/ws-server |
| 认证授权 | ws-server `_verifyClient` + connection.js auth flow |
| 资源管理 | session destroy/clenaup + heartbeat timer cleanup |
| 并发异步 | session tick vs destroy + ws-server heartbeat vs reap |
| 错误处理 | catch 覆盖 + unhandledRejection + uncaughtException |
| 密码学 | CRC32/MD5 用途 + token 比较 + 随机数生成 |
| 部署安全 | Docker seccomp + CDN SRI + URL 校验 |

共审查 27 个文件，发现 21 个问题。**不做修复，等待指令。**
