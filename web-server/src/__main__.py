from __future__ import annotations

import logging
import sys

import uvicorn

from .catalog import CatalogError
from .main import create_app, resolve_runtime_settings


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    try:
        host, port, config_path = resolve_runtime_settings()
        app = create_app(config_path)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(2) from exc
    except CatalogError as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(2) from exc
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
