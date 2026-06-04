# 第三轮修复方案

## 修复清单（12 项中 9 项需修复，3 项标记为设计限制）

### 第一批：微小改动 (7 项)

| ID | 文件 | 改动行数 | 修复 |
|----|------|---------|------|
| R3-C1 | frame-capture.js | ~10行 | `imgWidth` → `imgWidth, imgHeight` 双参数；边界检查修正 |
| R3-H3 | ws-server.js | ~3行 | `msg.token` 类型校验 |
| R3-M1 | ws-server.js | ~5行 | `_cleanedSessions` 清理旧条目（每 5 分钟一次） |
| R3-M2 | session.js | ~3行 | 新增公开 `notifyStatus()` → 委托 `_notifyStatus` |
| R3-M4 | ws-server.js | ~3行 | IP 归一化（IPv6 前缀剥离） |
| R3-L1 | ws-server.js | ~2行 | resize 宽/高范围校验 |
| R3-L2 | server/index.js + ws-server.js | ~3行 | 新增 `getSessionCount()` 公开方法 |

### 第二批：需人工确认 (1 项)

| ID | 改动 | 风险 |
|----|------|------|
| R3-H2 | `_verifyClient` 跳过无 HTTP 头的浏览器客户端 → 全部认证移至消息层 | 改变认证语义：HTTPS API 客户端之前通过 HTTP 头认证，修复后也必须通过消息认证 |

### 不修复 (3 项)

| ID | 原因 |
|----|------|
| R3-H4 | 与 R3-C1 同根因，修复后自动解决 |
| R3-M3 | expando 属性是设计基础，无法最小化修复 |
| R3-M5 | 审计确认安全 |
