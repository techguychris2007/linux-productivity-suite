// Atlas desktop entry point (Tauri 2). It supervises the Rust permission core
// and Python engine, then exposes their loopback APIs to the webview through IPC.

use keyring::Entry;
use reqwest::blocking;
use reqwest::Client;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Error, ErrorKind, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager, RunEvent, State};

const KEYRING_SERVICE: &str = "org.projectatlas.Atlas";

fn valid_provider_kind(kind: &str) -> bool {
    !kind.is_empty()
        && kind
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn read_provider_secret(kind: &str) -> Result<Option<String>, String> {
    if !valid_provider_kind(kind) {
        return Err("Invalid provider name.".into());
    }
    let entry = Entry::new(KEYRING_SERVICE, kind).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write_provider_secret(kind: &str, secret: &str) -> Result<(), String> {
    if !valid_provider_kind(kind) {
        return Err("Invalid provider name.".into());
    }
    let entry = Entry::new(KEYRING_SERVICE, kind).map_err(|error| error.to_string())?;
    entry
        .set_password(secret)
        .map_err(|error| error.to_string())
}

fn restore_provider_secret(kind: &str, previous: Option<&str>) {
    if let Some(secret) = previous {
        let _ = write_provider_secret(kind, secret);
    } else if valid_provider_kind(kind) {
        if let Ok(entry) = Entry::new(KEYRING_SERVICE, kind) {
            let _ = entry.delete_credential();
        }
    }
}

fn legacy_provider_secret(data_dir: &PathBuf, kind: &str) -> Option<String> {
    let settings = fs::read_to_string(data_dir.join("engine/settings.json")).ok()?;
    let json: Value = serde_json::from_str(&settings).ok()?;
    let provider = json.get("provider")?;
    if provider.get("kind")?.as_str()? != kind {
        return None;
    }
    provider.get("api_key")?.as_str().map(str::to_owned)
}

fn configured_provider_kind(data_dir: &PathBuf) -> Option<String> {
    let settings = fs::read_to_string(data_dir.join("engine/settings.json")).ok()?;
    let json: Value = serde_json::from_str(&settings).ok()?;
    let kind = json.get("provider")?.get("kind")?.as_str()?;
    valid_provider_kind(kind).then(|| kind.to_owned())
}

struct AppState {
    data_dir: PathBuf,
    core_port: u16,
    engine_port: u16,
    ui_token: String,
    client: Client,
    children: Mutex<Vec<Child>>,
    shutting_down: Arc<AtomicBool>,
}

fn free_loopback_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn wait_for_port(port: u16, child: &mut Child, label: &str) -> std::io::Result<()> {
    for _ in 0..100 {
        if let Some(status) = child.try_wait()? {
            return Err(Error::new(
                ErrorKind::Other,
                format!("{label} exited during startup ({status})"),
            ));
        }
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(Error::new(
        ErrorKind::TimedOut,
        format!("{label} did not start listening on 127.0.0.1:{port}"),
    ))
}

fn runtime_resources(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let installed = app.path().resource_dir()?;
    if installed.join("bin/atlas-core-host").is_file()
        && installed.join("engine/atlas_engine/devserver.py").is_file()
    {
        return Ok(installed);
    }

    // The build hook also prepares these resources for cargo tauri dev.
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/desktop-resources");
    if development.join("bin/atlas-core-host").is_file()
        && development
            .join("engine/atlas_engine/devserver.py")
            .is_file()
    {
        return Ok(development);
    }

    Err(Error::new(
        ErrorKind::NotFound,
        "Atlas runtime resources are missing; build the desktop app with pnpm build:desktop first",
    )
    .into())
}

fn start_services(app: &tauri::AppHandle) -> Result<AppState, Box<dyn std::error::Error>> {
    let resources = runtime_resources(app)?;
    let core_bin = resources.join("bin/atlas-core-host");
    let engine_python_path = resources.join("engine");
    let data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&data_dir)?;

    let core_port = free_loopback_port()?;
    let engine_port = free_loopback_port()?;
    let runtime_info = data_dir.join("runtime/core.json");
    let _ = fs::remove_file(&runtime_info);

    let mut core = Command::new(core_bin)
        .env("ATLAS_DATA_DIR", &data_dir)
        .env("ATLAS_CORE_PORT", core_port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    let ui_token = (|| -> Result<String, Box<dyn std::error::Error>> {
        for _ in 0..100 {
            if let Some(status) = core.try_wait()? {
                return Err(Error::new(
                    ErrorKind::Other,
                    format!("Atlas core exited during startup ({status})"),
                )
                .into());
            }
            if let Ok(text) = fs::read_to_string(&runtime_info) {
                let info: Value = serde_json::from_str(&text)?;
                if let Some(token) = info["ui_token"].as_str().filter(|t| !t.is_empty()) {
                    wait_for_port(core_port, &mut core, "Atlas core")?;
                    return Ok(token.to_owned());
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
        Err(Error::new(
            ErrorKind::TimedOut,
            "Atlas core did not publish its runtime credentials",
        )
        .into())
    })();

    let ui_token = match ui_token {
        Ok(token) => token,
        Err(error) => {
            let _ = core.kill();
            let _ = core.wait();
            return Err(error);
        }
    };

    let startup_secret = configured_provider_kind(&data_dir).and_then(|kind| {
        read_provider_secret(&kind)
            .ok()
            .flatten()
            .map(|secret| (kind, secret))
    });
    let mut engine_command = Command::new("python3");
    engine_command
        .args(["-m", "atlas_engine.devserver"])
        .env("PYTHONPATH", engine_python_path)
        .env("ATLAS_DATA_DIR", &data_dir)
        .env("ATLAS_ENGINE_PORT", engine_port.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut engine = match engine_command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = core.kill();
            let _ = core.wait();
            return Err(error.into());
        }
    };

    if let Some(mut stdin) = engine.stdin.take() {
        let startup_data = match startup_secret {
            Some((kind, secret)) => json!({ "provider_kind": kind, "api_key": secret }),
            None => json!({}),
        };
        if let Ok(encoded) = serde_json::to_vec(&startup_data) {
            if let Err(error) = stdin.write_all(&encoded) {
                let _ = engine.kill();
                let _ = engine.wait();
                let _ = core.kill();
                let _ = core.wait();
                return Err(error.into());
            }
        }
    }

    if let Err(error) = wait_for_port(engine_port, &mut engine, "Atlas engine") {
        let _ = engine.kill();
        let _ = engine.wait();
        let _ = core.kill();
        let _ = core.wait();
        return Err(error.into());
    }

    Ok(AppState {
        data_dir,
        core_port,
        engine_port,
        ui_token,
        client: Client::new(),
        children: Mutex::new(vec![core, engine]),
        shutting_down: Arc::new(AtomicBool::new(false)),
    })
}

fn api_error(code: &str, message: impl Into<String>) -> Value {
    json!({ "code": code, "message": message.into() })
}

async fn post_core(state: &AppState, cmd: &str, args: Value) -> Result<Value, Value> {
    if cmd.is_empty()
        || cmd
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || c == '.' || c == '_'))
    {
        return Err(api_error("invalid_command", "Invalid Atlas command."));
    }

    let response = state
        .client
        .post(format!("http://127.0.0.1:{}/v1/{cmd}", state.core_port))
        .bearer_auth(&state.ui_token)
        .json(&args)
        .send()
        .await
        .map_err(|error| api_error("core_unreachable", error.to_string()))?;

    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| api_error("bad_response", error.to_string()))?;
    if let Some(error) = body.get("error") {
        return Err(error.clone());
    }
    if !status.is_success() {
        return Err(api_error(
            "core_error",
            format!("Atlas core returned {status}"),
        ));
    }
    Ok(body.get("result").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
async fn core_dispatch(
    state: State<'_, AppState>,
    cmd: String,
    args: Value,
) -> Result<Value, Value> {
    post_core(&state, &cmd, args).await
}

#[tauri::command]
async fn engine_request(
    state: State<'_, AppState>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, Value> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains("://") {
        return Err(api_error("invalid_path", "Invalid Atlas engine route."));
    }
    let url = format!("http://127.0.0.1:{}/v1{}", state.engine_port, path);
    let mut request_body = body.unwrap_or_else(|| json!({}));
    let mut secret_update: Option<(String, Option<String>)> = None;

    if method == "POST" && path == "/providers" {
        let kind = request_body
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| api_error("invalid_provider", "Choose an AI provider first."))?
            .to_owned();
        if !valid_provider_kind(&kind) {
            return Err(api_error("invalid_provider", "Invalid AI provider."));
        }

        let supplied = request_body
            .get("api_key")
            .and_then(Value::as_str)
            .filter(|secret| !secret.trim().is_empty())
            .map(str::to_owned);
        let secret_backed = matches!(kind.as_str(), "gemini" | "anthropic") || supplied.is_some();

        if secret_backed {
            let previous = read_provider_secret(&kind)
                .map_err(|error| api_error("keyring_unavailable", error))?;
            let legacy = if previous.is_none() {
                legacy_provider_secret(&state.data_dir, &kind)
            } else {
                None
            };

            if let Some(secret) = supplied.as_deref() {
                write_provider_secret(&kind, secret)
                    .map_err(|error| api_error("keyring_unavailable", error))?;
                secret_update = Some((kind.clone(), previous.clone()));
                request_body["api_key"] = json!(secret);
            } else if let Some(secret) = previous.as_deref() {
                request_body["api_key"] = json!(secret);
            } else if let Some(secret) = legacy.as_deref() {
                write_provider_secret(&kind, secret)
                    .map_err(|error| api_error("keyring_unavailable", error))?;
                secret_update = Some((kind.clone(), None));
                request_body["api_key"] = json!(secret);
            } else {
                request_body
                    .as_object_mut()
                    .map(|object| object.remove("api_key"));
            }
        }
        request_body["_atlas_keyring"] = json!(true);
    }

    let request = match method.as_str() {
        "GET" => state.client.get(url),
        "POST" => state.client.post(url).json(&request_body),
        _ => {
            return Err(api_error(
                "invalid_method",
                "Unsupported Atlas engine method.",
            ))
        }
    };

    let response = match request.bearer_auth(&state.ui_token).send().await {
        Ok(response) => response,
        Err(error) => {
            if let Some((kind, previous)) = secret_update.as_ref() {
                restore_provider_secret(kind, previous.as_deref());
            }
            return Err(api_error("engine_unreachable", error.to_string()));
        }
    };
    let status = response.status();
    let payload = match response.json::<Value>().await {
        Ok(payload) => payload,
        Err(error) => {
            if let Some((kind, previous)) = secret_update.as_ref() {
                restore_provider_secret(kind, previous.as_deref());
            }
            return Err(api_error("bad_response", error.to_string()));
        }
    };
    if let Some(error) = payload.get("error") {
        if let Some((kind, previous)) = secret_update.as_ref() {
            restore_provider_secret(kind, previous.as_deref());
        }
        return Err(error.clone());
    }
    if !status.is_success() {
        if let Some((kind, previous)) = secret_update.as_ref() {
            restore_provider_secret(kind, previous.as_deref());
        }
        return Err(api_error(
            "engine_error",
            format!("Atlas engine returned {status}"),
        ));
    }
    Ok(payload.get("result").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| path.to_string())
}

fn forward_engine_events(
    app: tauri::AppHandle,
    port: u16,
    token: String,
    shutting_down: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let client = blocking::Client::new();
        let mut last_seq = 0_u64;

        while !shutting_down.load(Ordering::Relaxed) {
            let url = format!("http://127.0.0.1:{port}/v1/events?after={last_seq}&token={token}");
            if let Ok(response) = client.get(url).send() {
                let mut reader = BufReader::new(response);
                let mut line = String::new();
                let mut data = String::new();

                while !shutting_down.load(Ordering::Relaxed) {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) if line == "\r\n" || line == "\n" => {
                            if !data.is_empty() {
                                if let Ok(event) = serde_json::from_str::<Value>(&data) {
                                    if let Some(seq) = event.get("seq").and_then(Value::as_u64) {
                                        last_seq = last_seq.max(seq);
                                    }
                                    let _ = app.emit("engine-event", event);
                                }
                                data.clear();
                            }
                        }
                        Ok(_) => {
                            if let Some(value) = line.strip_prefix("data:") {
                                data.push_str(value.trim());
                            }
                        }
                    }
                }
            }

            if !shutting_down.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_secs(2));
            }
        }
    });
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = start_services(app.handle())?;
            forward_engine_events(
                app.handle().clone(),
                state.engine_port,
                state.ui_token.clone(),
                state.shutting_down.clone(),
            );
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core_dispatch,
            engine_request,
            pick_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while building Atlas");

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit) {
            let state = handle.state::<AppState>();
            state.shutting_down.store(true, Ordering::Relaxed);
            if let Ok(mut children) = state.children.lock() {
                for child in children.iter_mut() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            };
        }
    });
}
