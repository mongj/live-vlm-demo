"""Send a synthetic camera image through the deployed WebUI and real model."""

import asyncio
import io
import json
import uuid

import aiohttp
from PIL import Image


async def main():
    sid = "ws-smoke-" + str(uuid.uuid4())
    payload = io.BytesIO()
    Image.new("RGB", (320, 240), "red").save(payload, format="JPEG")
    base = "https://127.0.0.1:8099"
    async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=False)) as client:
        try:
            async with client.ws_connect(base + "/ws?session_id=" + sid) as ws:
                await ws.send_json({"type": "update_prompt", "prompt": "What color is this image? Answer briefly."})

                async def send_frames():
                    for _ in range(90):
                        await ws.send_bytes(payload.getvalue())
                        await asyncio.sleep(1)

                sender = asyncio.create_task(send_frames())
                try:
                    async with asyncio.timeout(90):
                        async for msg in ws:
                            if msg.type != aiohttp.WSMsgType.TEXT:
                                continue
                            data = json.loads(msg.data)
                            if data.get("type") == "frame_error":
                                raise RuntimeError(data)
                            if data.get("type") == "frame_ack" and data.get("frames_received") == 1:
                                print("First JPEG frame acknowledged", flush=True)
                            if data.get("type") == "vlm_response" and data.get("text", "").strip():
                                print("Model response:", data["text"], flush=True)
                                assert "red" in data["text"].lower(), data
                                print("WEBSOCKET_INFERENCE_PASSED", flush=True)
                                return
                finally:
                    sender.cancel()
                    await asyncio.gather(sender, return_exceptions=True)
        finally:
            async with client.post(base + "/api/session/cleanup", json={"session_id": sid}) as response:
                print("Test session cleanup:", response.status, flush=True)
    raise RuntimeError("WebSocket closed before a model response")


asyncio.run(main())
