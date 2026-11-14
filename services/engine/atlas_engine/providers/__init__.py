from .anthropic import AnthropicProvider
from .base import AssistantTurn, LLMProvider, ProviderError, ToolCall
from .gemini import GeminiProvider
from .openai_compat import OpenAICompatProvider
from .scripted import ScriptedProvider

__all__ = ["GeminiProvider", "OpenAICompatProvider", "AnthropicProvider", "ScriptedProvider", "AssistantTurn",
           "ToolCall", "LLMProvider", "ProviderError", "make_provider", "PROVIDER_KINDS"]

# Order = order shown in Settings. Gemini (free tier) is the default; local servers are fully offline.
PROVIDER_KINDS = [
    {"kind": "gemini", "label": "Google Gemini (free tier)", "cost": "free", "remote": True,
     "needs": ["api_key"], "note": "Free key from Google AI Studio. Free-tier prompts may be used by Google to improve its products."},
    {"kind": "openai_compat", "label": "Local model (Ollama / llama.cpp / LM Studio)", "cost": "free", "remote": False,
     "needs": ["base_url", "model"], "note": "Runs on this computer; nothing leaves it. Needs a local model server."},
    {"kind": "anthropic", "label": "Anthropic Claude (paid)", "cost": "paid", "remote": True,
     "needs": ["api_key"], "note": "Optional. Requires a paid API key."},
]


def make_provider(cfg: dict) -> LLMProvider:
    kind = cfg.get("kind")
    if kind == "gemini":
        return GeminiProvider(cfg.get("api_key", ""), cfg.get("model") or None)
    if kind == "openai_compat":
        return OpenAICompatProvider(cfg.get("base_url", ""), cfg.get("model", ""), cfg.get("api_key", ""))
    if kind == "anthropic":
        return AnthropicProvider(cfg.get("api_key", ""), cfg.get("model") or "claude-sonnet-5-5")
    raise ProviderError(f"unknown provider kind '{kind}'")
