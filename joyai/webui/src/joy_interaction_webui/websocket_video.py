"""JPEG camera frames carried by the same WebSocket as session controls."""

import asyncio
import io
import time
from fractions import Fraction

import av
from aiortc import VideoStreamTrack
from PIL import Image

from .video_processor import VideoProcessorTrack

MAX_JPEG_BYTES = 1024 * 1024
MAX_FRAME_PIXELS = 1920 * 1080


def decode_jpeg(payload):
    if not payload or len(payload) > MAX_JPEG_BYTES:
        raise ValueError("Camera frame must be a JPEG smaller than 1 MB")
    with Image.open(io.BytesIO(payload)) as image:
        if image.format != "JPEG" or image.width * image.height > MAX_FRAME_PIXELS:
            raise ValueError("Camera frame must be JPEG and at most 1920×1080 pixels")
        image.load()
        return av.VideoFrame.from_image(image.convert("RGB"))


class WebSocketVideoTrack(VideoStreamTrack):
    def __init__(self):
        super().__init__()
        self.frames = asyncio.Queue(maxsize=1)
        self.started = time.monotonic()

    async def recv(self):
        return await self.frames.get()


class WebSocketVideoProcessor:
    def __init__(self, service, callback, background_service=None):
        self.source = WebSocketVideoTrack()
        self.processor = VideoProcessorTrack(
            self.source, service, callback, background_service
        )

    async def receive(self, payload):
        frame = await asyncio.to_thread(decode_jpeg, payload)
        frame.pts = round((time.monotonic() - self.source.started) * 1000)
        frame.time_base = Fraction(1, 1000)
        self.source.frames.put_nowait(frame)
        await self.processor.recv()
        return self.processor.frame_count

    def close(self):
        self.source.stop()
        self.processor.stop()
