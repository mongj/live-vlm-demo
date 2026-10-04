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
    gateway.app.add_middleware(PrivacyGate)
    gateway.main()


if __name__ == "__main__":
    main()
