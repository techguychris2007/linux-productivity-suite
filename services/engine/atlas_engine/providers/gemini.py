"""Google Gemini API provider (free tier via a free Google AI Studio key — the default for Atlas).

Notes (verified Nov 2026, re-check periodically):
- The free tier covers Flash / Flash-Lite models only; limits are per project and low, so 429s are expected.
- On the free tier, content sent may be used by Google to improve its products. Atlas shows this
  in the privacy indicator before any request is sent.
- Model names change frequently, so the model is discovered via the models endpoint instead of hard-coded.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any

from .base import AssistantTurn, ProviderError, ToolCall, Transport

BASE = "https://generativelanguage.googleapis.com/v1beta"

# JSON-schema keywords Gemini's function declarations accept (an OpenAPI subset).
_ALLOWED_SCHEMA_KEYS = {"type", "description", "properties", "required", "items", "enum", "minimum", "maximum",
                        "minItems", "maxItems", "minLength", "maxLength", "nullable", "format"}


def _clean_schema(s: Any) -> Any:
    if isinstance(s, dict):
        out = {k: _clean_schema(v) for k, v in s.items() if k in _ALLOWED_SCHEMA_KEYS}
        if isinstance(out.get("type"), list):  # Gemini takes one type: use the first non-null one, nullable if null was allowed
            types = out["type"]
            out["type"] = next((t for t in types if t != "null"), "string")
            if "null" in types:
                out["nullable"] = True
        if "properties" in s:
            out["properties"] = {k: _clean_schema(v) for k, v in s["properties"].items()}
            if not out["properties"]:
                del out["properties"]  # empty objects are rejected by some API versions
        return out
    if isinstance(s, list):
        return [_clean_schema(x) for x in s]
    return s


class GeminiTransportError(ProviderError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def gemini_http(url: str, headers: dict[str, str], body: dict[str, Any] | None, timeout: float = 120.0) -> dict[str, Any]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if body is not None else "GET",
                                 headers={"content-type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        raise GeminiTransportError(f"Gemini returned HTTP {e.code}: {detail}", e.code) from e
    except urllib.error.URLError as e:
        raise GeminiTransportError(f"cannot reach Gemini: {e.reason}") from e


class GeminiProvider:
    id = "gemini"
    remote = True

    def __init__(self, api_key: str, model: str | None = None, transport: Transport | None = None,
                 max_retries: int = 3, sleep=time.sleep) -> None:
        if not api_key:
            raise ProviderError("A free Gemini API key is required (create one at Google AI Studio).")
        self.api_key = api_key
        self._t = transport or gemini_http
        self._sleep = sleep
        self.max_retries = max_retries
        self.model = model or self.pick_default_model()

    # ---------- models ----------
    def list_models(self) -> list[dict]:
        resp = self._t(f"{BASE}/models?pageSize=200", {"x-goog-api-key": self.api_key}, None, 30.0)
        models = []
        for m in resp.get("models", []):
            if "generateContent" in m.get("supportedGenerationMethods", []):
                models.append({"id": m["name"].removeprefix("models/"), "label": m.get("displayName", m["name"]),
                               "input_token_limit": m.get("inputTokenLimit")})
        return models

    def pick_default_model(self) -> str:
        """Prefer a stable Flash model (free tier) over preview/experimental/lite/pro variants."""
        models = [m["id"] for m in self.list_models()]
        if not models:
            raise ProviderError("No Gemini models are available for this API key.")

        def rank(mid: str) -> tuple:
            unstable = any(x in mid for x in ("preview", "exp", "tts", "image", "live", "embedding", "audio"))
            return (unstable, "flash" not in mid, "lite" in mid, "pro" in mid, -_version(mid))
        return sorted(models, key=rank)[0]

    # ---------- message conversion ----------
    @staticmethod
    def to_contents(messages: list[dict]) -> list[dict]:
        names: dict[str, str] = {}  # tool_use_id -> tool name (functionResponse needs the name)
        contents = []
        for m in messages:
            parts = []
            for b in m["content"]:
                if b["type"] == "text" and b["text"]:
                    parts.append({"text": b["text"]})
                elif b["type"] == "tool_use":
                    names[b["id"]] = b["name"]
                    parts.append({"functionCall": {"name": b["name"], "args": b["input"]}})
                elif b["type"] == "tool_result":
                    key = "error" if b.get("is_error") else "result"
                    parts.append({"functionResponse": {"name": names.get(b["tool_use_id"], "unknown"),
                                                       "response": {key: b["content"]}}})
            if parts:
                contents.append({"role": "model" if m["role"] == "assistant" else "user", "parts": parts})
        return contents

    def build_request(self, system: str, messages: list[dict], tools: list[dict], max_tokens: int) -> dict:
        body: dict = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": self.to_contents(messages),
            "generationConfig": {"maxOutputTokens": max_tokens, "temperature": 0.3},
        }
        if tools:
            # Gemini function names must match [A-Za-z_][A-Za-z0-9_.-]* — Atlas names ("drive.list") comply.
            body["tools"] = [{"functionDeclarations": [
                {"name": t["name"], "description": t["description"], "parameters": _clean_schema(t["input_schema"])}
                for t in tools]}]
        return body

    def complete(self, system: str, messages: list[dict], tools: list[dict], max_tokens: int = 4096) -> AssistantTurn:
        url = f"{BASE}/models/{self.model}:generateContent"
        body = self.build_request(system, messages, tools, max_tokens)
        delay = 2.0
        for attempt in range(self.max_retries + 1):
            try:
                resp = self._t(url, {"x-goog-api-key": self.api_key}, body, 300.0)
                break
            except GeminiTransportError as e:
                if e.status in (429, 500, 503) and attempt < self.max_retries:
                    self._sleep(delay)
                    delay *= 2
                    continue
                if e.status == 429:
                    raise ProviderError("Gemini free-tier rate limit reached. Wait a minute and try again, "
                                        "or choose a lighter model in Settings.") from e
                raise
        cands = resp.get("candidates") or []
        if not cands:
            reason = (resp.get("promptFeedback") or {}).get("blockReason", "no candidates returned")
            raise ProviderError(f"Gemini returned no answer ({reason}).")
        parts = (cands[0].get("content") or {}).get("parts") or []
        text, calls = [], []
        for i, p in enumerate(parts):
            if "text" in p and not p.get("thought"):
                text.append(p["text"])
            elif "functionCall" in p:
                fc = p["functionCall"]
                calls.append(ToolCall(fc.get("id") or f"call_{int(time.time()*1000)}_{i}", fc["name"], fc.get("args") or {}))
        finish = cands[0].get("finishReason", "STOP")
        stop = "tool_use" if calls else ("max_tokens" if finish == "MAX_TOKENS" else "end_turn")
        return AssistantTurn("".join(text), calls, stop)


def _version(mid: str) -> float:
    import re
    m = re.search(r"(\d+(?:\.\d+)?)", mid)
    return float(m.group(1)) if m else 0.0
