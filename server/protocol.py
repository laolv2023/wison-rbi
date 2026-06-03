"""
PaintOp Binary Protocol — 编解码器

帧格式 (S→C):
  [Magic:2][Version:1][Type:1][TileCount:2][TileEntry*N][TileData*N]
  
  TileEntry (14 bytes):
    [X:2][Y:2][W:2][H:2][Encoding:2][DataLen:4]

HID 事件 (C→S):
  [Type:1][Payload:JSON]

控制消息: WebSocket Text 帧, JSON
"""

import struct
import json
from dataclasses import dataclass
from enum import IntEnum
from typing import List

MAGIC = b"PS"
VERSION = 0x01


class FrameType(IntEnum):
    KEYFRAME = 0x01  # 全量帧
    DIFF = 0x02  # 增量帧（仅脏 tile）


class TileEncoding(IntEnum):
    JPEG = 0x01
    PNG = 0x02


class HIDType(IntEnum):
    MOUSE_MOVE = 0x10
    MOUSE_DOWN = 0x11
    MOUSE_UP = 0x12
    MOUSE_WHEEL = 0x13
    KEY_DOWN = 0x14
    KEY_UP = 0x15


@dataclass
class Tile:
    x: int
    y: int
    w: int
    h: int
    encoding: TileEncoding
    data: bytes

    @property
    def data_len(self) -> int:
        return len(self.data)


@dataclass
class PaintOpFrame:
    frame_type: FrameType
    tiles: List[Tile]

    def encode(self) -> bytes:
        """编码为二进制帧"""
        buf = bytearray()
        buf.extend(MAGIC)  # 2 bytes
        buf.append(VERSION)  # 1 byte
        buf.append(self.frame_type)  # 1 byte
        buf.extend(struct.pack(">H", len(self.tiles)))  # 2 bytes

        for tile in self.tiles:
            buf.extend(
                struct.pack(
                    ">HHHHHI",
                    tile.x,
                    tile.y,
                    tile.w,
                    tile.h,
                    tile.encoding,
                    tile.data_len,
                )
            )

        for tile in self.tiles:
            buf.extend(tile.data)

        return bytes(buf)

    @classmethod
    def decode(cls, data: bytes) -> "PaintOpFrame":
        """解码二进制帧"""
        offset = 0

        magic = data[offset : offset + 2]
        if magic != MAGIC:
            raise ValueError(f"Invalid magic: {magic!r}")
        offset += 2

        version = data[offset]
        if version != VERSION:
            raise ValueError(f"Unsupported version: {version}")
        offset += 1

        frame_type = FrameType(data[offset])
        offset += 1

        tile_count = struct.unpack_from(">H", data, offset)[0]
        offset += 2

        tiles = []
        for _ in range(tile_count):
            x, y, w, h, enc, data_len = struct.unpack_from(">HHHHHI", data, offset)
            offset += 14  # TileEntry size
            tiles.append(
                {
                    "x": x,
                    "y": y,
                    "w": w,
                    "h": h,
                    "encoding": TileEncoding(enc),
                    "data_len": data_len,
                }
            )

        for tile in tiles:
            tile["data"] = data[offset : offset + tile["data_len"]]
            offset += tile["data_len"]

        return cls(
            frame_type=frame_type,
            tiles=[
                Tile(
                    x=t["x"],
                    y=t["y"],
                    w=t["w"],
                    h=t["h"],
                    encoding=t["encoding"],
                    data=t["data"],
                )
                for t in tiles
            ],
        )


def encode_hid(hid_type: HIDType, payload: dict) -> bytes:
    """编码 HID 事件"""
    body = json.dumps(payload).encode("utf-8")
    return struct.pack(">B", hid_type) + body


def decode_hid(data: bytes) -> tuple[HIDType, dict]:
    """解码 HID 事件"""
    hid_type = HIDType(data[0])
    payload = json.loads(data[1:].decode("utf-8"))
    return hid_type, payload


def encode_control(msg_type: str, **kwargs) -> str:
    """编码控制消息 (JSON)"""
    return json.dumps({"type": msg_type, **kwargs})


def decode_control(text: str) -> dict:
    """解码控制消息"""
    return json.loads(text)
