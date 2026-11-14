"""Tool registry: every capability Atlas AI has is a typed, validated, risk-tiered tool."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from .schema import ValidationError, validate

Risk = Literal["read", "write", "destructive", "external", "system"]


@dataclass
class ToolResult:
    content: Any
    # True when content originates from documents, files or the web: it is data, never instructions.
    untrusted: bool = False
    source: str | None = None
    # Short, human-readable outcome shown in the activity panel (never sent to the model).
    summary: str | None = None


@dataclass
class ToolContext:
    task_id: str
    app_context: dict[str, Any] = field(default_factory=dict)
    approval_token: str | None = None


@dataclass
class Tool:
    name: str
    description: str
    input_schema: dict
    risk: Risk
    handler: Callable[[dict, ToolContext], ToolResult]
    toolset: str = "core"

    def spec(self) -> dict:
        return {"name": self.name, "description": self.description, "input_schema": self.input_schema}


class ToolError(Exception):
    def __init__(self, message: str, code: str = "tool_error") -> None:
        super().__init__(message)
        self.code = code


class ApprovalRequired(Exception):
    def __init__(self, request_id: str, summary: str, risk: str) -> None:
        super().__init__(summary)
        self.request_id = request_id
        self.summary = summary
        self.risk = risk


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> Tool:
        if tool.name in self._tools:
            raise ValueError(f"tool {tool.name} already registered")
        if tool.input_schema.get("type") != "object":
            raise ValueError("tool input schema must be an object")
        self._tools[tool.name] = tool
        return tool

    def tool(self, name: str, description: str, input_schema: dict, risk: Risk = "read", toolset: str = "core"):
        def deco(fn: Callable[[dict, ToolContext], ToolResult]):
            self.register(Tool(name, description, input_schema, risk, fn, toolset))
            return fn
        return deco

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def list(self, toolsets: set[str] | None = None) -> list[Tool]:
        return [t for t in self._tools.values() if toolsets is None or t.toolset in toolsets]

    def call(self, name: str, args: dict, ctx: ToolContext) -> ToolResult:
        tool = self._tools.get(name)
        if tool is None:
            raise ToolError(f"unknown tool '{name}'", "unknown_tool")
        try:
            validate(args, tool.input_schema)
        except ValidationError as e:
            raise ToolError(f"invalid arguments for {name}: {e}", "invalid_arguments") from e
        return tool.handler(args, ctx)
