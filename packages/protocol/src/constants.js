/**
 * @wison/protocol/constants — 共享常量定义
 *
 * 帧协议中所有操作码、限制值和错误码的唯一定义文件。
 * 双环境兼容 (Node.js + 浏览器)，所有对象使用 Object.freeze 防篡改。
 *
 * 帧格式总览:
 *   [version:1] [flags:1] [frameId:4] [timestamp:8] [scrollX:4] [scrollY:4]
 *   [viewportW:2] [viewportH:2] [canvasW:2] [canvasH:2]  ← 帧头共 30 字节
 *   [tileCount:2] [TileEntry × N] [TileData × N]          ← 瓦片区
 *   [Command × M]                                          ← 命令流
 *   [CRC32:4]                                              ← 完整性校验
 */

'use strict';

// ── UMD 导出 ──────────────────────────────────────────────
// 同时支持 Node.js (module.exports) 和浏览器 (window.WisonProtocol)
const isNode = typeof module !== 'undefined' && module.exports;
const root = isNode ? module.exports : (window.WisonProtocol = window.WisonProtocol || {});

// ── Magic & Version ───────────────────────────────────────
// 帧起始魔数 "PS" (0x50 0x53)，用于快速识别 wison 协议帧
root.MAGIC = new Uint8Array([0x50, 0x53]);
// 当前协议版本号，帧头部首字节
root.PROTOCOL_VERSION = 0x01;

// ── Frame Types — 帧类型 ─────────────────────────────────
root.FrameType = Object.freeze({
  KEYFRAME: 0x01,   // 关键帧：包含全部视口内容，客户端可全量替换画布
  DIFF:      0x02,  // 差分帧：仅包含变化的瓦片，需要与前帧叠加显示
});

// ── OpCodes — 绘制命令操作码 ──────────────────────────────
// 每个 opcode 在帧的命令流中占 1 字节，后面跟随 3 字节 payload 长度 (big-endian 24-bit)
// 命令分为 7 个类别，按 opcode 区间划分:
//   0x00:       空操作 (NOOP)
//   0x01–0x0F: 画布状态 (save/restore/layer)
//   0x10–0x1F: 坐标变换 (translate/scale/rotate/concat)
//   0x20–0x2F: 裁剪区域 (clip)
//   0x30–0x3F: 形状绘制 (rect/oval/arc/path/shadow)
//   0x40–0x4F: 图像绘制 (bitmap/atlas)
//   0x50–0x5F: 文本绘制 (textblob/glyphrun)
//   0x60–0x6F: 画笔操作 (paint/color)
//   0x7F:       占位符 (placeholder)
root.OpCode = Object.freeze({
  NOOP: 0x00,          // 无操作，帧中的占位符

  // State (0x01–0x0F) — 画布状态栈
  SAVE:       0x01,    // 保存当前绘制状态 (入栈)
  RESTORE:    0x02,    // 恢复上一次保存的绘制状态 (出栈)
  SAVE_LAYER: 0x03,    // 保存状态并创建透明图层 (用于透明度/混合)

  // Transform (0x10–0x1F) — 坐标系变换
  CONCAT:     0x10,    // 矩阵连接 (3×3 变换矩阵)
  TRANSLATE:  0x11,    // 平移 (dx, dy)
  SCALE:      0x12,    // 缩放 (sx, sy)
  ROTATE:     0x13,    // 旋转 (angle_radians)

  // Clip (0x20–0x2F) — 裁剪区域
  CLIP_RECT:  0x20,    // 矩形裁剪 (x,y,w,h)
  CLIP_RRECT: 0x21,    // 圆角矩形裁剪 (x,y,w,h,rx,ry)
  CLIP_PATH:  0x22,    // 路径裁剪

  // Shapes (0x30–0x3F) — 形状和路径绘制
  DRAW_RECT:  0x30,    // 绘制矩形
  DRAW_RRECT: 0x31,    // 绘制圆角矩形
  DRAW_OVAL:  0x32,    // 绘制椭圆
  DRAW_ARC:   0x33,    // 绘制圆弧
  DRAW_PATH:  0x34,    // 绘制自定义路径 (包含动词+坐标序列)
  DRAW_POINTS:0x35,    // 绘制点集 (v1.10: 已从 validator 白名单移除)
  DRAW_SHADOW:0x36,    // 绘制阴影

  // Images (0x40–0x4F) — 图像渲染
  DRAW_IMAGE:      0x40,  // 绘制图像 (原尺寸)
  DRAW_IMAGE_RECT: 0x41,  // 绘制图像 (指定矩形区域)
  DRAW_ATLAS:      0x42,  // 绘制纹理图集 (v1.10: 已移除)

  // Text (0x50–0x5F) — 文本渲染
  DRAW_TEXT_BLOB:  0x50,  // 绘制文本块 (glyph 位置 + 字体信息)
  GLYPH_RUN_LIST:  0x51,  // 字形运行列表

  // Paint (0x60–0x6F) — 画笔和颜色
  DRAW_PAINT: 0x60,    // 以指定画笔绘制整个画布
  DRAW_COLOR: 0x61,    // 以指定颜色填充整个画布

  // Placeholder — 占位符，不做任何操作
  PLACEHOLDER: 0x7F,
});

