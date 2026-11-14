//! Folder grants and path confinement.
//!
//! The AI (and every other caller) addresses files as `(grant_id, relative_path)`.
//! Absolute paths outside a granted root can never be produced by this module.

use crate::json::{self, Value};
use crate::util::random_token;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access { Read, ReadWrite }

impl Access {
    pub fn as_str(&self) -> &'static str { match self { Access::Read => "read", Access::ReadWrite => "readwrite" } }
    pub fn parse(s: &str) -> Option<Self> { match s { "read" => Some(Access::Read), "readwrite" => Some(Access::ReadWrite), _ => None } }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Grant {
    pub id: String,
    pub label: String,
    pub root: PathBuf,
    pub access: Access,
    /// Whether Atlas AI may use this grant (users can grant a folder for manual use only).
    pub ai_allowed: bool,
}

impl Grant {
    pub fn to_value(&self) -> Value {
        Value::obj().with("id", self.id.as_str()).with("label", self.label.as_str())
            .with("root", self.root.to_string_lossy().to_string())
            .with("access", self.access.as_str()).with("ai_allowed", self.ai_allowed)
    }
    fn from_value(v: &Value) -> Option<Self> {
        Some(Grant {
            id: v.str_field("id")?.to_string(),
            label: v.str_field("label")?.to_string(),
            root: PathBuf::from(v.str_field("root")?),
            access: Access::parse(v.str_field("access")?)?,
            ai_allowed: v.get("ai_allowed").and_then(|b| b.as_bool()).unwrap_or(false),
        })
    }
}

#[derive(Debug, PartialEq)]
pub enum PathError {
    UnknownGrant,
    NotAllowedForAi,
    ReadOnly,
    InvalidPath(String),
    Escapes,
    Io(String),
}

impl std::fmt::Display for PathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathError::UnknownGrant => write!(f, "unknown folder grant"),
            PathError::NotAllowedForAi => write!(f, "this folder is not shared with Atlas AI"),
            PathError::ReadOnly => write!(f, "this folder was granted read-only"),
            PathError::InvalidPath(s) => write!(f, "invalid path: {}", s),
            PathError::Escapes => write!(f, "path escapes the granted folder"),
            PathError::Io(s) => write!(f, "{}", s),
        }
    }
}

/// Paths Atlas refuses to grant even if a user asks (credential stores and system roots).
const FORBIDDEN_ROOTS: &[&str] = &["/", "/etc", "/usr", "/bin", "/sbin", "/boot", "/proc", "/sys", "/dev", "/var", "/root"];
const FORBIDDEN_NAMES: &[&str] = &[".ssh", ".gnupg", ".password-store", ".aws", ".kube", "keyrings"];

pub struct GrantStore {
    file: Option<PathBuf>,
    grants: Vec<Grant>,
}

impl GrantStore {
    pub fn in_memory() -> Self { GrantStore { file: None, grants: vec![] } }

