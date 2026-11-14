"""LLM provider interface.

Internal message format (provider-neutral):
  {"role": "user" | "assistant", "content": [block, ...]}
  block = {"type": "text", "text": str}
        | {"type": "tool_use", "id": str, "name": str, "input": dict}
        | {"type": "tool_result", "tool_use_id": str, "content": str, "is_error": bool}
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

Transport = Callable[[str, dict[str, str], dict[str, Any], float], dict[str, Any]]


@dataclass
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]


@dataclass
class AssistantTurn:
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    stop_reason: str = "end_turn"

    def to_message(self) -> dict:
        blocks: list[dict] = []
        if self.text:
            blocks.append({"type": "text", "text": self.text})
        for c in self.tool_calls:
            blocks.append({"type": "tool_use", "id": c.id, "name": c.name, "input": c.input})
        return {"role": "assistant", "content": blocks}


class ProviderError(Exception):
    pass


class LLMProvider(Protocol):
    id: str
    model: str
    # True when requests leave this computer; shown to the user before any data is sent.
    remote: bool

    def complete(self, system: str, messages: list[dict], tools: list[dict], max_tokens: int = 4096) -> AssistantTurn: ...


def http_json(url: str, headers: dict[str, str], body: dict[str, Any], timeout: float = 120.0) -> dict[str, Any]:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        raise ProviderError(f"HTTP {e.code} from provider: {detail}") from e
    except urllib.error.URLError as e:
        raise ProviderError(f"cannot reach provider: {e.reason}") from e
