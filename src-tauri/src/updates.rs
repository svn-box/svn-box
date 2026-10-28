use crate::{model::*, state::Backend};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

pub struct Updates {
    state: Mutex<Value>,
    pending: AtomicBool,
    available: Mutex<Option<Update>>,
    downloaded: Mutex<Option<Vec<u8>>>,
}

struct Pending<'a>(&'a AtomicBool);

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Updates {
    pub fn new() -> Self {
        let disabled = cfg!(any(debug_assertions, feature = "native-smoke"));
        let mut state = json!({
            "phase": if disabled { "disabled" } else { "idle" },
            "currentVersion": env!("CARGO_PKG_VERSION"),
            "revision": 0,
        });
        if disabled {
            state["messageKey"] = json!("updates.developmentDisabled");
        }
        Self {
            state: Mutex::new(state),
            pending: AtomicBool::new(false),
            available: Mutex::new(None),
            downloaded: Mutex::new(None),
        }
    }

    pub fn snapshot(&self) -> Value {
        self.state.lock().unwrap().clone()
    }

    fn change(&self, app: &AppHandle, change: impl FnOnce(&mut Value)) {
        let value = {
            let mut state = self.state.lock().unwrap();
            change(&mut state);
            state["revision"] = json!(state["revision"].as_u64().unwrap_or(0) + 1);
            state.clone()
        };
        let _ = app.emit("svnbox:app-update", value);
    }

    fn fail(&self, app: &AppHandle, phase: &str, key: &str) {
        self.change(app, |s| {
            s["phase"] = json!(phase);
            s["messageKey"] = json!(key);
        });
    }
}

pub async fn act(app: &AppHandle, backend: &Backend, action: &str) -> Result<Value> {
    let updates = app.state::<Updates>();
    if action == "status" {
        return Ok(updates.snapshot());
    }
    if action == "release" {
        let version = s(&updates.snapshot(), "version").to_owned();
        let url = if version.is_empty() {
            "https://github.com/svn-box/svn-box/releases/latest".into()
        } else {
            format!("https://github.com/svn-box/svn-box/releases/tag/v{version}")
        };
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| error_message("network", "Cannot open the release page"))?;
        return Ok(updates.snapshot());
    }
    if s(&updates.snapshot(), "phase") == "disabled"
        || updates
            .pending
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
    {
        return Ok(updates.snapshot());
    }
    let _pending = Pending(&updates.pending);
    match action {
        "check" => {
            if updates.downloaded.lock().unwrap().is_some() {
                return Ok(updates.snapshot());
            }
            updates.change(app, |s| {
                s["phase"] = json!("checking");
                let o = s.as_object_mut().unwrap();
                o.remove("version");
                o.remove("percent");
                o.remove("messageKey");
            });
            let updater = app
                .updater_builder()
                .timeout(std::time::Duration::from_secs(30))
                .build();
            match updater {
                Ok(updater) => match updater.check().await {
                    Ok(Some(update))
                        if regex::Regex::new(r"^\d+\.\d+\.\d+$")
                            .unwrap()
                            .is_match(&update.version) =>
                    {
                        let version = update.version.clone();
                        *updates.available.lock().unwrap() = Some(update);
                        updates.change(app, |s| {
                            s["phase"] = json!("available");
                            s["version"] = json!(version);
                        });
                    }
                    Ok(None) => updates.change(app, |s| s["phase"] = json!("current")),
                    _ => updates.fail(app, "error", "updates.checkFailed"),
                },
                Err(_) => updates.fail(app, "error", "updates.checkFailed"),
            }
        }
        "download" => {
            if !["available", "error"].contains(&s(&updates.snapshot(), "phase")) {
                return Ok(updates.snapshot());
            }
            let update = updates.available.lock().unwrap().clone();
            if let Some(update) = update {
                updates.change(app, |s| {
                    s["phase"] = json!("downloading");
                    s["percent"] = json!(0);
                    s.as_object_mut().unwrap().remove("messageKey");
                });
                let mut received = 0_u64;
                let outcome = update
                    .download(
                        |chunk, total| {
                            received = received.saturating_add(chunk as u64);
                            if let Some(total) = total.filter(|v| *v > 0) {
                                updates.change(app, |s| {
                                    s["percent"] = json!(((received as f64 / total as f64) * 100.0)
                                        .clamp(0.0, 100.0))
                                });
                            }
                        },
                        || {},
                    )
                    .await;
                match outcome {
                    Ok(bytes) => {
                        *updates.downloaded.lock().unwrap() = Some(bytes);
                        updates.change(app, |s| {
                            s["phase"] = json!("downloaded");
                            s["percent"] = json!(100);
                        });
                    }
                    Err(_) => updates.fail(app, "error", "updates.downloadFailed"),
                }
            }
        }
        "install" => {
            if s(&updates.snapshot(), "phase") != "downloaded" {
                return Ok(updates.snapshot());
            }
            backend.0.accepting.store(false, Ordering::SeqCst);
            if backend.busy() || backend.0.pending_writes.load(Ordering::SeqCst) > 0 {
                backend.0.accepting.store(true, Ordering::SeqCst);
                updates.fail(app, "downloaded", "updates.busy");
                return Ok(updates.snapshot());
            }
            let update = updates.available.lock().unwrap().clone();
            let bytes = updates.downloaded.lock().unwrap().clone();
            if let (Some(update), Some(bytes)) = (update, bytes) {
                updates.change(app, |s| {
                    s["phase"] = json!("installing");
                    s.as_object_mut().unwrap().remove("messageKey");
                });
                match tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await {
                    Ok(Ok(())) => {
                        backend.0.close_approved.store(true, Ordering::SeqCst);
                        backend.shutdown();
                        app.restart();
                    }
                    _ => {
                        backend.0.accepting.store(true, Ordering::SeqCst);
                        updates.fail(app, "downloaded", "updates.installFailed");
                    }
                }
            } else {
                backend.0.accepting.store(true, Ordering::SeqCst);
                updates.fail(app, "downloaded", "updates.installFailed");
            }
        }
        _ => return Err(error("validation", "desktop.unsupportedOperation")),
    }
    Ok(updates.snapshot())
}
