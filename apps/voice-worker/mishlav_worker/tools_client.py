"""HTTP client for the Part 1 tools server (apps/backend). Every request carries the shared secret."""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger("mishlav.tools")

# Said by the bot when the tools server can't be reached (same wording style as the server's errors).
UNAVAILABLE = {"ok": False, "error": "tools_unavailable", "message_he": "תקלה זמנית. הציעי שנציג יחזור."}


class ToolsClient:
    def __init__(self, base_url: str, secret: str, provider: str, call_id: str, timeout_s: float = 8.0) -> None:
        if len(secret) < 16:
            raise ValueError("TOOLS_SECRET must be at least 16 characters (same as the server)")
        self.provider = provider
        self.call_id = call_id
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=timeout_s,
            headers={"X-Tools-Secret": secret, "X-Provider": provider, "X-Call-Id": call_id},
        )

    async def call_tool(self, name: str, params: dict[str, Any]) -> dict[str, Any]:
        try:
            r = await self._http.post(f"/tools/{name}", json=params)
        except httpx.HTTPError as e:
            log.error("tool %s: request failed: %s", name, e)
            return UNAVAILABLE
        if r.status_code == 401:
            log.error("tool %s: 401 — TOOLS_SECRET does not match the server", name)
            return UNAVAILABLE
        try:
            body = r.json()
        except ValueError:
            log.error("tool %s: HTTP %s, non-JSON body", name, r.status_code)
            return UNAVAILABLE
        return body if isinstance(body, dict) else UNAVAILABLE

    async def current_session(self) -> dict[str, Any] | None:
        """The active test session (`npm run session -- start ...`), or None."""
        try:
            r = await self._http.get("/test/session")
            r.raise_for_status()
            return r.json().get("session")
        except (httpx.HTTPError, ValueError) as e:
            log.warning("could not read the active test session: %s", e)
            return None

    async def call_context(self, scenario_id: str | None) -> dict[str, str] | None:
        """Prompt variables for this call (GET /test/context), or None if the server can't give them."""
        try:
            r = await self._http.get("/test/context", params={"scenario": scenario_id} if scenario_id else None)
            r.raise_for_status()
            variables = r.json().get("variables")
            return variables if isinstance(variables, dict) else None
        except (httpx.HTTPError, ValueError) as e:
            log.warning("could not read the call context: %s", e)
            return None

    async def post_metrics(self, payload: dict[str, Any]) -> None:
        try:
            r = await self._http.post("/test/metrics", json=payload)
            if r.status_code >= 400:
                log.warning("metrics rejected: HTTP %s %s", r.status_code, r.text[:300])
        except httpx.HTTPError as e:
            log.warning("could not post metrics: %s", e)

    async def aclose(self) -> None:
        await self._http.aclose()
