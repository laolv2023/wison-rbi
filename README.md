# Wison-RBI 设计方案

## 基于 Chromium Compositor 层拦截的浏览器隔离系统

> **文档状态**: Draft v1.5 (安全审计修复版)
> **设计原则**: 每一处设计决策必须可追溯至一个可审计的安全/性能理由
> **审计目标**: 安全边界清晰、状态转换可证明、数据流可逐字节追踪
>
> **v1.5 修复清单** (基于第三方安全审计，2026-06-03):
> - [P0] CommandValidator: 增加 Payload 子结构深度校验（防 OOM）
> - [P0] 图像缓存 Key: SHA-256 前 8 字节 → 完整 32 字节（防碰撞攻击）
> - [P0] DrawLayers: 增加 PostTask Worker 线程池异步编码（防看门狗崩溃）
> - [P0] frameHistory: Math.min → 环形缓冲区 + 时间戳 LRU（防 uint32 回绕）
> - [P0] MV3 合规: webRequestBlocking → declarativeNetRequest
> - [P1] drawShadow: 独立 OpCode 0x36，客户端完整解析
> - [P1] drawAtlas: 颜色解析 `& 0xFF` → 4 通道拆分
> - [P1] DisplayItemList: sk_sp 引用计数 + pending/active tree UAF 防护验证说明  

---

## 目录

