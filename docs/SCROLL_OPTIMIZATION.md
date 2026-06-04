# 客户端滚动平移优化设计

> v2.1 | 纯客户端优化 | 零服务端/协议改动

## 1. 问题

当前渲染行为：每次收到新帧，直接在画布上 `drawImage(tile_x, tile_y)` 叠加新瓦片。当用户滚动时：

```
帧 N:   画布显示 (scrollY=0)
帧 N+1: 服务端发送 scrollY=16 的新边缘瓦片
        客户端: drawImage(新瓦片, x, y+16)
        但旧瓦片仍在原位!
        → 画面撕裂: 上半部分是旧位置的内容，下半部分是新内容
```

**根因**：客户端没有意识到"旧内容需要移动"。它把瓦片当独立图像处理，不理解它们之间的空间关系。

## 2. 方案

### 2.1 核心思路

```
每次收到帧:
  1. 计算 scroll 增量: Δx = prevScrollX - newScrollX
  2. 如果 Δ≠0: 将整个画布内容平移 Δ，腾出空间
  3. 在新暴露的空白区域绘制新瓦片
```

### 2.2 原理

```
    帧 N                      帧 N+1 (向下滚动 16px)
┌──────────┐              ┌──────────┐
│  内容 A  │              │▓▓ 新边缘 ▓▓│  ← 新瓦片填充
│  内容 B  │   平移 16px   │  内容 A  │  ← moveImageSnapshot 平移
│  内容 C  │  ─────────→  │  内容 B  │
│  内容 D  │              │  内容 C  │
└──────────┘              └──────────┘
                          D 被裁剪掉

CanvasKit API:
  surface.makeImageSnapshot() → SkImage (当前画布快照)
  canvas.translate(Δx, Δy)     → 平移坐标系
  canvas.drawImage(snapshot)   → 在新位置绘制快照
  canvas.drawImage(newTiles)   → 覆盖新瓦片填补缺口
```

## 3. 实现

### 3.1 新增文件: `renderer.js` 扩展

在现有 Renderer 类中新增 `_scrollX`、`_scrollY` 状态和 `_renderScrollOptimized()` 方法。

