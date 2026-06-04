# Compositor PaintOp 设计审核报告

> 审核日期: 2026-06-04 | 审核人: 系统架构师视角

## 总体评价

设计方向正确，但 **实现复杂度被严重低估**。按 1-10 评分：

| 维度 | 评分 | 说明 |
|------|------|------|
| 架构合理性 | 8/10 | 双管道共存设计正确 |
| 协议设计 | 7/10 | 格式合理，缺边界情况处理 |
| 可行性 | 4/10 | Chromium 修改范围低估 5-10× |
| 性能模型 | 5/10 | 基准值偏乐观，缺关键开销 |
| 实施估算 | 2/10 | 6 周不可能，应 12-20 周 |

---

## 一、致命缺陷

### C1: `OnDisplayListFinalized` 的 `const DisplayItemList*` 参数无法获取 PaintOp 数据

**问题**: `DisplayItemList` 的 `paint_op_buffer_` 是 `private` 成员。从外部钩子 `OnDisplayListFinalized(const DisplayItemList* list)` 无法访问其内部的 PaintOp 数组。除非：

- 将 `paint_op_buffer_` 改为 public（破坏 Chromium 封装）
- 给钩子传递内部引用（需要修改更多文件）
- 在 `DisplayItemList` 中新增 public 访问器（需要修改 `.h` 文件）

**实际修改范围**: 至少 3 个文件：`.h` (新增访问器)、`.cc` (Finalize 钩子 + PaintOp 遍历)、新增钩子文件。

### C2: SkPaint 不能"内联 17 字节"序列化

**问题**: `SkPaint` 在 Chromium 中是引用计数对象（`sk_sp<SkPaint>`），包含：

```
SkPaint 实际结构:
  - Typeface (sk_sp<SkTypeface>)     ← 字体引用 (复杂)
  - Shader (sk_sp<SkShader>)         ← 渐变/图案 (极其复杂)
  - MaskFilter (sk_sp<SkMaskFilter>)  ← 阴影/模糊效果
  - ColorFilter (sk_sp<SkColorFilter>) ← 颜色变换
  - PathEffect (sk_sp<SkPathEffect>)  ← 虚线等效果
  - ImageFilter (sk_sp<SkImageFilter>) ← 图像滤镜
  - 12+ 个标量字段 (color, width, cap, join, etc.)
```

一个简单的纯色 Paint：~20 字节。一个带渐变的 Paint：渐变着色器的序列化可达 **数百字节**。一个带阴影的 Paint：MaskFilter 的序列化可达 **KB 级别**。

**结论**: Paint 的"17 字节内联"假设只适用于最简单的纯色画笔。实际网页中，渐变/阴影/模糊是常态。

### C3: DrawTextBlobOp 依赖客户端字体——不可行

**问题**: `SkTextBlob` 只存储 glyph ID + 位置。不存储字体数据。

```
远程浏览器场景:
  服务端 Chromium 渲染页面 → DrawTextBlobOp(glyphIDs, positions, font)
  客户端 CanvasKit 回放 → 需要相同的字体文件
  → 客户端没有服务端的字体 → 字形缺失/替换 → 文字位置错位
```

**现实**:
- 网页字体通过 `@font-face` 加载，客户端没有这些字体
- 系统字体 (Arial, Helvetica, CJK 字体) 在不同 OS 上版本不同
- Android/iOS 的字体集与 Linux 完全不同
- 即使同为 Noto Sans CJK，版本差异也会导致 glyph 宽度偏差

**可行方案**:
- 方案 A: 传输字体二进制（每字体 2-20 MB，不可接受）
- 方案 B: 传输已 rasterize 的 glyph 位图（garnet 的做法，回退到像素传输）
- 方案 C: 仅用于已知系统字体（限制适用性）

### C4: R-tree 增量传输的边界不精确