1. [系统概述](#1-系统概述)
2. [安全模型](#2-安全模型)
3. [架构总览](#3-架构总览)
4. [服务端设计](#4-服务端设计)
5. [客户端设计](#5-客户端设计)
6. [通信协议规范](#6-通信协议规范)
7. [帧元数据与输入同步 (方案 B)](#7-帧元数据与输入同步)
8. [错误处理与边界情况](#8-错误处理与边界情况)
9. [实现计划](#9-实现计划)
10. [审计清单](#10-审计清单)

---

## 1. 系统概述

### 1.1 目标

构建一个浏览器隔离（Browser Isolation）系统，使得：

1. **客户端浏览器**不执行任何来自远程网页的 HTML、CSS、JavaScript
2. **客户端仅接收**经过安全校验的 Skia 绘制命令，在 `<canvas>` 上重放
3. **客户端仅发送**原始 HID 事件（鼠标坐标/按钮、键盘键码、滚轮增量），不发送页面语义信息
4. **服务端 Chromium** 执行完整的网页渲染，但拦截点在 Compositor（`cc::`）层而非 Skia 层

### 1.2 与 Cloudflare NVR 的关键区别

| 维度 | Cloudflare NVR | Wison-RBI (本方案) |
|------|---------------|-------------------|
| **拦截层级** | Skia API（`SkCanvas` 方法） | Compositor 层（`cc::DisplayItemList` / `PaintOp`） |
| **Chromium 修改范围** | Skia 源码 ~15 个文件 | cc 层 1-2 个文件 + 独立 RecordingCanvas |
| **客户端渲染引擎** | NVR WASM（专有，内嵌 Skia） | CanvasKit WASM（开源，标准 Skia） |
| **输入同步** | 未公开 | 帧元数据方案 B（frame_id + scroll 锚定） |
| **增量更新** | 未公开 | R-tree 空间索引驱动的瓦片级选择性重放 |
| **可审计性** | 闭源 | 全链路开源 |

### 1.3 术语定义

| 术语 | 定义 |
|------|------|
| **PaintOp** | Chromium cc 层的绘制操作抽象，共 33 种类型，序列化为平坦字节缓冲区 |
| **DisplayItemList** | PaintOp 的有序列表 + R-tree 空间索引，cc 层光栅化的数据源 |
| **RecordingCanvas** | 自定义 SkCanvas 子类，截获所有绘制调用并序列化，不执行实际光栅化 |
| **CommandBuffer** | 序列化后的 Skia 命令流，一帧的所有绘制指令 |
| **Frame** | 一次完整的页面渲染快照，包含 CommandBuffer + 元数据（frame_id, scroll, viewport） |
| **CDP** | Chrome DevTools Protocol，用于向 Chromium 注入输入事件 |
| **CanvasKit** | Skia 图形库的 WebAssembly 编译产物，在客户端执行绘制命令 |

---

## 2. 安全模型

### 2.1 威胁模型

```
                      ╔══════════════════════════╗
                      ║     信任边界              ║
                      ║                          ║
  ┌─────────┐         ║  ┌─────────────────┐     ║  ┌──────────┐
  │ 客户端   │◄────────╫──│  WebSocket 信道  │─────╫──│  服务端   │
  │         │         ║  │  (TLS 1.3)      │     ║  │          │
  │ Canvas  │         ║  └─────────────────┘     ║  │Chromium  │
  │ 仅画布   │         ║                          ║  │沙箱内网页 │
  └─────────┘         ╚══════════════════════════╝  └──────────┘
```

**攻击者能力假设**（防御方视角）：

| 威胁 | 假设 | 对策 |
|------|------|------|
| 恶意网页 | 网页包含任意恶意 JS/WASM/WebGL | Chromium 沙箱隔离；客户端不接触原始内容 |
| 信道中间人 | 可窃听、篡改 WebSocket 消息 | TLS 1.3 + 命令格式校验 |
| 服务端被入侵 | 攻击者控制服务器，可发送任意"绘制命令" | 客户端命令白名单 + 参数范围校验 |
| 客户端被入侵 | 攻击者可读取 canvas 像素、注入 JS | 超出本文范围（假设客户端环境可信） |
| 侧信道攻击 | 通过渲染时序/像素读取推断页面内容 | 禁用 readPixels；限制度量回传 |

### 2.2 核心安全不变量

```
不变量 1: 客户端收到的每一个字节，只能是以下二者之一：
         (a) 合法的 Skia 绘制命令（通过白名单校验）
         (b) 帧元数据（frame_id, scroll, viewport）

不变量 2: 客户端发出的每一个字节，只能是以下二者之一：
         (a) 原始 HID 事件（鼠标、键盘、滚轮）
         (b) 帧引用（frame_id — 不含任何页面语义）

不变量 3: 所有页面内容（HTML/CSS/JS）仅在服务端 Chromium 沙箱内执行。
         服务端不向客户端传输原始 HTML/CSS/JS。
         客户端不向服务端传输页面元素引用。
```

### 2.3 审计边界

以下内容在本方案中**明确不涉及**（不属于浏览器隔离核心）：

- 用户认证与授权
- WebSocket 连接的建立与 TLS 配置
- Chromium 沙箱的加固（使用 Chromium 默认沙箱）
- 服务端操作系统安全
- 客户端浏览器扩展的安装与权限

---

## 3. 架构总览

### 3.1 全局数据流

```
┌───────────────────────────────────────────────────────────────────────┐
│                            服  务  端                                   │
│                                                                       │
│  ┌──────────┐    ┌─────────────────┐    ┌───────────────────┐          │
│  │ Chromium │───→│ PictureLayerImpl│───→│ DisplayItemList   │          │
│  │ (修改版) │    │ PaintOp 录制     │    │ Finalize()        │          │
│  └────┬─────┘    └────────┬────────┘    └────────┬──────────┘          │
│       │ CDP 输入           │                      │  ← 拦截点 1         │
│       │                    │              ┌───────▼──────────┐          │
│  ┌────┴──────────┐        │              │ LayerRecorder     │  ← 新增  │
│  │  I/O 代理      │        │              │ 全图层 PaintOp     │          │
│  │  (Node.js)    │        │              └───────┬──────────┘          │
│  └────┬──────────┘        │                      │                     │
│       │                   ▼                      │                     │
│       │         LayerTreeHostImpl                 │                     │
│       │         DrawLayers() ← 拦截点 2           │                     │
│       │              │                           │                     │
│       │     ┌────────▼──────────┐                │                     │
│       │     │  FrameAssembler   │  ← 新增        │                     │
│       │     │  遍历所有活跃图层   │                │                     │
│       │     │  PaintOp → Skia   │◄───────────────┘                     │
│       │     │  (RecordingCanvas)│                                       │
│       │     └────────┬──────────┘                                      │
│       │              │                                                  │
│       │     ┌────────▼──────────┐                                      │
│       │     │  CommandBuffer    │                                      │
│       │     │  (序列化 + gzip)  │                                      │
│       │     └────────┬──────────┘                                      │
│       │              │                                                  │
│  ┌────┴──────────────▼──────────────────────────────────────┐         │
│  │                    Frame Builder                         │         │
│  │  frame_id + scroll + viewport + CommandBuffer            │         │
│  └─────────────────────────────┬───────────────────────────┘         │
│                                │                                      │
│              WebSocket Server  │                                      │
│              (TLS 1.3)        │                                      │
│                                │                                      │
└────────────────────────────────┼──────────────────────────────────────┘
                                 │
                    ═════════════╪══════════════
                                 │   网络
                    ═════════════╪══════════════
                                 │
┌────────────────────────────────┼──────────────────────────────────────┐
│                            客  户  端                                   │
│                                │                                       │
│  ┌─────────────────────────────▼────────────────────────────┐        │
│  │                    Frame Receiver                         │        │
│  │  解压 → 校验 frame_id 单调性 → 提取元数据                 │        │
│  └─────────────┬───────────────────────────────┬────────────┘        │
│                │                               │                      │
│     CommandBuffer (Skia)              Frame Metadata                   │
│                │                     (scroll, viewport)               │
│  ┌─────────────▼──────────────┐               │                      │
│  │  命令白名单扫描器            │               │                      │
│  │  逐条校验 opcode + 参数     │               │                      │
│  │  拒绝 = 丢弃帧 + 告警      │               │                      │
│  └─────────────┬──────────────┘               │                      │
│                │                               │                      │
│  ┌─────────────▼───────────────────────────────▼──────────┐          │
│  │              CanvasKit WASM (Skia)                     │          │
│  │  每条合法命令 → canvas.drawRect/drawText/...           │          │
│  │  canvas.flush() → <canvas> 像素输出                    │          │
│  └─────────────────────────┬─────────────────────────────┘          │
│                            │                                         │
│  ┌─────────────────────────▼─────────────────────────────┐          │
│  │  <canvas id="main" width="1920" height="1080">        │          │
│  │  ┌─────────────────────────────────────────────────┐ │          │
│  │  │              用户看到的画面                       │ │          │
│  │  └─────────────────────────────────────────────────┘ │          │
│  └─────────────────────────┬─────────────────────────────┘          │
│                            │                                         │
│  ┌─────────────────────────▼─────────────────────────────┐          │
│  │              HID 事件捕获层                            │          │
│  │                                                       │          │
│  │  mousemove/mousedown/mouseup → {x, y, btn, frame_id}  │          │
│  │  keydown/keyup              → {key, code, mods,       │          │
│  │                                 frame_id}              │          │
│  │  wheel                      → {dx, dy, frame_id}      │          │
│  │                                                       │          │
│  │  + 快捷键过滤（Ctrl+T/W/N/Q 等不发送）                 │          │
│  └─────────────────────────┬─────────────────────────────┘          │
│                            │                                         │
└────────────────────────────┼─────────────────────────────────────────┘
                             │
                             │  WebSocket (TLS 1.3)
                             │
                    回到服务端 I/O 代理 → CDP 注入 → Chromium
```

---

## 4. 服务端设计

### 4.1 Chromium 修改点

**修改文件清单**：

| 文件 | 修改类型 | 行数（估） |
|------|---------|:---------:|
| `cc/layers/picture_layer_impl.cc` | 修改：在 `UpdateRasterSource` 增加录制分支 | ~40 |
| `cc/trees/layer_tree_host_impl.cc` | 修改：帧提交时收集所有图层 PaintOp | ~60 |
| `garnet/recording_canvas.h` | **新增** | ~160 |
| `garnet/recording_canvas.cc` | **新增** | ~400 |
| `garnet/command_buffer.h` | **新增** | ~90 |
| `garnet/command_buffer.cc` | **新增** | ~280 |
| `garnet/frame_assembler.h` | **新增** | ~50 |
| `garnet/frame_assembler.cc` | **新增** | ~180 |
| `garnet/BUILD.gn` | **新增**：GN 构建规则 | ~25 |

**总计**: ~1285 行 C++，集中在 4 个新增文件和 2 个修改文件。

#### 4.1.1 拦截点（修正后）: `DisplayItemList::Finalize()` + 图层树汇总

**设计理由**: 上一版设计曾将拦截点设在 `RasterSource::PlaybackToCanvas`，但该函数在瓦片光栅化阶段被调用——每帧可能被调用 16-100+ 次（每瓦片一次），且每个瓦片只包含经过 R-tree 裁剪的 PaintOp 子集。此外，合成层（`will-change`、`position:fixed` 等）根本不走此路径。修正后的方案在**两个环节**截获完整数据：

**环节 1 — 单个图层`: DisplayItemList::Finalize()`**（在 `cc::PictureLayerImpl` 中）

当一个图层的绘制内容准备好时，`DisplayItemList::Finalize()` 被调用。此时 PaintOpBuffer 包含该图层的**完整**绘制命令（全图层，非瓦片裁剪后的子集），是理想的拦截点。

**环节 2 — 帧汇总: `LayerTreeHostImpl` 帧提交**（在 `cc/trees/` 中）

每个合成帧提交时，遍历所有激活的 `PictureLayerImpl`，收集各图层的 PaintOpBuffer + 图层元数据（变换矩阵、裁剪区域、透明度、混合模式），由 `FrameAssembler` 合并为完整帧。

```
  Blink 渲染
    │
    ▼
  PictureLayerImpl::UpdateRasterSource()
    │
    ▼
  DisplayItemList::Finalize()              ← ● 拦截点 1: 捕获完整 PaintOp
    │
    ▼
  全图层 PaintOpBuffer → 存入录制缓存
    │
    ▼
  LayerTreeHostImpl::DrawLayers()          ← ● 拦截点 2: 汇总所有图层
    │
    ▼
  FrameAssembler::Assemble()               ← 新增
    │
    ├── 遍历所有活跃 PictureLayerImpl
    ├── 对每个图层的 PaintOpBuffer 执行:
    │     RecordingCanvas::Replay(PaintOpBuffer) → 捕获 Skia 命令
    │     附加 layer 元数据 → save/translate/clip/opacity
    ├── 合并为一个 CommandBuffer
    └── 附加 frame_id + scroll + viewport → 完成帧
```

```cpp
// cc/layers/picture_layer_impl.cc — 拦截点 1
// 在 UpdateRasterSource 中，DisplayItemList 最终化后捕获

void PictureLayerImpl::UpdateRasterSource(...) {
    // ... 现有 Chromium 代码 ...

    // ========== 新增：录制 ==========
#if defined(ENABLE_GARNET_RECORDING)
    if (garnet::IsRecordingEnabled() && raster_source_) {
        garnet::LayerRecorder::RecordLayer(
            id(),                          // layer_id
            raster_source_->GetDisplayItemList(),  // 完整 PaintOp
            DrawTransform(),               // 变换矩阵
            visible_layer_rect(),          // 可见区域
            contents_opaque(),             // 是否不透明
            draw_opacity()                 // 透明度
        );
    }
#endif
    // ================================
}

// cc/trees/layer_tree_host_impl.cc — 拦截点 2
// 帧提交时汇总所有图层
//
// ⚠️ 并发设计要点:
//   DrawLayers 运行在 Compositor 线程 (Impl 线程)。
//   RecordingCanvas 的 Playback 仅捕获绘制命令（sk_sp 指针拷贝，O(1)），
//   不执行任何 image->encodeToData() 或 gzip 压缩等 CPU 密集操作。
//   实际的图像编码、压缩由 FrameAssembler::EncodeAsync() 通过
//   PostTask 投递到独立的后台 Worker 线程池，避免阻塞 Compositor 触发
//   Chromium 看门狗超时（Sad Tab 崩溃）。

void LayerTreeHostImpl::DrawLayers(...) {
#if defined(ENABLE_GARNET_RECORDING)
    if (garnet::IsRecordingEnabled()) {
        garnet::FrameAssembler assembler(content_bounds.width(),
                                         content_bounds.height());
        assembler.SetFrameMetadata(
            active_tree()->source_frame_number(),
            CurrentScrollOffset(),
            device_viewport_size()
        );

        // 遍历所有活跃图层，提交到 RecordingCanvas
        // SubmitLayer 仅执行 Playback → 录制绘制命令到 CommandBuffer
        // （sk_sp 指针拷贝，无图像编码，无阻塞风险）
        for (auto* layer : active_tree()->picture_layers()) {
            assembler.SubmitLayer(layer->id());
        }

        // Finalize: 序列化 CommandBuffer（纯内存拷贝，μs 级）
        auto frame = assembler.Assemble(/*canvas_size=*/content_bounds);

        // 图像编码和 gzip 压缩异步派发到 Worker 线程池
        // 完成后回调 DeliverFrame，不阻塞 Compositor
        garnet::WorkerPool::PostTask([frame = std::move(frame)]() mutable {
            frame.EncodePendingImages();    // encodeToData() 在此执行
            frame.Compress();               // gzip 压缩
            garnet::DeliverFrame(std::move(frame));
        });
    }
#endif
    // ... 正常绘制逻辑继续 ...
}

// garnet/frame_assembler.cc — 图帧合并器

FrameAssembler::FrameAssembler(int width, int height) {
    recording_canvas_ = RecordingCanvas::Create(width, height);
}

void FrameAssembler::SetFrameMetadata(
    uint32_t frame_id, gfx::Vector2dF scroll, gfx::Size viewport) {
    frame_id_ = frame_id;
    scroll_x_ = scroll.x();
    scroll_y_ = scroll.y();
    viewport_w_ = viewport.width();
    viewport_h_ = viewport.height();
}

void FrameAssembler::SubmitLayer(int layer_id) {
    // LayerRecorder::GetRecord 返回 sk_sp<> 引用计数的快照，
    // 保证 DisplayItemList 在 Playback 期间不被释放。
    // RecordLayer 和 SubmitLayer 都在 Compositor 线程执行——
    // Chromium 的 LayerTreeHostImpl 保证在 DrawLayers() 之前
    // 所有 UpdateRasterSource() 调用已完成（通过 pending/active tree 状态机）。
    //
    // 🔒 UAF 防护验证:
    //   - sk_sp<DisplayItemList> 强引用: Playback 期间引用计数 ≥ 2
    //     (LayerRecorder 持有的 map + SubmitLayer 中的局部变量)
    //   - Chromium pending/active tree 切换: Blink 主线程的 DOM 突变
    //     写入 pending tree，直到下次 Composite 才激活。DrawLayers 操作
    //     的是 active tree，此时已不可变 (immutable)。
    //   - 最坏情况: 若 RecordLayer 与 SubmitLayer 之间 tree 被强制切换
    //     (极少发生)，sk_sp 引用计数保证 DisplayItemList 至少存活到
    //     Playback 返回。
    const auto& record = LayerRecorder::GetRecord(layer_id);
    if (!record) return;

    SkCanvas* canvas = recording_canvas_.get();

    // 为每个图层应用其独立的变换和裁剪
    canvas->save();
    canvas->concat(record->transform);
    canvas->clipRect(record->visible_rect);
    if (record->opacity < 1.0f) {
        SkPaint p;
        p.setAlphaf(record->opacity);
        canvas->saveLayer(nullptr, &p);
        record->display_list->Playback(canvas, PlaybackParams(nullptr));
        canvas->restore();
    } else {
        record->display_list->Playback(canvas, PlaybackParams(nullptr));
    }
    canvas->restore();
}

CommandBuffer FrameAssembler::Assemble(SkISize canvas_size) {
    // RecordingCanvas 此时已包含所有图层的绘制命令
    // 按图层树的 z-order 排列，每个图层的变换和裁剪都已正确应用
    // ⚠️ 仅执行序列化（纯内存拷贝），不编码图像——编码由 Worker 线程异步完成
    auto buf = recording_canvas_->Finalize();
    buf.setHeader(frame_id_, timestamp_ms_, scroll_x_, scroll_y_,
                  viewport_w_, viewport_h_, canvas_size.width(), canvas_size.height());
    return buf;
}

// ═══════════════════════════════════════════
//  4.2.4 并发模型：Compositor ↔ Worker 线程分离
// ═══════════════════════════════════════════
//
// 问题: encodeToData() 单张 4K 图像耗时 10-50ms，若在 Compositor 线程
//       同步调用，多张图像可累计阻塞 >200ms，触发 Chromium 看门狗崩溃。
//
// 方案: 两阶段异步流水线。
//
//   Compositor 线程 (DrawLayers, <1ms):
//     └─ Playback → 录制绘制命令 → sk_sp 指针捕获（无编码）
//     └─ Finalize() → 序列化 CommandBuffer（μs 级）
//     └─ PostTask → 投递到 Worker 线程
//
//   Worker 线程 (后台, 不阻塞合成):
//     └─ EncodePendingImages() → encodeToData() 逐图像编码
//     └─ Compress() → gzip 压缩
//     └─ DeliverFrame() → 通过 Mojo/pipe 发送到 Node.js I/O 代理
//
// 线程安全: sk_sp<SkImage> 引用计数是线程安全的。
//           CommandBuffer 在 PostTask 后所有权转移（move），无共享状态。

// garnet/command_buffer.h
class CommandBuffer {
 public:
  // 必须在 Worker 线程调用，不可在 Compositor 线程调用
  void EncodePendingImages();
  void Compress();
  // ...
 private:
  struct ImageSlot {
    sk_sp<SkImage> image;     // 线程安全引用计数
    uint32_t buffer_offset;   // 序列化缓冲区中的占位偏移
    uint32_t placeholder_len; // 占位长度，编码后回填
  };
  std::vector<ImageSlot> pending_images_;  // 仅 Worker 线程访问
  WorkerPool* worker_pool_;                // 全局共享线程池（4-8 线程）
};
```

**为什么这解决了 F001 和 F002？**

| 问题 | 原架构 (PlaybackToCanvas) | 修正后 (DisplayItemList + LayerTreeHost) |
|------|--------------------------|----------------------------------------|
| 瓦片碎片化 | 16+ 次回调/帧，每次不完整 | 1 次汇总/帧，每个图层完整 PaintOp |
| 合成层遗漏 | `will-change` 等图层不走 RasterSource | 遍历 `picture_layers()` 覆盖所有图层 |
| 图层变换丢失 | 无法获取图层级 transform | 从 `PictureLayerImpl` 提取 DrawTransform |
| frame_id/scroll | 无帧级元数据 | `LayerTreeHostImpl` 持有 `source_frame_number` 和 scroll |

#### 4.1.2 RecordingCanvas 实现

RecordingCanvas 继承自 `SkNWayCanvas`（Skia 提供的多路广播 Canvas），将所有绘制调用捕获为命令序列。

```cpp
// garnet/recording_canvas.h

#ifndef GARNET_RECORDING_CANVAS_H_
#define GARNET_RECORDING_CANVAS_H_

#include "include/core/SkCanvas.h"
#include "include/core/SkNWayCanvas.h"
#include "include/core/SkPaint.h"
#include "include/core/SkPath.h"
#include "include/core/SkTextBlob.h"
#include "include/core/SkImage.h"
#include "garnet/command_buffer.h"

namespace garnet {

class RecordingCanvas : public SkNWayCanvas {
public:
    // 工厂方法：创建 RecordingCanvas（绑定最小 device）
    static std::unique_ptr<RecordingCanvas> Create(int width, int height);

    // 完成录制，返回序列化的 CommandBuffer
    CommandBuffer Finalize();

    // ──── 状态管理 ────
    void willSave() override;
    void willRestore() override;
    SkCanvas::SaveLayerStrategy getSaveLayerStrategy(
        const SaveLayerRec& rec) override;

    // ──── 变换 ────
    void didConcat44(const SkM44& matrix) override;
    void didTranslate(SkScalar dx, SkScalar dy) override;
    void didScale(SkScalar sx, SkScalar sy) override;
    void didRotate(SkScalar rad) override;

    // ──── 裁剪 ────
    void onClipRect(const SkRect& rect, SkClipOp op,
                    ClipEdgeStyle style) override;
    void onClipRRect(const SkRRect& rrect, SkClipOp op,
                     ClipEdgeStyle style) override;
    void onClipPath(const SkPath& path, SkClipOp op,
                    ClipEdgeStyle style) override;

    // ──── 绘制形状 ────
    void onDrawRect(const SkRect& rect, const SkPaint& paint) override;
    void onDrawRRect(const SkRRect& rrect, const SkPaint& paint) override;
    void onDrawDRRect(const SkRRect& outer, const SkRRect& inner,
                      const SkPaint& paint) override;
    void onDrawOval(const SkRect& oval, const SkPaint& paint) override;
    void onDrawArc(const SkRect& oval, SkScalar startAngle,
                   SkScalar sweepAngle, bool useCenter,
                   const SkPaint& paint) override;
    void onDrawPath(const SkPath& path, const SkPaint& paint) override;
    void onDrawPoints(PointMode mode, size_t count,
                      const SkPoint pts[], const SkPaint& paint) override;

    // ──── 绘制图像 ────
    void onDrawImage2(const SkImage* image, SkScalar left, SkScalar top,
                      const SkSamplingOptions&,
                      const SkPaint* paint) override;
    void onDrawImageRect2(const SkImage* image, const SkRect& src,
                          const SkRect& dst, const SkSamplingOptions&,
                          const SkPaint* paint,
                          SrcRectConstraint constraint) override;
    void onDrawImageLattice(const SkImage* image, const Lattice& lattice,
                            const SkRect& dst, SkFilterMode,
                            const SkPaint* paint) override;
    void onDrawAtlas(const SkImage* atlas, const SkRSXform xform[],
                     const SkRect tex[], const SkColor colors[],
                     int count, SkBlendMode,
                     const SkSamplingOptions&,
                     const SkRect* cull, const SkPaint* paint) override;
    void onDrawPatch(const SkPoint cubics[12], const SkColor colors[4],
                     const SkPoint texCoords[4], SkBlendMode,
                     const SkPaint& paint) override;

    // ──── 绘制文本 ────
    void onDrawTextBlob(const SkTextBlob* blob, SkScalar x, SkScalar y,
                        const SkPaint& paint) override;
    void onDrawGlyphRunList(const SkGlyphRunList& glyphRunList,
                            const SkPaint& paint) override;

    // ──── 绘制顶点 ────
    void onDrawVerticesObject(const SkVertices* vertices, SkBlendMode,
                              const SkPaint& paint) override;

    // ──── 绘制其他 ────
    void onDrawPaint(const SkPaint& paint) override;
    void onDrawColor(SkColor4f color, SkBlendMode mode) override;
    void onDrawShadow(const SkPath& path, const SkDrawShadowRec& rec) override;
    void onDrawEdgeAAQuad(const SkRect& rect, const SkPoint clip[4],
                          QuadAAFlags aaFlags, const SkColor4f& color,
                          SkBlendMode mode) override;
    void onDrawEdgeAAImageSet(const ImageSetEntry set[], int count,
                              const SkPoint dstClips[],
                              const SkMatrix preViewMatrices[],
                              const SkSamplingOptions&,
                              const SkPaint* paint,
                              SrcRectConstraint constraint) override;
    void onDrawDrawable(SkDrawable* drawable,
                        const SkMatrix* matrix) override;
    void onDrawAnnotation(const SkRect& rect, const char key[],
                          SkData* value) override;

    // ──── 禁止像素回读（安全约束） ────
    bool onReadPixels(const SkPixmap&, int, int) override {
        return false;  // 绝对禁止
    }

private:
    RecordingCanvas(SkISize size);

    // 将 SkPaint 序列化到当前 command 的 payload
    void writePaint(const SkPaint& paint);
    // 将 SkPath 序列化到当前 command 的 payload
    void writePath(const SkPath& path);
    // 将 SkTextBlob 序列化到当前 command 的 payload
    void writeTextBlob(const SkTextBlob* blob);
    // 将 SkImage 序列化（引用或内联像素）
    void writeImage(const SkImage* image);
    // 将 SkSamplingOptions 序列化
    void writeSampling(const SkSamplingOptions& sampling);
    // 将 SkVertices 序列化
    void writeVertices(const SkVertices* vertices);
    // 将 SkRSXform 数组序列化（用于 drawAtlas）
    void writeRSXforms(const SkRSXform xform[], int count);
    // 将 SkDrawShadowRec 序列化
    void writeShadowRec(const SkDrawShadowRec& rec);

    CommandBuffer buffer_;
    int width_;
    int height_;
    ImageMode image_mode_ = ImageMode::kInline;
    std::unordered_set<uint64_t> sent_hashes_;
};

}  // namespace garnet
#endif  // GARNET_RECORDING_CANVAS_H_
```

**详细实现逻辑**：

```cpp
// garnet/recording_canvas.cc（关键方法）

SkCanvas::SaveLayerStrategy RecordingCanvas::getSaveLayerStrategy(
    const SaveLayerRec& rec) {
    buffer_.beginCommand(OpCode::kSaveLayer);
    if (rec.fBounds) buffer_.writeRect(*rec.fBounds);
    else buffer_.writeRect(SkRect::MakeEmpty());
    if (rec.fPaint) writePaint(*rec.fPaint);
    else { SkPaint empty; writePaint(empty); }
    buffer_.writeU32(rec.fSaveLayerFlags);
    buffer_.endCommand();
    return SkCanvas::kNoLayer_SaveLayerStrategy;  // 不创建实际图层
}

void RecordingCanvas::onDrawRect(const SkRect& rect, const SkPaint& paint) {
    buffer_.beginCommand(OpCode::kDrawRect);
    buffer_.writeRect(rect);
    writePaint(paint);
    buffer_.endCommand();

    // 不调用父类 onDrawRect——我们不渲染，只录制
}

void RecordingCanvas::onDrawTextBlob(
    const SkTextBlob* blob, SkScalar x, SkScalar y, const SkPaint& paint) {
    buffer_.beginCommand(OpCode::kDrawTextBlob);
    buffer_.writeScalar(x);
    buffer_.writeScalar(y);
    writeTextBlob(blob);
    writePaint(paint);
    buffer_.endCommand();
}

void RecordingCanvas::onDrawImage2(
    const SkImage* image, SkScalar left, SkScalar top,
    const SkSamplingOptions& sampling, const SkPaint* paint) {
    buffer_.beginCommand(OpCode::kDrawImage);
    buffer_.writeScalar(left);
    buffer_.writeScalar(top);
    writeSampling(sampling);  // 序列化滤波模式
    writeImage(image);
    if (paint) writePaint(*paint);
    buffer_.endCommand();
}

void RecordingCanvas::onDrawImageRect2(
    const SkImage* image, const SkRect& src, const SkRect& dst,
    const SkSamplingOptions& sampling, const SkPaint* paint,
    SrcRectConstraint constraint) {
    buffer_.beginCommand(OpCode::kDrawImageRect);
    buffer_.writeRect(src);
    buffer_.writeRect(dst);
    writeSampling(sampling);
    buffer_.writeU8(static_cast<uint8_t>(constraint));
    writeImage(image);
    if (paint) writePaint(*paint);
    buffer_.endCommand();
}

void RecordingCanvas::onDrawGlyphRunList(
    const SkGlyphRunList& glyphRunList, const SkPaint& paint) {
    // 新版 Skia 文本 API (Chromium M90+)
    // 将 SkGlyphRunList 拆解为多个独立的 glyphRun
    buffer_.beginCommand(OpCode::kGlyphRunList);
    int totalRuns = 0;
    for (auto& run : glyphRunList) {
        totalRuns++;
        buffer_.writeScalar(glyphRunList.origin().x());
        buffer_.writeScalar(glyphRunList.origin().y());
        buffer_.writeScalar(run.font().getSize());
        auto* typeface = run.font().refTypefaceOrDefault();
        buffer_.writeU32(typeface ? typeface->uniqueID() : 0);
        // 写入 glyph 数组
        buffer_.writeU32(run.runSize());
        for (int i = 0; i < run.runSize(); i++) {
            buffer_.writeU16(run.glyphs()[i]);
            buffer_.writeScalar(run.positions()[i].x());
            buffer_.writeScalar(run.positions()[i].y());
        }
    }
    buffer_.writeI32(totalRuns);
    writePaint(paint);
    buffer_.endCommand();
}

void RecordingCanvas::onDrawImageLattice(
    const SkImage* image, const Lattice& lattice,
    const SkRect& dst, SkFilterMode filter, const SkPaint* paint) {
    buffer_.beginCommand(OpCode::kDrawImageRect);  // 降级为 drawImageRect
    // 序列化 lattice 的九个格子 + 目标矩形
    buffer_.writeRect(dst);
    buffer_.writeU8(static_cast<uint8_t>(filter));
    writeImage(image);
    if (paint) writePaint(*paint);
    buffer_.endCommand();
}

void RecordingCanvas::onDrawAtlas(
    const SkImage* atlas, const SkRSXform xform[],
    const SkRect tex[], const SkColor colors[],
    int count, SkBlendMode mode, const SkSamplingOptions& sampling,
    const SkRect* cull, const SkPaint* paint) {
    // drawAtlas 语义：通过 RSXform 将纹理矩形变形绘制
    // 使用专用的 kDrawAtlas opcode（0x42），与 kDrawImage 区分
    buffer_.beginCommand(OpCode::kDrawAtlas);
    buffer_.writeI32(count);
    writeSampling(sampling);
    buffer_.writeU8(static_cast<uint8_t>(mode));
    buffer_.writeU8(colors ? 1 : 0);  // has_colors flag
    // 序列化 RSXform 数组 (每个 4 floats = 16 bytes)
    for (int i = 0; i < count; i++) {
        buffer_.writeScalar(xform[i].fSCos);
        buffer_.writeScalar(xform[i].fSSin);
        buffer_.writeScalar(xform[i].fTx);
        buffer_.writeScalar(xform[i].fTy);
    }
    // 序列化 tex rect 数组
    for (int i = 0; i < count; i++) {
        buffer_.writeRect(tex[i]);
    }
    // 序列化 colors 数组
    if (colors) {
        for (int i = 0; i < count; i++) {
            buffer_.writeU32(colors[i]);
        }
    }
    // cull rect
    buffer_.writeU8(cull ? 1 : 0);
    if (cull) buffer_.writeRect(*cull);
    writeImage(atlas);
    if (paint) writePaint(*paint);
    buffer_.endCommand();
}

void RecordingCanvas::onDrawPatch(
    const SkPoint cubics[12], const SkColor colors[4],
    const SkPoint texCoords[4], SkBlendMode mode, const SkPaint& paint) {
    buffer_.beginCommand(OpCode::kDrawPath);  // 降级：通过路径
    SkPath path;
    path.moveTo(cubics[0]);
    path.cubicTo(cubics[1], cubics[2], cubics[3]);
    path.cubicTo(cubics[4], cubics[5], cubics[6]);
    path.cubicTo(cubics[7], cubics[8], cubics[9]);
    path.cubicTo(cubics[10], cubics[11], cubics[0]);
    writePath(path);
    writePaint(paint);
    buffer_.endCommand();
}

void RecordingCanvas::onDrawVerticesObject(
    const SkVertices* vertices, SkBlendMode mode, const SkPaint& paint) {
    buffer_.beginCommand(OpCode::kDrawPath);  // 降级
    writeVertices(vertices);
    buffer_.writeU8(static_cast<uint8_t>(mode));
    writePaint(paint);
    buffer_.endCommand();
}

void RecordingCanvas::onDrawShadow(
    const SkPath& path, const SkDrawShadowRec& rec) {
    // 使用独立 OpCode 0x36 而非复用 kDrawPath（0x34）。
    // 客户端需要独立的分发路径以调用 CanvasKit drawShadow API。
    buffer_.beginCommand(OpCode::kDrawShadow);
    writePath(path);
    writeShadowRec(rec);       // 含 zPlaneParams, lightPos, lightRadius 等
    buffer_.endCommand();
}

void RecordingCanvas::onDrawEdgeAAQuad(
    const SkRect& rect, const SkPoint clip[4],
    QuadAAFlags aaFlags, const SkColor4f& color, SkBlendMode mode) {
    SkPaint p;
    p.setColor4f(color);
    p.setBlendMode(mode);
    p.setAntiAlias(aaFlags != QuadAAFlags::kNone);
    buffer_.beginCommand(OpCode::kDrawRect);
    buffer_.writeRect(rect);
    writePaint(p);
    buffer_.endCommand();
}

void RecordingCanvas::onDrawEdgeAAImageSet(
    const ImageSetEntry set[], int count,
    const SkPoint dstClips[], const SkMatrix preViewMatrices[],
    const SkSamplingOptions& sampling, const SkPaint* paint,
    SrcRectConstraint constraint) {
    // 批量图像集：依次降级为多个 drawImageRect
    for (int i = 0; i < count; i++) {
        buffer_.beginCommand(OpCode::kDrawImageRect);
        buffer_.writeRect(set[i].fSrcRect);
        buffer_.writeRect(set[i].fDstRect);
        writeSampling(sampling);
        buffer_.writeU8(static_cast<uint8_t>(constraint));
        writeImage(set[i].fImage.get());
        if (paint) writePaint(*paint);
        buffer_.endCommand();
    }
}

void RecordingCanvas::onDrawDrawable(SkDrawable* drawable, const SkMatrix* matrix) {
    // SkDrawable 是 Skia 的插件式绘制对象，无法可靠序列化
    // 记录为占位 op，客户端跳过
    buffer_.beginCommand(OpCode::kMaxOpCode);  // 使用 0x7F 作为占位
    buffer_.endCommand();
}

void RecordingCanvas::onDrawAnnotation(
    const SkRect& rect, const char key[], SkData* value) {
    // PDF/调试用标注，非视觉内容，跳过
}

void RecordingCanvas::didRotate(SkScalar rad) {
    buffer_.beginCommand(OpCode::kRotate);
    buffer_.writeScalar(rad);
    buffer_.endCommand();
}

CommandBuffer RecordingCanvas::Finalize() {
    buffer_.finalize();  // 冻结缓冲区，添加校验和
    return std::move(buffer_);
}
```

#### 4.1.3 CommandBuffer 序列化格式

```cpp
// garnet/command_buffer.h

namespace garnet {

// 命令操作码（与 CanvasKit API 一一对应）
enum class OpCode : uint8_t {
    // 状态 (0x00-0x0F)
    kSave           = 0x01,
    kRestore        = 0x02,
    kSaveLayer      = 0x03,

    // 变换 (0x10-0x1F)
    kConcat         = 0x10,
    kTranslate      = 0x11,
    kScale          = 0x12,
    kRotate         = 0x13,

    // 裁剪 (0x20-0x2F)
    kClipRect       = 0x20,
    kClipRRect      = 0x21,
    kClipPath       = 0x22,

    // 绘制形状 (0x30-0x3F)
    kDrawRect       = 0x30,
    kDrawRRect      = 0x31,
    kDrawOval       = 0x32,
    kDrawArc        = 0x33,
    kDrawPath       = 0x34,
    kDrawPoints     = 0x35,
    kDrawShadow     = 0x36,  // 独立 shadow 指令，不能复用 kDrawPath

    // 绘制图像 (0x40-0x4F)
    kDrawImage      = 0x40,
    kDrawImageRect  = 0x41,
    kDrawAtlas      = 0x42,

    // 绘制文本 (0x50-0x5F)
    kDrawTextBlob   = 0x50,
    kGlyphRunList   = 0x51,

    // 绘制其他 (0x60-0x6F)
    kDrawPaint      = 0x60,
    kDrawColor      = 0x61,

    // 限制: 最大合法 opcode = 0x7F
    kMaxOpCode      = 0x7F,
};

// 二进制帧格式：
//
// ┌────────────────────────────────────────────────────────┐
// │  Header (30 bytes)                                     │
// │  ┌──────────┬──────────┬──────────┬──────────┐        │
// │  │ frame_id │ timestamp│ scroll_x │ scroll_y │        │
// │  │ uint32   │  int64   │  int32   │  int32   │        │
// │  ├──────────┴──────────┴──────────┴──────────┤        │
// │  │ viewport_w│viewport_h│canvas_w │canvas_h │        │
// │  │ uint16    │ uint16   │ uint16  │ uint16  │        │
// │  │         reserved (uint16)        │                 │
// │  └───────────────────────────────────────────┘        │
// ├────────────────────────────────────────────────────────┤
// │  Command 0                                             │
// │  ┌────────┬──────────┬───────────────────────┐        │
// │  │ opcode │ pay_len  │ payload               │        │
// │  │ uint8  │ uint24   │ variable (pay_len B)  │        │
// │  └────────┴──────────┴───────────────────────┘        │
// ├────────────────────────────────────────────────────────┤
// │  Command 1                                             │
// │  ...                                                   │
// ├────────────────────────────────────────────────────────┤
// │  Trailer (4 bytes)                                     │
// │  ┌──────────────────────────────┐                      │
// │  │ CRC32 (header + all commands)│                      │
// │  └──────────────────────────────┘                      │
// └────────────────────────────────────────────────────────┘

class CommandBuffer {
public:
    // ──── Header 写入 ────
    void setHeader(uint32_t frame_id, int64_t timestamp_ms,
                   int32_t scroll_x, int32_t scroll_y,
                   uint16_t viewport_w, uint16_t viewport_h,
                   uint16_t canvas_w, uint16_t canvas_h);

    // ──── Command 写入 ────
    void beginCommand(OpCode op);
    void writeU8(uint8_t v);
    void writeU32(uint32_t v);
    void writeI32(int32_t v);
    void writeF32(float v);
    void writeScalar(SkScalar v);        // float
    void writeRect(const SkRect& r);     // 4 × float = 16 bytes
    void writeBlob(const void* data, size_t len);
    void endCommand();

    // ──── 序列化 ────
    void finalize();                     // 计算 CRC32，冻结
    std::vector<uint8_t> serialize() const;  // 返回完整帧字节流
    size_t size() const;

private:
    std::vector<uint8_t> data_;
    size_t current_cmd_start_;           // 当前命令在 data_ 中的起始偏移
    bool finalized_ = false;
};

}  // namespace garnet
```

**Paint 序列化格式**（payload 内的子结构）:

```
Paint = {
    color:        uint32 (RGBA, 4B)
    stroke_width: float   (4B)
    style:        uint8   (0=Fill, 1=Stroke, 2=StrokeAndFill)
    cap:          uint8
    join:         uint8
    _pad:         uint8   (对齐填充, 保证后续 float 4B 对齐)
    miter_limit:  float   (4B)
    blend_mode:   uint8
    anti_alias:   uint8
    has_shader:   uint8   (0/1)
    shader:       if has_shader → Shader variant (变长)
    has_mask_filter:  uint8
    mask_filter:  if has_mask_filter → MaskFilter variant
    has_color_filter: uint8
    color_filter: if has_color_filter → ColorFilter variant
    has_image_filter: uint8
    image_filter: if has_image_filter → ImageFilter variant
}
// 最小: 19B（纯色填充无特效，含 1B 对齐填充）
// 典型: 31-81B
// 复杂: 101-301B（多层 shader + filter）
```

#### 4.1.4 运行时配置

以下两项通过 Chromium 命令行参数或环境变量控制，可在不重新编译的情况下切换。

**配置项 1：图像传输策略** (`--garnet-image-mode`)

```
  inline     (默认)   每帧内联传输图像编码数据（PNG/JPEG/WebP 原始字节）。
                     优点：客户端无状态，断线重连无缓存一致性问题。
                     缺点：相同图像重复传输，带宽浪费。

  hash-ref   使用图像内容的完整 SHA-256（32 字节）作为引用键。
             首次出现：内联传输图像数据 + hash。
             再次出现：仅传输 hash 引用（32 字节），客户端从 LRU 缓存取出。
             缓存容量：客户端 64MB LRU，服务端维护 hash→image 映射。
                     优点：大幅节省带宽（重复图像如 logo、icon、背景图）。
                     缺点：客户端需维护缓存；重连后缓存失效需重新预热。
                     安全性：32 字节（256-bit）空间防止恶意碰撞攻击，
                             即使攻击者在服务端构造碰撞对，
                             256-bit 生日界约 2^128 次操作，计算上不可行。

  示例：
    chromium --garnet-image-mode=hash-ref
```

实现要点（`writeImage` 方法）：

> **注意**: `writeImage` 在 RecordingCanvas::Playback 期间被调用（Compositor 线程）。
> 本方法仅捕获 `sk_sp<SkImage>` 引用并分配图像槽位 ID，不在此处调用
> `encodeToData()`。实际编码由 `CommandBuffer::EncodePendingImages()`
> 在 Worker 线程异步完成。参见 §4.2.4 并发模型。

```cpp
void RecordingCanvas::writeImage(const SkImage* image) {
    if (image_mode_ == ImageMode::kHashRef) {
        // 使用完整 SHA-256（32 字节），防止 64-bit 生日碰撞攻击。
        // 256-bit 空间：恶意碰撞需要 ~2^128 次操作，计算上不可行。
        auto hash = ComputeSHA256(image);         // 32 字节
        if (sent_hashes_.count(hash)) {
            buffer_.writeU8(0x01);       // flag: 引用
            buffer_.writeBlob(hash, 32); // 32 字节完整 hash
            return;
        }
        sent_hashes_.insert(hash);
    }
    // ⚠️ 关键设计: 在 Compositor 线程仅分配槽位并捕获 sk_sp 引用,
    //   不调用 image->encodeToData()。实际编码由 Worker 线程执行。
    buffer_.writeU8(0x00);                // flag: 内联
    uint32_t slot = buffer_.reserveImageSlot(image);  // O(1)，无编码
    if (image_mode_ == ImageMode::kHashRef) {
        buffer_.writeBlob(hash, 32);
    }
}
```

**配置项 2：服务端光栅化** (`--garnet-raster-mode`)

```
  full      (默认)   PaintOp 录制 + 正常光栅化同时进行。
                    录制在 DisplayItemList::Finalize() 之后执行，
                    光栅化在正常瓦片光栅化阶段不受影响。
                    优点：可在服务端截图对比验证（调试/审计）。
                    缺点：消耗 GPU 内存（每个 Chromium 实例 ~50-200MB）。

  record-only      仅 PaintOp 录制，跳过正常光栅化。
                   DisplayItemList 仅进入录制缓存，不进入瓦片管理器。
                   优点：零 GPU 开销，适合高密度部署。
                   缺点：无法在服务端查看页面渲染结果。

  示例：
    chromium --garnet-raster-mode=record-only
```

#### 4.1.5 字体一致性机制

`SkTextBlob` 中携带的 glyph ID 是**字体文件特定的**。若服务端 Chromium 和客户端 CanvasKit 使用不同的字体文件（不同版本、不同回退链），glyph ID 映射错误会导致乱码。

**方案**: 服务端 Chromium 使用与 CanvasKit 完全相同的字体打包。

```
  服务端 Chromium：
    --font-renderer-hinting=none              # 关闭 hinting（CanvasKit 不支持）
    --disable-font-subpixel-positioning       # 对齐 CanvasKit 的渲染
    字体文件: /fonts/ (从 CanvasKit 提取)

  字体提取脚本:
    # 从 CanvasKit npm 包提取内嵌字体
    cp node_modules/canvaskit-wasm/bin/canvaskit.wasm /fonts/
    # 提取字体 blob → 转换为 Chromium 可加载的 .ttf 集合
    garnet_tool extract_fonts --from=canvaskit.wasm --to=/fonts/

  验证:
    # 同一段文字的服务端截图 vs 客户端 CanvasKit 截图
    # 逐像素对比（perceptual diff tolerance < 0.1%）
```

**fallback 字体处理**: 
- 网页指定的字体如果不在 CanvasKit 集合中，服务端 Chromium 的字体回退链与客户端 CanvasKit 的回退链需要一致
- 通过 `--force-webfonts` 标志，网页自定义字体（`@font-face`）下载后不通过 Skia 的字体管理器，而是直接作为 `SkTypeface` 对象内联到帧中传输
- 每帧字体二进制 ≤5MB，存入客户端 LRU 字体缓存

**已知局限**:
- CJK 字体（中/日/韩）文件过大（Noto Sans CJK ~15MB），不适合每帧传输。Phase 1 仅支持 CanvasKit 内嵌字体的字符集；Phase 3 添加按需 glyph 子集传输
- Emoji 渲染（彩色 glyph）在 CanvasKit 中有限支持；Phase 2 前限制为黑白 emoji

**验证**: `record-only` 模式下，在 LayerTreeHostImpl 中设置 `skip_raster=true` 即可跳过瓦片光栅化。DisplayItemList 的生命周期与正常模式相同（由图层缓存管理），仅录制输出被路由到 FrameAssembler 而非光栅化缓存。

### 4.2 I/O 代理 (Node.js)

```javascript
// server/io_proxy.js

const CDP = require('chrome-remote-interface');

class InputProxy {
    /**
     * @param {CDP.Client} cdpClient  - CDP 连接到 Chromium
     * @param {Map<number, FrameMeta>} frameHistory - frame_id → 帧元数据
     */
    constructor(cdpClient, frameHistory) {
        this.cdp = cdpClient;
        this.frameHistory = frameHistory;
        this._latestFrameId = 0;
        this._viewportW = 0;
        this._viewportH = 0;
        this._dpr = 1;
        this._lastClickTime = 0;
        this._lastClickX = 0;
        this._lastClickY = 0;
        this._clickCount = 0;
    }

    // 当新帧生成时，记录其元数据
    onFrameGenerated(frameMeta) {
        this._latestFrameId = frameMeta.frame_id;
        this.frameHistory.set(frameMeta.frame_id, {
            scroll_x: frameMeta.scroll_x,
            scroll_y: frameMeta.scroll_y,
            viewport_w: frameMeta.viewport_w,
            viewport_h: frameMeta.viewport_h,
            canvas_w: frameMeta.canvas_w,
            canvas_h: frameMeta.canvas_h,
            timestamp: frameMeta.timestamp,
        });

        // 清理超过 1000ms 的旧帧
        // 注意：V8 Map 的 forEach 在迭代期间 insert/delete 是安全的（不会漏项或抛异常）
        const cutoff = frameMeta.timestamp - 1000;
        this.frameHistory.forEach((meta, id) => {
            if (meta.timestamp < cutoff) {
                this.frameHistory.delete(id);
            }
        });
    }

    /**
     * 处理来自客户端的原始 HID 事件
     * @param {Object} event
     * @param {string} event.type     - 'mousemove'|'mousedown'|'mouseup'|
     *                                   'keydown'|'keyup'|'wheel'
     * @param {number} event.frame_id - 客户端渲染的最后一帧 ID
     * @param {number} [event.x]      - canvas 坐标 X
     * @param {number} [event.y]      - canvas 坐标 Y
     * @param {number} [event.button] - 鼠标按钮
     * @param {string} [event.key]    - 按键名
     * @param {string} [event.code]   - 物理键码
     * @param {number} [event.deltaX] - 滚轮增量
     * @param {number} [event.deltaY]
     */
    async handleInput(event) {
        // 1. 根据 frame_id 查找帧元数据（含 scroll offset）
        const meta = this._resolveFrameMeta(event.frame_id);

        switch (event.type) {
            case 'mousemove':
            case 'mousedown':
            case 'mouseup':
                await this._dispatchMouse(event, meta);
                break;
            case 'wheel':
                await this._dispatchWheel(event, meta);
                break;
            case 'keydown':
            case 'keyup':
                await this._dispatchKey(event);
                break;
            default:
                // 未知事件类型 — 丢弃，不抛出（防 DoS）
                console.warn(`Unknown input type: ${event.type}`);
        }
    }

    /**
     * 处理客户端视口更新
     * @param {Object} viewport
     * @param {number} viewport.width  - CSS 像素宽度
     * @param {number} viewport.height - CSS 像素高度
     * @param {number} viewport.devicePixelRatio
     */
    async handleViewport(viewport) {
        await this.cdp.Emulation.setDeviceMetricsOverride({
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: viewport.devicePixelRatio,
            mobile: false,
        });
        await this.cdp.Emulation.setVisibleSize({
            width: viewport.width,
            height: viewport.height,
        });
        // 更新帧元数据中的 viewport 尺寸（后续帧头将携带新值）
        // 注意：这些字段用于在旧帧历史全部淘汰（如刚连接时）的降级场景中
        // 提供兜底的 viewport 尺寸，确保 _canvasToViewport 不会拿到零值
        this._viewportW = viewport.width;
        this._viewportH = viewport.height;
        this._dpr = viewport.devicePixelRatio;
    }

    // ──── 坐标转换：canvas → viewport ────
    _canvasToViewport(canvasX, canvasY, meta) {
        // canvas 尺寸 = Chromium 绘制面 (如 2000×2200)
        // viewport 尺寸 = Chromium 视口 (如 1400×900)
        // 公式：
        //   vp_x = (canvas_x - meta.scroll_x) * (meta.viewport_w / meta.canvas_w)
        //   vp_y = (canvas_y - meta.scroll_y) * (meta.viewport_h / meta.canvas_h)
        //
        // 简单模式（canvas == viewport）:
        //   vp_x = canvas_x - meta.scroll_x
        //   vp_y = canvas_y - meta.scroll_y

        const scaleX = meta.viewport_w / meta.canvas_w;
        const scaleY = meta.viewport_h / meta.canvas_h;

        return {
            x: Math.max(0, Math.min(meta.viewport_w,
                   (canvasX - meta.scroll_x) * scaleX)),
            y: Math.max(0, Math.min(meta.viewport_h,
                   (canvasY - meta.scroll_y) * scaleY)),
        };
    }

    async _dispatchMouse(event, meta) {
        const vp = this._canvasToViewport(event.x, event.y, meta);

        // 双击/三击检测（300ms 窗口，5px 容差）
        const now = Date.now();
        if (event.type === 'mousedown') {
            if (now - this._lastClickTime < 300 &&
                Math.abs(vp.x - this._lastClickX) < 5 &&
                Math.abs(vp.y - this._lastClickY) < 5) {
                this._clickCount++;
            } else {
                this._clickCount = 1;
            }
            this._lastClickTime = now;
            this._lastClickX = vp.x;
            this._lastClickY = vp.y;
        }

        await this.cdp.Input.dispatchMouseEvent({
            type: this._mapMouseType(event.type),
            x: Math.round(vp.x),
            y: Math.round(vp.y),
            button: this._mapButton(event.button),
            buttons: event.buttons || 0,
            clickCount: event.type === 'mousedown' ? this._clickCount : 0,
        });
    }

    async _dispatchWheel(event, meta) {
        const vp = this._canvasToViewport(event.x, event.y, meta);

        await this.cdp.Input.dispatchMouseEvent({
            type: 'mouseWheel',
            x: Math.round(vp.x),
            y: Math.round(vp.y),
            deltaX: event.deltaX || 0,
            deltaY: event.deltaY || 0,
        });
    }

    async _dispatchKey(event) {
        await this.cdp.Input.dispatchKeyEvent({
            type: event.type === 'keydown' ? 'keyDown' : 'keyUp',
            key: event.key,
            code: event.code,
            text: event.type === 'keydown' ? event.key : undefined,
            unmodifiedText: event.type === 'keydown' ? event.key : undefined,
            location: event.location || 0,
            modifiers: this._computeModifiers(event),
            windowsVirtualKeyCode: this._keyToVK(event.code),
        });
    }

    // ──── Frame 解析 ────
    _resolveFrameMeta(frameId) {
        if (frameId && this.frameHistory.has(frameId)) {
            return this.frameHistory.get(frameId);
        }
        // 降级: 使用最新帧
        console.warn(
            `Frame ${frameId} not in history, falling back to latest ${this._latestFrameId}`
        );
        const latest = this.frameHistory.get(this._latestFrameId);
        if (latest) return latest;
        // 最终兜底：使用 handleViewport 写入的视口尺寸
        return {
            scroll_x: 0, scroll_y: 0,
            viewport_w: this._viewportW || 1400,
            viewport_h: this._viewportH || 900,
            canvas_w: this._viewportW || 1400,
            canvas_h: this._viewportH || 900,
            timestamp: 0,
        };
    }

    // ──── 按键映射 ────
    _mapMouseType(type) {
        const map = { mousemove: 'mouseMoved', mousedown: 'mousePressed',
                       mouseup: 'mouseReleased' };
        return map[type] || type;
    }

    _mapButton(btn) {
        const map = { 0: 'left', 1: 'middle', 2: 'right' };
        return map[btn] || 'none';
    }

    _computeModifiers(event) {
        let mods = 0;
        if (event.ctrlKey)  mods |= 2;
        if (event.shiftKey) mods |= 8;
        if (event.altKey)   mods |= 1;
        if (event.metaKey)  mods |= 4;
        return mods;
    }

    _keyToVK(code) {
        // 标准 US 键盘布局映射（简化）
        const vkMap = {
            'KeyA': 65, 'KeyB': 66, /* ... */ 'Enter': 13,
            'Space': 32, 'Tab': 9, 'Escape': 27, 'Backspace': 8,
            'Delete': 46, 'ArrowLeft': 37, 'ArrowUp': 38,
            'ArrowRight': 39, 'ArrowDown': 40,
        };
        return vkMap[code] || 0;
    }
}

module.exports = { InputProxy };
```

---

## 5. 客户端设计

### 5.1 WebExtension 结构

```
client/web-extension/
├── manifest.json       # Chrome Extension Manifest V3
├── background.js       # Service Worker: 请求拦截 + 重定向
├── index.html          # 扩展页面: <canvas> + 脚本加载
├── index.js            # 主逻辑: CanvasKit 初始化 + 帧消费 + HID 捕获
├── command_validator.js # 命令白名单扫描器
└── node_modules/
    ├── canvaskit-wasm/  # CanvasKit (Skia WASM)
    └── socket.io-client/
```

### 5.2 manifest.json

> **⚠️ MV3 合规修复**: Chrome Manifest V3 已在 Service Worker 中彻底移除
> `webRequestBlocking` API。传入 `['blocking']` 会直接抛异常导致扩展
> 无法安装。改用 `declarativeNetRequest` 静态规则 + `runtime.onMessage`
> 动态重定向方案。

```json
{
    "manifest_version": 3,
    "name": "Wison-RBI Browser Isolation",
    "version": "0.2.0",
    "description": "Compositor-layer browser isolation client",
    "permissions": [
        "declarativeNetRequest",
        "declarativeNetRequestWithHostAccess",
        "storage"
    ],
    "host_permissions": [
        "<all_urls>"
    ],
    "background": {
        "service_worker": "background.js"
    },
    "content_security_policy": {
        "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
    },
    "web_accessible_resources": [
        {
            "resources": [
                "index.html",
                "index.js",
                "command_validator.js",
                "node_modules/canvaskit-wasm/bin/*"
            ],
            "matches": ["<all_urls>"]
        }
    ],
    "declarative_net_request": {
        "rule_resources": [
            {
                "id": "rbi_rules",
                "enabled": true,
                "path": "rules.json"
            }
        ]
    }
}
```

### 5.3 请求拦截（declarativeNetRequest + 动态规则）

MV3 不支持 `webRequestBlocking`。拦截分两层实现：

**第一层：静态规则 (rules.json)** — 开机即生效

```json
[
  {
    "id": 1,
    "priority": 1,
    "action": {
      "type": "redirect",
      "redirect": {
        "regexSubstitution": "chrome-extension://__extension_id__/index.html?url=\\0"
      }
    },
    "condition": {
      "regexFilter": "^https?://.*",
      "resourceTypes": ["main_frame", "sub_frame"],
      "excludedInitiatorDomains": ["__extension_id__"]
    }
  }
]
```

**第二层：动态规则 (background.js)** — Service Worker 按需注入

```javascript
// background.js — Service Worker (MV3)
const EXTENSION_PAGE = chrome.runtime.getURL('index.html');

// MV3 中 webRequestBlocking 已被移除。
// 方案：使用 declarativeNetRequest.updateDynamicRules 在运行时
// 添加/更新重定向规则。静态规则 rules.json 处理一般情况，
// 动态规则处理需要特殊处理的 URL 模式。

// 监听标签页导航，确保重定向生效
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && !changeInfo.url.startsWith('chrome-extension://')) {
        // URL 未命中静态规则时的兜底: 通过 tabs.update 主动重定向
        if (!changeInfo.url.includes('wison-rbi-bypass')) {
            const redirectUrl = `${EXTENSION_PAGE}?url=${encodeURIComponent(changeInfo.url)}`;
            chrome.tabs.update(tabId, { url: redirectUrl });
        }
    }
});

// 允许用户配置例外站点（通过 storage API）
async function updateRules(excludedDomains) {
    const rules = excludedDomains.map((domain, i) => ({
        id: 1000 + i,
        priority: 100,
        action: { type: 'allow' },
        condition: {
            urlFilter: `*://*.${domain}/*`,
            resourceTypes: ['main_frame']
        }
    }));
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: Array.from({length: 100}, (_, i) => 1000 + i),
        addRules: rules
    });
}

// 说明：此方案的核心折中是使用 tabs.update 作为兜底重定向。
// 在纯 Service Worker 环境中（非扩展标签页）无法使用 tabs API，
// 此时完全依赖 declarativeNetRequest 静态规则。
// 对于完整 RBI 场景，推荐使用本地托管方案（CEF/Electron + 本地代理）
// 以获得完整的请求拦截能力——参见 §5.6 备选架构。
```

### 5.4 index.html

```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Wison-RBI</title>
    <style>
        * { margin: 0; padding: 0; border: none; overflow: hidden; }
        #main { display: block; position: fixed; top: 0; left: 0; }
    </style>
</head>
<body>
    <canvas id="main"></canvas>
    <script src="./node_modules/socket.io-client/dist/socket.io.js"></script>
    <script src="./node_modules/canvaskit-wasm/bin/canvaskit.js"></script>
    <script src="./command_validator.js"></script>
    <script src="./index.js"></script>
</body>
</html>
```

### 5.5 index.js（核心客户端逻辑）

```javascript
// index.js — 客户端主控制器

(() => {
    'use strict';

    // ============ 配置 ============
    const SERVER_URL = 'wss://localhost:3000';
    const CANVAS_ID = 'main';
    const RECONNECT_DELAY_MS = 1000;
    const FRAME_HISTORY_MAX_AGE_MS = 3000;

    // ============ 状态 ============
    let socket = null;
    let canvasKit = null;
    let surface = null;
    let skCanvas = null;
    let currentFrameId = 0;
    let frameMetadata = new Map();   // frame_id → {scroll_x, scroll_y, ...}
    let validator = null;
    let viewportChangeDetected = null;  // {w, h, count} 视口变化检测

    // ============ 初始化 ============
    async function init() {
        // 1. 获取目标 URL
        const urlParams = new URLSearchParams(location.search);
        const targetUrl = urlParams.get('url') || 'about:blank';

        // 2. 设置 canvas 初始尺寸 = 窗口尺寸 × devicePixelRatio
        const canvas = document.getElementById(CANVAS_ID);
        canvas.width = window.innerWidth * window.devicePixelRatio;
        canvas.height = window.innerHeight * window.devicePixelRatio;

        // 向服务端报告初始 viewport
        // （使用 CSS 像素，不含 devicePixelRatio）
        // (在 socket 连接后发送，见 connect())

        // 3. 初始化 CanvasKit
        canvasKit = await CanvasKitInit({
            locateFile: (file) =>
                `/node_modules/canvaskit-wasm/bin/${file}`
        }).ready();

        surface = canvasKit.MakeCanvasSurface(CANVAS_ID);
        if (!surface) {
            throw new Error('Failed to create CanvasKit surface');
        }
        skCanvas = surface.getCanvas();

        // 4. 初始化命令校验器
        validator = new CommandValidator();

        // 4b. 初始化字体注册表（从 CanvasKit 提取默认字体）
        // 字体 ID 0 = 默认（CanvasKit 内嵌），后续字体通过帧传输注册
        const defaultFont = canvasKit.Typeface.MakeDefault();
        if (defaultFont) {
            fontBlobs[0] = defaultFont;  // ID 0 = 默认回退字体
        }

        // 5. 连接服务器
        connect(targetUrl);

        // 6. 注册 HID 事件（不与页面交互——只传原始事件）
        registerHIDEvents();
    }

    // ============ WebSocket 连接 ============
    function connect(targetUrl) {
        socket = io(SERVER_URL, {
            transports: ['websocket'],
            upgrade: false,        // 只用 WebSocket，不降级
            reconnection: true,
            reconnectionDelay: RECONNECT_DELAY_MS,
        });

        socket.on('connect', () => {
            console.log(`[wison] connected, requesting: ${targetUrl}`);
            // 上报当前 viewport 尺寸（CSS 像素）
            socket.emit('viewport', {
                width: window.innerWidth,
                height: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio,
            });
            socket.emit('ready', targetUrl);
        });

        // 窗口 resize 时通知服务端调整 viewport（150ms 防抖）
        // 注意: 不在此处修改 canvas 尺寸——由 handleFrame Step 7 统一处理
        let resizeTimer = null;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                socket.emit('viewport', {
                    width: window.innerWidth,
                    height: window.innerHeight,
                    devicePixelRatio: window.devicePixelRatio,
                });
            }, 150);
        });

        // 核心：接收帧
        socket.on('frame', handleFrame);

        socket.on('disconnect', (reason) => {
            console.warn(`[wison] disconnected: ${reason}`);
            if (!canvasKit || !skCanvas) return;  // 未就绪，跳过
            // 显示断连状态
            skCanvas.clear(canvasKit.TRANSPARENT);
            skCanvas.drawText('Disconnected — reconnecting...', 60, 60,
                               makePaint('#FF0000'), makeFont(16));
            skCanvas.flush();
        });

        socket.on('error', (err) => {
            console.error('[wison] socket error:', err);
        });
    }

    // ============ 帧处理流水线 ============
    async function handleFrame(frameData) {
        try {
            // Step 1: 解压（如果服务端使用了 gzip）
            let frame;
            if (frameData instanceof ArrayBuffer) {
                frame = await decompressFrame(frameData);  // await Promise
            } else {
                frame = frameData;
            }

            // Step 2: 校验帧完整性
            if (!validateFrameCRC(frame)) {
                console.error('[wison] Frame CRC mismatch — dropped');
                return;
            }

            // Step 3: 校验 frame_id 单调性
            if (frame.frame_id <= currentFrameId) {
                console.warn(
                    `[wison] Non-monotonic frame_id: ${frame.frame_id} <= ${currentFrameId}`
                );
                // 不丢弃，但记录告警（可能由网络乱序导致）
            }
            currentFrameId = frame.frame_id;

            // Step 4: 存储帧元数据
            frameMetadata.set(frame.frame_id, {
                scroll_x: frame.scroll_x,
                scroll_y: frame.scroll_y,
                viewport_w: frame.viewport_w,
                viewport_h: frame.viewport_h,
                canvas_w: frame.canvas_w,
                canvas_h: frame.canvas_h,
                received_at: Date.now(),
            });
            pruneFrameHistory();

            // Step 5: 命令白名单扫描
            const scanResult = validator.scan(frame.commands);
            if (!scanResult.valid) {
                console.error(
                    `[wison] Invalid command at index ${scanResult.index}: ${scanResult.reason}`
                );
                // 丢弃整帧 + 告警
                reportSecurityAlert('INVALID_COMMAND', scanResult);
                return;
            }

            // Step 6: 重放到 CanvasKit
            skCanvas.save();
            replayCommands(frame.commands);
            skCanvas.restore();
            skCanvas.flush();

            // Step 7: 视口尺寸变更检查（由 resize-event→server→frame-header 闭环驱动）
            // 仅在 resize 已确认（≥2 帧稳定，≥2px 差异）时重建 surface
            const canvas = document.getElementById(CANVAS_ID);
            if (frame.viewport_w && frame.viewport_h) {
                const newW = Math.round(frame.viewport_w * window.devicePixelRatio);
                const newH = Math.round(frame.viewport_h * window.devicePixelRatio);
                if (canvas.width !== newW || canvas.height !== newH) {
                    if (!viewportChangeDetected ||
                        viewportChangeDetected.w !== newW ||
                        viewportChangeDetected.h !== newH) {
                        viewportChangeDetected = { w: newW, h: newH, count: 1 };
                    } else {
                        viewportChangeDetected.count++;
                        if (viewportChangeDetected.count >= 3) {
                            canvas.width = newW;
                            canvas.height = newH;
                            surface = canvasKit.MakeCanvasSurface(CANVAS_ID);
                            if (surface) skCanvas = surface.getCanvas();
                            viewportChangeDetected = null;
                        }
                    }
                }
            }

        } catch (err) {
            console.error('[wison] Frame processing error:', err);
        }
    }

    // ============ 命令重放引擎 ============
    function replayCommands(commands) {
        // commands 是 ArrayBuffer —— 二进制命令流
        const view = new DataView(commands);
        let offset = 0;

        while (offset < commands.byteLength) {
            const opcode = view.getUint8(offset);
            const payLen = (view.getUint8(offset + 1) << 16) |
                           (view.getUint8(offset + 2) << 8)  |
                           view.getUint8(offset + 3);
            offset += 4;
            const payload = new DataView(commands, offset, payLen);

            // 调用对应的 CanvasKit API
            dispatchCommand(opcode, payload);

            offset += payLen;
        }
    }

    function dispatchCommand(opcode, payload) {
        switch (opcode) {
            case 0x01: // save
                skCanvas.save();
                break;
            case 0x02: // restore
                skCanvas.restore();
                break;
            case 0x03: // saveLayer
                {
                    const bounds = readRect(payload, 0);
                    const paintResult = readPaint(payload, 16);
                    const flags = payload.getUint32(16 + paintResult.bytesRead, true);
                    // CanvasKit saveLayer(paint, bounds, backdrop, flags)
                    skCanvas.saveLayer(paintResult.paint, bounds.rect, null, flags);
                }
                break;
            case 0x10: // concat
                {
                    const m = new Float32Array(payload.buffer, payload.byteOffset, 9);
                    skCanvas.concat(m);
                }
                break;
            case 0x11: // translate
                {
                    const dx = payload.getFloat32(0, true);
                    const dy = payload.getFloat32(4, true);
                    skCanvas.translate(dx, dy);
                }
                break;
            case 0x12: // scale
                {
                    const sx = payload.getFloat32(0, true);
                    const sy = payload.getFloat32(4, true);
                    skCanvas.scale(sx, sy);
                }
                break;
            case 0x13: // rotate
                {
                    const rad = payload.getFloat32(0, true);
                    skCanvas.rotate(rad);
                }
                break;
            case 0x20: // clipRect
                {
                    const rect = readRect(payload, 0);
                    const op = payload.getUint8(16);
                    const aa = payload.getUint8(17);
                    skCanvas.clipRect(rect, op, aa);
                }
                break;
            case 0x21: // clipRRect
                {
                    const rrect = readRRect(payload, 0);
                    const op = payload.getUint8(rrect.byteSize);
                    const aa = payload.getUint8(rrect.byteSize + 1);
                    skCanvas.clipRRect(rrect, op, aa);
                }
                break;
            case 0x22: // clipPath
                {
                    const path = readPath(payload, 0);
                    const op = payload.getUint8(path.byteSize);
                    const aa = payload.getUint8(path.byteSize + 1);
                    skCanvas.clipPath(path, op, aa);
                }
                break;
            case 0x30: // drawRect
                {
                    const rect = readRect(payload, 0);
                    const pr = readPaint(payload, 16);
                    skCanvas.drawRect(rect, pr.paint);
                }
                break;
            case 0x31: // drawRRect
                {
                    const rrect = readRRect(payload, 0);
                    const pr = readPaint(payload, rrect.bytesRead);
                    skCanvas.drawRRect(rrect.rrect, pr.paint);
                }
                break;
            case 0x32: // drawOval
                {
                    const rect = readRect(payload, 0);
                    const pr = readPaint(payload, 16);
                    skCanvas.drawOval(rect, pr.paint);
                }
                break;
            case 0x33: // drawArc
                {
                    const oval = readRect(payload, 0);
                    const startAngle = payload.getFloat32(16, true);
                    const sweepAngle = payload.getFloat32(20, true);
                    const useCenter = payload.getUint8(24);
                    const pr = readPaint(payload, 25);
                    skCanvas.drawArc(oval, startAngle, sweepAngle, useCenter, pr.paint);
                }
                break;
            case 0x34: // drawPath
                {
                    const path = readPath(payload, 0);
                    const pr = readPaint(payload, path.bytesRead);
                    skCanvas.drawPath(path.path, pr.paint);
                }
                break;
            case 0x35: // drawPoints
                {
                    const mode = payload.getUint8(0);
                    const count = payload.getUint32(1, true);
                    const pts = readPoints(payload, 5, count);
                    const pr = readPaint(payload, 5 + pts.bytesRead);
                    skCanvas.drawPoints(mode, count, pts.pts, pr.paint);
                }
                break;
            case 0x36: // drawShadow (独立 opcode，非复用 drawPath)
                {
                    const path = readPath(payload, 0);
                    const sr = readShadowRec(payload, path.bytesRead);
                    // CanvasKit drawShadow(path, zPlaneParams, lightPos, lightRadius, ambient, spot, flags)
                    skCanvas.drawShadow(
                        path.path,
                        sr.zPlaneParams,    // [fZPlaneX, fZPlaneY, fZPlaneZ]
                        sr.lightPos,         // [fLightPosX, fLightPosY, fLightPosZ]
                        sr.lightRadius,
                        sr.ambientColor,     // SkColor (RGBA)
                        sr.spotColor,
                        sr.flags
                    );
                }
                break;
            case 0x40: // drawImage
                {
                    const imgX = payload.getFloat32(0, true);
                    const imgY = payload.getFloat32(4, true);
                    const sampling = readSampling(payload, 8);
                    const img = readImage(payload, 8 + sampling.bytesRead);
                    const paintOff = 8 + sampling.bytesRead + img.bytesRead;
                    const pr = readPaint(payload, paintOff);
                    skCanvas.drawImageOptions(img.img, imgX, imgY,
                        sampling.filter, sampling.mipmap, pr.paint || undefined);
                }
                break;
            case 0x41: // drawImageRect
                {
                    const src = readRect(payload, 0);
                    const dst = readRect(payload, 16);
                    const sampling = readSampling(payload, 32);
                    const constraint = payload.getUint8(32 + sampling.bytesRead);
                    const img = readImage(payload, 33 + sampling.bytesRead);
                    const paintOff = 33 + sampling.bytesRead + img.bytesRead;
                    const pr = readPaint(payload, paintOff);
                    skCanvas.drawImageRectOptions(img.img, src, dst,
                        sampling.filter, sampling.mipmap, constraint, pr.paint || undefined);
                }
                break;
            case 0x42: // drawAtlas
                {
                    const count = payload.getUint32(0, true);
                    const sampling = readSampling(payload, 4);
                    const mode = payload.getUint8(4 + sampling.bytesRead);
                    const hasColors = payload.getUint8(5 + sampling.bytesRead);
                    let off = 6 + sampling.bytesRead;
                    // RSXform: CanvasKit 期望 {scos, ssin, tx, ty} 对象数组
                    const xforms = [];
                    for (let i = 0; i < count; i++) {
                        xforms.push({
                            scos: payload.getFloat32(off, true),
                            ssin: payload.getFloat32(off + 4, true),
                            tx:   payload.getFloat32(off + 8, true),
                            ty:   payload.getFloat32(off + 12, true),
                        });
                        off += 16;
                    }
                    // tex 数组: each is {fLeft, fTop, fRight, fBottom}
                    const tex = [];
                    for (let i = 0; i < count; i++) {
                        tex.push({
                            fLeft:   payload.getFloat32(off, true),
                            fTop:    payload.getFloat32(off + 4, true),
                            fRight:  payload.getFloat32(off + 8, true),
                            fBottom: payload.getFloat32(off + 12, true),
                        });
                        off += 16;
                    }
                    // colors: null or Float32Array([r,g,b,a,...])
                    let colors = null;
                    if (hasColors) {
                        colors = new Float32Array(count * 4);
                        for (let i = 0; i < count; i++) {
                            // ⚠️ 已修复: 原代码只用 & 0xFF 取最低字节（丢失 RGB）。
                            // SkColor 是 32-bit ARGB（或 Skia 内部 RGBA），
                            // 需要正确解包为 4 个独立浮点通道。
                            const argb = payload.getUint32(off + i * 4, true);
                            colors[i * 4]     = ((argb >> 16) & 0xFF) / 255;  // R
                            colors[i * 4 + 1] = ((argb >> 8)  & 0xFF) / 255;  // G
                            colors[i * 4 + 2] = (argb & 0xFF) / 255;           // B
                            colors[i * 4 + 3] = ((argb >> 24) & 0xFF) / 255;  // A
                        }
                        off += count * 4;
                    }
                    const hasCull = payload.getUint8(off);
                    off += 1;
                    const cull = hasCull ? readRect(payload, off).rect : null;
                    if (hasCull) off += 16;
                    const img = readImage(payload, off);
                    off += img.bytesRead;
                    const pr = readPaint(payload, off);
                    skCanvas.drawAtlas(img.img, xforms, tex, colors, count, mode,
                        sampling.filter, cull, pr.paint || undefined);
                }
                break;
            case 0x50: // drawTextBlob
                {
                    const tx = payload.getFloat32(0, true);
                    const ty = payload.getFloat32(4, true);
                    const blob = readTextBlob(payload, 8);
                    const pr = readPaint(payload, 8 + blob.bytesRead);
                    skCanvas.drawTextBlob(blob.blob, tx, ty, pr.paint);
                }
                break;
            case 0x51: // glyphRunList (多 run 文本, SkGlyphRunList)
                {
                    // payload 布局: [run1:originX(4)+originY(4)+fontSize(4)+fontID(4)
                    //   +runSize(4)+glyphs(2N)+positions(8N)]...[totalRuns(4,末尾)]
                    const totalRuns = payload.getInt32(payload.byteLength - 4, true);
                    let off = 0;
                    for (let r = 0; r < totalRuns; r++) {
                        const oX = payload.getFloat32(off, true);
                        const oY = payload.getFloat32(off + 4, true);
                        const fSize = payload.getFloat32(off + 8, true);
                        const fID = payload.getUint32(off + 12, true);
                        const rSize = payload.getUint32(off + 16, true);
                        off += 20;
                        const glyphs = new Uint16Array(payload.buffer,
                            payload.byteOffset + off, rSize);
                        off += rSize * 2;
                        const pos = new Float32Array(payload.buffer,
                            payload.byteOffset + off, rSize * 2);
                        off += rSize * 8;
                        const typeface = canvasKit.Typeface.MakeFreeTypeFaceFromData(
                            fontBlobs[fID] || fontBlobs[0]);
                        const font = new canvasKit.SkFont(typeface || null, fSize);
                        const b = canvasKit.TextBlob.MakeFromRWGlyphs(
                            glyphs, pos, font);
                        // 每个 run 独立绘制（已在 glyphRunList 上下文中）
                        skCanvas.save();
                        skCanvas.translate(oX, oY);
                        skCanvas.drawTextBlob(b, 0, 0, new canvasKit.SkPaint());
                        skCanvas.restore();
                    }
                }
                break;
            case 0x60: // drawPaint
                {
                    const pr = readPaint(payload, 0);
                    skCanvas.drawPaint(pr.paint);
                }
                break;
            case 0x61: // drawColor
                {
                    const r = payload.getUint8(0);
                    const g = payload.getUint8(1);
                    const b = payload.getUint8(2);
                    const a = payload.getUint8(3);
                    const mode = payload.getUint8(4);
                    skCanvas.drawColor([r, g, b, a], mode);
                }
                break;
            case 0x7F: // 占位/跳过（SkDrawable 等不可序列化对象）
                break;
            default:
                console.warn(`[wison] Unhandled opcode: 0x${opcode.toString(16)}`);
        }
    }

    // ============ HID 事件捕获 ============
    function registerHIDEvents() {
        const canvas = document.getElementById(CANVAS_ID);

        // ─── 鼠标事件 ───
        const mouseHandler = (e) => {
            socket.emit('io', {
                type: e.type,                      // 'mousemove'/'mousedown'/'mouseup'
                x: Math.round(e.offsetX),
                y: Math.round(e.offsetY),
                button: e.button,
                buttons: e.buttons,
                frame_id: currentFrameId,        // 关键：锚定到当前可见帧
            });
            e.preventDefault();
        };

        canvas.addEventListener('mousemove', mouseHandler, { passive: false });
        canvas.addEventListener('mousedown', mouseHandler, { passive: false });
        canvas.addEventListener('mouseup', mouseHandler, { passive: false });

        // 禁止右键菜单
        canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            socket.emit('io', {
                type: 'mousedown',
                x: Math.round(e.offsetX),
                y: Math.round(e.offsetY),
                button: 2,
                buttons: 2,
                frame_id: currentFrameId,
            });
        });

        // ─── 滚轮 ───
        canvas.addEventListener('wheel', (e) => {
            socket.emit('io', {
                type: 'wheel',
                x: Math.round(e.offsetX),
                y: Math.round(e.offsetY),
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                frame_id: currentFrameId,
            });
            e.preventDefault();
        }, { passive: false });

        // ─── 键盘事件 ───
        document.addEventListener('keydown', keyHandler, true);
        document.addEventListener('keyup', keyHandler, true);

        function keyHandler(e) {
            // 敏感快捷键过滤（不发送到远端）
            if (isBrowserShortcut(e)) {
                e.preventDefault();
                return;  // 不发送
            }

            socket.emit('io', {
                type: e.type,          // 'keydown' / 'keyup'
                key: e.key,            // 'a', 'Enter', etc.
                code: e.code,          // 'KeyA', 'Enter', etc.
                location: e.location,  // 0=standard, 1=left, 2=right, 3=numpad
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                shiftKey: e.shiftKey,
                metaKey: e.metaKey,
                repeat: e.repeat,
                frame_id: currentFrameId,
            });
            e.preventDefault();
        }
    }

    // ============ 敏感快捷键过滤 ============
    function isBrowserShortcut(e) {
        // 浏览器控制快捷键 → 不发送
        const ctrlOrMeta = e.ctrlKey || e.metaKey;

        // 标签页操作
        if (ctrlOrMeta && ['t', 'T', 'n', 'N', 'w', 'W', 'q', 'Q'].includes(e.key)) {
            return true;  // Ctrl+T/N/W/Q
        }
        if (ctrlOrMeta && e.shiftKey && ['T', 'N'].includes(e.key)) {
            return true;  // Ctrl+Shift+T/N (恢复关闭标签页/无痕窗口)
        }
        if (ctrlOrMeta && e.key === 'Tab') {
            return true;  // Ctrl+Tab (切换标签页)
        }
        if (ctrlOrMeta && e.shiftKey && e.key === 'Tab') {
            return true;  // Ctrl+Shift+Tab (反向切换标签页)
        }
        if (ctrlOrMeta && /^[1-9]$/.test(e.key)) {
            return true;  // Ctrl+[1-9] (跳转到第N个标签页)
        }
        if (e.key === 'PageUp' || e.key === 'PageDown') {
            if (ctrlOrMeta) return true;  // Ctrl+PgUp/PgDn (切换标签页)
        }

        // 窗口操作
        if (e.altKey && e.key === 'F4') {
            return true;  // Alt+F4
        }
        if (e.key === 'F11') {
            return true;  // F11 全屏
        }

        // 页面操作
        if (ctrlOrMeta && ['r', 'R'].includes(e.key)) {
            return true;  // Ctrl+R (刷新——会导致远程重新加载)
        }
        if (e.key === 'F5') {
            return true;  // F5 (刷新)
        }
        if (ctrlOrMeta && ['s', 'S'].includes(e.key)) {
            return true;  // Ctrl+S 保存
        }
        if (ctrlOrMeta && ['d', 'D'].includes(e.key)) {
            return true;  // Ctrl+D 添加书签
        }
        if (ctrlOrMeta && ['h', 'H'].includes(e.key)) {
            return true;  // Ctrl+H 历史记录
        }
        if (ctrlOrMeta && ['j', 'J'].includes(e.key)) {
            return true;  // Ctrl+J 下载管理
        }
        if (ctrlOrMeta && ['u', 'U'].includes(e.key)) {
            return true;  // Ctrl+U 查看源代码（泄漏 HTML）
        }
        if (e.key === 'Escape') {
            return true;  // Esc 停止加载
        }

        // 开发者工具
        if (e.key === 'F12') {
            return true;  // F12 DevTools
        }
        if (ctrlOrMeta && e.shiftKey && ['I', 'i'].includes(e.key)) {
            return true;  // Ctrl+Shift+I DevTools
        }
        if (ctrlOrMeta && e.shiftKey && ['J', 'j'].includes(e.key)) {
            return true;  // Ctrl+Shift+J Console
        }

        // PrintScreen
        if (e.key === 'PrintScreen') {
            return true;
        }
        return false;
    }

    // ============ 帧历史清理 ============
    function pruneFrameHistory() {
        const now = Date.now();
        for (const [id, meta] of frameMetadata) {
            if (now - meta.received_at > FRAME_HISTORY_MAX_AGE_MS) {
                frameMetadata.delete(id);
            }
        }
    }

    // ============ 辅助函数 ============
    function makePaint(colorStr) {
        const paint = new canvasKit.SkPaint();
        paint.setColor(canvasKit.parseColorString(colorStr));
        paint.setAntiAlias(true);
        return paint;
    }

    function makeFont(size) {
        return new canvasKit.SkFont(null, size);
    }

    function reportSecurityAlert(type, detail) {
        // 上报安全告警（生产环境 → 安全监控系统）
        console.error(`[SECURITY] ${type}:`, detail);
        // TODO: 发送到安全监控端点
    }

    // ============ 帧校验 ============
    function decompressFrame(arrayBuffer) {
        // gzip 解压，使用浏览器 DecompressionStream API
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(arrayBuffer);
        writer.close();
        return new Response(ds.readable).arrayBuffer();  // → Promise<ArrayBuffer>
    }

    function validateFrameCRC(frame) {
        // frame 格式: [header:30B][commands:N-5B][CRC32:4B]
        // 计算 header + commands 的 CRC32-ISO-HDLC (poly=0xEDB88320)
        // 与末尾 4 字节比较
        const frameBytes = new Uint8Array(
            frame instanceof ArrayBuffer ? frame : frame.buffer
        );
        if (frameBytes.length < 34) return false;  // 最小: 30B header + 4B CRC
        const expectedCRC = new DataView(frameBytes.buffer,
            frameBytes.length - 4).getUint32(0, true);
        // 对 [0, len-4) 计算 CRC32
        const actualCRC = crc32(frameBytes, frameBytes.length - 4);
        return actualCRC === expectedCRC;
    }

    // CRC32 查表法（多项式 0xEDB88320）
    function crc32(data, length) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < length; i++) {
            crc ^= data[i];
            for (let j = 0; j < 8; j++) {
                crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
            }
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    // ============ 反序列化辅助函数 ============
    // 所有 read* 函数返回 {result} 或 {result, bytesRead} 格式
    // bytesRead 用于调用方计算下一字段偏移

    function readRect(view, offset) {
        return {
            bytesRead: 16,  // 4 × float32 LE
            rect: canvasKit.LTRBRect(
                view.getFloat32(offset, true),
                view.getFloat32(offset + 4, true),
                view.getFloat32(offset + 8, true),
                view.getFloat32(offset + 12, true)
            )
        };
    }

    function readRRect(view, offset) {
        // rrect: SkRRect = rect(16B) + radii(8 floats = 32B) = 48B
        const rect = canvasKit.LTRBRect(
            view.getFloat32(offset, true), view.getFloat32(offset + 4, true),
            view.getFloat32(offset + 8, true), view.getFloat32(offset + 12, true)
        );
        const radii = [];
        for (let i = 0; i < 8; i++) {
            radii.push(view.getFloat32(offset + 16 + i * 4, true));
        }
        const rrect = new canvasKit.RRect(rect, radii[0], radii[1], radii[2], radii[3],
                                          radii[4], radii[5], radii[6], radii[7]);
        return { bytesRead: 48, rrect };
    }

    function readPath(view, offset) {
        // path 格式: [verbCount:4B][verbs:N×1B][pointCount:4B][points:N×8B]
        const verbCount = view.getUint32(offset, true);
        const verbs = new Uint8Array(view.buffer, view.byteOffset + offset + 4, verbCount);
        const pointCount = view.getUint32(offset + 4 + verbCount, true);
        const points = new Float32Array(view.buffer, view.byteOffset + offset + 8 + verbCount, pointCount * 2);
        const path = canvasKit.Path.MakeFromVerbsPointsWeights(verbs, points, null);
        const bytesRead = 8 + verbCount + pointCount * 8;
        return { bytesRead, path };
    }

    function readPoints(view, offset, count) {
        // points: count × (x:4B + y:4B) = count × 8B
        const pts = new Float32Array(view.buffer, view.byteOffset + offset, count * 2);
        return { bytesRead: count * 8, pts };
    }

    function readShadowRec(view, offset) {
        // ShadowRec 格式:
        //   zPlaneParams: 3×float32 (12B)
        //   lightPos:     3×float32 (12B)
        //   lightRadius:  float32   (4B)
        //   ambientColor: uint32    (4B)  SkColor
        //   spotColor:    uint32    (4B)  SkColor
        //   flags:        uint32    (4B)
        const zPlaneParams = [
            view.getFloat32(offset, true),
            view.getFloat32(offset + 4, true),
            view.getFloat32(offset + 8, true),
        ];
        const lightPos = [
            view.getFloat32(offset + 12, true),
            view.getFloat32(offset + 16, true),
            view.getFloat32(offset + 20, true),
        ];
        const lightRadius = view.getFloat32(offset + 24, true);
        const ambientColor = view.getUint32(offset + 28, true);
        const spotColor = view.getUint32(offset + 32, true);
        const flags = view.getUint32(offset + 36, true);
        return {
            bytesRead: 40,
            zPlaneParams, lightPos, lightRadius, ambientColor, spotColor, flags,
        };
    }

    function readImage(view, offset) {
        // image 格式: [flag:1B][encoded_size:4B][encoded_data:N B][hash:8B if hash-ref]
        const flag = view.getUint8(offset);
        if (flag === 0x00) {  // 内联
            const size = view.getUint32(offset + 1, true);
            const imgBytes = new Uint8Array(view.buffer, view.byteOffset + offset + 5, size);
            const img = canvasKit.MakeImageFromEncoded(imgBytes);
            let bytesRead = 5 + size;
            // hash-ref 模式下末尾有 8 字节 hash
            if (view.byteLength - (view.byteOffset + offset + bytesRead) >= 8) {
                bytesRead += 8;  // consume hash
            }
            return { bytesRead, img };
        } else if (flag === 0x01) {  // 引用
            const hash = new Uint8Array(view.buffer, view.byteOffset + offset + 1, 8);
            const img = imageCache.get(hash);  // 从 LRU 缓存取出
            return { bytesRead: 9, img };
        }
        return { bytesRead: 0, img: null };
    }

    function readTextBlob(view, offset) {
        // textBlob: [x:4B][y:4B][glyphCount:4B][glyphs:glyphCount×2B]
        //          [positions:glyphCount×8B][fontID:4B][fontSize:4B]
        const tx = view.getFloat32(offset, true);
        const ty = view.getFloat32(offset + 4, true);
        const glyphCount = view.getUint32(offset + 8, true);
        const glyphs = new Uint16Array(view.buffer, view.byteOffset + offset + 12, glyphCount);
        const positions = new Float32Array(view.buffer, view.byteOffset + offset + 12 + glyphCount * 2, glyphCount * 2);
        const fontID = view.getUint32(offset + 12 + glyphCount * 2 + glyphCount * 8, true);
        const fontSize = view.getFloat32(offset + 16 + glyphCount * 2 + glyphCount * 8, true);
        const typeface = canvasKit.Typeface.MakeFreeTypeFaceFromData(fontBlobs[fontID] || fontBlobs[0]);
        const font = new canvasKit.SkFont(typeface, fontSize);
        const blob = canvasKit.TextBlob.MakeFromGlyphs(glyphs, font);
        const bytesRead = 20 + glyphCount * 10;
        return { bytesRead, blob };
    }

    function readSampling(view, offset) {
        // sampling: [filterMode:1B][mipmapMode:1B]
        // filterMode: 0=nearest, 1=linear
        // mipmapMode: 0=none, 1=nearest, 2=linear
        const filter = view.getUint8(offset) ? canvasKit.FilterMode.Linear
                                              : canvasKit.FilterMode.Nearest;
        const mipmap = view.getUint8(offset + 1) === 2 ? canvasKit.MipmapMode.Linear
                      : view.getUint8(offset + 1) === 1 ? canvasKit.MipmapMode.Nearest
                      : canvasKit.MipmapMode.None;
        return { bytesRead: 2, filter, mipmap };
    }

    function readPaint(view, offset) {
        // Paint 二进制格式（与 §4.1.3 对应）:
        //   [0:4]   color RGBA uint32 LE
        //   [4:8]   stroke_width float32 LE
        //   [8]     style (0=Fill/1=Stroke/2=StrokeAndFill)
        //   [9]     cap
        //   [10]    join
        //   [11]    _pad (byte, 4B alignment)
        //   [12:16] miter_limit float32 LE
        //   [16]    blend_mode
        //   [17]    anti_alias
        //   [18]    has_shader
        //   ...
        const paint = new canvasKit.SkPaint();

        // color: 解包 uint32 RGBA → [r,g,b,a] (0-255 → 0-1)
        const rgba = view.getUint32(offset, true);
        paint.setColor([
            ((rgba >> 0)  & 0xFF) / 255,
            ((rgba >> 8)  & 0xFF) / 255,
            ((rgba >> 16) & 0xFF) / 255,
            ((rgba >> 24) & 0xFF) / 255,
        ]);

        paint.setStrokeWidth(view.getFloat32(offset + 4, true));

        const styleVal = view.getUint8(offset + 8);
        paint.setStyle(styleVal === 1 ? canvasKit.PaintStyle.Stroke
                      : styleVal === 2 ? canvasKit.PaintStyle.StrokeAndFill
                      : canvasKit.PaintStyle.Fill);

        paint.setStrokeCap(view.getUint8(offset + 9));
        paint.setStrokeJoin(view.getUint8(offset + 10));
        // offset 11 = padding, skip
        paint.setStrokeMiter(view.getFloat32(offset + 12, true));
        paint.setBlendMode(view.getUint8(offset + 16));
        paint.setAntiAlias(view.getUint8(offset + 17) !== 0);

        let bytesRead = 18;

        // shader (变长, Phase 2 实现)
        const hasShader = view.getUint8(offset + bytesRead);
        bytesRead += 1;
        if (hasShader) bytesRead += 16;  // Phase 2: 解析 Shader variant

        // mask filter
        const hasMask = view.getUint8(offset + bytesRead);
        bytesRead += 1;
        if (hasMask) bytesRead += 8;

        // color filter
        const hasColorFilter = view.getUint8(offset + bytesRead);
        bytesRead += 1;
        if (hasColorFilter) bytesRead += 16;

        // image filter
        const hasImageFilter = view.getUint8(offset + bytesRead);
        bytesRead += 1;
        if (hasImageFilter) bytesRead += 16;

        return { paint, bytesRead };
    }

    // 字体 blob 注册表（在 init() 中初始化）
    const fontBlobs = {};
    function registerFont(fontData, fontID) {
        fontBlobs[fontID] = fontData;
    }

    // 图像 LRU 缓存（hash-ref 模式）
    const imageCache = new Map();  // hash → CanvasKit.Image
    const IMAGE_CACHE_MAX = 64;   // 最多 64 个图像

    // ============ 启动 ============
    init().catch((err) => {
        console.error('[wison] Initialization failed:', err);
        document.body.innerHTML = `
            <div style="padding:40px;font-family:sans-serif;">
                <h1>Wison-RBI Initialization Failed</h1>
                <pre>${err.message}</pre>
            </div>`;
    });
})();
```

### 5.6 命令白名单扫描器

```javascript
// command_validator.js

