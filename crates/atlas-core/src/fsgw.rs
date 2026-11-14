//! Filesystem gateway. All operations go through `GrantStore::resolve`.
//! Overwrites are backed up; deletions move files into Atlas's own trash (never unlink).

use crate::json::Value;
use crate::util::now_ms;
use std::path::{Path, PathBuf};

pub const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;

fn io(e: std::io::Error) -> String { e.to_string() }

pub fn entry_value(root: &Path, p: &Path) -> Value {
    let md = std::fs::symlink_metadata(p).ok();
    let rel = p.strip_prefix(root).unwrap_or(p).to_string_lossy().to_string();
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let kind = match &md { Some(m) if m.is_dir() => "dir", Some(m) if m.file_type().is_symlink() => "symlink", Some(_) => "file", None => "missing" };
    let modified = md.as_ref().and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
    Value::obj().with("name", name).with("path", rel).with("kind", kind)
        .with("size", md.as_ref().map(|m| m.len()).unwrap_or(0)).with("modified_ms", modified)
}

pub fn list(root: &Path, dir: &Path, show_hidden: bool) -> Result<Vec<Value>, String> {
    let mut out = vec![];
    for e in std::fs::read_dir(dir).map_err(io)? {
        let e = e.map_err(io)?;
        let name = e.file_name().to_string_lossy().to_string();
        if !show_hidden && name.starts_with('.') { continue; }
        out.push(entry_value(root, &e.path()));
    }
    out.sort_by(|a, b| {
        let ka = (a.str_field("kind") != Some("dir"), a.str_field("name").unwrap_or("").to_lowercase());
        let kb = (b.str_field("kind") != Some("dir"), b.str_field("name").unwrap_or("").to_lowercase());
        ka.cmp(&kb)
    });
    Ok(out)
}

pub fn read_text(p: &Path, max: u64) -> Result<(String, bool), String> {
    let md = std::fs::metadata(p).map_err(io)?;
    if !md.is_file() { return Err("not a file".into()); }
    let limit = max.min(MAX_READ_BYTES);
    let bytes = {
        use std::io::Read;
        let mut f = std::fs::File::open(p).map_err(io)?;
        let mut buf = Vec::new();
        f.by_ref().take(limit).read_to_end(&mut buf).map_err(io)?;
        buf
    };
    let truncated = md.len() > limit;
    String::from_utf8(bytes).map(|s| (s, truncated)).map_err(|_| "file is not UTF-8 text".into())
}

/// Write text atomically. If the file exists, a backup copy is stored first and its location returned.
pub fn write_text(p: &Path, content: &str, backups: &Path, overwrite: bool) -> Result<Option<PathBuf>, String> {
    let mut backup = None;
    if p.exists() {
        if !overwrite { return Err("file already exists".into()); }
        if !p.is_file() { return Err("target is not a file".into()); }
        let dest = backups.join(format!("{}", now_ms())).join(p.file_name().unwrap_or_default());
        std::fs::create_dir_all(dest.parent().unwrap()).map_err(io)?;
        std::fs::copy(p, &dest).map_err(io)?;
        backup = Some(dest);
    }
    if let Some(parent) = p.parent() { std::fs::create_dir_all(parent).map_err(io)?; }
    let tmp = p.with_file_name(format!(".{}.atlas-tmp", p.file_name().unwrap_or_default().to_string_lossy()));
    std::fs::write(&tmp, content).map_err(io)?;
    std::fs::rename(&tmp, p).map_err(io)?;
    Ok(backup)
}

pub fn trash(p: &Path, trash_dir: &Path) -> Result<PathBuf, String> {
    if !p.exists() { return Err("no such file or folder".into()); }
    let dest = trash_dir.join(format!("{}", now_ms())).join(p.file_name().unwrap_or_default());
    std::fs::create_dir_all(dest.parent().unwrap()).map_err(io)?;
    std::fs::rename(p, &dest).or_else(|_| {
        // Cross-device: copy then remove only for regular files.
        if p.is_file() { std::fs::copy(p, &dest).and_then(|_| std::fs::remove_file(p)).map_err(io) } else { Err("cannot move folder across devices".into()) }
    })?;
    Ok(dest)
}

pub fn search(root: &Path, start: &Path, query: &str, limit: usize) -> Vec<Value> {
    let q = query.to_lowercase();
    let mut out = vec![];
    let mut stack = vec![(start.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            visited += 1;
            if visited > 50_000 || out.len() >= limit { return out; }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') { continue; }
            let path = e.path();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if name.to_lowercase().contains(&q) { out.push(entry_value(root, &path)); }
            if is_dir && depth < 8 { stack.push((path, depth + 1)); }
        }
    }
    out
}