    pub fn load(file: PathBuf) -> Result<Self, String> {
        let grants = match std::fs::read_to_string(&file) {
            Ok(s) => json::parse(&s)?.as_arr().map(|a| a.iter().filter_map(Grant::from_value).collect()).unwrap_or_default(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
            Err(e) => return Err(e.to_string()),
        };
        Ok(GrantStore { file: Some(file), grants })
    }

    fn save(&self) -> Result<(), String> {
        if let Some(f) = &self.file {
            if let Some(p) = f.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
            let tmp = f.with_extension("tmp");
            std::fs::write(&tmp, Value::Arr(self.grants.iter().map(|g| g.to_value()).collect()).to_json()).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, f).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn list(&self) -> &[Grant] { &self.grants }
    pub fn get(&self, id: &str) -> Option<&Grant> { self.grants.iter().find(|g| g.id == id) }

    pub fn add(&mut self, root: &Path, label: &str, access: Access, ai_allowed: bool) -> Result<Grant, PathError> {
        let canon = root.canonicalize().map_err(|e| PathError::Io(e.to_string()))?;
        if !canon.is_dir() { return Err(PathError::InvalidPath("not a directory".into())); }
        let s = canon.to_string_lossy();
        if FORBIDDEN_ROOTS.iter().any(|r| s == *r) { return Err(PathError::InvalidPath("system folders cannot be granted".into())); }
        if canon.components().any(|c| matches!(c, Component::Normal(n) if FORBIDDEN_NAMES.iter().any(|f| n == *f))) {
            return Err(PathError::InvalidPath("credential folders cannot be granted".into()));
        }
        if let Some(existing) = self.grants.iter().find(|g| g.root == canon) { return Ok(existing.clone()); }
        let g = Grant { id: format!("g_{}", &random_token()[..12]), label: label.to_string(), root: canon, access, ai_allowed };
        self.grants.push(g.clone());
        self.save().map_err(PathError::Io)?;
        Ok(g)
    }

    pub fn revoke(&mut self, id: &str) -> Result<bool, String> {
        let before = self.grants.len();
        self.grants.retain(|g| g.id != id);
        let changed = before != self.grants.len();
        if changed { self.save()?; }
        Ok(changed)
    }

    /// Resolve a grant-relative path to an absolute path guaranteed to be inside the grant root.
    /// `for_ai`: enforce `ai_allowed`. `write`: enforce ReadWrite.
    pub fn resolve(&self, grant_id: &str, rel: &str, write: bool, for_ai: bool) -> Result<(Grant, PathBuf), PathError> {
        let g = self.get(grant_id).ok_or(PathError::UnknownGrant)?.clone();
        if for_ai && !g.ai_allowed { return Err(PathError::NotAllowedForAi); }
        if write && g.access != Access::ReadWrite { return Err(PathError::ReadOnly); }
        let rel_path = Path::new(rel);
        if rel_path.is_absolute() { return Err(PathError::InvalidPath("absolute paths are not accepted".into())); }
        if rel.contains('\0') { return Err(PathError::InvalidPath("NUL byte".into())); }
        let mut joined = g.root.clone();
        for c in rel_path.components() {
            match c {
                Component::Normal(n) => joined.push(n),
                Component::CurDir => {}
                Component::ParentDir => return Err(PathError::Escapes),
                _ => return Err(PathError::InvalidPath("unsupported path component".into())),
            }
        }
        // Defeat symlink escapes: canonicalize the deepest existing ancestor and check containment.
        let mut probe = joined.clone();
        let mut tail: Vec<std::ffi::OsString> = vec![];
        loop {
            match probe.canonicalize() {
                Ok(c) => {
                    if !c.starts_with(&g.root) { return Err(PathError::Escapes); }
                    let mut full = c;
                    for t in tail.iter().rev() { full.push(t); }
                    return Ok((g, full));
                }
                Err(_) => {
                    let name = probe.file_name().ok_or(PathError::Escapes)?.to_os_string();
                    tail.push(name);
                    if !probe.pop() { return Err(PathError::Escapes); }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("atlas-perm-{}-{}", name, crate::util::random_token()[..8].to_string()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn confines_paths() {
        let root = tmpdir("confine");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        let mut s = GrantStore::in_memory();
        let g = s.add(&root, "Test", Access::ReadWrite, true).unwrap();
        assert!(s.resolve(&g.id, "docs/a.txt", true, true).is_ok());
        assert!(s.resolve(&g.id, "new/deep/file.txt", true, true).is_ok());
        assert_eq!(s.resolve(&g.id, "../x", false, true).unwrap_err(), PathError::Escapes);
        assert_eq!(s.resolve(&g.id, "docs/../../x", false, true).unwrap_err(), PathError::Escapes);
        assert!(matches!(s.resolve(&g.id, "/etc/passwd", false, true).unwrap_err(), PathError::InvalidPath(_)));
        assert_eq!(s.resolve("nope", "a", false, true).unwrap_err(), PathError::UnknownGrant);
    }

    #[test]
    fn blocks_symlink_escape() {
        let root = tmpdir("symlink");
        let outside = tmpdir("outside");
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let mut s = GrantStore::in_memory();
        let g = s.add(&root, "T", Access::ReadWrite, true).unwrap();
        assert_eq!(s.resolve(&g.id, "link/secret.txt", false, true).unwrap_err(), PathError::Escapes);
    }

    #[test]
    fn enforces_access_and_ai_flag() {
        let root = tmpdir("access");
        let mut s = GrantStore::in_memory();
        let g = s.add(&root, "T", Access::Read, false).unwrap();
        assert_eq!(s.resolve(&g.id, "a", true, false).unwrap_err(), PathError::ReadOnly);
        assert_eq!(s.resolve(&g.id, "a", false, true).unwrap_err(), PathError::NotAllowedForAi);
        assert!(s.resolve(&g.id, "a", false, false).is_ok());
    }

    #[test]
    fn refuses_dangerous_roots() {
        let mut s = GrantStore::in_memory();
        assert!(s.add(Path::new("/etc"), "x", Access::Read, true).is_err());
        let root = tmpdir("ssh");
        std::fs::create_dir_all(root.join(".ssh")).unwrap();
        assert!(s.add(&root.join(".ssh"), "x", Access::Read, true).is_err());
    }

    #[test]
    fn persists() {
        let root = tmpdir("persist");
        let file = root.join("state/grants.json");
        let id = {
            let mut s = GrantStore::load(file.clone()).unwrap();
            s.add(&root, "P", Access::ReadWrite, true).unwrap().id
        };
        let s2 = GrantStore::load(file).unwrap();
        assert_eq!(s2.get(&id).unwrap().label, "P");
    }
}
