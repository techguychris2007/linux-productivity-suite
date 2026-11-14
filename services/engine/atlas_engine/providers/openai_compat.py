"""OpenAI-compatible Chat Completions provider.

Covers hosted services and local servers that expose `/v1/chat/completions`
(llama.cpp server, vLLM, LM Studio, Ollama's OpenAI endpoint — verify per server).
`remote` is derived from the base URL so local servers are not flagged as data leaving the machine.
"""

from __future__ import annotations

import json
from urllib.parse import urlparse

from .base import AssistantTurn, ProviderError, ToolCall, Transport, http_json

_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


class OpenAICompatProvider:
    id = "openai_compat"

    def __init__(self, base_url: str, model: str, api_key: str = "", transport: Transport = http_json) -> None:
        if not base_url or not model:
            raise ProviderError("base_url and model are required")
        self.base_url, self.model, self.api_key, self._t = base_url.rstrip("/"), model, api_key, transport
        self.remote = urlparse(self.base_url).hostname not in _LOCAL_HOSTS

    @staticmethod
    def to_openai_messages(system: str, messages: list[dict]) -> list[dict]:
        out: list[dict] = [{"role": "system", "content": system}]
        for m in messages:
            texts = [b["text"] for b in m["content"] if b["type"] == "text"]
            if m["role"] == "assistant":
                msg: dict = {"role": "assistant", "content": "\n".join(texts) or None}
                calls = [b for b in m["content"] if b["type"] == "tool_use"]
                if calls:
                    msg["tool_calls"] = [{"id": c["id"], "type": "function",
                                          "function": {"name": c["name"], "arguments": json.dumps(c["input"])}} for c in calls]
                out.append(msg)
            else:
                for b in m["content"]:
                    if b["type"] == "tool_result":
                        out.append({"role": "tool", "tool_call_id": b["tool_use_id"], "content": b["content"]})
                if texts:
                    out.append({"role": "user", "content": "\n".join(texts)})
        return out

    def complete(self, system: str, messages: list[dict], tools: list[dict], max_tokens: int = 4096) -> AssistantTurn:
        body: dict = {"model": self.model, "max_tokens": max_tokens, "messages": self.to_openai_messages(system, messages)}
        if tools:
            body["tools"] = [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                                               "parameters": t["input_schema"]}} for t in tools]
        headers = {"authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        resp = self._t(f"{self.base_url}/chat/completions", headers, body, 300.0)
        try:
            choice = resp["choices"][0]
            msg = choice["message"]
        except (KeyError, IndexError) as e:
            raise ProviderError(f"unexpected response: {str(resp)[:200]}") from e
        calls = []
        for c in msg.get("tool_calls") or []:
            try:
                args = json.loads(c["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {"_unparseable_arguments": c["function"].get("arguments")}
            calls.append(ToolCall(c["id"], c["function"]["name"], args))
        stop = "tool_use" if calls else ("max_tokens" if choice.get("finish_reason") == "length" else "end_turn")
        return AssistantTurn(msg.get("content") or "", calls, stop)
