import asyncio
import io
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

from joy_interaction_webui import server
from joy_interaction_webui.websocket_video import decode_jpeg


def jpeg(size=(64, 48)):
    stream = io.BytesIO()
    Image.new("RGB", size, "red").save(stream, format="JPEG")
    return stream.getvalue()


class FakeService:
    model = "test"
    api_base = "http://unused"
    prompt = None
    system_prompt_key = "test"

    def __init__(self):
        self.frames = []
        self.tasks = set()
        self.finish = asyncio.Event()
        self.response = ""
        self.count = 0

    def system_prompt_options(self):
        return []

    def update_prompt(self, prompt):
        self.prompt = prompt

    async def process_frame(self, image, **kwargs):
        task = asyncio.current_task()
        self.tasks.add(task)
        try:
            self.frames.append((image.size, kwargs))
            await self.finish.wait()
            self.response = "red image"
            self.count += 1
        finally:
            self.tasks.discard(task)

    def get_current_response(self):
        return self.response, bool(self.tasks)

    def get_metrics(self):
        return {"total_inferences": self.count}

    def consume_background_handoff_metric(self):
        return None

    async def cancel_active_requests(self):
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


class WebSocketVideoTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.services = {}
        self.responses = []

        def session(sid):
            if sid not in self.services:
                self.services[sid] = FakeService()
            state = {"vlm_service": self.services[sid], "background_service": None}
            server.sessions[sid] = state
            return state

        self.patches = [
            patch.object(server, "get_or_create_session", session),
            patch.object(server, "get_session_callback", lambda sid: lambda text, metrics: self.responses.append((sid, text))),
        ]
        for item in self.patches:
            item.start()
        app = web.Application()
        app.router.add_get("/ws", server.websocket_handler)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        for svc in self.services.values():
            await svc.cancel_active_requests()
        for item in self.patches:
            item.stop()
        server.sessions.clear()

    async def connect(self, sid):
        ws = await self.client.ws_connect("/ws?session_id=" + sid)
        self.assertEqual((await ws.receive_json())["type"], "status")
        self.assertEqual((await ws.receive_json())["type"], "server_config")
        return ws

    async def test_frames_controls_results_and_isolation(self):
        ws = await self.connect("camera")
        other = await self.connect("other")
        await ws.send_bytes(jpeg())
        self.assertEqual((await ws.receive_json())["frames_received"], 1)
        await ws.send_json({"type": "update_prompt", "prompt": "what color?"})
        self.assertEqual((await ws.receive_json())["type"], "prompt_updated")
        svc = self.services["camera"]
        self.assertEqual(svc.prompt, "what color?")
        self.assertEqual(svc.frames[0][0], (64, 48))
        self.assertEqual(svc.frames[0][1]["frame_metadata"]["timestamp_kind"], "relative_seconds")
        self.assertEqual(self.services["other"].frames, [])
        svc.finish.set()
        await asyncio.sleep(0.01)
        await ws.send_bytes(jpeg())
        self.assertEqual((await ws.receive_json())["frames_received"], 2)
        self.assertIn(("camera", "red image"), self.responses)
        await other.close()

    async def test_bad_frame_then_valid_frame(self):
        ws = await self.connect("invalid")
        await ws.send_bytes(b"not a jpeg")
        self.assertEqual((await ws.receive_json())["type"], "frame_error")
        await ws.send_bytes(jpeg())
        self.assertEqual((await ws.receive_json())["type"], "frame_ack")

    async def test_disconnect_cancels_inference(self):
        ws = await self.connect("disconnect")
        await ws.send_bytes(jpeg())
        await ws.receive_json()
        svc = self.services["disconnect"]
        self.assertTrue(svc.tasks)
        await ws.close()
        for _ in range(20):
            if not svc.tasks:
                break
            await asyncio.sleep(0.01)
        self.assertFalse(svc.tasks)

    def test_image_limits(self):
        with self.assertRaises(ValueError):
            decode_jpeg(b"x" * (1024 * 1024 + 1))
        with self.assertRaises(ValueError):
            decode_jpeg(jpeg((2000, 2000)))


if __name__ == "__main__":
    unittest.main()