// ── HID Event Types — 人机交互事件类型 ────────────────────
// 客户端捕获 → 编码为二进制 HID 消息 → 服务端解码 → CDP 注入
// 每个 HID 消息格式: [type:1] [JSON_payload:N]
root.HIDType = Object.freeze({
  MOUSE_MOVE:  0x10,   // 鼠标移动
  MOUSE_DOWN:  0x11,   // 鼠标按下
  MOUSE_UP:    0x12,   // 鼠标释放
  MOUSE_WHEEL: 0x13,   // 滚轮滚动
  KEY_DOWN:    0x14,   // 键盘按下
  KEY_UP:      0x15,   // 键盘释放
  TOUCH_START: 0x16,   // 触摸开始
  TOUCH_MOVE:  0x17,   // 触摸移动
  TOUCH_END:   0x18,   // 触摸结束
});

// ── Tile Encoding — 瓦片编码格式 ──────────────────────────
root.TileEncoding = Object.freeze({
  JPEG: 0x01,   // JPEG 编码 (有损压缩，适合照片内容)
  PNG:  0x02,   // PNG 编码 (无损压缩，适合文本/UI 元素)
});

// ── Limits — 协议限制常量 ─────────────────────────────────
// 所有限制值均为防御性上限，防止恶意帧导致 DoS 或 OOM
root.Limits = Object.freeze({
  // 单条命令 payload ≤ 1MB——防止单条命令携带巨型数据
  MAX_PAYLOAD_BYTES: 1 << 20,

  // 单帧总命令数 ≤ 50K——上限远高于实际需求 (典型帧 10-100 条)
  MAX_COMMANDS_PER_FRAME: 50000,

  // 单帧总字节 ≤ 64MB——防止组合攻击 (50K 命令 × 1MB payload = 50GB 理论值)
  MAX_BYTES_PER_FRAME: 64 << 20,

  // 客户端接收原始帧 ≤ 4MB——WebSocket 帧大小限制
  MAX_COMPRESSED_FRAME: 4 << 20,

  // DRAW_PATH 路径动词 ≤ 100K——防止路径复杂度攻击
  MAX_PATH_VERBS: 100000,

  // DRAW_TEXT_BLOB 字形 ≤ 50K——防止字形数量攻击
  MAX_TEXT_BLOB_GLYPHS: 50000,

  // DRAW_IMAGE 图像 ≤ 10MB——防止大图像攻击
  MAX_IMAGE_BYTES: 10 << 20,

  // 矩阵元素固定 3×3 = 9 个 float32——防止异常矩阵尺寸
  MAX_MATRIX_ELEMENTS: 9,

  // 单帧最大瓦片数——3600 = ceil(1280/16) × ceil(720/16) = 80×45
  MAX_TILES: 3600,

  // SAVE 嵌套深度 ≤ 16384——防止无限嵌套导致栈溢出
  MAX_SAVE_DEPTH: 16384,

  // 帧历史窗口——客户端保留最近 N 帧用于差分恢复
  MAX_FRAME_HISTORY: 64,

  // 心跳超时 15s——超过此时间无消息视为连接断开
  HEARTBEAT_TIMEOUT_MS: 15000,
  // 心跳间隔 5s——服务端定期 ping 客户端的间隔
  HEARTBEAT_INTERVAL_MS: 5000,

  // HID 事件限流——正常速率 125Hz，突发允许 250 个令牌
  HID_RATE_LIMIT_HZ: 125,
  HID_BURST_LIMIT: 250,

  // 会话管理
  MAX_SESSIONS: 5,                   // 最大并发会话数
  SESSION_IDLE_TIMEOUT_MS: 300000,   // 空闲超时 5 分钟

  // 客户端重连策略 (指数退避)
  RECONNECT_BASE_MS: 1000,           // 初始退避时间 1s
  RECONNECT_MAX_MS: 30000,           // 最大退避时间 30s
  RECONNECT_MAX_ATTEMPTS: 5,         // 最大重连次数
});

