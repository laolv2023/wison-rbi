# 第二轮全量代码审计方案

> 目标：与第一轮审计**正交**——不重复检查输入校验/认证/资源泄漏/并发/错误处理/密码学
> 聚焦：**数据流完整性、状态机正确性、协议兼容性、边界零值、整数运算、事件管道、GC压力**

## 1. 七维度检查清单

### D1: 数据流完整性 (Data Flow Integrity)
- [ ] Encoder → Decoder 是否互为逆函数（对所有帧类型）
- [ ] Encoder `finalize()` 输出的 CRC32 与 Decoder 的 CRC32 是否一致
- [ ] 帧头 `version` 字段在编解码间是否对齐
- [ ] tile 数据偏移在 encoder 和 decoder 中的计算是否一致
- [ ] 命令 payload 偏移在 `extractCommandPayload` 中的计算是否与 decoder `decode` 中的一致

### D2: 状态机正确性 (State Machine)
- [ ] Session 启动/运行/销毁状态转换是否正确
- [ ] 帧循环启停状态：`_running` 与 `_started` 的转换关系
- [ ] WebSocket 连接状态：OPEN/CLOSING/CLOSED 的转换
- [ ] 重连状态机：`_reconnectAttempt` 与 `_intentionalClose` 的交互
- [ ] Chromium 重启时的状态恢复：导航 → 帧捕获 → HID 注入的时序

### D3: 协议兼容性 (Protocol Compatibility)
- [ ] Encoder 输出的帧头格式与 Decoder 预期的一致（v1.6 版）
- [ ] `isValidOpcode()` 辅助函数是否与 `VALID_OPCODES` Set 一致
- [ ] `HIDType` 枚举值是否与 server `input-proxy` 中的 `case` 匹配
- [ ] `Limits` 常量在 encoder/decoder/validator 三侧是否一致

### D4: 边界零值 (Null/Undefined/Zero)
- [ ] `setMetadata({})` 没有传任何参数时的默认行为
- [ ] `addCommand(opcode, null)` 时的行为（L82: `!payload || payload.length === 0` 立即 return）
- [ ] `finalize()` 在没有 tile 也没有 command 时的空帧输出
- [ ] `DataView.getUint32` 在 buffer 为空时的行为
- [ ] `view.getUint8()` 在 offset 超出 DataView 范围时的行为（不同于 Uint8Array）
- [ ] `fs.readFileSync` 返回空文件时 contentType 是否正确

### D5: 整数运算 (Integer Arithmetic)
- [ ] JavaScript 的按位运算限制在 32-bit signed integer
- [ ] `payLen = (data[off] << 16) | (data[off+1] << 8) | data[off+2]` — payLen > 0x7FFFFF 时结果负值
- [ ] `DataView.setUint32` 接受负数吗？JS number → uint32 的转换
- [ ] `new Float32Array(payload, offset, count * 2)` — offset 必须是 buffer 内的偏移
- [ ] `BigInt(this._timestamp)` — timestamp 可能为负数吗？
- [ ] `(viewportH || 720) & 0xFFFF` — 如果 viewportH = 65536，截断为 0

### D6: 事件管道 (Event Pipeline)
- [ ] 鼠标事件 → CanvasKit 渲染画面: 确认坐标转换链条无丢失
- [ ] frame_id 缺失时的降级行为（scroll offset 使用 0）
- [ ] 连续输入事件丢帧场景（限流器丢弃后是否恢复）
- [ ] 键盘事件重复/缺失（keyDown 没有对应 keyUp 时的行为）

### D7: 内存/GC 压力 (Memory & GC)
- [ ] `setMetadata()` 每次重置 `_tiles` 和 `_commands` 数组，但旧数组何时 GC？
- [ ] `decoder.decode()` 每次创建 `DecodedFrame` 对象——高频 60fps × 300KB+ 对象分配
- [ ] `_computeDirtyTiles` 中字符串拼接 `${imgHash}:${i}` — 每帧 3600 次
- [ ] `ws.send()` 不等待 drain 事件——ArrayBuffer 的 GC 时机

## 2. 数据流全链路追踪

```
用户鼠标点击
  → hid-capture.js _onMouse()
    → _send(HID_TYPE.MOUSE_DOWN)
      → _encode() 生成二进制 HID 事件 (1B type + JSON payload)
        → connection.sendHID()
          → ws.send(ArrayBuffer)
            → ws-server.js _onConnection / 'message' handler
              → session.injectHID(data)
                → input-proxy.inject(data)
                  → DataView(data) 解析 type + JSON.parse
                    → cdp.dispatchMouse() via CDP
                      → Chromium 内部处理
                        → frame-capture.capture()
                          → page.screenshot()
                            → encoder.finalize()
                              → ws.send(ArrayBuffer) 回客户端
                                → connection.js onmessage
                                  → renderer.render()
                                    → decoder.decode()
                                    → validator.scan()
                                    → _renderTiles(decoded)
                                    → _dispatchCommands(decoded)
                                      → CanvasKit 绘制
```

## 3. 状态机检查

```
Session:
  CREATED → STARTING → RUNNING → DESTROYED
              ↓            ↑
           FAILED ───── RESTARTING

Connection:
  DISCONNECTED → CONNECTING → CONNECTED → DISCONNECTED
                    ↑  (reconnect)          ↓ (intentional → stop)
                    └────────────────────────┘

FrameValidator:
  IDLE → SCANNING → VALID → REJECTED → REQUEST_KEYFRAME
                            ↓
                          IDLE (reset)
```
