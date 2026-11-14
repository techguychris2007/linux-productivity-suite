// Atlas desktop entry point (Tauri 2).
// STATUS: written against the Tauri 2 API but NOT YET COMPILED — the Milestone 1 build environment
// had no access to crates.io. Compile on Ubuntu with network access: `cargo tauri build`.
//
// Responsibilities:
//  - Owns the security core in-process (UI commands go straight to Broker::dispatch as Caller::Ui).
//  - Starts atlas-core-host (engine-facing API) and the Python engine as sidecars; supervises them.
//  - Proxies UI → engine requests and forwards engine SSE events to the webview as "engine-event".

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use atlas_core::json::{self, Value};
use atlas_core::{Broker, Caller};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

struct AppState { broker: Mutex<Broker>, engine_port: u16, ui_token: String }

fn to_serde(v: &Value) -> serde_json::Value { serde_json::from_str(&v.to_json()).unwrap_or(serde_json::Value::Null) }
fn from_serde(v: &serde_json::Value) -> Value { json::parse(&v.to_string()).unwrap_or(Value::Null) }

#[tauri::command]
fn core_dispatch(state: State<AppState>, cmd: String, args: serde_json::Value) -> Result<serde_json::Value, serde_json::Value> {
    let mut b = state.broker.lock().unwrap();
    b.dispatch(Caller::Ui, &cmd, &from_serde(&args)).map(|v| to_serde(&v)).map_err(|e| to_serde(&e.to_value()))
}

#[tauri::command]
async fn engine_request(state: State<'_, AppState>, method: String, path: String, body: Option<serde_json::Value>) -> Result<serde_json::Value, serde_json::Value> {
    let url = format!("http://127.0.0.1:{}/v1{}", state.engine_port, path);
    let client = reqwest::Client::new();
    let req = if method == "POST" { client.post(&url).json(&body.unwrap_or(serde_json::json!({}))) } else { client.get(&url) };
    let resp = req.bearer_auth(&state.ui_token).send().await
        .map_err(|e| serde_json::json!({"code": "engine_unreachable", "message": e.to_string()}))?;
    let v: serde_json::Value = resp.json().await.map_err(|e| serde_json::json!({"code": "bad_response", "message": e.to_string()}))?;
    match v.get("error") { Some(err) => Err(err.clone()), None => Ok(v.get("result").cloned().unwrap_or_default()) }
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().file().blocking_pick_folder().map(|p| p.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let broker = Broker::new(data_dir.clone()).map_err(|e| e.to_string())?;
            // TODO(M2): spawn atlas-core-host + atlas-engine sidecars (tauri_plugin_shell sidecar API),
            // read runtime/core.json for the ui_token, and stream engine SSE into `app.emit("engine-event", ..)`.
            let ui_token = String::new();
            app.manage(AppState { broker: Mutex::new(broker), engine_port: 47802, ui_token });
            let _ = app.emit("atlas-ready", ());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![core_dispatch, engine_request, pick_folder])
        .run(tauri::generate_context!())
        .expect("error while running Atlas");
}
