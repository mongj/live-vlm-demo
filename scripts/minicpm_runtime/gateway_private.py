"""Expose only the pinned runtime's health/status and video WebSocket routes."""
import os
from pathlib import Path
import sys

import prepare
from safety import PrivacyGate


def main():
    config = prepare.check(os.environ["MINICPM_RUNTIME_ROOT"])
    source = Path(config["source"])
    os.chdir(source)
    sys.path.insert(0, str(source))
    import gateway
    speech = config.get("speech")
    if speech:
        from speech_routes import install, speech_socket
        install(gateway.app, socket_path=speech_socket(config["root"], os.environ["PBS_JOBID"]), token_file=Path(speech["token_file"]))
    gateway.app.add_middleware(PrivacyGate, speech_enabled=bool(speech))
    gateway.main()


if __name__ == "__main__":
    main()
