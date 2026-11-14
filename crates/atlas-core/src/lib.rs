//! Project Atlas security core.
//!
//! `Broker::dispatch` is the single entry point used by the Tauri app (UI commands over IPC)
//! and by the core host (HTTP for the AI engine sidecar and for browser-based development).

pub mod approvals;
pub mod audit;
pub mod fsgw;
pub mod json;
pub mod permissions;
pub mod util;

use approvals::{Approvals, Risk};
use audit::Audit;
use json::Value;
use permissions::{Access, GrantStore, PathError};
use std::path::PathBuf;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Caller { Ui, Engine }

impl Caller {
    pub fn as_str(&self) -> &'static str { match self { Caller::Ui => "user", Caller::Engine => "atlas-ai" } }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ApiError { pub code: &'static str, pub message: String, pub data: Value }

impl ApiError {
    fn new(code: &'static str, message: impl Into<String>) -> Self { ApiError { code, message: message.into(), data: Value::Null } }
    pub fn to_value(&self) -> Value {
        Value::obj().with("code", self.code).with("message", self.message.as_str()).with("data", self.data.clone())
    }
}

impl From<PathError> for ApiError {
    fn from(e: PathError) -> Self {
        let code = match e { PathError::UnknownGrant => "not_found", PathError::Io(_) => "io", PathError::InvalidPath(_) => "invalid_argument", _ => "forbidden" };
        ApiError::new(code, e.to_string())
    }
}

type R = Result<Value, ApiError>;

pub struct Broker {
    pub grants: GrantStore,
    pub approvals: Approvals,
    pub audit: Audit,
    data_dir: PathBuf,
}

/// Static description of every command: required caller and risk tier.
pub fn command_spec(cmd: &str) -> Option<(Option<Caller>, Risk)> {
    use Caller::*;
    Some(match cmd {
        "core.info" => (None, Risk::Read),
        "grants.list" => (None, Risk::Read),
        "grants.add" | "grants.revoke" => (Some(Ui), Risk::System),
        "fs.list" | "fs.stat" | "fs.read_text" | "fs.search" => (None, Risk::Read),
        "fs.write_text" | "fs.mkdir" | "fs.move" => (None, Risk::Write),
        "fs.trash" => (None, Risk::Destructive),
        "approvals.pending" | "approvals.approve" | "approvals.deny" | "audit.recent" => (Some(Ui), Risk::Read),
        "approvals.request" | "approvals.claim" | "approvals.consume" => (Some(Engine), Risk::Read),
        _ => return None,
    })
}

fn arg<'a>(a: &'a Value, k: &str) -> Result<&'a str, ApiError> {
    a.str_field(k).ok_or_else(|| ApiError::new("invalid_argument", format!("missing string argument '{}'", k)))
}

/// Fingerprint of an action = command + arguments without the approval token.
pub fn fingerprint(cmd: &str, args: &Value) -> String {
    let mut a = args.clone();
    if let Value::Obj(m) = &mut a { m.remove("approval_token"); }
    format!("{}:{}", cmd, a.to_json())
}

fn summarize(cmd: &str, args: &Value) -> String {
    let p = args.str_field("path").unwrap_or("");
    match cmd {
        "fs.trash" => format!("Move '{}' to the Atlas trash", p),
        _ => format!("{} {}", cmd, p),
    }
}

impl Broker {
    pub fn new(data_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        Ok(Broker {
            grants: GrantStore::load(data_dir.join("grants.json"))?,
            approvals: Approvals::new(10 * 60 * 1000),
            audit: Audit::to_file(data_dir.join("audit.log.jsonl")),
            data_dir,
        })
    }

    pub fn in_memory(data_dir: PathBuf) -> Self {
        Broker { grants: GrantStore::in_memory(), approvals: Approvals::new(60_000), audit: Audit::in_memory(), data_dir }
    }

    pub fn dispatch(&mut self, caller: Caller, cmd: &str, args: &Value) -> R {
        let Some((required, risk)) = command_spec(cmd) else {
            return Err(ApiError::new("unknown_command", format!("unknown command '{}'", cmd)));
        };
        let detail = { let mut a = args.clone(); if let Value::Obj(m) = &mut a { m.remove("approval_token"); m.remove("content"); } a };
        if let Some(req) = required {
            if req != caller {
                self.audit.record(caller.as_str(), cmd, detail, "denied:caller");
                return Err(ApiError::new("forbidden", format!("'{}' is not available to {}", cmd, caller.as_str())));
            }
        }
        // Human approval gate for AI-initiated risky actions.
        if caller == Caller::Engine && risk.needs_approval_for_ai() {
            let fp = fingerprint(cmd, args);
            let ok = args.str_field("approval_token").map(|t| self.approvals.consume(t, &fp)).unwrap_or(false);
            if !ok {
                let r = self.approvals.request(&fp, &summarize(cmd, args), risk);
                self.audit.record(caller.as_str(), cmd, detail, "approval_required");
                let mut e = ApiError::new("approval_required", "This action needs your approval in Atlas.");
                e.data = Value::obj().with("request_id", r.id.as_str()).with("summary", r.summary.as_str()).with("risk", risk.as_str());
                return Err(e);
            }
        }
        let result = self.run(caller, cmd, args);
        let outcome = match &result { Ok(_) => "ok".to_string(), Err(e) => format!("error:{}", e.code) };
        self.audit.record(caller.as_str(), cmd, detail, &outcome);
        result
    }

