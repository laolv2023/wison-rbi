# 第三轮审计问题确认报告

> 基准：commit `1cb66c0`
> 方法：逐条代码读取 + 模拟实验

---

## 全部确认

| # | ID | 级别 | 确认方式 | 结论 |
|---|----|------|---------|------|
| 1 | R3-C1 | CRITICAL | L117 读代码 + 800×600 模拟 crash | ✅ 确认 |
| 2 | R3-H1 | HIGH | L235-236 读代码 + `setMetadata()` 防御验证 | ❌ 误判（setMetadata 已清理） |
| 3 | R3-H2 | HIGH | L50-58 vs L147-156 读代码 | ✅ 确认 |
| 4 | R3-H3 | HIGH | L149 `Buffer.from(msg.token||'')` 无类型校验 | ✅ 确认 |
| 5 | R3-H4 | HIGH | L116 `allocUnsafe` + R3-C1 加剧 | ✅ 确认（R3-C1 的共因） |
| 6 | R3-M1 | MEDIUM | L29 `_cleanedSessions` Set 只增不减 | ✅ 确认 |
| 7 | R3-M2 | MEDIUM | L166 调用 `session._notifyStatus` | ✅ 确认 |
| 8 | R3-M3 | MEDIUM | L87 `ws._wisonSessionId` expando | ✅ 确认 |
| 9 | R3-M4 | MEDIUM | L63 `remoteAddress` IPv4/IPv6 | ✅ 确认 |
| 10 | R3-M5 | MEDIUM | L222-229 `close()` + 立即 `delete` | ⚠️ 安全（_cleanedSessions 防重入） |
| 11 | R3-L1 | LOW | L175 `if (msg.width && msg.height)` 无范围 | ✅ 确认 |
| — | R3-L2 | LOW | L65 `wsServer._sessions` 私有访问 | ✅ 确认 |
| — | R3-L3 | LOW | L83 `Math.random()` 已知限制 | ✅ 确认 |
| — | R3-I1/2/3 | INFO | 信息性 | ✅ 确认 |

**总结：14/16 完全确认，1 项判定安全（R3-M5），1 项误判（R3-H1）。实际问题 = 14 个。**

## 误判说明

**R3-H1** — 初始判断 `finalize()` 抛出时 `reset()` 不执行导致 `_tiles` 堆积。但 `setMetadata()` 在每帧开始时通过 `this._tiles = []` 和 `this._commands = []` 清理所有累加器。`encoder.js:71-73` 处的代码证实了这一点。**无需修复。**

## 致命路径实验验证 (R3-C1)

| viewport | 结果 |
|----------|------|
| 1280×720 | ✅ OK（默认尺寸恰好对齐 tile 网格） |
| **800×600** | **❌ CRASH**（`srcOff=1,920,000 ≥ buffer=1,920,000`，`_updateAllHashes` 中的循环无边界检查） |
| 1366×768 | ✅ OK |
| 1024×768 | ✅ OK |

崩溃触发条件：`height / tileSize` 不是整数（即 `height % 16 ≠ 0`），且 `height < width`。

---

## 误判修正总结

| ID | 原始判定 | 修正 |
|----|---------|------|
| R3-H1 | HIGH — finalize 异常后 _tiles 堆积 | 安全 — setMetadata() 在每帧清理。**撤销** |
| R3-M5 | MEDIUM — close 后立即 delete 存在竞态 | 安全 — _cleanedSessions 防重入。**撤销** |

**最终确认：12 个有效新问题 + 1 个 CRITICAL（验证中降级的 2 项为安全）。**
