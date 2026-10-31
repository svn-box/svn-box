use crate::{model::*, state::Backend};
use futures_util::future::{AbortHandle, AbortRegistration, Abortable};
use serde_json::{json, Value};
use std::{
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

struct Session {
    state: Value,
    pending: bool,
    generation: u64,
    abort: Option<AbortHandle>,
    available: Option<Update>,
    downloaded: Option<Arc<Vec<u8>>>,
}

impl Session {
    fn new(disabled: bool) -> Self {
        let mut state = json!({
            "phase": if disabled { "disabled" } else { "idle" },
            "currentVersion": env!("CARGO_PKG_VERSION"),
            "revision": 0,
        });
        if disabled {
            state["messageKey"] = json!("updates.developmentDisabled");
        }
        Self {
            state,
            pending: false,
            generation: 0,
            abort: None,
            available: None,
            downloaded: None,
        }
    }

    fn bump(&mut self) {
        self.state["revision"] = json!(self.state["revision"].as_u64().unwrap_or(0) + 1);
    }

    fn begin(&mut self) -> Option<(u64, AbortRegistration)> {
        if self.pending || self.downloaded.is_some() {
            return None;
        }
        self.generation += 1;
        self.pending = true;
        let (abort, registration) = AbortHandle::new_pair();
        self.abort = Some(abort);
        self.available = None;
        self.state["phase"] = json!("checking");
        for key in [
            "version",
            "publishedAt",
            "percent",
            "received",
            "total",
            "notes",
            "messageKey",
        ] {
            self.state.as_object_mut().unwrap().remove(key);
        }
        self.bump();
        Some((self.generation, registration))
    }

    fn change(&mut self, generation: u64, change: impl FnOnce(&mut Self)) -> bool {
        if generation != self.generation {
            return false;
        }
        change(self);
        self.bump();
        true
    }

    fn finish(&mut self, generation: u64) {
        if generation == self.generation {
            self.pending = false;
            self.abort = None;
        }
    }

    fn cancel(&mut self) -> bool {
        if !self.pending
            || !["checking", "downloading", "verifying"].contains(&s(&self.state, "phase"))
        {
            return false;
        }
        self.generation += 1;
        if let Some(abort) = self.abort.take() {
            abort.abort();
        }
        self.pending = false;
        self.available = None;
        self.state["phase"] = json!("paused");
        self.state.as_object_mut().unwrap().remove("messageKey");
        self.bump();
        true
    }
}

pub struct Updates {
    session: Mutex<Session>,
}

struct Pending<'a> {
    updates: &'a Updates,
    generation: u64,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.updates.session.lock().unwrap().finish(self.generation);
    }
}

impl Updates {
    pub fn new() -> Self {
        let smoke_fixture =
            cfg!(feature = "native-smoke") && std::env::var_os("SVNBOX_SMOKE_UPDATER").is_some();
        Self {
            session: Mutex::new(Session::new(
                cfg!(any(debug_assertions, feature = "native-smoke")) && !smoke_fixture,
            )),
        }
    }

    pub fn snapshot(&self) -> Value {
        self.session.lock().unwrap().state.clone()
    }

    fn emit(&self, app: &AppHandle) {
        // Emit after releasing the state lock; listeners may immediately request a snapshot.
        let snapshot = self.snapshot();
        let _ = app.emit("svnbox:app-update", snapshot);
    }

    fn change(&self, app: &AppHandle, generation: u64, change: impl FnOnce(&mut Session)) -> bool {
        let accepted = self.session.lock().unwrap().change(generation, change);
        if accepted {
            self.emit(app);
        }
        accepted
    }

    fn fail(&self, app: &AppHandle, generation: u64, phase: &str, key: &str) {
        self.change(app, generation, |session| {
            session.state["phase"] = json!(phase);
            session.state["messageKey"] = json!(key);
        });
    }
}