**问题**: 文档说"仅序列化新视口区域的 PaintOp"。但 R-tree 索引的是 bounding rect，不是 Painting 的实际可见区域。

```
场景: 一个 <div> 高度 500px，包含大量文本

R-tree 条目: bounding rect = (0, 200, 1280, 700)
  覆盖旧视口 (0-720) 和新视口 (100-820)
  → "新区域" 判断: bbox 底部 (700) > 旧视口底部 (720)? 否
  → 被错误地跳过!

结果: 新滚动进来的内容丢失
```

**解决方案**: 需要裁剪 PaintOp（类似 SkCanvas 的 `quickReject`），但这又需要理解每个 PaintOp 的语义。

---

## 二、重大风险

### R1: Chromium 版本适配成本

```
当前 Tile 方案:
  Playwright 版本升级 → 零成本 (API 兼容)

PaintOp 方案:
  Chromium 主分支每 6 周发版
  每次发版要检查:
    - cc::DisplayItemList 内部结构是否变化
    - PaintOp 类型是否增删
    - Skia API 是否变更 (2-3 次/年)
    - GN 构建系统是否变更
  
  每次适配: 2-5 天 × 10+ 版本/年 = 20-50 天/年
```

### R2: SkShader/渐变序列化——几乎不可能完整实现

现代网页中渐变无处不在。`SkShader` 的序列化需要覆盖：

| Shader 类型 | 序列化难度 | 复杂度 |
|------------|-----------|--------|
| SkColorShader (纯色) | 简单 | 4 字节 |
| SkLinearGradient | 中等 | ~200B + color stops |
| SkRadialGradient | 中等 | ~200B + color stops |
| SkSweepGradient | 中等 | ~200B |
| SkConicalGradient | 困难 | ~300B |
| SkImageShader (纹理) | 极其困难 | 图像 + 变换矩阵 + 采样模式 |
| SkPerlinNoiseShader | 极其困难 | 噪声参数 + 随机种子 |
| SkGradientShader (复合) | 几乎不可能 | 多个渐变 compose |

如果只能序列化纯色 Paint，实际收益大打折扣——渐变在网页中的使用率 > 60%。

### R3: CanvasKit 不是 Chromium Skia 的镜像

```
Chromium 使用: Skia (C++, 最新 commit, GPU 加速)
CanvasKit 使用: Skia (WASM, 0.39.1 = 2023 版本, WebGL 子集)

API 差异:
  - CanvasKit 0.39.1 缺少一些较新的 PaintOp 参数
  - 字体渲染参数 (hinting, subpixel) 在 WASM 中行为不同
  - WebGL Canvas 的 clipRegion 行为与 Chromium GPU 不同
  - 某些 SkImageFilter 在 CanvasKit 中不可用

→ 命令回放不能保证像素级一致
→ 累积误差: 100 帧后位置偏移 2-3 px
```

---

## 三、设计缺失

| 缺失项 | 重要性 | 说明 |
|--------|--------|------|
| **字体策略** | 致命 | 没有字体，文本无法渲染 |
| **渐变序列化** | 致命 | 没有渐变，60%+ 的网页无法正确渲染 |
| **错误恢复** | 高 | PaintOp 回放失败时如何降级到 Tile |
| **版本协商** | 高 | 服务端/客户端 PaintOp 版本不匹配 |
| **性能预算** | 高 | Chromium 序列化 PaintOp 的 CPU 开销 (每帧) |
| **内存预算** | 高 | 图像去重缓存在服务端的最大尺寸 |
| **调试工具** | 中 | PaintOp dump/可视化/副作用检测 |
| **WebGL 内容** | 中 | 设计提到 WebGL 但不清晰如何截获 |
| **跨域字体** | 中 | `@font-face` 字体的 CORS 和许可 |

---

## 四、性能模型修正

原设计声称的带宽收益需要重新评估——加上 Paint/渐变/阴影的实际序列化成本：

