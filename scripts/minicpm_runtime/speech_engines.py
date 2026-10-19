"""Offline CPU speech. Audio/text stay in memory; assets are provisioned explicitly."""
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import stat


class SpeechFailure(Exception):
    """Only fixed, content-free error codes cross a process or HTTP boundary."""


def validate_text(text):
    if not isinstance(text, str) or not text.strip() or len(text) > 500 or any(0xD800 <= ord(c) <= 0xDFFF for c in text):
        raise SpeechFailure("invalid")


def validate_pcm(pcm, seconds):
    if not isinstance(pcm, bytes) or not pcm or len(pcm) % 2:
        raise SpeechFailure("invalid")
    if len(pcm) > seconds * 32000:
        raise SpeechFailure("too_long")


def verify_assets(root):
    root = Path(root)
    try:
        if not root.is_absolute() or root.resolve() != root:
            raise ValueError()
        files = json.loads(Path(__file__).with_name("speech-assets.json").read_text())["files"]
        checksums = {}
        for name, expected in files.items():
            path = root / name
            info = path.lstat()
            if path.resolve() != path or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022:
                raise ValueError()
            sha = hashlib.sha256()
            blob = hashlib.sha1(f"blob {info.st_size}\0".encode())
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    sha.update(chunk)
                    blob.update(chunk)
            if expected.get("sha256", sha.hexdigest()) != sha.hexdigest() or expected.get("git_blob", blob.hexdigest()) != blob.hexdigest():
                raise ValueError()
            checksums[name] = sha.hexdigest()
        return checksums
    except (OSError, ValueError, KeyError):
        raise SpeechFailure("unavailable") from None


def collect_synthesis(chunks):
    import numpy as np
    result = bytearray()
    for chunk in chunks:
        samples = np.asarray(chunk.audio_float_array)
        if chunk.sample_channels != 1 or samples.ndim != 1 or not np.isfinite(samples).all():
            raise SpeechFailure("invalid")
        rate = chunk.sample_rate
        if rate <= 0 or len(samples) / rate > 30:
            raise SpeechFailure("too_long")
        if rate != 16000:
            from scipy.signal import resample_poly
            divisor = math.gcd(rate, 16000)
            samples = resample_poly(samples, 16000 // divisor, rate // divisor)
        if len(result) + samples.size * 2 > 960000:
            raise SpeechFailure("too_long")
        result.extend(np.clip(np.rint(samples * 32767), -32768, 32767).astype("<i2").tobytes())
    validate_pcm(bytes(result), 30)
    return bytes(result)


class SpeechEngines:
    def __init__(self, asset_root):
        root = Path(asset_root)
        verify_assets(root)  # Includes tokenizer: missing tokenizer must never trigger remote fallback.
        os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", CUDA_VISIBLE_DEVICES="",
                          OMP_NUM_THREADS="2", OPENBLAS_NUM_THREADS="2", MKL_NUM_THREADS="2")
        # Engines can log input text/phonemes, including at DEBUG; do not attach content logs.
        for name in ("piper", "piper.voice", "faster_whisper", "faster_whisper.transcribe"):
            logger = logging.getLogger(name)
            logger.disabled = True
            logger.propagate = False
        import onnxruntime as ort
        ort.disable_telemetry_events()
        from faster_whisper import WhisperModel
        from piper import PiperVoice
        from piper.config import PiperConfig
        self.asr = WhisperModel(str(root / "asr"), device="cpu", compute_type="int8",
                                cpu_threads=2, num_workers=1, local_files_only=True)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        options.log_severity_level = 4
        config = PiperConfig.from_dict(json.loads((root / "voice/en_US-ljspeech-medium.onnx.json").read_text()))
        if config.espeak_voice != "en":
            raise SpeechFailure("unavailable")
        self.voice = PiperVoice(session=ort.InferenceSession(str(root / "voice/en_US-ljspeech-medium.onnx"),
                                sess_options=options, providers=["CPUExecutionProvider"]),
                                config=config, use_tashkeel=False)

    def transcribe(self, pcm_s16le):
        validate_pcm(pcm_s16le, 15)
        import numpy as np
        audio = np.frombuffer(pcm_s16le, dtype="<i2").astype(np.float32) / 32768
        if np.sqrt(np.mean(audio ** 2)) < .005:
            return ""
        segments, _ = self.asr.transcribe(audio, language="en", vad_filter=True,
                                        condition_on_previous_text=False, beam_size=1)
        return " ".join(segment.text.strip() for segment in segments).strip()[:4000]

    def synthesize(self, text):
        validate_text(text)
        return collect_synthesis(self.voice.synthesize(text))
