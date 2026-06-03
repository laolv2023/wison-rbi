# 排障指南

> v1.12

## 1. 连接问题

### 客户端无法连接 (指示灯灰色)

**排查步骤**:

```bash
# 1. 服务端是否运行
curl http://localhost:8080/health

# 2. WebSocket 端口是否可达
# 浏览器 DevTools → Network → WS 标签 → 查看连接状态

# 3. 认证 Token 是否正确
# 检查 localStorage: wison_token
# 检查服务端日志: grep "Auth" logs

# 4. IP 是否被限流 (>3 连接)
# 查看服务端日志: "Too many connections from IP"
```

**常见原因**:
- 服务端未启动
- 防火墙阻止 8080 端口
- `WISON_AUTH_TOKEN` 不匹配
- 超过每 IP 最大连接数

### 连接反复断开

- 心跳超时: 检查网络延迟是否 > 15s
- 服务端 OOM: `docker stats` 查看内存
- Chromium 崩溃: 服务端日志 `CHROMIUM_CRASH`

## 2. 渲染问题

### 画面黑屏

```
可能原因:
1. CanvasKit WASM 加载失败
   → 检查浏览器控制台: "CanvasKit init failed"
   → 检查 CDN 可达性: curl https://unpkg.com/canvaskit-wasm@0.39.1/bin/canvaskit.wasm

2. WebGL 不支持
   → 检查浏览器: chrome://gpu → WebGL 状态
   → 降级使用软件渲染 (SW Canvas)

3. 帧 CRC32 校验全部失败
   → 检查服务端日志: "Frame capture error"
   → 检查 Chromium 是否正常运行
```

### 画面不更新 (静态)

- 帧间无变化 → 正常 (差分传输只发变化瓦片)
- 永久静态 → 检查 `_captureFrame` 是否卡死 (FPS 始终为 0)
- 强制刷新: URL 栏重新输入同一个 URL 触发导航

### 画面闪烁

- 关键帧频繁 → 检查 `keyframeInterval` (默认 300 帧 = 15s)
- 瓦片错位 → CanvasKit drawImage 坐标错误
- 滚动闪烁 → 导航后未重置 `_prevHashes`

## 3. 输入问题

### 鼠标点击无效

```
排查:
1. 检查坐标变换:
   浏览器控制台 → hid-capture → _canvasToViewport 输出
   验证 x, y 是否正确

2. 检查 CDP 注入:
   服务端日志 trace 级别:
   WISON_LOG_LEVEL=trace node index.js
   查看 "dispatchMouse" 日志

3. 检查令牌桶:
   如果点击频率 > 125Hz → 事件被静默丢弃
```

### 键盘输入无效

- 检查焦点: 需要先点击画布获取焦点
- 检查 CDP: 服务端 `WISON_LOG_LEVEL=trace` 查看 key 分发

### 剪贴板粘贴无效

- 浏览器要求 `navigator.clipboard.readText()` 权限
- HTTPS 环境或 localhost 才能使用
- Firefox 需要 `dom.events.asyncClipboard.readText` 启用

## 4. 性能问题

### 帧率低 (< 10fps)

```
可能原因:
1. CPU 不足 → docker stats 检查 CPU throttle
2. 脏瓦片过多 (> 50%) → 减少 frameTickMs 或降低强制关键帧
3. sharp 线程争用 → 多 session 时 CPU 竞争
4. 网络延迟 → 检查客户端与服务端之间的 RTT
```

### 内存持续增长

```
排查:
- 服务端: process.memoryUsage() (通过 /metrics 查看)
- Chromium: ps aux | grep chromium → RSS
- Node.js: 设置 --max-old-space-size=512 (Dockerfile)
- 疑似泄漏: 24h 监控内存趋势
```

### 带宽过高

- 正常范围: 100-500 KB/s (取决于页面复杂度)
- 异常高: 检查是否有视频/动画 → 导致大量瓦片变化
- 降带宽: 增大 tileSize (当前 16px) → 减半瓦片数

## 5. 部署问题

### Docker 启动失败

```bash
# 检查日志
docker logs wison-rbi

# 常见错误:
# "Browser closed unexpectedly" → 缺少 --cap-add=SYS_ADMIN
# "cannot open shared object file" → 缺少 libvips
# "Port 8080 already in use" → 端口冲突
```

### Chromium 无法启动

```bash
# 手动测试
npx playwright install chromium
node -e "require('playwright').chromium.launch({headless:true})"

# 常见原因:
# - 缺少系统依赖: npx playwright install-deps chromium
# - /dev/shm 太小: --disable-dev-shm-usage (Dockerfile 已加)
# - 容器 cgroup 限制: 增加 --memory
```

## 6. 日志分析

### 关键日志模式

| 日志内容 | 含义 | 操作 |
|---------|------|------|
| `"Auth failed"` | Token 认证失败 | 检查 WISON_AUTH_TOKEN |
| `"Too many connections"` | IP 限流触发 | 增加 WISON_IP_MAX_CONN |
| `"Heartbeat timeout"` | 客户端断连 | 正常，自动清理 |
| `"Frame capture error"` | 截图失败 | Chromium 可能崩溃 |
| `"Restart limit exceeded"` | 重启 3 次失败 | Session 已销毁 |
| `"Backpressure, skipping frame"` | 客户端跟不上 | 网络或渲染慢 |
| `"Chromium crash detected"` | 浏览器崩溃 | 自动重启 |

### 开启详细日志

```bash
WISON_LOG_LEVEL=trace node index.js 2>&1 | grep -v "heartbeat"
```

## 7. 获取帮助

1. 查看本文档的对应章节
2. 检查服务端日志 (`WISON_LOG_LEVEL=debug`)
3. 浏览器 DevTools Console (F12)
4. 浏览器 DevTools Network (WebSocket 帧)
5. 运行测试套件: `node --test packages/*/tests/*.test.js`
