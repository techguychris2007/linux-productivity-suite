"""Anthropic Messages API provider (cloud; data leaves the computer)."""

from __future__ import annotations

from .base import AssistantTurn, ProviderError, ToolCall, Transport, http_json


class AnthropicProvider:
    id = "anthropic"
    remote = True

    def __init__(self, api_key: str, model: str = "claude-sonnet-5-5",
                 base_url: str = "https://api.anthropic.com", transport: Transport = http_json) -> None:
        if not api_key:
            raise ProviderError("an Anthropic API key is required")
        self.api_key, self.model, self.base_url, self._t = api_key, model, base_url.rstrip("/"), transport

    def build_request(self, system: str, messages: list[dict], tools: list[dict], max_tokens: int) -> dict:
        body = {"model": self.model, "max_tokens": max_tokens, "system": system, "messages": messages}
        if tools:
            body["tools"] = tools
        return body

    def complete(self, system: str, messages: list[dict], tools: list[dict], max_tokens: int = 4096) -> AssistantTurn:
        resp = self._t(f"{self.base_url}/v1/messages",
                       {"x-api-key": self.api_key, "anthropic-version": "2023-06-01"},
                       self.build_request(system, messages, tools, max_tokens), 300.0)
        if resp.get("type") == "error":
            raise ProviderError(resp.get("error", {}).get("message", "provider error"))
        text, calls = [], []
        for b in resp.get("content", []):
            if b.get("type") == "text":
                text.append(b.get("text", ""))
            elif b.get("type") == "tool_use":
                calls.append(ToolCall(b["id"], b["name"], b.get("input") or {}))
        return AssistantTurn("".join(text), calls, resp.get("stop_reason", "end_turn"))
