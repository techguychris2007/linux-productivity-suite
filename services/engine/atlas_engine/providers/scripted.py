"""Deterministic provider for automated tests. Never offered to end users."""

from __future__ import annotations

from typing import Callable

from .base import AssistantTurn


class ScriptedProvider:
    id = "scripted"
    model = "scripted"
    remote = False

    def __init__(self, script: list[AssistantTurn | Callable[[list[dict]], AssistantTurn]]) -> None:
        self.script = list(script)
        self.calls: list[dict] = []

    def complete(self, system: str, messages: list[dict], tools: list[dict], max_tokens: int = 4096) -> AssistantTurn:
        self.calls.append({"system": system, "messages": [dict(m) for m in messages], "tools": tools})
        if not self.script:
            return AssistantTurn("(script exhausted)")
        step = self.script.pop(0)
        return step(messages) if callable(step) else step
