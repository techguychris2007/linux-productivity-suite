import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  LuSparkles, LuArrowUp, LuPause, LuPlay, LuSquare, LuHand, LuCheck, LuCircleCheck, LuCircleX, LuShieldAlert,
  LuCloud, LuLaptop, LuX, LuCircleDot, LuTriangleAlert,
} from "react-icons/lu";
import type { EngineEvent, ProviderPublic, TaskSummary } from "@atlas/shared-types";
import { TERMINAL_STATUSES } from "@atlas/shared-types";
import { Badge, Button, IconButton, Spinner } from "@atlas/ui";
import { useAtlas } from "../context";

type State = { tasks: Record<string, TaskSummary>; order: string[]; events: Record<string, EngineEvent[]>; lastSeq: number };
type Action = { type: "tasks"; tasks: TaskSummary[] } | { type: "event"; ev: EngineEvent } | { type: "task"; task: TaskSummary };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "tasks": {
      const tasks = { ...s.tasks }; const order = [...s.order];
      for (const t of a.tasks) { tasks[t.id] = { ...tasks[t.id], ...t }; if (!order.includes(t.id)) order.push(t.id); }
      order.sort((x, y) => (tasks[y].created ?? 0) - (tasks[x].created ?? 0));
      return { ...s, tasks, order };
    }
    case "task": return reducer(s, { type: "tasks", tasks: [a.task] });
    case "event": {
      const ev = a.ev;
      if (ev.seq <= s.lastSeq) return s;
      const list = [...(s.events[ev.task_id] ?? []), ev];
      const t: TaskSummary = s.tasks[ev.task_id] ?? { id: ev.task_id, goal: ev.data.goal ?? "", status: "queued", plan: [], result: null, error: null, tainted: false, created: ev.ts, provider: {} };
      const nt = { ...t };
      if (ev.type === "task.status") nt.status = ev.data.status;
      if (ev.type === "plan.updated") nt.plan = ev.data.plan;
      if (ev.type === "task.completed") { nt.status = "completed"; nt.result = ev.data.result; }
      if (ev.type === "task.failed") { nt.status = "failed"; nt.error = ev.data.error; }
      if (ev.type === "task.cancelled") nt.status = "cancelled";
      if (ev.type === "task.started") nt.provider = ev.data.provider;
      const order = s.order.includes(ev.task_id) ? s.order : [ev.task_id, ...s.order];
      return { tasks: { ...s.tasks, [ev.task_id]: nt }, order, events: { ...s.events, [ev.task_id]: list }, lastSeq: ev.seq };
    }
  }
}

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued", running: "Working", paused: "Paused", waiting_approval: "Needs your approval", verifying: "Checking the result",
  completed: "Done", failed: "Failed", cancelled: "Stopped",
};
const toolLabel = (name: string) => {
  const [app, action = ""] = name.split(".");
  const a = action.replace(/_/g, " ");
  return `${app.charAt(0).toUpperCase()}${app.slice(1)} · ${a.charAt(0).toUpperCase()}${a.slice(1)}`;
};
/** Minimal, safe Markdown for assistant messages: escape first, then **bold**, *italic*, `code`. */
const renderMd = (text: string) => ({ __html: text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!))
  .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<i>$2</i>").replace(/`([^`]+)`/g, "<code>$1</code>") });

