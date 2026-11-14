// Types shared by the shell, apps and the engine API.

export type Risk = "read" | "write" | "destructive" | "external" | "system";

export interface Grant {
  id: string;
  label: string;
  root: string;
  access: "read" | "readwrite";
  ai_allowed: boolean;
}

export interface FsEntry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink" | "missing";
  size: number;
  modified_ms: number | null;
}

export interface ApprovalRequest {
  id: string;
  summary: string;
  risk: Risk;
  created_ms: number;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
}

export type TaskStatus =
  | "queued" | "running" | "paused" | "waiting_approval" | "verifying" | "completed" | "failed" | "cancelled";

export interface PlanStep { title: string; status: "pending" | "running" | "done" | "skipped" }

export interface TaskSummary {
  id: string;
  goal: string;
  status: TaskStatus;
  plan: PlanStep[];
  result: string | null;
  error: string | null;
  tainted: boolean;
  created: number;
  provider: { id?: string; model?: string; remote?: boolean };
  app?: string | null;
}

export interface EngineEvent {
  seq: number;
  task_id: string;
  type:
    | "task.created" | "task.started" | "task.status" | "task.completed" | "task.failed" | "task.cancelled" | "task.user_control"
    | "plan.updated" | "model.request" | "assistant.message"
    | "tool.started" | "tool.finished" | "tool.failed"
    | "approval.required" | "approval.resolved" | "verify.started" | "verify.result" | "resource.changed";
  data: Record<string, any>;
  ts: number;
}

export interface ProviderKind {
  kind: "gemini" | "openai_compat" | "anthropic";
  label: string;
  cost: "free" | "paid";
  remote: boolean;
  needs: string[];
  note: string;
}

export interface ProviderPublic {
  kind: ProviderKind["kind"];
  model?: string;
  base_url?: string;
  has_api_key: boolean;
}

export const TERMINAL_STATUSES: TaskStatus[] = ["completed", "failed", "cancelled"];