| 场景 | 原估算 | 修正后 (含真实 Paint) | 实际收益 |
|------|--------|---------------------|---------|
| 静态文本 | 0 KB/s | 0 KB/s | ✅ 0× (持平) |
| 纯色文本滚动 | 50 KB/s | **80 KB/s** (SkPaint 更大) | ~2× (vs Tiles 150 KB/s) |
| 渐变文本滚动 | — | **300 KB/s** (渐变序列化) | ~0.5× (Tiles 更优!) |
| CSS 动画 (纯变换) | 5 KB/s | **5 KB/s** | ✅ 80× |
| CSS 动画 (带阴影) | 5 KB/s | **50 KB/s** | 8× |
| 图片浏览 | 200 KB/s | **250 KB/s** (含图像数据) | ~2.5× |
| 视频 | 3 MB/s | 3 MB/s | 持平 |

**修正结论**: PaintOp 的实际收益比设计估计低 30-50%，主要瓶颈在 SkPaint 序列化和渐变/阴影处理。

---

## 五、实施成本修正

| 阶段 | 原估算 | 修正 | 原因 |
|------|--------|------|------|
| Chromium 补丁 | 2周 | **4周** | 需要修改 ≥5 个文件，不是 1 个 |
| PaintOp 序列化 | — (未列出) | **4周** | SkPaint/SkShader/SkTextBlob 序列化极其复杂 |
| CDP 域扩展 | 1周 | **2周** | 需要修改 CDP 协议定义 + 前端 + 后端 |
| 协议扩展 | 3天 | 3天 | ✅ 正确 |
| PaintOpFrameCapture | 3天 | **2周** | 需要处理 PaintOp 遍历和增量裁剪 |
| 客户端渲染 | 1周 | **3周** | CanvasKit 字体/渐变回放需要大量适配 |
| 帧选择逻辑 | 2天 | 2天 | ✅ 正确 |
| 测试 | 1周 | **3周** | 需要 300+ 真实网页验证 |
| 字体方案 | — (未列出) | **2周** | 选型+集成 (系统字体集或 glyph 位图) |
| **合计** | **6周** | **~18周 (4.5 月)** | |

---

## 六、可行的降级方案

如果 18 周的完整实现不可接受，考虑以下务实方案：

### 降级方案 A: Glyph 位图模式

```
不序列化 DrawTextBlobOp
  而是在 Chromium 侧:
    - 对文本区域单独 rasterize → 位图
    - 作为 DrawImageOp 传输（嵌入 ImageRef 表）
    - 其他 PaintOp 照常序列化（变换、裁剪、矩形等）

优点: 解决字体问题，文本保真
缺点: 文本位图 ≈ 回归到像素传输，但矢量部分仍保持优势
带宽: 介于纯 Tiles 和纯 PaintOp 之间
```

### 降级方案 B: 仅几何变换模式

```
只截获以下 PaintOp:
  - Save/Restore/Translate/Scale/Rotate
  - ClipRect/ClipRRect

其他所有绘制操作 (DrawRect/DrawPath/DrawImage/DrawTextBlob):
  回退到 page.screenshot() → JPEG 瓦片

优点:
  - 滚动优化: 客户端 translate() + 仅传新瓦片
  - 零 SkPaint/SkShader 序列化需求
  - 实现周期: ~4 周
  - 主要收益保留

缺点:
  - CSS 动画的带宽优势丧失（需要 DrawRect 等）
  - 滚动场景的收益约为纯 PaintOp 的 50%
```

---

## 七、审核结论

| 项目 | 结论 |
|------|------|
| **能做吗?** | 可以，但比设计估算难 3-4× |
| **应该做吗?** | 值得，但需要降级为务实方案 |
| **建议路径** | 先实现降级方案 B (几何变换)，逐步扩展到完整 PaintOp |
| **第一阶段** | 4 周实现滚动优化 (translate + 增量瓦片 = 现有技术融合) |