class CommandValidator {
    constructor() {
        // 合法 opcode 集合
        this.VALID_OPCODES = new Set([
            0x01, 0x02, 0x03,                      // save/restore/saveLayer
            0x10, 0x11, 0x12, 0x13,               // concat/translate/scale/rotate
            0x20, 0x21, 0x22,                      // clipRect/clipRRect/clipPath
            0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36,   // shapes (+ drawShadow)
            0x40, 0x41, 0x42,                      // images (+ drawAtlas)
            0x50, 0x51,                            // text (+ glyphRunList)
            0x60, 0x61,                            // paint/color
        ]);

        // 参数范围约束（防止超大分配导致 OOM）
        this.LIMITS = {
            MAX_PAYLOAD_BYTES: 1 << 20,     // 单条命令 payload ≤ 1MB
            MAX_COMMANDS_PER_FRAME: 50000,   // 单帧 ≤ 50K 条命令
            MAX_PATH_VERBS: 100000,          // 路径 ≤ 100K 个动词
            MAX_TEXT_BLOB_GLYPHS: 50000,     // 文本 ≤ 50K 个 glyph
            MAX_IMAGE_BYTES: 10 << 20,       // 图像 ≤ 10MB
            MAX_MATRIX_ELEMENTS: 9,          // 矩阵固定 3×3
        };
    }