    fn run(&mut self, caller: Caller, cmd: &str, a: &Value) -> R {
        let for_ai = caller == Caller::Engine;
        match cmd {
            "core.info" => Ok(Value::obj().with("version", VERSION).with("caller", caller.as_str())),
            "grants.list" => Ok(Value::Arr(self.grants.list().iter().filter(|g| !for_ai || g.ai_allowed).map(|g| g.to_value()).collect())),
            "grants.add" => {
                let access = Access::parse(a.str_field("access").unwrap_or("readwrite")).ok_or_else(|| ApiError::new("invalid_argument", "access must be read or readwrite"))?;
                let path = arg(a, "path")?;
                let label = a.str_field("label").map(String::from).unwrap_or_else(|| {
                    std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string())
                });
                let g = self.grants.add(std::path::Path::new(path), &label, access, a.get("ai_allowed").and_then(|v| v.as_bool()).unwrap_or(true))?;
                Ok(g.to_value())
            }
            "grants.revoke" => Ok(Value::obj().with("revoked", self.grants.revoke(arg(a, "id")?).map_err(|e| ApiError::new("io", e))?)),
            "fs.list" => {
                let (g, p) = self.grants.resolve(arg(a, "grant")?, a.str_field("path").unwrap_or(""), false, for_ai)?;
                let hidden = a.get("show_hidden").and_then(|v| v.as_bool()).unwrap_or(false);
                Ok(Value::Arr(fsgw::list(&g.root, &p, hidden).map_err(|e| ApiError::new("io", e))?))
            }
            "fs.stat" => {
                let (g, p) = self.grants.resolve(arg(a, "grant")?, arg(a, "path")?, false, for_ai)?;
                Ok(fsgw::entry_value(&g.root, &p))
            }
            "fs.read_text" => {
                let (_, p) = self.grants.resolve(arg(a, "grant")?, arg(a, "path")?, false, for_ai)?;
                let max = a.get("max_bytes").and_then(|v| v.as_f64()).map(|n| n as u64).unwrap_or(fsgw::MAX_READ_BYTES);
                let (text, truncated) = fsgw::read_text(&p, max).map_err(|e| ApiError::new("io", e))?;
                Ok(Value::obj().with("content", text).with("truncated", truncated))
            }
            "fs.search" => {
                let (g, p) = self.grants.resolve(arg(a, "grant")?, a.str_field("path").unwrap_or(""), false, for_ai)?;
                let limit = a.get("limit").and_then(|v| v.as_f64()).unwrap_or(50.0).clamp(1.0, 500.0) as usize;
                Ok(Value::Arr(fsgw::search(&g.root, &p, arg(a, "query")?, limit)))
            }
            "fs.write_text" => {
                let (g, p) = self.grants.resolve(arg(a, "grant")?, arg(a, "path")?, true, for_ai)?;
                let overwrite = a.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false);
                let backup = fsgw::write_text(&p, arg(a, "content")?, &self.data_dir.join("backups"), overwrite).map_err(|e| ApiError::new("io", e))?;
                Ok(fsgw::entry_value(&g.root, &p).with("backup", backup.map(|b| b.to_string_lossy().to_string())))
            }
            "fs.mkdir" => {
                let (g, p) = self.grants.resolve(arg(a, "grant")?, arg(a, "path")?, true, for_ai)?;
                std::fs::create_dir_all(&p).map_err(|e| ApiError::new("io", e.to_string()))?;
                Ok(fsgw::entry_value(&g.root, &p))
            }
            "fs.move" => {
                let grant = arg(a, "grant")?;
                let (g, from) = self.grants.resolve(grant, arg(a, "path")?, true, for_ai)?;
                let (_, to) = self.grants.resolve(grant, arg(a, "to")?, true, for_ai)?;
                if !from.exists() { return Err(ApiError::new("not_found", "source does not exist")); }
                if to.exists() { return Err(ApiError::new("conflict", "destination already exists")); }
                if let Some(parent) = to.parent() { std::fs::create_dir_all(parent).map_err(|e| ApiError::new("io", e.to_string()))?; }
                std::fs::rename(&from, &to).map_err(|e| ApiError::new("io", e.to_string()))?;
                Ok(fsgw::entry_value(&g.root, &to))
            }
            "fs.trash" => {
                let (_, p) = self.grants.resolve(arg(a, "grant")?, arg(a, "path")?, true, for_ai)?;
                let dest = fsgw::trash(&p, &self.data_dir.join("trash")).map_err(|e| ApiError::new("io", e))?;
                Ok(Value::obj().with("trashed_to", dest.to_string_lossy().to_string()))
            }
            "approvals.pending" => Ok(Value::Arr(self.approvals.pending().iter().map(|r| r.to_value()).collect())),
            "approvals.approve" => { self.approvals.approve(arg(a, "id")?).map_err(|e| ApiError::new("conflict", e))?; Ok(Value::obj().with("approved", true)) }
            "approvals.deny" => { self.approvals.deny(arg(a, "id")?).map_err(|e| ApiError::new("conflict", e))?; Ok(Value::obj().with("denied", true)) }
            "approvals.request" => {
                let risk = Risk::parse(arg(a, "risk")?).ok_or_else(|| ApiError::new("invalid_argument", "bad risk"))?;
                let r = self.approvals.request(&format!("engine:{}", arg(a, "fingerprint")?), arg(a, "summary")?, risk);
                Ok(r.to_value())
            }
            "approvals.claim" => {
                let t = self.approvals.claim(arg(a, "id")?).map_err(|e| ApiError::new("conflict", e))?;
                Ok(Value::obj().with("token", t))
            }
            "approvals.consume" => {
                let ok = self.approvals.consume(arg(a, "token")?, &format!("engine:{}", arg(a, "fingerprint")?));
                Ok(Value::obj().with("valid", ok))
            }
            "audit.recent" => Ok(Value::Arr(self.audit.recent(a.get("limit").and_then(|v| v.as_f64()).unwrap_or(100.0) as usize))),
            _ => Err(ApiError::new("unknown_command", cmd.to_string())),
        }
    }
}
