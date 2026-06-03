# Wison-RBI 全量代码审计方案

> 基准：commit `ef56443`，27 个源文件，~3000 行代码
> 原则：发现问题、记录但不修复；每条结论附文件路径+行号

## 1. 六维度检查清单

### 维度 A: 输入校验 (Input Validation)
- [ ] WebSocket 消息大小/类型校验
- [ ] 二进制帧解码：每步边界检查完整性
- [ ] CommandValidator：白名单 + 子结构 + 帧级限制 + save/restore
- [ ] HID 事件 payload 解析校验
- [ ] URL 参数/导航目标校验
- [ ] HTTP 路由参数校验（路径穿越）
- [ ] 环境变量/配置值类型和范围校验

### 维度 B: 认证与授权 (AuthN/AuthZ)
- [ ] Token 认证是否正确实现（时序攻击？）
- [ ] WebSocket 连接建立前认证
- [ ] 会话隔离（能否跨会话访问数据？）
- [ ] IP 限流绕过可能性

### 维度 C: 资源管理 (Resource)
- [ ] Chromium 实例泄漏（异常路径）
- [ ] WebSocket 连接泄漏
- [ ] 内存泄漏（闭包、定时器、EventEmitter）
- [ ] 文件描述符泄漏
- [ ] 未处理的 Promise rejection
- [ ] 帧缓冲区无界增长可能性

### 维度 D: 并发与异步 (Concurrency)
- [ ] 竞态条件（session 创建/销毁）
- [ ] 帧循环与导航的交互（navigate 时 frame loop 在运行？）
- [ ] CDP 命令并发（同一 page 多个 CDP 调用）
- [ ] setInterval 与 clearInterval 配对
- [ ] EventEmitter 监听器未移除

### 维度 E: 错误处理 (Error Handling)
- [ ] try/catch 覆盖所有 async 路径
- [ ] 错误传播是否导致静默失败
- [ ] 日志包含敏感信息（token、URL参数？）
- [ ] Crash-only vs graceful degradation

### 维度 F: 密码学与安全基元 (Crypto)
- [ ] CRC32 仅用于完整性校验（非安全用途——正确）
- [ ] 随机数生成是否正确（crypto.randomUUID vs Math.random）
- [ ] Token 比较是否防时序攻击（crypto.timingSafeEqual）

## 2. 文件清单 (27 个)

| 文件 | 行数 | 审计重点 |
|------|------|---------|
| `packages/protocol/src/constants.js` | ~150 | OpCode 完整性、限制值合理性 |
| `packages/protocol/src/encoder.js` | ~160 | 二进制编码正确性、溢出 |
| `packages/protocol/src/decoder.js` | ~170 | 每步边界检查、DoS 抗性 |
| `packages/protocol/src/validator.js` | ~220 | 安全边界完整性 |
| `packages/server/src/config.js` | ~60 | 默认安全性 |
| `packages/server/src/index.js` | ~130 | 静态文件服务、路由安全 |
| `packages/server/src/ws-server.js` | ~210 | 认证、限流、心跳、并发 |
| `packages/server/src/session.js` | ~210 | 资源泄漏、竞态、crash恢复 |
| `packages/server/src/cdp-client.js` | ~110 | 重试逻辑、超时 |
| `packages/server/src/frame-capture.js` | ~140 | 差分算法、内存 |
| `packages/server/src/input-proxy.js` | ~100 | 限流正确性、令牌桶实现 |
| `packages/client/index.html` | ~120 | CSP、XSS、依赖加载 |
| `packages/client/src/connection.js` | ~170 | 重连逻辑、背压 |
| `packages/client/src/renderer.js` | ~220 | OpCode 映射完整性 |
| `packages/client/src/hid-capture.js` | ~120 | 事件归一化、坐标转换 |
| `packages/client/src/frame-buffer.js` | ~80 | 环形缓冲正确性 |
| `packages/protocol/tests/validator.test.js` | ~250 | 覆盖率 |
| `packages/server/tests/server.test.js` | ~60 | 覆盖率 |
| `Dockerfile` | ~30 | 安全配置 |
| `docker-compose.yml` | ~30 | 暴露端口、资源限制 |
| `package.json` (root) | ~15 | 依赖声明 |
| `packages/protocol/package.json` | ~5 | — |
| `packages/server/package.json` | ~10 | 依赖版本 |
| `CODING_PLAN.md` | 文档 | 不审计 |
| `packages/README.md` | 文档 | 不审计 |
| `README.md` | 设计文档 | 仅交叉验证关键设计决策 |

## 3. 风险优先级矩阵

| 等级 | 定义 | 示例 |
|------|------|------|
| **CRITICAL** | 可远程利用、无认证、导致 RCE/数据泄露 | 路径穿越、认证绕过 |
| **HIGH** | 可导致 DoS/信息泄露/会话劫持 | OOM、无限循环、资源泄漏 |
| **MEDIUM** | 逻辑缺陷、可被利用但不直接致命 | 竞态条件、错误静默 |
| **LOW** | 最佳实践偏离、无直接安全影响 | 硬编码值、日志格式 |
| **INFO** | 优化建议、代码风格 | 命名、注释完整性 |
