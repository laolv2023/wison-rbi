# Compositor PaintOp 集成设计方案

> v2.0 架构设计 | 保留 JPEG 瓦片管道，新增 PaintOp 编码路径

## 1. 设计目标

```
当前:   page.screenshot() → JPEG tiles → 客户端 drawImage()
新增:   cc::PaintOp 截获 → 序列化命令流 → 客户端 WebGPU/CanvasKit 回放

共存:   帧级自动选择 (Tile 还是 PaintOp)
```

## 2. 总体架构

```
┌───────────────────────────────────────────────────────────────┐
│                    FrameCapture (扩)                          │
│  ┌─────────────────────┐  ┌─────────────────────────────┐    │
│  │ TilePipeline (现有)  │  │ PaintOpPipeline (新增)      │    │
│  │ screenshot → sharp   │  │ CDP getDisplayItemList     │    │
│  │ → MD5 diff → JPEG    │  │ → serialize → CRC32        │    │
│  └────────┬────────────┘  └──────────────┬──────────────┘    │
│           │                              │                    │
│           └──────────┬───────────────────┘                    │
│                      ▼                                        │
│           FrameEncoder (扩: 新帧类型 PAINTOP)                  │
│                      ▼                                        │
│              WebSocket → 客户端                                │
└───────────────────────────────────────────────────────────────┘

客户端:
┌───────────────────────────────────────────────────────────────┐
│                    Renderer (扩)                               │
│  ┌─────────────────────┐  ┌─────────────────────────────┐    │
│  │ TileRenderer (现有)  │  │ PaintOpRenderer (新增)      │    │
│  │ JPEG → drawImage    │  │ PaintOp → CanvasKit API     │    │
│  └─────────────────────┘  └─────────────────────────────┘    │
└───────────────────────────────────────────────────────────────┘
```

## 3. Chromium 修改 (最小化)

### 3.1 修改范围

仅修改 **1 个文件**：`cc/paint/display_item_list.cc`

```cpp
// cc/paint/display_item_list.cc — 在 Finalize() 末尾插入钩子

void DisplayItemList::Finalize() {
  // ... 现有代码: 空间索引构建、内存优化 ...

#if defined(WISON_RBI_HOOK)  // GN 编译标志
  if (wison_hook_enabled_) {
    WisonRBHook::OnDisplayListFinalized(this);
  }
#endif
}
```

### 3.2 钩子实现 (独立文件)

```cpp
// cc/paint/wison_rbi_hook.h — 新增文件
// 编译条件: wison_rbi_hook = true (GN arg)

class WisonRBHook {
 public:
  static void OnDisplayListFinalized(const DisplayItemList* list);

  // CDP 命令: 启用/禁用截获
  static void Enable();
  static void Disable();
  static bool IsEnabled();

  // 获取上次 Finalize 的序列化数据
  static std::vector<uint8_t> TakeSerializedOps();

 private:
  static bool enabled_;
  static std::vector<uint8_t> serialized_buffer_;
  static size_t frame_seq_;
  static gfx::Rect last_scroll_rect_;
};
```

### 3.3 CDP 集成

新增 CDP 域命令：

```javascript
// 通过 Runtime.evaluate 注入，无需修改 CDP 协议
// 只需要 key 一个控制变量:
window.__wison_paintop_enabled = true;
```

实际方案：通过 **CDP `Page.addScriptToEvaluateOnNewDocument`** 注入一个轻量 JS 钩子，该钩子设置一个全局标志。配合 CDP `Runtime.evaluate` 读取序列化结果。

更优化方案：**扩展 CDP 自定义域**（需要修改 Chromium 的 CDP 定义，约 +50 行）：

```cpp
// content/browser/devtools/protocol/wison_handler.cc — 新增
// 注册自定义 CDP 域: "Wison"
// 命令: Wison.enable(), Wison.disable(), Wison.getFrame()
// 事件: Wison.frameReady(serializedData)
```

## 4. PaintOp 类型映射

