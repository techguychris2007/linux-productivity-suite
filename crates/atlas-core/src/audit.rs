//! Append-only audit log (JSON Lines). Every brokered action is recorded, allowed or not.

use crate::json::Value;
use crate::util::now_ms;
use std::io::Write;
use std::path::PathBuf;

pub struct Audit { file: Option<PathBuf>, memory: Vec<Value> }

impl Audit {
    pub fn in_memory() -> Self { Audit { file: None, memory: vec![] } }
    pub fn to_file(file: PathBuf) -> Self { Audit { file: Some(file), memory: vec![] } }

    pub fn record(&mut self, actor: &str, action: &str, detail: Value, outcome: &str) {
        let entry = Value::obj().with("ts", now_ms()).with("actor", actor).with("action", action)
            .with("detail", detail).with("outcome", outcome);
        if let Some(f) = &self.file {
            if let Some(p) = f.parent() { let _ = std::fs::create_dir_all(p); }
            if let Ok(mut fh) = std::fs::OpenOptions::new().create(true).append(true).open(f) {
                let _ = writeln!(fh, "{}", entry.to_json());
            }
        }
        self.memory.push(entry);
        if self.memory.len() > 2000 { self.memory.drain(0..1000); }
    }

    pub fn recent(&self, n: usize) -> Vec<Value> {
        self.memory.iter().rev().take(n).cloned().collect()
    }
}
