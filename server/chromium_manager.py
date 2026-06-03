"""
Chromium Manager — 通过 Playwright 控制 headless Chromium

核心循环:
  1. Frame tick (可配置间隔，默认 50ms)
  2. 截图 → PIL Image
  3. 帧差对比 (16×16 tile grid)
  4. 脏 tile → JPEG 编码
  5. 生成 PaintOpFrame → 交给 WebSocket 发送
"""

import asyncio
import io
import hashlib
import time
import logging
from dataclasses import dataclass, field
from typing import Optional, Callable, Awaitable

from PIL import Image
from playwright.async_api import async_playwright, Browser, BrowserContext, Page

from protocol import PaintOpFrame, FrameType, Tile, TileEncoding

logger = logging.getLogger(__name__)

TILE_SIZE = 16
KEYFRAME_INTERVAL = 300  # 每 N 帧强制发一次 Keyframe
TICK_INTERVAL = 0.05  # 50ms


@dataclass
class ChromiumSession:
    """单个远程浏览器会话"""

    viewport: tuple[int, int] = (1280, 720)
    target_url: str = "https://example.com"
    frame_callback: Optional[Callable[[PaintOpFrame], Awaitable[None]]] = None
    status_callback: Optional[Callable[[dict], Awaitable[None]]] = None

    # 内部状态
    _browser: Browser | None = field(default=None, repr=False)
    _context: BrowserContext | None = field(default=None, repr=False)
    _page: Page | None = field(default=None, repr=False)
    _prev_hashes: list[bytes] = field(default_factory=list, repr=False)
    _frame_count: int = 0
    _running: bool = False
    _task: asyncio.Task | None = field(default=None, repr=False)

    async def start(self):
        """启动 Chromium 并开始帧捕获"""
        self._running = True
        playwright = await async_playwright().start()

        self._browser = await playwright.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-software-rasterizer",
            ],
        )
        self._context = await self._browser.new_context(
            viewport={"width": self.viewport[0], "height": self.viewport[1]},
            device_scale_factor=1,
        )
        self._page = await self._context.new_page()

        # 监听页面导航事件，通知客户端
        self._page.on("framenavigated", self._on_navigated)
        self._page.on("load", self._on_load)

        # 先加载空白页，等待客户端指定目标 URL
        await self._page.goto("about:blank", wait_until="domcontentloaded")

        # 初始化 tile 哈希表
        cols = self.viewport[0] // TILE_SIZE
        rows = self.viewport[1] // TILE_SIZE
        self._prev_hashes = [b"\x00"] * (cols * rows)

        # 启动帧循环
        self._task = asyncio.create_task(self._frame_loop())

        logger.info(
            "Chromium launched, awaiting navigation (%dx%d)",
            *self.viewport,
        )

    async def stop(self):
        """停止会话，销毁 Chromium"""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

        if self._browser:
            await self._browser.close()
        logger.info("Chromium session stopped")

    async def navigate(self, url: str):
        """导航到新 URL"""
        self.target_url = url
        if self._page:
            await self._page.goto(url, wait_until="domcontentloaded")
            self._frame_count = 0  # 强制下一帧为 Keyframe
            logger.info("Navigating to: %s", url)

    async def resize(self, width: int, height: int):
        """调整视口大小"""
        self.viewport = (width, height)
        if self._page:
            await self._page.set_viewport_size({"width": width, "height": height})
            cols = width // TILE_SIZE
            rows = height // TILE_SIZE
            self._prev_hashes = [b"\x00"] * (cols * rows)

    async def inject_mouse(self, event_type: str, x: float, y: float, button: str = "left", delta_x: float = 0, delta_y: float = 0):
        """注入鼠标事件"""
        if not self._page:
            return
        if event_type == "mousemove":
            await self._page.mouse.move(x, y)
        elif event_type == "mousedown":
            await self._page.mouse.move(x, y)
            await self._page.mouse.down(button=button)
        elif event_type == "mouseup":
            await self._page.mouse.move(x, y)
            await self._page.mouse.up(button=button)
        elif event_type == "wheel":
            await self._page.mouse.wheel(delta_x, delta_y)

    async def inject_key(self, event_type: str, key: str, code: str = "", modifiers: dict | None = None):
        """注入键盘事件"""
        if not self._page:
            return
        modifiers = modifiers or {}
        if event_type == "keydown":
            await self._page.keyboard.down(key)
        elif event_type == "keyup":
            await self._page.keyboard.up(key)
        elif event_type == "keypress":
            # 对于可打印字符
            if len(key) == 1:
                await self._page.keyboard.type(key)

    async def inject_text(self, text: str):
        """注入文本 (用于 IME 输入)"""
        if self._page:
            await self._page.keyboard.type(text)

    # ── 内部方法 ──────────────────────────────────────────

    async def _frame_loop(self):
        """主帧循环: 截图 → 差分 → 编码 → 回调"""
        while self._running:
            try:
                await self._capture_and_send()
            except Exception:
                logger.exception("Frame capture error")
            await asyncio.sleep(TICK_INTERVAL)

    async def _capture_and_send(self):
        if not self._page:
            return

        # 截图
        screenshot = await self._page.screenshot(type="jpeg", quality=70, full_page=False)
        img = Image.open(io.BytesIO(screenshot))
        img = img.convert("RGB")

        # 计算脏 tile
        dirty_tiles = self._compute_dirty_tiles(img)

        # 决定帧类型
        cols = self.viewport[0] // TILE_SIZE
        rows = self.viewport[1] // TILE_SIZE
        total_tiles = cols * rows

        self._frame_count += 1
        is_keyframe = (
            len(dirty_tiles) > total_tiles * 0.5
            or self._frame_count % KEYFRAME_INTERVAL == 0
        )

        if is_keyframe:
            # 全量帧: 所有 tile 标记为脏，发送整帧 JPEG
            tiles = [
                Tile(
                    x=0,
                    y=0,
                    w=self.viewport[0],
                    h=self.viewport[1],
                    encoding=TileEncoding.JPEG,
                    data=screenshot,
                )
            ]
            frame_type = FrameType.KEYFRAME
            self._update_all_hashes(img)
        elif dirty_tiles:
            tiles = self._encode_dirty_tiles(img, dirty_tiles)
            frame_type = FrameType.DIFF
        else:
            return  # 无变化，不发送

        frame = PaintOpFrame(frame_type=frame_type, tiles=tiles)

        if self.frame_callback:
            await self.frame_callback(frame)

    def _compute_dirty_tiles(self, img: Image.Image) -> list[tuple[int, int]]:
        """对比当前帧与上一帧，返回脏 tile 坐标列表"""
        cols = self.viewport[0] // TILE_SIZE
        rows = self.viewport[1] // TILE_SIZE
        dirty = []

        for row in range(rows):
            for col in range(cols):
                x, y = col * TILE_SIZE, row * TILE_SIZE
                tile_img = img.crop((x, y, x + TILE_SIZE, y + TILE_SIZE))
                tile_hash = hashlib.md5(tile_img.tobytes()).digest()

                idx = row * cols + col
                if tile_hash != self._prev_hashes[idx]:
                    dirty.append((x, y))
                    self._prev_hashes[idx] = tile_hash

        return dirty

    def _encode_dirty_tiles(self, img: Image.Image, dirty: list[tuple[int, int]]) -> list[Tile]:
        """将脏 tile 编码为 Tile 列表"""
        tiles = []
        for x, y in dirty:
            tile_img = img.crop((x, y, x + TILE_SIZE, y + TILE_SIZE))
            buf = io.BytesIO()
            tile_img.save(buf, format="JPEG", quality=60)
            tiles.append(
                Tile(
                    x=x,
                    y=y,
                    w=TILE_SIZE,
                    h=TILE_SIZE,
                    encoding=TileEncoding.JPEG,
                    data=buf.getvalue(),
                )
            )
        return tiles

    def _update_all_hashes(self, img: Image.Image):
        """Keyframe 后更新全部 tile 哈希"""
        cols = self.viewport[0] // TILE_SIZE
        rows = self.viewport[1] // TILE_SIZE
        self._prev_hashes = []

        for row in range(rows):
            for col in range(cols):
                x, y = col * TILE_SIZE, row * TILE_SIZE
                tile_img = img.crop((x, y, x + TILE_SIZE, y + TILE_SIZE))
                self._prev_hashes.append(hashlib.md5(tile_img.tobytes()).digest())

    # ── 事件回调 ──────────────────────────────────────────

    async def _on_navigated(self, frame):
        if frame == self._page.main_frame and self.status_callback:
            await self.status_callback(
                {
                    "type": "status",
                    "url": frame.url,
                    "loading": True,
                    "title": "",
                }
            )

    async def _on_load(self, page):
        if self.status_callback:
            title = await page.title()
            await self.status_callback(
                {
                    "type": "status",
                    "url": page.url,
                    "loading": False,
                    "title": title,
                }
            )
