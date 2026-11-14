"""The Atlas AI orchestrator: one agent loop (plan → act → observe → verify) over typed tools.

Every state change emits an event on the EventBus; the activity panel renders only these events.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from .events import EventBus
from .providers.base import AssistantTurn, LLMProvider, ProviderError, ToolCall
from .tools import ApprovalRequired, ToolContext, ToolError, ToolRegistry, ToolResult
from .untrusted import POLICY, wrap

SYSTEM_PROMPT = """You are Atlas AI, the assistant built into Project Atlas, a desktop suite on Ubuntu.
You complete the user's request by calling tools. Rules:
- First call task.set_plan with a short list of concrete steps; keep it updated with task.update_step.
- Use only the tools provided. Never invent file names, folder grants or results.
- Prefer the smallest set of changes that satisfies the request. Do not delete or overwrite files unless asked.
- When finished, reply with a brief summary of what you did and where the results are.
""" + "\n" + POLICY

VERIFIER_PROMPT = """You are the Atlas verification step. You cannot call tools.
Given the user's request and a transcript of the tool calls and results, decide whether the request
was fully and correctly satisfied using only evidence in the transcript.
Reply with exactly 'PASS' on the first line, or 'FIX:' followed by a short list of what is missing or wrong."""

PLAN_TOOLS = [
    {"name": "task.set_plan", "description": "Set the step-by-step plan for this task.",
     "input_schema": {"type": "object", "properties": {"steps": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 20}},
                      "required": ["steps"], "additionalProperties": False}},
    {"name": "task.update_step", "description": "Mark a plan step (0-based index) as running, done or skipped.",
     "input_schema": {"type": "object", "properties": {"index": {"type": "integer", "minimum": 0},
                                                       "status": {"type": "string", "enum": ["running", "done", "skipped"]}},
                      "required": ["index", "status"], "additionalProperties": False}},
]

TERMINAL = {"completed", "failed", "cancelled"}


class ApprovalGateway(Protocol):
    def request_approval(self, fingerprint: str, summary: str, risk: str) -> str: ...
    def wait_for_token(self, request_id: str, should_stop: Callable[[], bool], timeout: float = 600.0, poll: float = 0.4) -> str: ...


class TaskStopped(Exception):
    pass


@dataclass
class Task:
    goal: str
    app_context: dict[str, Any] = field(default_factory=dict)
    toolsets: set[str] | None = None
    id: str = field(default_factory=lambda: "t_" + uuid.uuid4().hex[:12])
    status: str = "queued"  # queued|running|paused|waiting_approval|verifying|completed|failed|cancelled
    plan: list[dict[str, str]] = field(default_factory=list)
    result: str | None = None
    error: str | None = None
    tainted: bool = False
    created: float = field(default_factory=time.time)
    provider: dict[str, Any] = field(default_factory=dict)
    _resume: threading.Event = field(default_factory=threading.Event, repr=False)
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)

    def summary(self) -> dict[str, Any]:
        return {"id": self.id, "goal": self.goal, "status": self.status, "plan": self.plan, "result": self.result,
                "error": self.error, "tainted": self.tainted, "created": self.created, "provider": self.provider,
                "app": self.app_context.get("app")}


def _short(v: Any, n: int = 160) -> str:
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    return s if len(s) <= n else s[: n - 1] + "…"


class Orchestrator:
    def __init__(self, registry: ToolRegistry, bus: EventBus, provider_factory: Callable[[], LLMProvider | None],
                 approvals: ApprovalGateway | None = None, max_iterations: int = 24, verify: bool = True,
                 max_tool_failures: int = 3) -> None:
        self.registry, self.bus, self.provider_factory, self.approvals = registry, bus, provider_factory, approvals
        self.max_iterations, self.verify, self.max_tool_failures = max_iterations, verify, max_tool_failures
        self.tasks: dict[str, Task] = {}
        self._lock = threading.Lock()

    # ---------- public control API ----------
    def start(self, goal: str, app_context: dict | None = None, toolsets: set[str] | None = None, background: bool = True) -> Task:
        task = Task(goal=goal.strip(), app_context=app_context or {}, toolsets=toolsets)
        task._resume.set()
        with self._lock:
            self.tasks[task.id] = task
        self.bus.emit(task.id, "task.created", goal=task.goal, app=task.app_context.get("app"))
        if background:
            threading.Thread(target=self._run, args=(task,), daemon=True, name=task.id).start()
        else:
            self._run(task)
        return task

    def pause(self, task_id: str) -> Task:
        t = self.tasks[task_id]
        if t.status not in TERMINAL:
            t._resume.clear()
            self._status(t, "paused")
        return t

    def resume(self, task_id: str) -> Task:
        t = self.tasks[task_id]
        if t.status == "paused":
            self._status(t, "running")
            t._resume.set()
        return t

    def cancel(self, task_id: str) -> Task:
        t = self.tasks[task_id]
        if t.status not in TERMINAL:
            t._cancel.set()
            t._resume.set()
        return t

    def take_control(self, task_id: str) -> Task:
        """User takes over: pause and say so in the activity log."""
        t = self.pause(task_id)
        self.bus.emit(t.id, "task.user_control", message="You have control. Resume when you want Atlas AI to continue.")
        return t

    # ---------- internals ----------
    def _status(self, task: Task, status: str) -> None:
        task.status = status
        self.bus.emit(task.id, "task.status", status=status)

    def _checkpoint(self, task: Task) -> None:
        while not task._resume.wait(0.2):
            if task._cancel.is_set():
                break
        if task._cancel.is_set():
            raise TaskStopped()

    def _tools_for(self, task: Task) -> list[dict]:
        return PLAN_TOOLS + [t.spec() for t in self.registry.list(task.toolsets)]

    def _run(self, task: Task) -> None:
        try:
            provider = self.provider_factory()
            if provider is None:
                raise ProviderError("No AI provider is configured. Open Settings → Atlas AI to choose one.")
            task.provider = {"id": provider.id, "model": provider.model, "remote": provider.remote}
            self._status(task, "running")
            self.bus.emit(task.id, "task.started", provider=task.provider)
            ctx_note = f"\nCurrent application context: {json.dumps(task.app_context)}" if task.app_context else ""
            system = SYSTEM_PROMPT + ctx_note
            messages: list[dict] = [{"role": "user", "content": [{"type": "text", "text": task.goal}]}]
            failures: dict[str, int] = {}
            verified = False
            for iteration in range(self.max_iterations):
                self._checkpoint(task)
                self.bus.emit(task.id, "model.request", iteration=iteration)
                turn: AssistantTurn = provider.complete(system, messages, self._tools_for(task))
                messages.append(turn.to_message())
                if turn.text:
                    self.bus.emit(task.id, "assistant.message", text=turn.text)
                if not turn.tool_calls:
                    if self.verify and not verified:
                        verified = True
                        verdict = self._verify(task, provider, messages, turn.text)
                        if verdict is not None:
                            messages.append({"role": "user", "content": [{"type": "text", "text":
                                "The verification step found problems. Fix them, then summarise again:\n" + verdict}]})
                            continue
                    task.result = turn.text
                    for step in task.plan:
                        if step["status"] in ("pending", "running"):
                            step["status"] = "done" if step["status"] == "running" else step["status"]
                    self._status(task, "completed")
                    self.bus.emit(task.id, "task.completed", result=turn.text)
                    return
                results = []
                for call in turn.tool_calls:
                    self._checkpoint(task)
                    results.append(self._execute(task, call, failures))
                messages.append({"role": "user", "content": results})
            raise ProviderError(f"Stopped after {self.max_iterations} steps without finishing.")
        except TaskStopped:
            self._status(task, "cancelled")
            self.bus.emit(task.id, "task.cancelled")
        except Exception as e:  # noqa: BLE001 — every failure must reach the user
            task.error = str(e)
            self._status(task, "failed")
            self.bus.emit(task.id, "task.failed", error=str(e), kind=type(e).__name__)

    def _verify(self, task: Task, provider: LLMProvider, messages: list[dict], final: str) -> str | None:
        prev = task.status
        self._status(task, "verifying")
        self.bus.emit(task.id, "verify.started")
        lines = []
        for m in messages[1:]:
            for b in m["content"]:
                if b["type"] == "tool_use":
                    lines.append(f"CALL {b['name']} {_short(b['input'], 400)}")
                elif b["type"] == "tool_result":
                    lines.append(f"RESULT{' (error)' if b.get('is_error') else ''} {_short(b['content'], 600)}")
        transcript = "\n".join(lines) or "(no tool calls)"
        prompt = f"User request:\n{task.goal}\n\nTranscript:\n{transcript}\n\nFinal answer:\n{final}"
        verdict = provider.complete(VERIFIER_PROMPT, [{"role": "user", "content": [{"type": "text", "text": prompt}]}], [])
        text = verdict.text.strip()
        passed = text.upper().startswith("PASS")
        self.bus.emit(task.id, "verify.result", passed=passed, notes=_short(text, 600))
        self._status(task, prev if prev != "verifying" else "running")
        return None if passed else text

    def _execute(self, task: Task, call: ToolCall, failures: dict[str, int]) -> dict:
        def result(content: str, is_error: bool = False) -> dict:
            return {"type": "tool_result", "tool_use_id": call.id, "content": content, "is_error": is_error}

        if call.name == "task.set_plan":
            steps = call.input.get("steps") or []
            if not isinstance(steps, list) or not steps:
                return result("steps must be a non-empty list", True)
            task.plan = [{"title": str(s)[:200], "status": "pending"} for s in steps[:20]]
            self.bus.emit(task.id, "plan.updated", plan=task.plan)
            return result("plan recorded")
        if call.name == "task.update_step":
            i, st = call.input.get("index"), call.input.get("status")
            if not isinstance(i, int) or not (0 <= i < len(task.plan)) or st not in ("running", "done", "skipped"):
                return result("invalid step update", True)
            task.plan[i]["status"] = st
            self.bus.emit(task.id, "plan.updated", plan=task.plan)
            return result("ok")

        tool = self.registry.get(call.name)
        if tool is None or (task.toolsets is not None and tool.toolset not in task.toolsets):
            self.bus.emit(task.id, "tool.failed", call_id=call.id, name=call.name, error="unknown tool")
            return result(f"Unknown tool '{call.name}'.", True)

        self.bus.emit(task.id, "tool.started", call_id=call.id, name=tool.name, risk=tool.risk,
                      args=_short(call.input, 300), app=tool.toolset)
        ctx = ToolContext(task_id=task.id, app_context=task.app_context)
        try:
            # Taint rule: once untrusted content was read, external actions always need fresh approval.
            if tool.risk == "external" and task.tainted:
                ctx.approval_token = self._await_approval(task, call, self._engine_approval(task, call, tool.risk))
            for attempt in range(2):
                try:
                    res: ToolResult = self.registry.call(tool.name, call.input, ctx)
                    break
                except ApprovalRequired as a:
                    if attempt == 1:
                        raise ToolError("approval was not accepted", "approval_failed")
                    self.bus.emit(task.id, "approval.required", call_id=call.id, request_id=a.request_id,
                                  summary=a.summary, risk=a.risk, name=tool.name)
                    ctx.approval_token = self._await_approval(task, call, a.request_id)
        except TaskStopped:
            raise
        except _Denied as d:
            self.bus.emit(task.id, "tool.failed", call_id=call.id, name=tool.name, error=str(d))
            return result(f"The user did not approve this action ({d}). Do not retry it; continue or explain.", True)
        except ToolError as e:
            failures[tool.name] = failures.get(tool.name, 0) + 1
            self.bus.emit(task.id, "tool.failed", call_id=call.id, name=tool.name, error=str(e), code=e.code)
            if failures[tool.name] >= self.max_tool_failures:
                raise ProviderError(f"'{tool.name}' failed {failures[tool.name]} times: {e}") from e
            return result(f"Error ({e.code}): {e}", True)

        if res.untrusted:
            task.tainted = True
        content = wrap(res.content, res.source) if res.untrusted else (
            res.content if isinstance(res.content, str) else json.dumps(res.content, ensure_ascii=False))
        self.bus.emit(task.id, "tool.finished", call_id=call.id, name=tool.name, summary=res.summary or _short(res.content, 200))
        for ch in res.changed:
            self.bus.emit(task.id, "resource.changed", **ch)
        return result(content)

    def _engine_approval(self, task: Task, call: ToolCall, risk: str) -> str:
        if self.approvals is None:
            raise _Denied("no approval channel available")
        fp = hashlib.sha256(f"{task.id}:{call.name}:{json.dumps(call.input, sort_keys=True)}".encode()).hexdigest()
        summary = f"{call.name} {_short(call.input, 120)}"
        rid = self.approvals.request_approval(fp, summary, risk)
        self.bus.emit(task.id, "approval.required", call_id=call.id, request_id=rid, summary=summary, risk=risk, name=call.name)
        return rid

    def _await_approval(self, task: Task, call: ToolCall, request_id: str) -> str:
        if self.approvals is None:
            raise _Denied("no approval channel available")
        prev = task.status
        self._status(task, "waiting_approval")
        try:
            token = self.approvals.wait_for_token(request_id, lambda: task._cancel.is_set())
        except Exception as e:  # noqa: BLE001
            if task._cancel.is_set():
                raise TaskStopped() from e
            self.bus.emit(task.id, "approval.resolved", request_id=request_id, approved=False, reason=str(e))
            self._status(task, prev)
            raise _Denied(str(e)) from e
        self.bus.emit(task.id, "approval.resolved", request_id=request_id, approved=True)
        self._status(task, prev)
        return token


class _Denied(Exception):
    pass
