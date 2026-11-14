use atlas_core::json::Value;
use atlas_core::{Broker, Caller};
use std::path::PathBuf;

fn setup(name: &str) -> (Broker, PathBuf, String) {
    let base = std::env::temp_dir().join(format!("atlas-broker-{}-{}", name, &atlas_core::util::random_token()[..8]));
    let root = base.join("Documents");
    std::fs::create_dir_all(&root).unwrap();
    let mut b = Broker::new(base.join("data")).unwrap();
    let g = b.dispatch(Caller::Ui, "grants.add", &Value::obj().with("path", root.to_string_lossy().to_string()).with("ai_allowed", true)).unwrap();
    let id = g.str_field("id").unwrap().to_string();
    (b, root, id)
}

#[test]
fn engine_cannot_grant_or_approve() {
    let (mut b, _, _) = setup("caller");
    let e = b.dispatch(Caller::Engine, "grants.add", &Value::obj().with("path", "/tmp")).unwrap_err();
    assert_eq!(e.code, "forbidden");
    let e = b.dispatch(Caller::Engine, "approvals.approve", &Value::obj().with("id", "x")).unwrap_err();
    assert_eq!(e.code, "forbidden");
}

#[test]
fn write_read_backup_roundtrip() {
    let (mut b, root, g) = setup("rw");
    let w = |c: &str, ow: bool| Value::obj().with("grant", g.as_str()).with("path", "notes/a.md").with("content", c).with("overwrite", ow);
    b.dispatch(Caller::Engine, "fs.write_text", &w("v1", false)).unwrap();
    assert_eq!(b.dispatch(Caller::Engine, "fs.write_text", &w("v2", false)).unwrap_err().code, "io");
    let r = b.dispatch(Caller::Engine, "fs.write_text", &w("v2", true)).unwrap();
    let backup = r.str_field("backup").unwrap();
    assert_eq!(std::fs::read_to_string(backup).unwrap(), "v1");
    assert_eq!(std::fs::read_to_string(root.join("notes/a.md")).unwrap(), "v2");
    let read = b.dispatch(Caller::Engine, "fs.read_text", &Value::obj().with("grant", g.as_str()).with("path", "notes/a.md")).unwrap();
    assert_eq!(read.str_field("content"), Some("v2"));
    let found = b.dispatch(Caller::Ui, "fs.search", &Value::obj().with("grant", g.as_str()).with("query", "A.M")).unwrap();
    assert_eq!(found.as_arr().unwrap().len(), 1);
}

#[test]
fn ai_trash_requires_user_approval() {
    let (mut b, root, g) = setup("trash");
    std::fs::write(root.join("old.txt"), "x").unwrap();
    let args = Value::obj().with("grant", g.as_str()).with("path", "old.txt");
    let e = b.dispatch(Caller::Engine, "fs.trash", &args).unwrap_err();
    assert_eq!(e.code, "approval_required");
    let req = e.data.str_field("request_id").unwrap().to_string();
    assert!(root.join("old.txt").exists(), "nothing happens before approval");
    // Engine cannot see the token until the user approves.
    let c = b.dispatch(Caller::Engine, "approvals.claim", &Value::obj().with("id", req.as_str())).unwrap();
    assert_eq!(c.get("token"), Some(&Value::Null));
    b.dispatch(Caller::Ui, "approvals.approve", &Value::obj().with("id", req.as_str())).unwrap();
    let c = b.dispatch(Caller::Engine, "approvals.claim", &Value::obj().with("id", req.as_str())).unwrap();
    let token = c.str_field("token").unwrap().to_string();
    // A token cannot be reused for a different file.
    let other = Value::obj().with("grant", g.as_str()).with("path", "other.txt").with("approval_token", token.as_str());
    assert_eq!(b.dispatch(Caller::Engine, "fs.trash", &other).unwrap_err().code, "approval_required");
    let ok = b.dispatch(Caller::Engine, "fs.trash", &args.clone().with("approval_token", token.as_str())).unwrap();
    assert!(!root.join("old.txt").exists());
    assert!(PathBuf::from(ok.str_field("trashed_to").unwrap()).exists(), "moved to Atlas trash, not deleted");
    let audit = b.dispatch(Caller::Ui, "audit.recent", &Value::obj()).unwrap();
    assert!(audit.as_arr().unwrap().iter().any(|e| e.str_field("outcome") == Some("approval_required")));
}

#[test]
fn ai_only_sees_ai_allowed_grants() {
    let (mut b, root, _) = setup("visibility");
    let private = root.parent().unwrap().join("Private");
    std::fs::create_dir_all(&private).unwrap();
    let pg = b.dispatch(Caller::Ui, "grants.add", &Value::obj().with("path", private.to_string_lossy().to_string()).with("ai_allowed", false)).unwrap();
    let list = b.dispatch(Caller::Engine, "grants.list", &Value::obj()).unwrap();
    assert_eq!(list.as_arr().unwrap().len(), 1);
    let e = b.dispatch(Caller::Engine, "fs.list", &Value::obj().with("grant", pg.str_field("id").unwrap())).unwrap_err();
    assert_eq!(e.code, "forbidden");
}

#[test]
fn binary_roundtrip_with_backup() {
    let (mut b, root, g) = setup("bin");
    let data = atlas_core::b64::encode(&[0u8, 1, 2, 250, 255]);
    let w = Value::obj().with("grant", g.as_str()).with("path", "out/x.bin").with("data", data.as_str());
    b.dispatch(Caller::Engine, "fs.write_base64", &w).unwrap();
    assert_eq!(std::fs::read(root.join("out/x.bin")).unwrap(), vec![0u8, 1, 2, 250, 255]);
    assert_eq!(b.dispatch(Caller::Engine, "fs.write_base64", &w).unwrap_err().code, "io", "no silent overwrite");
    let r = b.dispatch(Caller::Engine, "fs.write_base64", &w.clone().with("overwrite", true)).unwrap();
    assert!(r.str_field("backup").is_some());
    let back = b.dispatch(Caller::Engine, "fs.read_base64", &Value::obj().with("grant", g.as_str()).with("path", "out/x.bin")).unwrap();
    assert_eq!(back.str_field("data"), Some(data.as_str()));
}

#[test]
fn only_ui_can_skip_backup() {
    let (mut b, _root, g) = setup("nobackup");
    let w = |who| Value::obj().with("grant", g.as_str()).with("path", "d.atlasdoc").with("content", who).with("overwrite", true).with("backup", false);
    b.dispatch(Caller::Ui, "fs.write_text", &w("v1")).unwrap();
    assert!(b.dispatch(Caller::Ui, "fs.write_text", &w("v2")).unwrap().get("backup") == Some(&Value::Null));
    assert!(b.dispatch(Caller::Engine, "fs.write_text", &w("v3")).unwrap().str_field("backup").is_some(), "AI edits always backed up");
}
