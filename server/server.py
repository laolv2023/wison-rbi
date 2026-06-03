"""
PaintOp Remote Browser — 服务端入口

单进程 aiohttp 服务器:
  GET  /          → 返回 client/index.html
  GET  /health    → 健康检查
  WS   /ws        → WebSocket 端点 (每连接一个 Chromium 会话)

启动: python server.py --port 8080
"""

import asyncio
import argparse
import logging
import json
from pathlib import Path

import aiohttp
from aiohttp import web, WSMsgType

from chromium_manager import ChromiumSession
from protocol import decode_hid, encode_control, HIDType

logger = logging.getLogger(__name__)

CLIENT_DIR = Path(__file__).parent.parent / "client"


class SessionHandler:
    """管理单个 WebSocket 连接对应的 Chromium 会话

    Chromium 不会在连接建立时自动启动——等待客户端发送第一个
    navigate 指令后才启动。这样客户端可以先展示网站选择器，
    用户选定网站后再启动远端浏览器。
    """

    def __init__(self, ws: web.WebSocketResponse):
        self.ws = ws
        self.session = ChromiumSession(
            viewport=(1280, 720),
            target_url="about:blank",
        )
        self.session.frame_callback = self._send_frame
        self.session.status_callback = self._send_status
        self._started = False

    async def _ensure_started(self, url: str):
        """延迟启动 Chromium（首次 navigate 时调用）"""
        if self._started:
            return
        self._started = True
        self.session.target_url = url
        await self.session.start()
        logger.info("Chromium session started for: %s", url)

    async def _send_frame(self, frame):
        """发送 PaintOp 帧到客户端"""
        if not self.ws.closed:
            try:
                await self.ws.send_bytes(frame.encode())
            except ConnectionResetError:
                logger.warning("Client disconnected during frame send")

    async def _send_status(self, msg: dict):
        """发送状态更新到客户端"""
        if not self.ws.closed:
            try:
                await self.ws.send_str(json.dumps(msg))
            except ConnectionResetError:
                pass

    async def stop(self):
        await self.session.stop()

    async def handle_message(self, msg: aiohttp.WSMessage):
        """处理来自客户端的消息"""
        if msg.type == WSMsgType.BINARY:
            await self._handle_binary(msg.data)

        elif msg.type == WSMsgType.TEXT:
            await self._handle_text(msg.data)

    async def _handle_binary(self, data: bytes):
        """处理二进制 HID 事件（仅在会话已启动后生效）"""
        if not self._started:
            return
        try:
            hid_type, payload = decode_hid(data)
        except Exception:
            logger.warning("Failed to decode HID event: %r", data[:50])
            return

        if hid_type in (HIDType.MOUSE_MOVE, HIDType.MOUSE_DOWN, HIDType.MOUSE_UP, HIDType.MOUSE_WHEEL):
            action = {
                HIDType.MOUSE_MOVE: "mousemove",
                HIDType.MOUSE_DOWN: "mousedown",
                HIDType.MOUSE_UP: "mouseup",
                HIDType.MOUSE_WHEEL: "wheel",
            }[hid_type]
            await self.session.inject_mouse(
                event_type=action,
                x=payload.get("x", 0),
                y=payload.get("y", 0),
                button=payload.get("button", "left"),
                delta_x=payload.get("deltaX", 0),
                delta_y=payload.get("deltaY", 0),
            )

        elif hid_type in (HIDType.KEY_DOWN, HIDType.KEY_UP):
            await self.session.inject_key(
                event_type="keydown" if hid_type == HIDType.KEY_DOWN else "keyup",
                key=payload.get("key", ""),
                code=payload.get("code", ""),
            )

    async def _handle_text(self, text: str):
        """处理文本控制消息"""
        try:
            msg = json.loads(text)
        except json.JSONDecodeError:
            return

        msg_type = msg.get("type", "")

        if msg_type == "navigate":
            url = msg.get("url", "")
            if url:
                if not self._started:
                    # 首次 navigate → 启动 Chromium + 导航
                    await self._ensure_started(url)
                else:
                    await self.session.navigate(url)

        elif msg_type == "resize":
            width = msg.get("width", 1280)
            height = msg.get("height", 720)
            if self._started:
                await self.session.resize(width, height)

        elif msg_type == "text":
            if self._started:
                await self.session.inject_text(msg.get("value", ""))

        elif msg_type == "ping":
            if not self.ws.closed:
                await self.ws.send_str(encode_control("pong"))

        elif msg_type == "scroll":
            if self._started:
                await self.session.inject_mouse(
                    event_type="wheel",
                    x=msg.get("x", 0),
                    y=msg.get("y", 0),
                    delta_x=msg.get("deltaX", 0),
                    delta_y=msg.get("deltaY", 0),
                )


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    """WebSocket /ws 端点"""
    ws = web.WebSocketResponse(max_msg_size=10 * 1024 * 1024)  # 10MB
    await ws.prepare(request)

    handler = SessionHandler(ws)
    # 不自动启动 Chromium——等待客户端发送 navigate 指令

    logger.info("WebSocket connected, awaiting session start: %s", request.remote)

    try:
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                logger.error("WebSocket error: %s", ws.exception())
                break
            await handler.handle_message(msg)
    finally:
        await handler.stop()
        logger.info("WebSocket session ended: %s", request.remote)

    return ws


async def health_handler(request: web.Request) -> web.Response:
    """健康检查"""
    return web.json_response(
        {
            "status": "ok",
            "version": "0.1.0",
            "protocol_version": 1,
        }
    )


def create_app() -> web.Application:
    app = web.Application(client_max_size=10 * 1024 * 1024)

    # 静态文件: 客户端 HTML/JS
    if CLIENT_DIR.exists():
        app.router.add_static("/", CLIENT_DIR, show_index=True)
    else:
        logger.warning("Client directory not found: %s", CLIENT_DIR)

    # API 路由
    app.router.add_get("/ws", websocket_handler)
    app.router.add_get("/health", health_handler)

    return app


def main():
    parser = argparse.ArgumentParser(description="PaintOp Remote Browser Server")
    parser.add_argument("--port", type=int, default=8080, help="HTTP/WS port")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Bind address")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    app = create_app()
    logger.info("PaintOp server starting on %s:%d", args.host, args.port)
    web.run_app(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