export function AiDock() {
  const { bridge, aiDraft, askAi, setAiOpen, notify, grants, route, go, activeDoc } = useAtlas();
  const [state, dispatch] = useReducer(reducer, { tasks: {}, order: [], events: {}, lastSeq: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [provider, setProvider] = useState<ProviderPublic | null | undefined>(undefined);
  const [resolving, setResolving] = useState<Record<string, boolean>>({});
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bridge.engine<TaskSummary[]>("GET", "/tasks").then((t) => dispatch({ type: "tasks", tasks: t })).catch(() => {});
    const refreshProvider = () => bridge.engine<{ current: ProviderPublic | null }>("GET", "/providers").then((r) => setProvider(r.current)).catch(() => setProvider(null));
    refreshProvider();
    const iv = window.setInterval(refreshProvider, 5000);
    const un = bridge.subscribe(0, (ev) => {
      dispatch({ type: "event", ev });
      if (ev.type === "approval.required") notify({ tone: "warning", title: "Atlas AI needs your approval", body: ev.data.summary });
    }, setConnected);
    return () => { un(); clearInterval(iv); };
  }, [bridge, notify]);

  useEffect(() => { if (aiDraft) { setInput(aiDraft); askAi(""); } }, [aiDraft, askAi]);

  const current = selected ?? state.order[0] ?? null;
  const task = current ? state.tasks[current] : null;
  const events = current ? state.events[current] ?? [] : [];
  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }); }, [events.length]);

  const pendingApprovals = useMemo(() => {
    const resolved = new Set(events.filter((e) => e.type === "approval.resolved").map((e) => e.data.request_id));
    const seen = new Map<string, EngineEvent>();
    for (const e of events) if (e.type === "approval.required" && !resolved.has(e.data.request_id)) seen.set(e.data.request_id, e);
    return task && !TERMINAL_STATUSES.includes(task.status) ? [...seen.values()] : [];
  }, [events, task]);

  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const goal = input.trim();
    if (!goal) return;
    try {
      const t = await bridge.engine<TaskSummary>("POST", "/tasks", { goal, app_context: { app: route.split(":")[0], ...(activeDoc ? { open_document: activeDoc } : {}), shared_folders: grants.filter((g) => g.ai_allowed).map((g) => ({ grant: g.id, label: g.label })) } });
      dispatch({ type: "task", task: t }); setSelected(t.id); setInput("");
    } catch (err: any) { notify({ tone: "danger", title: "Atlas AI couldn't start", body: err.message }); }
  };
  const control = async (action: "pause" | "resume" | "cancel" | "take_control") => {
    if (!task) return;
    try { dispatch({ type: "task", task: await bridge.engine<TaskSummary>("POST", `/tasks/${task.id}/${action}`) }); }
    catch (err: any) { notify({ tone: "danger", title: "Could not update the task", body: err.message }); }
  };
  const decide = async (requestId: string, approve: boolean) => {
    setResolving((r) => ({ ...r, [requestId]: true }));
    try { await bridge.core(approve ? "approvals.approve" : "approvals.deny", { id: requestId }); }
    catch (err: any) { notify({ tone: "danger", title: "Approval failed", body: err.message }); setResolving((r) => ({ ...r, [requestId]: false })); }
  };

  const active = task && !TERMINAL_STATUSES.includes(task.status);
  return (
    <aside className="ai-dock" aria-label="Atlas AI">
      <header className="ai-head">
        <div className="row gap-2"><LuSparkles className="ai-mark" /><strong>Atlas AI</strong>
          <span className={`conn ${connected ? "on" : ""}`} title={connected ? "Live" : "Reconnecting"} /></div>
        <IconButton label="Close Atlas AI" onClick={() => setAiOpen(false)}><LuX /></IconButton>
      </header>

      {provider === null && (
        <div className="banner banner-info">No AI provider yet. <button className="link" onClick={() => go("settings:ai")}>Connect a free one</button> (Gemini or a local model).</div>
      )}
      {provider && (
        <div className={`privacy ${provider.kind === "openai_compat" ? "local" : "remote"}`}>
          {provider.kind === "openai_compat" ? <LuLaptop /> : <LuCloud />}
          <span>{provider.kind === "openai_compat" ? "Runs on this computer" : provider.kind === "gemini" ? "Requests go to Google Gemini" : "Requests go to Anthropic"}</span>
          {provider.model && <code className="ellipsis">{provider.model}</code>}
        </div>
      )}

      {state.order.length > 1 && (
        <select className="task-switch" aria-label="Task history" value={current ?? ""} onChange={(e) => setSelected(e.target.value)}>
          {state.order.map((id) => <option key={id} value={id}>{STATUS_LABEL[state.tasks[id].status]} · {state.tasks[id].goal.slice(0, 60)}</option>)}
        </select>
      )}

      <div className="ai-feed" ref={feedRef}>
        {!task && (
          <div className="ai-intro">
            <p>Describe the result you want. Atlas AI plans the steps and uses your shared folders. You can watch every step, and it asks before risky actions.</p>
          </div>
        )}
        {task && (
          <>
            <div className="goal">{task.goal}</div>
            <div className={`status status-${task.status}`}>
              {active ? <Spinner /> : task.status === "completed" ? <LuCircleCheck /> : <LuCircleX />}
              {STATUS_LABEL[task.status]}
              {task.tainted && <Badge tone="warning">read external content</Badge>}
            </div>
            {task.plan.length > 0 && (
              <ol className="plan">
                {task.plan.map((p, i) => (
                  <li key={i} className={`plan-${p.status}`}>
                    {p.status === "done" ? <LuCheck /> : p.status === "running" ? <Spinner size={11} /> : <LuCircleDot />}
                    <span>{p.title}</span>
                  </li>
                ))}
              </ol>
            )}
            {pendingApprovals.map((e) => (
              <div key={e.data.request_id} className="approval" role="alert">
                <div className="row gap-2"><LuShieldAlert /><strong>Approve this action?</strong><Badge tone="danger">{e.data.risk}</Badge></div>
                <p>{e.data.summary}</p>
                <div className="row gap-2">
                  <Button size="sm" variant="primary" disabled={resolving[e.data.request_id]} onClick={() => decide(e.data.request_id, true)}>Approve</Button>
                  <Button size="sm" variant="ghost" disabled={resolving[e.data.request_id]} onClick={() => decide(e.data.request_id, false)}>Deny</Button>
                </div>
              </div>
            ))}
            <ul className="timeline">
              {events.filter((e) => ["tool.started", "tool.finished", "tool.failed", "assistant.message", "verify.result", "task.user_control", "task.failed"].includes(e.type)).map((e) => (
                <li key={e.seq} className={`tl tl-${e.type.replace(".", "-")}`}>
                  {e.type === "tool.started" && <><span className="tl-dot" /> <span className="tl-tool">{toolLabel(e.data.name)}</span>{e.data.risk !== "read" && <Badge tone={e.data.risk === "write" ? "accent" : "danger"}>{e.data.risk}</Badge>}</>}
                  {e.type === "tool.finished" && <><LuCheck className="ok" /> <span className="muted ellipsis">{e.data.summary}</span></>}
                  {e.type === "tool.failed" && <><LuTriangleAlert className="bad" /> <span className="muted">{e.data.error}</span></>}
                  {e.type === "assistant.message" && <div className="msg" dangerouslySetInnerHTML={renderMd(e.data.text)} />}
                  {e.type === "verify.result" && <span className="muted">{e.data.passed ? "Verified the result" : "Verification asked for fixes"}</span>}
                  {e.type === "task.user_control" && <span className="muted">{e.data.message}</span>}
                  {e.type === "task.failed" && <div className="banner banner-danger">{e.data.error}</div>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {active && (
        <div className="ai-controls">
          {task!.status === "paused"
            ? <Button size="sm" icon={<LuPlay />} onClick={() => control("resume")}>Resume</Button>
            : <Button size="sm" icon={<LuPause />} onClick={() => control("pause")}>Pause</Button>}
          <Button size="sm" icon={<LuHand />} onClick={() => control("take_control")}>Take control</Button>
          <Button size="sm" variant="danger" icon={<LuSquare />} onClick={() => control("cancel")}>Stop</Button>
        </div>
      )}

      <form className="composer" onSubmit={send}>
        <textarea aria-label="Message Atlas AI" rows={2} placeholder={provider ? "Ask Atlas AI to do something…" : "Connect an AI provider in Settings first"}
          value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="hero-send" aria-label="Send" disabled={!input.trim()}><LuArrowUp /></button>
      </form>
    </aside>
  );
}