从 33 种 cc::PaintOp 中选择有意义的子集：

### 4.1 需要传输的 PaintOp

| cc::PaintOp | Type ID | CanvasKit API | 典型 payload |
|-------------|---------|---------------|-------------|
| SaveOp | 0x01 | canvas.save() | 0 |
| RestoreOp | 0x02 | canvas.restore() | 0 |
| SaveLayerOp | 0x03 | canvas.saveLayer() | bounds(16) + paint(~40) |
| ConcatOp | 0x10 | canvas.concat(matrix) | 36 (9×float) |
| TranslateOp | 0x11 | canvas.translate(dx,dy) | 8 |
| ScaleOp | 0x12 | canvas.scale(sx,sy) | 8 |
| RotateOp | 0x13 | canvas.rotate(rad) | 4 |
| ClipRectOp | 0x20 | canvas.clipRect(r) | 16 |
| ClipRRectOp | 0x21 | canvas.clipRRect(r,radii) | 44 |
| ClipPathOp | 0x22 | canvas.clipPath(path) | 变长 (~200B) |
| DrawRectOp | 0x30 | canvas.drawRect(r,paint) | 16 + paint(~40) |
| DrawRRectOp | 0x31 | canvas.drawRRect(r,radii,paint) | 44 + paint |
| DrawOvalOp | 0x32 | canvas.drawOval(r,paint) | 16 + paint |
| DrawPathOp | 0x34 | canvas.drawPath(path,paint) | 变长 (~300B) |
| DrawImageOp | 0x40 | canvas.drawImage(img) | 变长 + image_ref |
| DrawImageRectOp | 0x41 | canvas.drawImageRect(img,src,dst,paint) | 32 + paint + ref |
| DrawTextBlobOp | 0x50 | canvas.drawTextBlob(blob,x,y,paint) | 变长 (~500B) |
| DrawColorOp | 0x61 | canvas.drawColor(color,mode) | 8 |

### 4.2 不需要传输的 PaintOp

| PaintOp | 原因 |
|---------|------|
| NoopOp / RestoreOp 内部的 | 编译器优化产物 |
| SetMatrixOp (废弃) | cc 层不再使用 |
| DrawRecordOp | 递归 DisplayItemList，已展开 |
| DrawLineOp/DrawArcOp 等 | 罕见的调试 Op |
| AnnotateOp | 仅用于 tracing |

## 5. 序列化格式

### 5.1 PaintOp 帧 (FrameType 0x03)

```
帧头 (30 字节，同 v1):
  [version:1][flags:1][frameId:4][timestamp:8]
  [scrollX:4][scrollY:4][scrollOffset_dx:4][scrollOffset_dy:4]
  [viewportW:2][viewportH:2][canvasW:2][canvasH:2]

PaintOp 流:
  [opCount:4]
  [PaintOp × N]:
    [type:2][flags:2][payloadLen:4][payload:payloadLen]

图像引用区:
  [imageCount:4]
  [ImageRef × M]:
    [imageId:4][encoding:2][width:2][height:2][dataLen:4][data:dataLen]

CRC32: [4]
```

### 5.2 PaintOp header (8 字节)

```
[type:2][flags:2][payloadLen:4]

type:       0x0001 = Save, 0x0011 = Translate, ...
flags:      bit0=paint_included, bit1=has_image_ref, bit2=skip_if_offscreen
payloadLen: payload 字节数 (不包含此 header)
```

### 5.3 Paint 结构 (内联编码)

```
Paint 对象在 PaintOp payload 中以内联方式编码:
[style:1][color:4][strokeWidth:4][strokeMiter:4]
[blendMode:1][antiAlias:1][alpha:1][filterQuality:1]
总计: ~17 字节 (vs 完整的 SkPaint ~40+ 字节)
```

### 5.4 图像处理

