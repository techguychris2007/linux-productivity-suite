//! atlas-core-host: serves `Broker::dispatch` on 127.0.0.1 for the AI engine sidecar
//! and, during browser-based development, for the UI.
//!
//! Auth: two bearer tokens. The UI token maps to `Caller::Ui`, the engine token to `Caller::Engine`.
//! Tokens come from ATLAS_UI_TOKEN / ATLAS_ENGINE_TOKEN, or are generated and written to
//! `$ATLAS_DATA_DIR/runtime/core.json` with 0600 permissions.
//!
//! Env: ATLAS_DATA_DIR (default ~/.local/share/atlas), ATLAS_CORE_PORT (default 47801),
//!      ATLAS_DEV_ORIGIN (CORS origin allowed for the dev UI, e.g. http://127.0.0.1:5173).

use atlas_core::json::{self, Value};
use atlas_core::util::{ct_eq, random_token};
use atlas_core::{Broker, Caller};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

const MAX_BODY: usize = 16 * 1024 * 1024;

struct Ctx { broker: Mutex<Broker>, ui_token: String, engine_token: String, origin: Option<String> }

fn main() {
    let data_dir = std::env::var("ATLAS_DATA_DIR").map(std::path::PathBuf::from).unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        std::path::PathBuf::from(home).join(".local/share/atlas")
    });
    let port: u16 = std::env::var("ATLAS_CORE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(47801);
    let ui_token = std::env::var("ATLAS_UI_TOKEN").unwrap_or_else(|_| random_token());
    let engine_token = std::env::var("ATLAS_ENGINE_TOKEN").unwrap_or_else(|_| random_token());
    let origin = std::env::var("ATLAS_DEV_ORIGIN").ok();

    let broker = Broker::new(data_dir.clone()).expect("cannot open Atlas data directory");
    let runtime = data_dir.join("runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let info = Value::obj().with("port", port as u64).with("ui_token", ui_token.as_str()).with("engine_token", engine_token.as_str());
    let info_path = runtime.join("core.json");
    std::fs::write(&info_path, info.to_json()).unwrap();
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&info_path, std::fs::Permissions::from_mode(0o600)); }

    let listener = TcpListener::bind(("127.0.0.1", port)).expect("cannot bind core port");
    eprintln!("atlas-core-host {} listening on 127.0.0.1:{} (runtime info: {})", atlas_core::VERSION, port, info_path.display());
    let ctx = Arc::new(Ctx { broker: Mutex::new(broker), ui_token, engine_token, origin });
    for stream in listener.incoming().flatten() {
        let ctx = ctx.clone();
        std::thread::spawn(move || { let _ = handle(stream, &ctx); });
    }
}

fn respond(s: &mut TcpStream, status: &str, body: &str, ctx: &Ctx, req_origin: Option<&str>) -> std::io::Result<()> {
    let mut h = format!("HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n", status, body.len());
    if let (Some(allowed), Some(o)) = (&ctx.origin, req_origin) {
        if allowed == o {
            h.push_str(&format!("Access-Control-Allow-Origin: {}\r\nAccess-Control-Allow-Headers: authorization, content-type\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nVary: Origin\r\n", o));
        }
    }
    h.push_str("\r\n");
    s.write_all(h.as_bytes())?; s.write_all(body.as_bytes())
}

fn handle(mut stream: TcpStream, ctx: &Ctx) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
    let (mut len, mut auth, mut origin, mut host) = (0usize, None::<String>, None::<String>, None::<String>);
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" { break; }
        if let Some((k, v)) = h.split_once(':') {
            let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_string());
            match k.as_str() { "content-length" => len = v.parse().unwrap_or(0), "authorization" => auth = Some(v), "origin" => origin = Some(v), "host" => host = Some(v), _ => {} }
        }
    }
    let o = origin.as_deref();
    // DNS-rebinding defence: only accept loopback Host headers.
    if !host.as_deref().map(|h| h.starts_with("127.0.0.1:") || h.starts_with("localhost:")).unwrap_or(false) {
        return respond(&mut stream, "403 Forbidden", r#"{"error":{"code":"forbidden","message":"bad host"}}"#, ctx, o);
    }
    if method == "OPTIONS" { return respond(&mut stream, "204 No Content", "", ctx, o); }
    if method != "POST" || !path.starts_with("/v1/") {
        return respond(&mut stream, "404 Not Found", r#"{"error":{"code":"not_found","message":"use POST /v1/<command>"}}"#, ctx, o);
    }
    if len > MAX_BODY { return respond(&mut stream, "413 Payload Too Large", r#"{"error":{"code":"too_large","message":"body too large"}}"#, ctx, o); }
    let caller = match auth.as_deref().and_then(|a| a.strip_prefix("Bearer ")) {
        Some(t) if ct_eq(t, &ctx.ui_token) => Caller::Ui,
        Some(t) if ct_eq(t, &ctx.engine_token) => Caller::Engine,
        _ => return respond(&mut stream, "401 Unauthorized", r#"{"error":{"code":"unauthorized","message":"missing or invalid token"}}"#, ctx, o),
    };
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    let args = if body.is_empty() { Value::obj() } else {
        match std::str::from_utf8(&body).map_err(|e| e.to_string()).and_then(json::parse) {
            Ok(v) => v,
            Err(e) => return respond(&mut stream, "400 Bad Request", &Value::obj().with("error", Value::obj().with("code", "bad_json").with("message", e)).to_json(), ctx, o),
        }
    };
    let cmd = &path[4..];
    let result = ctx.broker.lock().unwrap().dispatch(caller, cmd, &args);
    match result {
        Ok(v) => respond(&mut stream, "200 OK", &Value::obj().with("result", v).to_json(), ctx, o),
        Err(e) => {
            let status = match e.code { "forbidden" => "403 Forbidden", "not_found" | "unknown_command" => "404 Not Found", "approval_required" => "409 Conflict", "conflict" => "409 Conflict", _ => "400 Bad Request" };
            respond(&mut stream, status, &Value::obj().with("error", e.to_value()).to_json(), ctx, o)
        }
    }
}