    /**
     * 扫描命令缓冲区，返回校验结果
     */
    scan(commandsBuffer) {
        const view = new DataView(commandsBuffer);
        let offset = 0;
        let cmdCount = 0;
        let saveDepth = 0;  // save/restore 配对检查

        while (offset < commandsBuffer.byteLength) {
            if (cmdCount >= this.LIMITS.MAX_COMMANDS_PER_FRAME) {
                return this._reject(offset, 'Too many commands');
            }

            if (offset + 4 > commandsBuffer.byteLength) {
                return this._reject(offset, 'Truncated command header');
            }

            const opcode = view.getUint8(offset);
            const payLen = (view.getUint8(offset + 1) << 16) |
                           (view.getUint8(offset + 2) << 8)  |
                           view.getUint8(offset + 3);

            // 校验 1: opcode 白名单
            if (!this.VALID_OPCODES.has(opcode)) {
                return this._reject(offset, `Invalid opcode: 0x${opcode.toString(16)}`);
            }

            // 校验 2: payload 大小
            if (payLen > this.LIMITS.MAX_PAYLOAD_BYTES) {
                return this._reject(offset, `Payload too large: ${payLen}`);
            }

            // 校验 3: 缓冲区边界
            if (offset + 4 + payLen > commandsBuffer.byteLength) {
                return this._reject(offset, 'Payload overflows buffer');
            }

            // 校验 4: save/restore 配对
            if (opcode === 0x01) saveDepth++;
            if (opcode === 0x02) saveDepth--;
            if (saveDepth < 0) {
                return this._reject(offset, 'Unbalanced restore');
            }

            // 校验 5: payload 子结构深度检查（防止嵌套炸弹 + OOM）
            // 对包含内部计数字段的 opcode，必须验证 count * element_size <= payLen
            // 否则攻击者可传入 payLen=500KB 但内部 pointCount=10亿 导致 OOM
            const subResult = this._validatePayloadSubstructure(opcode, payLen,
                new DataView(commandsBuffer, offset + 4, payLen));
            if (!subResult.valid) {
                return this._reject(offset, subResult.reason);
            }

            offset += 4 + payLen;
            cmdCount++;
        }

        if (saveDepth !== 0) {
            return { valid: false, index: cmdCount, reason: 'Unbalanced save' };
        }

        return { valid: true, commandCount: cmdCount };
    }