```
嵌入图像的 DrawImageOp:
  payload 中 imageId 引用 ImageRef 表中的条目
  ImageRef 表包含图像数据 (JPEG/PNG/WebP)

去重:
  服务端维护 image_id → hash 映射
  相同图像只传输一次 (全部帧生命周期内)

客户端:
  维护 image_id → SkImage 缓存
  在 drawImage() 时查表
```

## 6. 增量传输 (关键优化)

### 6.1 DisplayItemList 空间索引

`DisplayItemList` 内置 R-tree 空间索引。可以按视口区域查询 PaintOp 子集：

```cpp
// 利用 R-tree 只序列化当前视口内的 PaintOp
std::vector<size_t> visible_op_indices;
list->rtree().Search(gfx::Rect(viewport_x, viewport_y, 
                                viewport_width, viewport_height),
                     &visible_op_indices);
```

### 6.2 差分传输

```
帧间差分:
  不是 PaintOp 级别的 diff (太复杂)
  而是视口空间的增量:

滚动场景:
  用户滚动 100px →
    旧视口: (0, 0, 1280, 720)
    新视口: (0, 100, 1280, 720)
    重叠区: (0, 100, 1280, 620)  ← 不重传
    新区域: (0, 720, 1280, 100)  ← 仅序列化此区域 PaintOp
    带宽 = 100/720 ≈ 14% 全帧

  客户端:
    保留当前 SkCanvas 内容
    对重叠区做 translate(0, -100) → 内容向下移动
    仅对新增区域执行 PaintOp 回放
```

### 6.3 协议扩展

```
帧头中的 scrollOffset:
  [scrollOffset_dx:4][scrollOffset_dy:4]
  表示此帧相对于上一帧的滚动偏移

增量标记:
  flags 字节 bit1 = 增量帧
  增量帧仅包含新增可见区域的 PaintOp
  
  全量帧 (bit1=0): 全部视口 PaintOp
  增量帧 (bit1=1): 仅新增视口 PaintOp
```

## 7. 客户端 PaintOp → CanvasKit 回放

### 7.1 解析器

```javascript
class PaintOpRenderer {
  _dispatch(paintOp, images) {
    const { type, payload, paint } = paintOp;

    // 先设置 paint (如果包含)
    if (paint) this._applyPaint(paint);

    switch (type) {
      case TYPE.SAVE:       this._canvas.save(); break;
      case TYPE.RESTORE:    this._canvas.restore(); break;
      case TYPE.TRANSLATE:  this._canvas.translate(p.dx, p.dy); break;
      case TYPE.SCALE:      this._canvas.scale(p.sx, p.sy); break;
      case TYPE.CLIP_RECT:  this._canvas.clipRect(
                              [p.x,p.y,p.w,p.h], ck.ClipOp.Intersect, true); break;
      case TYPE.DRAW_RECT:  this._canvas.drawRect(
                              [p.x,p.y,p.w,p.h], this._paint); break;
      case TYPE.DRAW_PATH:  this._canvas.drawPath(
                              this._makePath(p.verbs, p.pts), this._paint); break;
      case TYPE.DRAW_IMAGE: {
        const img = images.get(p.imageId);
        if (img) this._canvas.drawImage(img, p.x, p.y);
        break;
      }
      case TYPE.DRAW_IMAGE_RECT:
        // drawImageRect(src, dst)
        break;
      case TYPE.DRAW_TEXT_BLOB:
        this._drawTextBlob(p);
        break;
      case TYPE.DRAW_COLOR:
        this._canvas.drawColor(p.color, p.mode);
        break;
    }
  }

  _applyPaint(p) {
    this._paint.setColor(p.color);
    this._paint.setStyle(p.style);  // Fill / Stroke
    this._paint.setStrokeWidth(p.strokeWidth);
    this._paint.setAlphaf(p.alpha / 255);
    this._paint.setBlendMode(p.blendMode);
    this._paint.setAntiAlias(p.antiAlias);
  }

  _makePath(verbs, pts) {
    const path = new this._ck.Path();
    let ptIdx = 0;
    for (const v of verbs) {
      switch (v) {
        case VERB.MOVE:  path.moveTo(pts[ptIdx], pts[ptIdx+1]); ptIdx+=2; break;
        case VERB.LINE:  path.lineTo(pts[ptIdx], pts[ptIdx+1]); ptIdx+=2; break;
        case VERB.QUAD:  path.quadTo(...); ptIdx+=4; break;
        case VERB.CUBIC: path.cubicTo(...); ptIdx+=6; break;
        case VERB.CONIC: path.conicTo(...); ptIdx+=4; break;
        case VERB.CLOSE: path.close(); break;
      }
    }
    return path;
  }
}
```

