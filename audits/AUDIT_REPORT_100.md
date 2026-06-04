# 第100轮代码审计报告

> v1.13 | 100 轮聚焦审计 | 重点：生产环境不可测路径

## 总计: 19 个新发现

| 级别 | 数量 | ID |
|------|------|-----|
| **HIGH** | 1 | R29 |
| **MEDIUM** | 9 | R8, R12, R13, R16, R27, R30, R31, R53, R56 |
| **LOW** | 7 | R3, R7, R11, R14, R15, R24, R62 |
| **INFO** | 2 | R26, R45 |

## 详细清单

### HIGH
| ID | 文件:行 | 问题 |
|----|--------|------|
| **R29** | cdp-client.js:51 | CDP `_send` 无超时→鼠标事件在浏览器冻结时永久阻塞→阻塞所有后续 HID |

### MEDIUM
| ID | 文件:行 | 问题 |
|----|--------|------|
| **R8** | session.js:64 | `page.screenshot()` 无超时→渲染器冻结时永久挂起 |
| **R12** | session.js:303 | _restartChromium 失败后 _browser/_page/_cdp 引用未清空 |
| **R13** | session.js:299 | 重启后 navigate 失败→截图错误页→markFailure→无限重启循环 |
| **R16** | session.js:177 | destroy() 无超时→browser.close() 卡死时阻塞所有 _reapIdleSessions |
| **R27** | frame-capture.js:108 | 右边缘半瓦片 (1366px宽) sharp.extract 越界→帧捕获崩溃 |
| **R30** | cdp-client.js:53 | CDP 重试不区分可恢复/永久错误→永久错误仍重试 3 次 (1.5s延迟) |
| **R31** | cdp-client.js:75 | clickCount 恒为 1→双击无效 |
| **R53** | renderer.js:91 | CRC32 失败不计入 rejection→永不触发 request_keyframe→永久显示错误帧 |
| **R56** | renderer.js:88 | decode 异常不计入 rejection→相同问题 |

### LOW
| ID | 文件:行 | 问题 |
|----|--------|------|
| R3 | session.js:91 | crash handler 未 await/catch _onChromiumCrash→unhandled rejection |
| R7 | session.js:200 | _restartChromium 3次上限后不清除 _frameLoop 定时器 |
| R11 | session.js:271 | 重启异步间隙中 HID 使用旧 CDP→静默失败 |
| R14 | session.js:188 | forceKeyframe 在重启间隙 _capture=null 时静默忽略 |
| R15 | session.js:309 | _notifyStatus 同步调用→若回调阻塞则延迟帧捕获 |
| R24 | frame-capture.js:116 | allocUnsafe + 边缘瓦片→未初始化字节混入 MD5→假阳性 |
| R62 | hid-capture.js:68 | canvas 失焦→键盘中断→无自动聚焦 |

### INFO
| ID | 文件:行 | 问题 |
|----|--------|------|
| R26 | frame-capture.js:90 | 关键帧两次截图 (PNG+JPEG)→双倍截图开销 |
| R45 | ws-server.js:180 | 无 URL 黑白名单→SSRF 风险 (设计决策) |

---

## 六轮累计总览

```
R1: 21 | R2: 14 | R3: 16 | R4: 17 | R5: 8 | R100: 19
══════════════════════════════════════════════════════════
总计: 95 个独立问题 (合并后去重)
```
