from __future__ import annotations

import os
from typing import Any, ClassVar

import httpx

from .joyai import JOYAI_TURN_TIMEOUT_SECONDS, JoyAIAdapter
from ..types import SessionError

TOKEN_ID_ENV = "JOYAI_MODAL_TOKEN_ID"
TOKEN_SECRET_ENV = "JOYAI_MODAL_TOKEN_SECRET"


class JoyAIModalAdapter(JoyAIAdapter):
    """JoyAI webinfer deployed by `make joyai-modal`, behind Modal proxy-token auth."""

    unavailable_message: ClassVar[str] = (
        "JoyAI (Modal) is starting (a cold start takes several minutes) or is not "
        "deployed. Retry shortly, or run `make joyai-modal` to deploy and wait until it is ready"
    )

    def _client_kwargs(self) -> dict[str, Any]:
        token_id = os.environ.get(TOKEN_ID_ENV, "").strip()
        token_secret = os.environ.get(TOKEN_SECRET_ENV, "").strip()
        if not token_id or not token_secret:
            raise SessionError(
                f"JoyAI (Modal) needs {TOKEN_ID_ENV} and {TOKEN_SECRET_ENV}; "
                "run `make joyai-modal` and restart the gateway",
                fatal=True,
            )
        return {
            **super()._client_kwargs(),
            "headers": {"Modal-Key": token_id, "Modal-Secret": token_secret},
            # The model is reached over the Internet rather than a local tunnel.
            "timeout": httpx.Timeout(JOYAI_TURN_TIMEOUT_SECONDS, connect=15.0),
        }