    /**
     * 深度校验 Payload 内部子结构，防止 OOM 攻击。
     *
     * 原理：攻击者可以通过合法 payLen（如 500KB）包裹一个伪造的
     * pointCount=10亿 来触发客户端 new Float32Array(OOM)。
     * 本方法对每个包含数组计数的 opcode，提取 count 并验证
     * count * element_size <= actual_payLen。
     */
    _validatePayloadSubstructure(opcode, payLen, payload) {
        const p = payload; // DataView of the payload body

        switch (opcode) {
            case 0x34: { // drawPath: verbCount + pointCount + verbs[] + points[]
                if (payLen < 8) return this._reject(-1, 'drawPath: payload too short for counts');
                const verbCount  = p.getUint32(0, true);
                const pointCount = p.getUint32(4, true);
                if (verbCount > this.LIMITS.MAX_PATH_VERBS)
                    return this._reject(-1, `drawPath: verbCount ${verbCount} exceeds limit`);
                if (pointCount > this.LIMITS.MAX_PATH_VERBS)
                    return this._reject(-1, `drawPath: pointCount ${pointCount} exceeds limit`);
                // verbs: 1 byte each, points: 2 float32 each (8 bytes)
                if (8 + verbCount + pointCount * 8 > payLen)
                    return this._reject(-1, `drawPath: sub-structure overflows payLen`);
                break;
            }
            case 0x35: { // drawPoints: mode(1) + count(4) + points(count*2*4)
                if (payLen < 5) return this._reject(-1, 'drawPoints: payload too short');
                const count = p.getUint32(1, true);
                if (count > this.LIMITS.MAX_PATH_VERBS)
                    return this._reject(-1, `drawPoints: count ${count} exceeds limit`);
                if (5 + count * 8 > payLen)
                    return this._reject(-1, `drawPoints: sub-structure overflows payLen`);
                break;
            }
            case 0x42: { // drawAtlas: count(4) + ...RSXform(16) + tex(16) + colors(4) each
                if (payLen < 4) return this._reject(-1, 'drawAtlas: payload too short');
                const count = p.getUint32(0, true);
                if (count > this.LIMITS.MAX_PATH_VERBS)
                    return this._reject(-1, `drawAtlas: count ${count} exceeds limit`);
                // rough lower bound: count * 36 (xforms+tex+colors) + sampling + image
                if (4 + count * 36 > payLen)
                    return this._reject(-1, `drawAtlas: sub-structure overflows payLen`);
                break;
            }
            case 0x50: { // drawTextBlob: tx(4)+ty(4)+glyphCount(4)+glyphs(2*N)+positions(2*4*N)
                if (payLen < 12) return this._reject(-1, 'drawTextBlob: payload too short');
                const glyphCount = p.getUint32(8, true);
                if (glyphCount > this.LIMITS.MAX_TEXT_BLOB_GLYPHS)
                    return this._reject(-1, `drawTextBlob: glyphCount ${glyphCount} exceeds limit`);
                if (12 + glyphCount * 10 > payLen) // 2 (glyph) + 8 (pos)
                    return this._reject(-1, `drawTextBlob: sub-structure overflows payLen`);
                break;
            }
            case 0x51: { // glyphRunList: similar pattern, glyphCount at offset depends on runs
                // Conservative: validate first glyphCount if present
                if (payLen >= 4) {
                    const gc = p.getUint32(0, true);
                    if (gc > this.LIMITS.MAX_TEXT_BLOB_GLYPHS)
                        return this._reject(-1, `glyphRunList: glyphCount ${gc} exceeds limit`);
                }
                break;
            }
        }
        return { valid: true };
    }

