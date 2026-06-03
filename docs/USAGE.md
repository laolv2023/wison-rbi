# 使用指南

> v1.12

## 1. 启动服务端

```bash
# 开发环境 (无认证)
node packages/server/src/index.js

# 生产环境 (带认证)
WISON_AUTH_TOKEN=my-secret-token node packages/server/src/index.js
```

## 2. 打开客户端

浏览器访问 `http://localhost:8080`。

### 认证模式

如果服务端设置了 `WISON_AUTH_TOKEN`，客户端连接时会自动发送首个 `auth` 消息:

```javascript
// 浏览器控制台可手动设置
localStorage.setItem('wison_token', 'my-secret-token');
// 刷新页面
```

## 3. 输入 URL

在页面顶部的 URL 输入框中输入目标地址 (如 `https://example.com`)，按 Enter 或点击"连接"。

支持的 URL 格式:
- `http://example.com`
- `https://example.com`
- `http://localhost:3000` (容器内)
- `https://example.com/path?query=value`

## 4. 远程交互

| 操作 | 说明 |
|------|------|
| 鼠标移动 | 在画布上移动鼠标 → 光标位置同步 |
| 鼠标点击 | 左键单击/双击 → 页面交互 |
| 键盘输入 | 焦点在画布时键入文字 |
| 滚轮滚动 | 滚轮 → 页面滚动 |
| 触屏 | 移动端支持触摸事件 |
| 粘贴 | Ctrl+V → 剪贴板内容注入 |

## 5. 状态指示

| 状态 | 指示灯 | 说明 |
|------|--------|------|
| 等待连接 | 🔴 灰色 | WebSocket 未连接 |
| 加载中 | 🟡 黄色 | 页面正在加载 |
| 就绪 | 🟢 绿色 | 页面已加载，可交互 |
| 错误 | 🔴 红色 | 连接出错 |

## 6. 状态栏信息

| 指标 | 说明 |
|------|------|
| FPS | 当前帧率 (帧/秒) |
| BW | 带宽消耗 (KB/s) |
| ftype | 当前帧类型 (k=关键帧, d=差分帧) |

## 7. 快捷操作

| 操作 | 效果 |
|------|------|
| 刷新按钮 (客户端) | 请求关键帧 (request_keyframe) |
| 浏览器刷新 (F5) | 重新连接服务端 |
| 修改 URL 后 Enter | 服务端导航到新 URL |

## 8. 移动端

客户端支持触摸事件 (touchstart/touchmove/touchend) 和响应式布局。建议在移动端使用横屏模式。

## 9. 多会话

服务端默认支持 5 个并发会话。多个浏览器标签页可连接到同一服务端，每个标签页创建一个独立 Session。

## 10. 断开与重连

- 网络中断 → 客户端自动重连 (指数退避: 1s → 2s → 4s → 8s → 16s)
- 服务端重启 → 客户端重连后创建新 Session
- 空闲 5 分钟 → 服务端回收 Session
