This workspace copy of the JoyAI WebUI is launched by `../../scripts/joyai.pbs`
through `make joyai` from the repository root.
The original source was copied from
`/home/mingjun/JoyAI-VL-Interaction/services/webui`.

Webcam mode sends JPEG images as binary messages on the session's `/ws`
connection. The browser keeps its local video preview, limits images to
1280×720, and waits for `frame_ack` before sending another image. Sampling
and inference use the existing `VideoProcessorTrack` path. WebRTC remains
in use for RTSP mode.

Only HTTPS port 8099 needs forwarding for webcam mode:

```bash
ssh -N -L 8099:cvml10:8099 cvml-cluster
```

Open https://127.0.0.1:8099 and reload the page after updating this code.

Run the transport tests from the parent `joyai` directory:

```bash
PYTHONPATH=webui/src /home/mingjun/.conda/envs/joyai-py312-cu129/bin/python -m unittest discover -s tests -v
node tests/test_camera_upload.cjs
```