    _reject(offset, reason) {
        return { valid: false, index: offset, reason };
    }
}

// 导出给 index.js 使用
```

---

## 6. 通信协议规范

### 6.1 协议总览

```
                    TLS 1.3 + WebSocket

  ┌─────────────────────────────────────────────────────────────┐
  │  Client → Server                                             │
  │                                                              │
  │  1.  ready        {url: string}                             │
  │  2.  viewport     {width, height, devicePixelRatio}         │
  │  3.  io           原始 HID 事件（见 6.4）                     │
  │  4.  ping         (WebSocket 原生)                           │
  │                                                              │
  ├─────────────────────────────────────────────────────────────┤
  │  Server → Client                                             │
  │                                                              │
  │  1.  frame        二进制帧（见 6.2）                          │
  │  2.  error        {code, message}                           │
  │  3.  pong         (WebSocket 原生)                           │
  └─────────────────────────────────────────────────────────────┘
```

### 6.2 Server → Client: Frame 消息

**二进制格式**（`socket.emit('frame', ArrayBuffer)`）:

```
┌──────────────────────────────────────────────────────────────┐
│ Byte  0-29:  Frame Header (30 bytes)                          │
│                                                              │
│   [0:4]    frame_id          uint32 LE   单调递增帧 ID       │
│   [4:12]   timestamp_ms      int64  LE   Unix 毫秒时间戳     │
│   [12:16]  scroll_x          int32  LE   页面滚动 X（px）     │
│   [16:20]  scroll_y          int32  LE   页面滚动 Y（px）     │
│   [20:22]  viewport_w        uint16 LE   视口宽度（px）       │
│   [22:24]  viewport_h        uint16 LE   视口高度（px）       │
│   [24:26]  canvas_w          uint16 LE   绘制面宽度（px）     │
│   [26:28]  canvas_h          uint16 LE   绘制面高度（px）     │
│   [28:30]  reserved          uint16     (保留)               │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ Byte 30..N-5: Command Stream                                 │
│                                                              │
│   命令 = [opcode:1B][pay_len:3B][payload:pay_len B]          │
│   对齐：4 字节边界                                            │
│                                                              │
│   opcode 范围: 0x01-0x7F                                     │
│   pay_len 范围: 0 - 1,048,576 (1MB)                         │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ Byte N-4..N-1: Trailer                                       │
│                                                              │
│   [N-4:N] CRC32  uint32 LE   (Header + Command Stream)       │
│   CRC 多项式: 0xEDB88320 (IEEE 802.3)                        │
└──────────────────────────────────────────────────────────────┘