async fn check_and_download(app: &AppHandle, generation: u64) {
    let updates = app.state::<Updates>();
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .build();
    let update = match updater {
        Ok(updater) => match updater.check().await {
            Ok(Some(update))
                if regex::Regex::new(r"^\d+\.\d+\.\d+$")
                    .unwrap()
                    .is_match(&update.version) =>
            {
                update
            }
            Ok(None) => {
                updates.change(app, generation, |session| {
                    session.state["phase"] = json!("current");
                });
                return;
            }
            _ => {
                updates.fail(app, generation, "error", "updates.checkFailed");
                return;
            }
        },
        Err(_) => {
            updates.fail(app, generation, "error", "updates.checkFailed");
            return;
        }
    };
    if !updates.change(app, generation, |session| {
        session.available = Some(update.clone());
        session.state["phase"] = json!("downloading");
        session.state["version"] = json!(update.version);
        if let Some(date) = update.date {
            session.state["publishedAt"] = json!(date.unix_timestamp() * 1000);
        }
        session.state["notes"] = json!(update
            .body
            .as_deref()
            .unwrap_or("")
            .chars()
            .take(6000)
            .collect::<String>());
        session.state["received"] = json!(0);
    }) {
        return;
    }
    let mut received = 0_u64;
    let mut last_emitted = Instant::now();
    let outcome = update
        .download(
            |chunk, total| {
                received = received.saturating_add(chunk as u64);
                if last_emitted.elapsed() < Duration::from_millis(100)
                    && total.is_none_or(|total| received < total)
                {
                    return;
                }
                last_emitted = Instant::now();
                updates.change(app, generation, |session| {
                    session.state["received"] = json!(received);
                    if let Some(total) = total.filter(|total| *total > 0) {
                        session.state["total"] = json!(total);
                        session.state["percent"] =
                            json!(((received as f64 / total as f64) * 100.0).clamp(0.0, 100.0));
                    }
                });
            },
            || {
                updates.change(app, generation, |session| {
                    session.state["phase"] = json!("verifying");
                });
            },
        )
        .await;
    match outcome {
        Ok(bytes) => {
            updates.change(app, generation, |session| {
                session.state["received"] = json!(bytes.len());
                session.state["total"] = json!(bytes.len());
                session.downloaded = Some(Arc::new(bytes));
                session.state["phase"] = json!("downloaded");
                session.state["percent"] = json!(100);
            });
        }
        Err(_) => updates.fail(app, generation, "error", "updates.downloadFailed"),
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
    if s(&updates.snapshot(), "phase") == "disabled" {
        return Ok(updates.snapshot());
    }
    match action {
        "check" | "download" => {
            let request = updates.session.lock().unwrap().begin();
            if let Some((generation, registration)) = request {
                updates.emit(app);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let updates = app.state::<Updates>();
                    let _pending = Pending {
                        updates: &updates,
                        generation,
                    };
                    let _ =
                        Abortable::new(check_and_download(&app, generation), registration).await;
                });
            }
        }
        "cancel" => {
            let cancelled = updates.session.lock().unwrap().cancel();
            if cancelled {
                updates.emit(app);
            }
        }
        "install" => {
            let request = {
                let mut session = updates.session.lock().unwrap();
                if session.pending || s(&session.state, "phase") != "downloaded" {
                    None
                } else if let (Some(update), Some(bytes)) =
                    (session.available.clone(), session.downloaded.clone())
                {
                    session.pending = true;
                    session.generation += 1;
                    Some((session.generation, update, bytes))
                } else {
                    None
                }
            };
            let Some((generation, update, bytes)) = request else {
                return Ok(updates.snapshot());
            };
            let _pending = Pending {
                updates: &updates,
                generation,
            };
            backend.0.accepting.store(false, Ordering::SeqCst);
            if backend.busy() || backend.0.pending_writes.load(Ordering::SeqCst) > 0 {
                backend.0.accepting.store(true, Ordering::SeqCst);
                updates.fail(app, generation, "downloaded", "updates.busy");
                return Ok(updates.snapshot());
            }
            updates.change(app, generation, |session| {
                session.state["phase"] = json!("installing");
                session.state.as_object_mut().unwrap().remove("messageKey");
            });
            match tauri::async_runtime::spawn_blocking(move || update.install(bytes.as_slice()))
                .await
            {
                Ok(Ok(())) => {
                    backend.0.close_approved.store(true, Ordering::SeqCst);
                    backend.shutdown();
                    app.restart();
                }
                _ => {
                    backend.0.accepting.store(true, Ordering::SeqCst);
                    updates.fail(app, generation, "downloaded", "updates.installFailed");
                }
            }
        }
        _ => return Err(error("validation", "desktop.unsupportedOperation")),
    }
    Ok(updates.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_stops_the_task_and_rejects_late_results_after_retry() {
        let mut session = Session::new(false);
        let (old, _) = session.begin().unwrap();
        let abort = session.abort.clone().unwrap();
        assert!(session.begin().is_none());
        assert!(session.cancel());
        assert!(abort.is_aborted());
        let (new, _) = session.begin().unwrap();
        assert!(!session.change(old, |s| s.state["phase"] = json!("downloaded")));
        session.finish(old);
        assert!(session.pending);
        assert_eq!(session.generation, new);
        session.finish(new);
        assert!(!session.pending);
    }

    #[test]
    fn completed_download_is_retained_until_explicit_installation() {
        let mut session = Session::new(false);
        let (generation, _) = session.begin().unwrap();
        session.change(generation, |session| {
            session.downloaded = Some(Arc::new(vec![1, 2, 3]));
            session.state["phase"] = json!("downloaded");
        });
        session.finish(generation);
        assert!(!session.cancel());
        assert!(session.begin().is_none());
        assert_eq!(
            session.downloaded.as_deref().unwrap().as_slice(),
            &[1, 2, 3]
        );
    }
}