### 7.2 图像缓存

```javascript
class ImageCache {
  constructor() { this._images = new Map(); }

  add(imageId, jpegData) {
    const img = this._ck.MakeImageFromEncoded(jpegData);
    if (img) this._images.set(imageId, img);
  }

  get(imageId) {
    return this._images.get(imageId);
  }

  evict(maxSize = 50) {
    if (this._images.size > maxSize) {
      const oldest = this._images.keys().next().value;
      this._images.get(oldest).delete();
      this._images.delete(oldest);
    }
  }
}
```

## 8. 帧类型自动选择

### 8.1 选择逻辑

```javascript
// FrameCapture 决策
function selectFrameType(metrics) {
  // 规则优先级:

  // 1. 硬件加速内容 → PaintOp (截图捕获不到 WebGL/Video)
  if (metrics.hasCompositedContent) return 'paintop';

  // 2. 静态页面 → Tile (零带宽优势)
  if (metrics.dirtyTileRatio === 0) return 'tile';

  // 3. 纯 CSS 动画 → PaintOp (变换在 PaintOp 中几乎免费)
  if (metrics.animatingElements > 0 && metrics.dirtyTileRatio < 0.3)
    return 'paintop';

  // 4. 首次加载 → Tile (单帧 JPEG 比全量 PaintOp 小)
  if (metrics.firstFrame) return 'tile';

  // 5. 高频滚动 (>10px/frame) → PaintOp (增量传输)
  if (metrics.scrollSpeed > 10 && metrics.dirtyTileRatio > 0.3)
    return 'paintop';

  // 6. 低变化率 → Tile (JPEG 小瓦片命令流更紧凑)
  if (metrics.dirtyTileRatio < 0.15) return 'tile';

  // 7. 默认 → PaintOp (大多数场景 PaintOp 更优)
  return 'paintop';
}
```

### 8.2 无缝切换

```
客户端处理:
  frameType=0x01 (Keyframe Tile): 清空画布 → drawImage(全幅JPEG)
  frameType=0x02 (Diff Tile):     保留画布 → drawImage(脏瓦片)
  frameType=0x03 (PaintOp Full):  清空画布 → dispatchCommands(全部)
  frameType=0x04 (PaintOp Delta): 保留画布 → translate(scroll) → dispatchCommands(增量)

关键: 切换不丢状态
  Tile→PaintOp: 最后一帧 Tile 保留在 Canvas 上，PaintOp 覆盖新区域
  PaintOp→Tile:  发送关键帧 Tile 全幅替换
```

## 9. 服务端实现

### 9.1 PaintOpFrameCapture

