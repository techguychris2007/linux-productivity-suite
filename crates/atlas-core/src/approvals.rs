//! Human approval for risky actions.
//!
//! Flow: a caller attempts an action → the broker returns `ApprovalRequired{request_id}` →
//! the UI (and only the UI) approves → the broker mints a single-use token bound to the
//! exact action fingerprint → the caller retries with the token. The model cannot approve itself
//! because the approve endpoint is only reachable with the UI credential.

use crate::json::Value;
use crate::util::{now_ms, random_token, ct_eq};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Risk { Read, Write, Destructive, External, System }

impl Risk {
    pub fn as_str(&self) -> &'static str {
        match self { Risk::Read => "read", Risk::Write => "write", Risk::Destructive => "destructive", Risk::External => "external", Risk::System => "system" }
    }
    pub fn parse(s: &str) -> Option<Risk> {
        Some(match s { "read" => Risk::Read, "write" => Risk::Write, "destructive" => Risk::Destructive, "external" => Risk::External, "system" => Risk::System, _ => return None })
    }
    /// Risk tiers that always require a human approval when the caller is the AI engine.
    pub fn needs_approval_for_ai(&self) -> bool { matches!(self, Risk::Destructive | Risk::External | Risk::System) }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Status { Pending, Approved, Denied, Consumed, Expired }

impl Status {
    fn as_str(&self) -> &'static str {
        match self { Status::Pending => "pending", Status::Approved => "approved", Status::Denied => "denied", Status::Consumed => "consumed", Status::Expired => "expired" }
    }
}

#[derive(Debug, Clone)]
pub struct Request {
    pub id: String,
    pub fingerprint: String,
    pub summary: String,
    pub risk: Risk,
    pub created_ms: u64,
    pub status: Status,
    token: Option<String>,
}

impl Request {
    pub fn to_value(&self) -> Value {
        Value::obj().with("id", self.id.as_str()).with("summary", self.summary.as_str())
            .with("risk", self.risk.as_str()).with("created_ms", self.created_ms).with("status", self.status.as_str())
    }
}

pub struct Approvals {
    requests: BTreeMap<String, Request>,
    ttl_ms: u64,
}

impl Approvals {
    pub fn new(ttl_ms: u64) -> Self { Approvals { requests: BTreeMap::new(), ttl_ms } }

    fn expire(&mut self) {
        let now = now_ms();
        for r in self.requests.values_mut() {
            if matches!(r.status, Status::Pending | Status::Approved) && now.saturating_sub(r.created_ms) > self.ttl_ms {
                r.status = Status::Expired; r.token = None;
            }
        }
    }

    /// Reuse an open request for the same fingerprint so retries don't spam the user.
    pub fn request(&mut self, fingerprint: &str, summary: &str, risk: Risk) -> Request {
        self.expire();
        if let Some(r) = self.requests.values().find(|r| r.fingerprint == fingerprint && r.status == Status::Pending) {
            return r.clone();
        }
        let r = Request { id: format!("ap_{}", &random_token()[..16]), fingerprint: fingerprint.into(), summary: summary.into(), risk, created_ms: now_ms(), status: Status::Pending, token: None };
        self.requests.insert(r.id.clone(), r.clone());
        r
    }

    pub fn pending(&mut self) -> Vec<Request> {
        self.expire();
        self.requests.values().filter(|r| r.status == Status::Pending).cloned().collect()
    }

    pub fn get(&self, id: &str) -> Option<&Request> { self.requests.get(id) }

    /// UI-only. Returns the single-use token.
    pub fn approve(&mut self, id: &str) -> Result<String, String> {
        self.expire();
        let r = self.requests.get_mut(id).ok_or("unknown approval request")?;
        if r.status != Status::Pending { return Err(format!("request is {}", r.status.as_str())); }
        let t = random_token();
        r.status = Status::Approved; r.token = Some(t.clone());
        Ok(t)
    }

    pub fn deny(&mut self, id: &str) -> Result<(), String> {
        let r = self.requests.get_mut(id).ok_or("unknown approval request")?;
        if r.status != Status::Pending { return Err(format!("request is {}", r.status.as_str())); }
        r.status = Status::Denied;
        Ok(())
    }

    /// Consume a token for exactly this fingerprint. Single use.
    pub fn consume(&mut self, token: &str, fingerprint: &str) -> bool {
        self.expire();
        for r in self.requests.values_mut() {
            if r.status == Status::Approved {
                if let Some(t) = &r.token {
                    if ct_eq(t, token) {
                        if r.fingerprint != fingerprint { return false; }
                        r.status = Status::Consumed; r.token = None;
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Lets a caller holding a request id fetch the token after the user approved.
    /// Only the original requester knows the id; the token is released once.
    pub fn claim(&mut self, id: &str) -> Result<Option<String>, String> {
        self.expire();
        let r = self.requests.get(id).ok_or("unknown approval request")?;
        match r.status {
            Status::Approved => Ok(r.token.clone()),
            Status::Pending => Ok(None),
            ref s => Err(format!("request is {}", s.as_str())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn token_is_single_use_and_bound() {
        let mut a = Approvals::new(60_000);
        let r = a.request("delete:g1:a.txt", "Delete a.txt", Risk::Destructive);
        let r2 = a.request("delete:g1:a.txt", "Delete a.txt", Risk::Destructive);
        assert_eq!(r.id, r2.id, "duplicate pending requests are merged");
        let t = a.approve(&r.id).unwrap();
        assert!(!a.consume(&t, "delete:g1:b.txt"), "token bound to fingerprint");
        assert!(a.consume(&t, "delete:g1:a.txt"));
        assert!(!a.consume(&t, "delete:g1:a.txt"), "single use");
    }
    #[test]
    fn deny_and_expiry() {
        let mut a = Approvals::new(0);
        let r = a.request("x", "x", Risk::External);
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert!(a.approve(&r.id).is_err(), "expired");
        let mut b = Approvals::new(60_000);
        let r = b.request("y", "y", Risk::External);
        b.deny(&r.id).unwrap();
        assert!(b.approve(&r.id).is_err());
        assert!(b.claim(&r.id).is_err());
    }
}