```javascript
// ════════════════════════════════════════════════════════════
// 滚动优化渲染器 (扩展现有 Renderer)
// ════════════════════════════════════════════════════════════

class Renderer {
  constructor(canvas, ck, options) {
    // ... 现有初始化代码 ...

    // v2.1: 滚动优化状态
    this._scrollX = 0;
    this._scrollY = 0;
    this._scrollOptimizeThreshold = 4;  // 最小优化滚动量 (px)
  }

  // ══════════════════════════════════════════════════════════
  // 渲染入口 (替换现有 render 方法中的 _renderTiles 调用)
  // ══════════════════════════════════════════════════════════

  _renderTiles(decoded) {
    const { tiles, tileCount, scrollX, scrollY } = decoded;

    if (tileCount === 0) return;

    // 判断是否为 Keyframe (单瓦片全幅)
    const isKeyframe = tileCount === 1 && tiles[0].w === decoded.viewportW;

    if (isKeyframe) {
      // Keyframe: 全幅替换，重置滚动状态
      this._scrollX = scrollX;
      this._scrollY = scrollY;
      this._drawKeyframe(decoded);
      return;
    }

    // 计算滚动增量
    const dx = scrollX - this._scrollX;
    const dy = scrollY - this._scrollY;

    // 判断是否值得做滚动优化
    if (Math.abs(dx) >= this._scrollOptimizeThreshold ||
        Math.abs(dy) >= this._scrollOptimizeThreshold) {
      this._renderScrollOptimized(decoded, dx, dy);
    } else {
      // 增量太小，直接覆盖 (避免不必要的快照开销)
      this._renderDirect(decoded);
    }

    this._scrollX = scrollX;
    this._scrollY = scrollY;
  }

  // ══════════════════════════════════════════════════════════
  // 滚动优化渲染
  //
  // 原理:
  //   1. 对当前画布做快照 (SkImage)
  //   2. 清空画布
  //   3. 在平移后的位置绘制快照
  //   4. 在新暴露区域覆盖新瓦片
  //
  // ⚠️ CanvasKit 的 makeImageSnapshot() 在 WebGL Canvas 上
  //    需要 GPU→CPU 回读，有 ~1-3ms 开销。
  //    仅当 dy > 4px 时触发，避免微小滚动引起不必要的回读。
  // ══════════════════════════════════════════════════════════

  _renderScrollOptimized(decoded, dx, dy) {
    const { tiles, tileCount } = decoded;
    const c = this._skCanvas;
    const ck = this._ck;

    // Step 1: 快照当前画布
    const snapshot = this._surface.makeImageSnapshot();
    if (!snapshot) {
      // 快照失败 (WebGL 上下文丢失等) → 降级为直接渲染
      this._renderDirect(decoded);
      return;
    }

    // Step 2: 清空画布
    c.clear(ck.TRANSPARENT);

    // Step 3: 平移快照
    // 注意: 平移方向与服务端 scroll 增量相反
    // 服务端 scrollY+16 表示页面下滚 → 内容上移 → 客户端 translate(0, -16)
    c.save();
    c.translate(-dx, -dy);
    c.drawImage(snapshot, 0, 0);
    c.restore();

    // Step 4: 覆盖新瓦片 (新暴露区域的瓦片)
    for (const tile of tiles) {
      const raw = new Uint8Array(decoded.data, tile.dataOffset, tile.dataLen);
      const img = ck.MakeImageFromEncoded(raw);
      if (img) {
        c.drawImage(img, tile.x, tile.y);
        img.delete();
      }
    }

    // Step 5: 释放快照 (CanvasKit GC)
    snapshot.delete();
  }

  // ══════════════════════════════════════════════════════════
  // 直接渲染 (微小滚动或无滚动时使用)
  // ══════════════════════════════════════════════════════════

  _renderDirect(decoded) {
    const { tiles, tileCount } = decoded;
    const c = this._skCanvas;
    const ck = this._ck;

    if (tileCount === 0) return;

    for (const tile of tiles) {
      const raw = new Uint8Array(decoded.data, tile.dataOffset, tile.dataLen);
      const img = ck.MakeImageFromEncoded(raw);
      if (img) {
        c.drawImage(img, tile.x, tile.y);
        img.delete();
      }
    }
  }

  _drawKeyframe(decoded) {
    const { tiles } = decoded;
    const c = this._skCanvas;
    const ck = this._ck;

    const raw = new Uint8Array(decoded.data, tiles[0].dataOffset, tiles[0].dataLen);
    const img = ck.MakeImageFromEncoded(raw);
    if (img) {
      c.clear(ck.TRANSPARENT);
      c.drawImage(img, 0, 0);
      img.delete();
    }
  }
}
```

### 3.2 关键 API 说明

```javascript
// CanvasKit Surface API:

surface.makeImageSnapshot()
  → 返回 SkImage 对象
  → WebGL 模式: gl.readPixels + SkImage::MakeFromRaster (GPU→CPU 回读)
  → 软件模式: 直接内存拷贝
  → 开销: WebGL ~1-3ms, SW ~0.2ms
  → 失败: 返回 null (WebGL 上下文丢失)

canvas.translate(dx, dy)
  → 平移当前变换矩阵
  → 后续所有绘制操作在平移后的坐标系中进行

canvas.drawImage(snapshot, x, y)
  → 在 (x, y) 处绘制快照图像
  → 受当前变换矩阵影响 (translate/scale/rotate)

image.delete()
  → 释放 WASM 堆中的 SkImage 对象
  → 必须显式调用 (CanvasKit 无 GC)
```

## 4. 性能分析

### 4.1 快照开销

| Canvas 类型 | makeImageSnapshot | 说明 |
|------------|-------------------|------|
| WebGL (GPU) | **1-3 ms** | gl.readPixels + GPU→CPU 拷贝 |
| 软件渲染 (CPU) | **0.1-0.3 ms** | memcpy |

### 4.2 场景收益