```javascript
class PaintOpFrameCapture {
  constructor(page, viewport, cdp, logger) {
    this._cdp = cdp;
    this._page = page;
    this._viewport = viewport;
    this._enabled = false;
    this._imageCache = new Map(); // image_hash → image_id
    this._scrollX = 0;
    this._scrollY = 0;
    this._seq = 0;
  }

  async enable() {
    // 注入 Chromium 钩子 (通过 CDP Runtime.evaluate)
    await this._cdp.evaluate(`
      window.__wison = { paintop_enabled: true, seq: 0 };
    `);
    this._enabled = true;
  }

  async capture() {
    if (!this._enabled) return null;

    // 获取序列化的 PaintOp 数据
    const result = await this._cdp.evaluate(`
      window.__wison.data || null
    `);

    if (!result) return null;

    // 解析 PaintOp 缓冲区
    const { ops, images, scrollX, scrollY, seq } = this._parse(result);

    // 计算滚动增量
    const dScrollX = scrollX - this._scrollX;
    const dScrollY = scrollY - this._scrollY;
    this._scrollX = scrollX;
    this._scrollY = scrollY;

    // 生成帧类型
    const isScroll = Math.abs(dScrollX) > 0 || Math.abs(dScrollY) > 0;

    return {
      frameType: this._seq === 0 ? 0x03 : (isScroll ? 0x04 : 0x03),
      ops,
      images,      // [{imageId, encoding, data}]
      scrollX,
      scrollY,
      dScrollX,
      dScrollY,
      seq: this._seq++,
    };
  }
}
```

### 9.2 编码器集成

```javascript
// FrameEncoder 扩展
class FrameEncoder {
  addPaintOp(type, flags, payload) { /* 同上 */ }
  addImage(imageId, encoding, width, height, data) { /* 同上 */ }

  finalize(frameType) {
    // 现有 Tile 路径不变

    // PaintOp 路径:
    if (frameType === 0x03 || frameType === 0x04) {
      // 帧头 → opCount → PaintOp[] → imageCount → ImageRef[] → CRC32
    }
  }
}
```

## 10. 改进后的渲染管道

```
FrameCapture
  │
  ├── _tileCapture()      ← 现有路径，不变
  │   └── screenshot → sharp → MD5 → JPEG
  │
  ├── _paintOpCapture()   ← 新增路径
  │   └── CDP getDisplayList → serialize → CRC32
  │
  ├── _selectFrameType(metrics)
  │   └── 自动选择最优编码
  │
  └── FrameEncoder.finalize(frameType, data)

Session._captureFrame()
  ├── result = capture.capture()
  ├── encoder.setMetadata(...)
  ├── for tile of result.tiles → encoder.addTile(...)
  ├── for op of result.ops → encoder.addPaintOp(...)
  ├── for img of result.images → encoder.addImage(...)
  └── encoder.finalize(result.frameType)

Renderer.render(frameData)
  ├── 解码 → 检查 frameType
  ├── frameType=0x01/0x02 → _renderTiles(decoded)
  └── frameType=0x03/0x04 → _dispatchPaintOps(decoded)
```

## 11. 总对总对比 (完成后的系统)

| 场景 | Tile 方案 | PaintOp 方案 | 自动选择 |
|------|----------|-------------|---------|
| 首次加载 | 60 KB | 180 KB | Tile |
| 静态文本 | 0 KB/s | 0 KB/s | Tile |
| 滚动文本 | 150 KB/s | 50 KB/s | PaintOp |
| CSS 动画 | 400 KB/s | 5 KB/s | PaintOp |
| 视频播放 | 3 MB/s | 3 MB/s (trivial) | PaintOp+Tiles |
| 图片浏览 | 600 KB/s | 200 KB/s | PaintOp |
| WebGL | ❌ 不可用 | ✅ PaintOp | PaintOp |

## 12. 实施步骤

| 阶段 | 内容 | 工期 |
|------|------|------|
| Phase 1 | Chromium 补丁: cc/paint/display_item_list.cc 钩子 + PaintOp 序列化 | 2周 |
| Phase 2 | CDP 域扩展 (Wison.enable/disable/getFrame) | 1周 |
| Phase 3 | 协议扩展: FrameType 0x03/0x04 + PaintOp 编码格式 | 3天 |
| Phase 4 | PaintOpFrameCapture + FrameEncoder 集成 | 3天 |
| Phase 5 | 客户端 PaintOpRenderer + ImageCache | 1周 |
| Phase 6 | 帧类型自动选择 + 无缝切换 | 2天 |
| Phase 7 | 测试: 100+ PaintOp 场景验证 | 1周 |
| **合计** | | **~6周** |