总大小范围：32 字节（空帧） ~ 10MB（复杂页首帧）
典型值：10-30KB gzip 压缩后
```

**Opcode 分配表**:

```
  0x00          保留（空操作标记）
  0x01-0x0F     状态管理 (save/restore/saveLayer)
  0x10-0x1F     变换 (concat/translate/scale/rotate)
  0x20-0x2F     裁剪 (clipRect/clipRRect/clipPath)
  0x30-0x3F     形状绘制 (rect/rrect/oval/arc/path/points)
  0x40-0x4F     图像绘制 (image/imageRect/atlas)
  0x50-0x5F     文本绘制 (textBlob/glyphRunList)
  0x60-0x6F     其他绘制 (paint/color)
  0x70-0x7F     保留
  0x80-0xFF     非法（客户端必须拒收）
```

### 6.3 Client → Server: viewport 消息

报告客户端视口尺寸。在连接建立和窗口 resize 时发送。

```typescript
{
    type: 'viewport',
    width: number,           // CSS 像素宽度
    height: number,          // CSS 像素高度
    devicePixelRatio: number // 设备像素比 (1.0 / 2.0 / ...)
}
```

服务端接收后：
1. 调用 `Emulation.setDeviceMetricsOverride({width, height, deviceScaleFactor})`
2. 调用 `Emulation.setVisibleSize({width, height})`
3. 后续帧的帧头中更新 `viewport_w`/`viewport_h`

### 6.4 Client → Server: IO 消息

**JSON 格式**（`socket.emit('io', object)`）:

```typescript
// 鼠标移动
{
    type: 'mousemove',
    x: number,        // canvas 坐标 X (px)
    y: number,        // canvas 坐标 Y (px)
    button: 0,        // 当前无按钮
    buttons: 0,
    frame_id: number  // 客户端当前渲染帧 ID
}