```
场景: 平滑滚动 16px/frame

当前方案:
  每帧: 解码 ~30 个 JPEG 边缘瓦片
        drawImage × 30 (保留旧瓦片在原位)
  ⚠️ 问题: 旧瓦片不动，画面撕裂

优化方案:
  每帧: makeImageSnapshot (1-3ms)
        canvas.clear + translate + drawImage(snapshot × 1)
        drawImage × 30 (新瓦片)
  ✅ 画面正确

GPU 额外开销: 1-3ms/frame
在 20fps (50ms/帧) 窗口中: 1-3ms 是可接受的
```

### 4.3 WebGL 回读优化

```javascript
// 可选: 双 Surface 方案 (零回读)
//
// 问题: makeImageSnapshot 在 WebGL 需要 GPU→CPU 回读
// 优化: 使用两个 WebGL Surface，利用 GPU 纹理直接 blit
//
// 实现:
//   surfaceA = MakeWebGLCanvasSurface(canvas)  ← 显示 surface
//   surfaceB = MakeWebGLCanvasSurface(canvas)  ← 离屏 surface
//
// 滚动时:
//   surfaceB.clear()
//   surfaceB.drawImage(surfaceA 的内容, -dx, -dy)  ← GPU 纹理拷贝
//   surfaceB.drawImage(新瓦片)                       ← 叠加新瓦片
//   交换 surfaceA ↔ surfaceB (本质上就是 canvas swap)
//
// CanvasKit 限制: 无法在两个 WebGL Surface 间直接传输纹理
// 需要 intermediate SkImage 或 readPixels (本方案已使用)
```

## 5. 边界处理

### 5.1 大滚轮跳跃

```
用户快速滚动 (Page Down, 720px):
  Δy = 720, 超出画布高度
  → _renderScrollOptimized 会将整个快照移出画布
  → 结果: 全部空白 + 新瓦片覆盖
  → 效果等同 Keyframe (正确)
```

### 5.2 双向滚动

```
用户同时横向+纵向滚动:
  Δx = 100, Δy = 50
  → translate(-100, -50)
  → 快照整体平移
  → 新瓦片覆盖右侧 100px 和底部 50px 的 L 形区域
  → 正确
```

### 5.3 Keyframe 中断滚动优化

```
Keyframe 到达时:
  _drawKeyframe() → clear + drawImage(全幅)
  _scrollX/Y 被重置
  → 下一帧从新基线计算增量
  → 正确
```

### 5.4 CanvasKit 初始化失败

```
makeImageSnapshot → null (无 SkCanvas 或 WebGL 丢失)
  → _renderScrollOptimized 降级为 _renderDirect
  → 画面不优化但有内容 (与当前行为一致)
```

## 6. 修改清单

| 文件 | 修改 | 行数 |
|------|------|------|
| `renderer.js` | 新增 `_scrollX/Y` 状态 | +2 |
| `renderer.js` | 新增 `_renderScrollOptimized()` | +30 |
| `renderer.js` | 新增 `_renderDirect()` | +10 |
| `renderer.js` | 修改 `_renderTiles()` 入口 | +15 |
| `renderer.js` | 新增 `_drawKeyframe()` | +10 |
| **合计** | 1 个文件 | **~67 行** |

## 7. 测试验证

```javascript
// 手动测试: 浏览器 DevTools Console

// 1. 滚动优化触发标记
renderer._scrollX = 0;
renderer._scrollY = 0;

// 2. 模拟服务端发送滚动增量帧
// 观察: canvas 内容应平滑平移 + 新内容出现在边缘

// 3. 性能基准: 对比优化前后帧耗时
console.time('render');
renderer.render(frameData);
console.timeEnd('render');
// 期望: 与直接渲染耗时接近 (< +3ms)

// 4. WebGL 丢失测试:
// chrome://flags → WebGL → Disabled
// 期望: 自动降级为 _renderDirect
```

## 8. 总结

| 指标 | 值 |
|------|-----|
| 修改文件 | 1 个 (renderer.js) |
| 新增代码 | ~67 行 |
| 协议改动 | **零** |
| 服务端改动 | **零** |
| GPU 额外开销 | 1-3ms/帧 (WebGL 回读) |
| CPU 额外开销 | <0.3ms/帧 (SW Canvas) |
| 兼容性 | 有快照→优化，无快照→降级 |
