/**
 * @wison/protocol — 共享常量定义
 *
 * 双环境兼容 (Node.js + 浏览器)。
 * 所有对象使用 Object.freeze 防止运行时篡改。
 */

'use strict';

// ── UMD 导出 ──────────────────────────────────────────────
const isNode = typeof module !== 'undefined' && module.exports;
const root = isNode ? module.exports : (window.WisonProtocol = window.WisonProtocol || {});

// ── Magic & Version ───────────────────────────────────────
root.MAGIC = new Uint8Array([0x50, 0x53]); // "PS" — intentionally not frozen (TypedArray limitation)
root.PROTOCOL_VERSION = 0x01;

// ── Frame Types ───────────────────────────────────────────
root.FrameType = Object.freeze({
  KEYFRAME: 0x01,
  DIFF: 0x02,
});

// ── OpCodes ───────────────────────────────────────────────
root.OpCode = Object.freeze({
  NOOP: 0x00,

  // State (0x01–0x0F)
  SAVE: 0x01,
  RESTORE: 0x02,
  SAVE_LAYER: 0x03,

  // Transform (0x10–0x1F)
  CONCAT: 0x10,
  TRANSLATE: 0x11,
  SCALE: 0x12,
  ROTATE: 0x13,

  // Clip (0x20–0x2F)
  CLIP_RECT: 0x20,
  CLIP_RRECT: 0x21,
  CLIP_PATH: 0x22,

  // Shapes (0x30–0x3F)
  DRAW_RECT: 0x30,
  DRAW_RRECT: 0x31,
  DRAW_OVAL: 0x32,
  DRAW_ARC: 0x33,
  DRAW_PATH: 0x34,
  DRAW_POINTS: 0x35,
  DRAW_SHADOW: 0x36,

  // Images (0x40–0x4F)
  DRAW_IMAGE: 0x40,
  DRAW_IMAGE_RECT: 0x41,
  DRAW_ATLAS: 0x42,

  // Text (0x50–0x5F)
  DRAW_TEXT_BLOB: 0x50,
  GLYPH_RUN_LIST: 0x51,

  // Paint (0x60–0x6F)
  DRAW_PAINT: 0x60,
  DRAW_COLOR: 0x61,

  // Placeholder
  PLACEHOLDER: 0x7F,
});

// ── HID Event Types ───────────────────────────────────────
root.HIDType = Object.freeze({
  MOUSE_MOVE: 0x10,
  MOUSE_DOWN: 0x11,
  MOUSE_UP: 0x12,
  MOUSE_WHEEL: 0x13,
  KEY_DOWN: 0x14,
  KEY_UP: 0x15,
  TOUCH_START: 0x16,
  TOUCH_MOVE: 0x17,
  TOUCH_END: 0x18,
});

// ── Tile Encoding ─────────────────────────────────────────
root.TileEncoding = Object.freeze({
  JPEG: 0x01,
  PNG: 0x02,
});

// ── Limits (v1.6 — 包含帧级字节上限) ─────────────────────
root.Limits = Object.freeze({
  // 单条命令 payload ≤ 1MB
  MAX_PAYLOAD_BYTES: 1 << 20,

  // 单帧总命令数 ≤ 50K
  MAX_COMMANDS_PER_FRAME: 50000,

  // 单帧总字节 ≤ 64MB（防组合攻击: 50K × 1MB = 50GB）
  MAX_BYTES_PER_FRAME: 64 << 20,

  // 单帧压缩后 ≤ 4MB（防 zip bomb）
  MAX_COMPRESSED_FRAME: 4 << 20,

  // 路径动词 ≤ 100K
  MAX_PATH_VERBS: 100000,

  // 文本 glyph ≤ 50K
  MAX_TEXT_BLOB_GLYPHS: 50000,

  // 图像 ≤ 10MB
  MAX_IMAGE_BYTES: 10 << 20,

  // 矩阵固定 3×3
  MAX_MATRIX_ELEMENTS: 9,

  // 单帧 tile 数 ≤ 3600（80×45 grid @ 16px）
  MAX_TILES: 3600,

  // 帧历史窗口
  MAX_FRAME_HISTORY: 64,

  // 心跳超时
  HEARTBEAT_TIMEOUT_MS: 15000,
  HEARTBEAT_INTERVAL_MS: 5000,

  // HID 限流
  HID_RATE_LIMIT_HZ: 125,
  HID_BURST_LIMIT: 250,

  // 会话
  MAX_SESSIONS: 5,
  SESSION_IDLE_TIMEOUT_MS: 300000,

  // 重连
  RECONNECT_BASE_MS: 1000,
  RECONNECT_MAX_MS: 30000,
  RECONNECT_MAX_ATTEMPTS: 5,
});

// ── Error Codes ───────────────────────────────────────────
root.ErrorCode = Object.freeze({
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  PAGE_TIMEOUT: 'PAGE_TIMEOUT',
  CHROMIUM_CRASH: 'CHROMIUM_CRASH',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  AUTH_FAILED: 'AUTH_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  SESSION_FULL: 'SESSION_FULL',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  DECOMPRESSION_FAILED: 'DECOMPRESSION_FAILED',
});

// ── Frame Header Layout (v1.6) ────────────────────────────
root.FRAME_HEADER_SIZE = 30;
root.TILE_ENTRY_SIZE = 14; // x(2) + y(2) + w(2) + h(2) + encoding(2) + dataLen(4)
root.TILE_GRID = 16; // 16×16 pixels per tile

// ── Helper: validate opcode ───────────────────────────────
root.isValidOpcode = function (opcode) {
  return opcode >= 0x01 && opcode <= 0x61 && opcode !== 0x0F && opcode !== 0x1F &&
    opcode !== 0x2F && opcode !== 0x3F && opcode !== 0x4F && opcode !== 0x5F;
};

// ── Helper: opcode category ───────────────────────────────
root.opcodeCategory = function (opcode) {
  if (opcode <= 0x0F) return 'state';
  if (opcode <= 0x1F) return 'transform';
  if (opcode <= 0x2F) return 'clip';
  if (opcode <= 0x3F) return 'shape';
  if (opcode <= 0x4F) return 'image';
  if (opcode <= 0x5F) return 'text';
  if (opcode <= 0x6F) return 'paint';
  return 'unknown';
};
