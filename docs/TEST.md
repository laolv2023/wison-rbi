# 测试文档

> v1.12 | 237 测试定义 | 6 测试文件

## 运行测试

```bash
# 全部测试
node --test packages/*/tests/*.test.js

# 协议测试
node --test packages/protocol/tests/*.test.js

# 服务端测试
node --test packages/server/tests/*.test.js
```

## 测试文件

| 文件 | 数量 | 覆盖 |
|------|------|------|
| `validator.test.js` | 15 | 命令白名单/深度/截断/子结构 |
| `server.test.js` | 6 | WS 消息/限流/认证 |
| `encoder-decoder.test.js` | 75 | 编码/解码/CRC32/管道往返 |
| `integration-extended.test.js` | 66 | validator/input/config/renderer/pipeline |
| `fill-coverage.test.js` | 74 | 全opcode/URL/CSP/SRI/鉴权 |
| `boundary.test.js` | 24 | 压力/边界/并发 |

## 测试覆盖矩阵

| 层级 | 单元 | 集成 | 边界 | 压力 |
|------|------|------|------|------|
| 编码器 | ✅ | ✅ | ✅ | ✅ |
| 解码器 | ✅ | ✅ | ✅ | ✅ |
| 校验器 | ✅ | ✅ | ✅ | - |
| CRC32 | ✅ | ✅ | ✅ | - |
| 配置 | ✅ | - | ✅ | - |
| 输入代理 | - | ✅ | ✅ | ✅ |
| 渲染器 | ✅ | - | ✅ | - |
| 管道 (端到端) | - | ✅ | ✅ | ✅ |

## 拟真测试的已知限制

测试环境通过 Mock 覆盖协议层和服务层逻辑，但以下需要真实环境:

| 需真实环境 | 替代方案 |
|-----------|---------|
| Chromium page.screenshot | Mock FrameCapture |
| CanvasKit WASM 渲染 | Mock CanvasKit API |
| sharp JPEG 编码 | 跳过 (纯计算验证) |
| CDP 命令延迟 | Mock CDP |
| 真实网络传输 | 本地 WS |
| 多 session 并发 | 单线程测试 |

详见 `TEST_GAP_ANALYSIS.md` (未入库)。
