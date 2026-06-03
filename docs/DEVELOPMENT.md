# 开发指南

> v1.12

## 1. 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | ≥20.0 | LTS 版本推荐 |
| npm | ≥10.0 | 随 Node.js 分发 |
| Playwright Chromium | 自动下载 | `npx playwright install chromium` |
| libvips | 自动安装 | sharp 的原生依赖，需编译工具链 |

## 2. 快速启动

```bash
# 克隆仓库
git clone https://github.com/laolv2023/wison-rbi.git
cd wison-rbi

# 安装依赖 (所有包)
npm install

# 安装 Chromium
npx playwright install chromium

# 启动开发服务器
node packages/server/src/index.js

# 浏览器打开
open http://localhost:8080
```

## 3. 项目结构

```
wison-rbi/                    # npm workspaces 根
├── packages/
│   ├── protocol/             # 共享协议包
│   │   └── src/              # constants + encoder + decoder + validator
│   ├── server/               # 服务端包
│   │   └── src/              # index + ws-server + session + capture + cdp + input
│   └── client/               # 客户端包 (纯静态文件)
│       ├── index.html        # 入口 HTML
│       └── src/              # connection + renderer + hid-capture
```

**npm workspaces**: 三个包通过 `npm workspaces` 管理依赖。`@wison/protocol` 通过 `workspace:*` 协议引用。

## 4. 开发工作流

### 4.1 修改协议

```bash
# 协议文件: packages/protocol/src/*.js
# 两环境 (Node + 浏览器) 兼容，使用 UMD 模式导出
# 常量修改后需同步检查 encoder/decoder/validator
# 运行协议测试:
node --test packages/protocol/tests/*.test.js
```

### 4.2 修改服务端

```bash
# 服务端文件: packages/server/src/*.js
# 修改后重启:
node packages/server/src/index.js
# 运行测试:
node --test packages/server/tests/*.test.js
```

### 4.3 修改客户端

```bash
# 客户端文件: packages/client/src/*.js + index.html
# 刷新浏览器即可，无需重启服务端
# 注意: 客户端脚本由静态文件服务提供
```

### 4.4 添加新 OpCode

1. 在 `constants.js` 的 `OpCode` 中添加
2. 在 `validator.js` 的 `VALID_OPCODES` 中添加
3. 在 `renderer.js` 的 `_dispatch` 中添加渲染实现
4. 添加对应的编码/解码测试
5. 更新 `isValidOpcode()` 范围检查

## 5. 代码规范

| 规范 | 要求 |
|------|------|
| 编码风格 | 项目自带一致风格 (2空格缩进、单引号、分号) |
| 注释 | JSDoc + 中文行内注释 |
| 错误处理 | try/catch + pino 结构化日志 |
| 命名 | 私有方法 `_` 前缀，事件回调 `on_` 前缀 |
| 常量 | 协议常量在 `constants.js`，配置在 `config.js` |
| 测试 | `node:test` + `assert`，文件命名 `*.test.js` |

## 6. 调试

```bash
# 开启 debug 日志
WISON_LOG_LEVEL=debug node packages/server/src/index.js

# 单 session 启动 (禁用认证)
WISON_MAX_SESSIONS=1 node packages/server/src/index.js

# Node.js inspect
node --inspect packages/server/src/index.js
# Chrome: chrome://inspect

# Chromium 可见模式 (调试渲染问题)
# 修改 session.js: headless: false
# 需要 DISPLAY 环境变量
```

## 7. 常见开发场景

### 添加新的 HID 事件类型

1. `constants.js` HIDType 添加
2. `hid-capture.js` 添加事件监听
3. `input-proxy.js` 添加 decode 分支
4. 测试: `integration-extended.test.js`

### 修改帧协议

1. `encoder.js` 修改 `finalize()` 写入顺序
2. `decoder.js` 修改 `decode()` 读取顺序
3. 更新 `FRAME_HEADER_SIZE` 或 `TILE_ENTRY_SIZE`
4. 运行 `encoder-decoder.test.js` (75 测试)

### 修改瓦片差分逻辑

1. `frame-capture.js` 修改 `_computeDirtyTiles()`
2. 运行集成测试验证 800×600/1280×720/1920×1080