// 鼠标按下/释放
{
    type: 'mousedown' | 'mouseup',
    x: number,
    y: number,
    button: number,   // 0=左键, 1=中键, 2=右键
    buttons: number,  // 位掩码
    frame_id: number
}

// 键盘按下/释放
{
    type: 'keydown' | 'keyup',
    key: string,      // 'a', 'Enter', 'Escape' ...
    code: string,     // 'KeyA', 'Enter', 'Escape' ...
    ctrlKey: boolean,
    altKey: boolean,
    shiftKey: boolean,
    metaKey: boolean,
    location: number,   // 0=standard, 1=left, 2=right, 3=numpad
    repeat: boolean,  // 是否为重复按键
    frame_id: number
}

// 滚轮
{
    type: 'wheel',
    x: number,
    y: number,
    deltaX: number,   // 水平滚动增量 (px)
    deltaY: number,   // 垂直滚动增量 (px)
    frame_id: number
}
```

**为什么 IO 消息用 JSON 而非二进制？**

1. HID 事件体积极小（~50-150 字节），JSON 开销可忽略
2. 可读性和调试便利性远优于二进制
3. 事件频率在人类输入范围内（≤125Hz），不构成性能瓶颈
4. Frame 消息用二进制是因为命令流可达数十 KB，压缩效率更重要

### 6.5 错误消息

```typescript
// Server → Client
{
    type: 'error',
    code: string,
    // 错误码:
    //   'NAVIGATION_FAILED'  - Chromium 无法导航到目标 URL
    //   'PAGE_TIMEOUT'       - 页面加载超时（30s）
    //   'CHROMIUM_CRASH'     - Chromium 进程异常退出
    //   'INTERNAL_ERROR'     - 内部错误
    message: string
}
```

---

## 7. 帧元数据与输入同步

### 7.1 方案 B 核心算法

```
问题：用户在帧 N 的画面上的 canvas 坐标 (cx, cy) 应该映射到
     Chromium 的哪个 viewport 坐标？

解法：客户端在输入事件中携带 frame_id。
     服务端根据 frame_id 查找该帧的 scroll offset，做精确坐标转换。
```

### 7.2 时序图

```
  客户端                              服务端
  ──────                              ──────
     │                                   │
     │◄─── frame(42, scroll=0) ──────────│
     │                                   │
     │  [当前帧:42, scroll=0]             │
     │                                   │
     │── wheel(dY=-300, frame_id=42) ──→│ t=0
     │                                   │
     │  [用户看到滚动动画开始]             │
     │                                   │ t=5   收到滚轮
     │                                   │ t=10  Chromium 滚动 → scroll=300
     │                                   │ t=12  PaintOp 生成
     │                                   │
     │◄── frame(43, scroll=300) ────────│ t=18
     │                                   │
     │  [当前帧:43, scroll=300]           │
     │                                   │
     │── mousedown(x=420,y=500,         │
     │      frame_id=43) ──────────────→│ t=25
     │                                   │
     │                                   │ t=30  查找帧 43: scroll=300
     │                                   │       vp = canvasToViewport(420,500, scroll=300)
     │                                   │       = (420, 200)
     │                                   │       CDP.dispatchMouseEvent(420,200)
     │                                   │       → 命中正确元素 ✓
```

### 7.3 坐标转换公式

```
  canvas_w, canvas_h:  Chromium 绘制面尺寸（服务端已知，写入帧头）
  viewport_w, viewport_h: Chromium 视口尺寸（服务端已知，写入帧头）
  scroll_x, scroll_y:   帧对应的滚动偏移（服务端已知，写入帧头）

  客户端 canvas CSS 尺寸 = viewport_w × viewport_h
  客户端 canvas 像素尺寸 = viewport_w × viewport_h × devicePixelRatio

  **viewport 同步机制**:
  1. 初始化: 客户端 connect 后立即发送 `viewport {width, height, devicePixelRatio}`
  2. resize: 窗口变化时客户端再次发送 `viewport` 消息
  3. 服务端收到后调用 CDP `Emulation.setDeviceMetricsOverride` 调整 Chromium 视口
  4. 后续帧的帧头中携带更新后的 viewport_w/viewport_h
  5. 客户端收到帧后根据帧头 viewport 调整 canvas 像素尺寸（Step 7）

  canvasX, canvasY:    客户端 onMouseDown 的 offsetX, offsetY
                       （已考虑 devicePixelRatio，因为 canvas 的 CSS 尺寸
                        等于 viewport，像素尺寸 = viewport × dPR）

  服务端转换:
    vp_x = canvasX - scroll_x   (当 canvas == viewport 时)
    vp_y = canvasY - scroll_y

  如果需要缩放（canvas != viewport）:
    vp_x = (canvasX - scroll_x) * (viewport_w / canvas_w)
    vp_y = (canvasY - scroll_y) * (viewport_h / canvas_h)
```

### 7.4 帧历史管理

```javascript
// 服务端 frameHistory: 环形缓冲区 + 时间戳 LRU
//
// ⚠️ 已修复: 原方案使用 Math.min(frame_id) 找最旧帧。
//   frame_id 为 uint32，约 49 天后回绕到 0，Math.min 会错误地
//   丢弃最新帧而保留 49 天前的旧帧——导致坐标转换使用错误 scroll，
//   点击完全错位。
//
// 新方案: 固定大小环形缓冲区（最多 64 帧），每条记录附带单调递增
// 的序列号。淘汰时按时间戳（而非 frame_id）查找最旧记录。
// frame_id 仅用于客户端输入同步（查找对应帧的 scroll offset），
// 不参与淘汰决策。

const MAX_HISTORY_SIZE = 64;

// 环形缓冲区: 预分配 64 槽位，循环写入
const ringBuffer = new Array(MAX_HISTORY_SIZE);
let writeCursor = 0;            // 下一写入位置 (0..63)
let totalFrames = 0;           // 单调递增计数（用于判断缓冲区是否满）

function addFrame(meta) {
    // meta.frame_id: 来自 Chromium 的 uint32（允许回绕）
    // meta.timestamp: Date.now()，单调递增，用于淘汰决策
    meta.timestamp = Date.now();

    const slot = writeCursor;
    ringBuffer[slot] = meta;
    writeCursor = (writeCursor + 1) % MAX_HISTORY_SIZE;
    totalFrames++;
}

function findFrame(frameId) {
    // O(n) 线性扫描环形缓冲区（n≤64，可忽略）
    for (let i = 0; i < Math.min(totalFrames, MAX_HISTORY_SIZE); i++) {
        const idx = totalFrames <= MAX_HISTORY_SIZE
            ? i
            : (writeCursor + i) % MAX_HISTORY_SIZE;
        if (ringBuffer[idx] && ringBuffer[idx].frame_id === frameId) {
            return ringBuffer[idx];
        }
    }
    return null;
}

function getLatestFrame() {
    if (totalFrames === 0) return null;
    const latestIdx = totalFrames <= MAX_HISTORY_SIZE
        ? totalFrames - 1
        : (writeCursor - 1 + MAX_HISTORY_SIZE) % MAX_HISTORY_SIZE;
    return ringBuffer[latestIdx];
}

// 环形缓冲区自动淘汰：新写入覆盖最旧槽位（O(1)），无需显式删除。
// frame_id 回绕后 findFrame 依赖精确匹配而非大小比较，不受溢出影响。
```

### 7.5 降级策略

```
  if frameHistory.has(event.frame_id):
      → 精确转换 ✓
  else:
      → 使用最新帧（frame_id 未命中或已淘汰）
      → 记录告警（若为高频未命中则说明 RTT > 缓冲区覆盖窗口）
```

---

## 8. 错误处理与边界情况

### 8.1 网络异常

| 场景 | 客户端行为 | 服务端行为 |
|------|----------|----------|
| WebSocket 断开 | 显示"重连中"，保留最后帧 | 检测心跳超时（15s）→ 销毁 Chromium 实例 |
| 帧 CRC 校验失败 | 丢弃该帧，使用上一帧继续显示 | 不重传（帧是离散的，下一帧会覆盖） |
| frame_id 非单调 | 接受（网络乱序），但记录告警 | 发送方保证单调递增 |
| 命令白名单拒绝 | 丢弃整帧，记录安全告警 | 不感知（客户端防御措施） |
| 重连成功 | 发送新的 `ready` 消息，frame_id 重置 | 重新导航到目标 URL |

### 8.2 Chromium 异常

| 场景 | 处理 |
|------|------|
| 页面崩溃 (sad tab) | Puppeteer 检测 `pageerror`/`crashed` → 发送 `error` 消息 → 重启 Chromium |
| 导航超时 (30s) | Puppeteer `goto` timeout → `error('PAGE_TIMEOUT')` |
| 内存超限 | 限制 Chromium `--max_old_space_size` |
| 僵尸标签页 | 定期心跳检查，无活动 5 分钟后销毁 |

### 8.3 客户端边界

| 场景 | 处理 |
|------|------|
| CanvasKit 加载失败 | 显示错误页面 + 重试按钮 |
| Canvas 尺寸为 0 | 使用最小尺寸 800×600 |
| 窗口 resize | 重新计算 canvas 像素尺寸，发送新的 viewport 尺寸到服务端 |
| 标签页失焦 | 继续接收帧，但释放键盘事件监听（防止误输入） |
| 移动端触摸 | V1 不支持，降级显示为"移动端不支持" |

### 8.4 安全边界

| 场景 | 处理 |
|------|------|
| 命令 payload 超大 (>1MB) | 白名单扫描器拒绝，整帧丢弃 |
| 命令数量超大 (>50000/帧) | 拒绝 |
| save/restore 不配对 | 拒绝 |
| 未知 opcode (>0x7F) | 拒绝 |
| image 数据超大 (>10MB) | 拒绝 |
| Canvas readPixels 尝试 | RecordingCanvas 硬编码返回 false |
| 客户端 eval/Function 注入 | CSP 禁止 `unsafe-eval`（仅 `wasm-unsafe-eval`） |

---

## 9. 实现计划

### 9.1 阶段划分

```
Phase 1: 最小可行原型 (2-3 周)
├── Chromium 修改：raster_source.cc 拦截点
├── RecordingCanvas：核心 20 个方法
├── CommandBuffer：基本序列化格式
├── 服务端 Node.js：单页面、单用户
├── 客户端：CanvasKit 集成 + 命令重放
└── 验证：静态 HTML 页面渲染一致

Phase 2: 输入闭环 (1-2 周)
├── 客户端 HID 捕获（鼠标 + 键盘 + 滚轮）
├── frame_id 同步机制
├── 服务端 CDP 注入
├── 坐标转换与帧历史
└── 验证：可交互浏览（点击链接、输入文字、滚动）

Phase 3: 安全加固 (1-2 周)
├── 命令白名单扫描器（客户端）
├── CRC 校验
├── 敏感快捷键过滤
├── TLS 集成
└── 渗透测试

Phase 4: 性能优化 (2-3 周)
├── 增量帧（R-tree 选择性重放）
├── gzip 传输压缩
├── 图像缓存（hash 引用去重，`--garnet-image-mode=hash-ref` 时启用）
├── CanvasKit 预加载
└── 基准测试（首帧延迟、带宽、CPU）

Phase 5: 生产化 (持续)
├── 多用户并发
├── Chromium 实例池
├── 监控与告警
├── 日志与审计
└── 部署文档
```

### 9.2 关键技术风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|:---:|:---:|------|
| Chromium 版本升级导致拦截点失效 | 中 | 高 | cc 层入口 `PlaybackToCanvas` 签名稳定；GitHub Actions 自动检测编译 |
| CanvasKit 与 RecordingCanvas 序列化不兼容 | 中 | 高 | 写一致性测试套件；锁定 CanvasKit 版本 |
| 字体渲染不一致 | 高 | 中 | CanvasKit 内嵌字体；避免依赖系统字体 |
| WebSocket 背压（帧生成快于发送） | 中 | 中 | 发送队列 + 丢帧策略（丢弃非关键中间帧） |
| Chromium 内存泄漏 | 低 | 高 | 硬限制 `--max_old_space_size`；定期重启实例 |

---

## 10. 审计清单

### 10.1 安全审计要点

- [ ] **命令白名单完整性**: 是否所有合法 opcode 都在 `VALID_OPCODES` 中？是否有遗漏的 opcode 可以绕过？
- [ ] **参数边界检查**: `MAX_PAYLOAD_BYTES`、`MAX_PATH_VERBS` 等是否足够严格？是否存在整数溢出？
- [ ] **RecordingCanvas 覆盖完整性**: 是否有 SkCanvas 方法没有被重写，导致命令遗漏或泄漏？
- [ ] **readPixels 禁用**: 客户端和 RecordingCanvas 是否都无法读取像素？
- [ ] **frame_id 单调性**: 是否存在 frame_id 回绕（uint32 溢出）场景？
- [ ] **敏感键过滤**: `isBrowserShortcut()` 列表是否完整？是否有平台差异（macOS Cmd vs Windows Ctrl）？
- [ ] **CSP 策略**: `wasm-unsafe-eval` 是否是最小权限？是否可以收紧？
- [ ] **WebSocket 认证**: TLS 证书验证？是否有 token 认证？
- [ ] **Chromium 沙箱**: 是否启用了 Chromium 的 `--no-sandbox`（绝对不能）？
- [ ] **日志审计**: 输入事件和绘制命令是否记录审计日志？日志中是否包含敏感内容（密码、token）？

### 10.2 架构审计要点

- [ ] **信任边界**: 图表中是否每个组件的边界都有明确标记？
- [ ] **数据最小化**: 每条消息是否只包含完成功能所需的最少信息？
- [ ] **错误处理**: 每个异常路径是否有明确处理？是否存在静默失败导致安全降级？
- [ ] **状态一致性**: 客户端和服务端的帧状态同步是否有降级策略？
- [ ] **增量更新正确性**: R-tree 选择性重放是否会产生遗漏或重复绘制？

### 10.3 实现审计要点

- [ ] **RecordingCanvas 的 31 个方法**: 是否每个方法都正确序列化了所有必要参数？是否处理了参数为空的情况？
- [ ] **Paint 序列化**: 是否覆盖了所有 SkPaint 属性（shader, filter, mask）？
- [ ] **TextBlob 序列化**: 是否保留了所有 glyph 位置信息？字体引用是否正确？
- [ ] **Image 序列化**: 是否处理了图像编码格式的差异？是否有去重机制防止重复传输？
- [ ] **字节序一致性**: 所有多字节值是否统一使用 Little Endian？
- [ ] **CRC 多项式**: 是否与客户端一致？

### 10.4 操作性审计要点

- [ ] **Chromium 编译**: 是否有可复现的编译流程（Dockerfile）？
- [ ] **依赖版本锁定**: CanvasKit、Socket.IO、CDP 版本是否锁定？
- [ ] **性能基准**: 是否有可测量的延迟/带宽/CPU 基准？
- [ ] **回滚策略**: WebExtension 更新失败时如何回滚？
- [ ] **密钥管理**: TLS 私钥存储在哪里？CDP 端口是否仅绑定 localhost？

---

> **文档版本**: v1.4 | **作者**: Wison-RBI Design Team | **日期**: 2026-06-03