// ── Error Codes — 错误码常量 ──────────────────────────────
// 服务端通过 status 消息通知客户端当前状态
root.ErrorCode = Object.freeze({
  NAVIGATION_FAILED:    'NAVIGATION_FAILED',     // 页面导航失败
  PAGE_TIMEOUT:         'PAGE_TIMEOUT',          // 页面加载超时
  CHROMIUM_CRASH:       'CHROMIUM_CRASH',        // Chromium 进程崩溃
  INTERNAL_ERROR:       'INTERNAL_ERROR',        // 内部未知错误
  AUTH_FAILED:          'AUTH_FAILED',           // 认证失败
  RATE_LIMITED:         'RATE_LIMITED',          // 触发限流
  SESSION_FULL:         'SESSION_FULL',          // 会话数达上限
  VALIDATION_FAILED:    'VALIDATION_FAILED',     // 帧校验失败
  DECOMPRESSION_FAILED: 'DECOMPRESSION_FAILED',  // 解压失败
});

// ── Frame Header Layout — 帧头结构常量 ────────────────────
root.FRAME_HEADER_SIZE = 30;  // 帧头固定 30 字节
root.TILE_ENTRY_SIZE = 14;    // 瓦片条目: x(2)+y(2)+w(2)+h(2)+encoding(2)+dataLen(4) = 14 字节
root.TILE_GRID = 16;          // 瓦片网格：16×16 像素/瓦片

// ── Helper: validate opcode — 检查操作码是否合法 ──────────
// 跳过分隔预留值 (0x0F, 0x1F, 0x2F, 0x3F, 0x4F, 0x5F) 和 NOOP(0x00)
root.isValidOpcode = function (opcode) {
  return opcode >= 0x01 && opcode <= 0x61 && opcode !== 0x0F && opcode !== 0x1F &&
    opcode !== 0x2F && opcode !== 0x3F && opcode !== 0x4F && opcode !== 0x5F;
};

// ── Helper: opcodeCategory — 获取操作码类别 ────────────────
// 用于日志分类和统计
root.opcodeCategory = function (opcode) {
  if (opcode <= 0x0F) return 'state';       // 状态操作
  if (opcode <= 0x1F) return 'transform';   // 变换操作
  if (opcode <= 0x2F) return 'clip';        // 裁剪操作
  if (opcode <= 0x3F) return 'shape';       // 形状绘制
  if (opcode <= 0x4F) return 'image';       // 图像绘制
  if (opcode <= 0x5F) return 'text';        // 文本绘制
  if (opcode <= 0x6F) return 'paint';       // 画笔操作
  return 'unknown';
};
