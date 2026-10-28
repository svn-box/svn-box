use crate::{
    model::*,
    runner::{Context, Runner},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

pub struct SavedReview {
    pub value: Value,
    pub content: Option<Vec<u8>>,
    pub created: Instant,
}
type Job = Box<dyn FnOnce() + Send>;
type Emit = dyn Fn(&str, Value) + Send + Sync;
pub struct Runtime {
    pub root: PathBuf,
    pub vault: Arc<dyn crate::auth::Vault>,
    pub store: Mutex<Value>,
    pub runner: Runner,
    pub operations: Mutex<Vec<Value>>,
    pub reviews: Mutex<HashMap<String, SavedReview>>,
    pub requests: Mutex<HashMap<String, Context>>,
    pub cancelled: Mutex<HashMap<String, Instant>>,
    pub controls: Mutex<HashMap<String, Context>>,
    pub queues: Mutex<HashMap<String, Sender<Job>>>,
    pub accepting: AtomicBool,
    pub pending_writes: AtomicUsize,
    pub ready: AtomicBool,
    pub close_requested: AtomicBool,
    pub close_approved: AtomicBool,
    pub emit: Arc<Emit>,
}

#[derive(Clone)]
pub struct Backend(pub Arc<Runtime>);

impl Backend {
    pub fn load(
        root: PathBuf,
        bundled: PathBuf,
        emit: impl Fn(&str, Value) + Send + Sync + 'static,
    ) -> Result<Self> {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(&root)?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        let mut store = match read_json(&root.join("workspace.json")) {
            Ok(v) => v,
            Err(_) if !root.join("workspace.json").exists() => empty_state(),
            Err(e) => return Err(e),
        };
        if store["version"] != 1
            || !store["workingCopies"].is_array()
            || !store["settings"].is_object()
            || !store["sessions"].is_object()
        {
            return Err(error(
                "validation",
                "store.unsupportedDataFormatPreserveWorkspaceJsonBeforeInvestigating",
            ));
        }
        for key in [
            "repositories",
            "bookmarks",
            "groups",
            "credentials",
            "recentMessages",
        ] {
            if !store[key].is_array() {
                store[key] = json!([]);
            }
        }
        if !["zh-CN", "en"].contains(&s(&store["settings"], "language")) {
            store["settings"]["language"] = json!("zh-CN");
        }
        if !["light", "dark", "ocean", "mint", "iris", "sunset", "forest"]
            .contains(&s(&store["settings"], "theme"))
        {
            store["settings"]["theme"] = json!("light");
        }
        if store["workingCopies"]
            .as_array()
            .unwrap()
            .iter()
            .any(|copy| {
                s(copy, "id").is_empty() || !std::path::Path::new(s(copy, "path")).is_absolute()
            })
        {
            return Err(error(
                "validation",
                "store.unsupportedDataFormatPreserveWorkspaceJsonBeforeInvestigating",
            ));
        }
        let repositories = items(&store["repositories"]);
        for profile in store["credentials"].as_array_mut().unwrap() {
            if s(profile, "rootUrl").is_empty() {
                if let Some(repository) = repositories
                    .iter()
                    .find(|r| s(r, "credentialId") == s(profile, "id"))
                {
                    profile["rootUrl"] =
                        json!(crate::paths::credential_root(s(repository, "rootUrl"))?);
                }
            }
        }
        set_language(s(&store["settings"], "language"));
        let mut operations: Vec<Value> = match read_json(&root.join("operations.json")) {
            Ok(v) => v
                .as_array()
                .cloned()
                .ok_or_else(|| error_message("validation", "Invalid operation history"))?,
            Err(_) if !root.join("operations.json").exists() => vec![],
            Err(e) => return Err(e),
        };
        for op in &mut operations {
            if active(op) {
                op["state"] = json!("uncertain");
                op["error"] = json!(error(
                    "command",
                    "svn.theAppClosedBeforeTheOperationFinishedRefresh"
                ));
            }
        }
        #[cfg(not(test))]
        let vault: Arc<dyn crate::auth::Vault> = Arc::new(crate::auth::Keychain);
        #[cfg(test)]
        let vault: Arc<dyn crate::auth::Vault> = Arc::new(crate::auth::MemoryVault::default());
        let backend = Self(Arc::new(Runtime {
            vault,
            root,
            store: Mutex::new(store),
            runner: Runner::new(bundled),
            operations: Mutex::new(operations),
            reviews: Mutex::new(HashMap::new()),
            requests: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashMap::new()),
            controls: Mutex::new(HashMap::new()),
            queues: Mutex::new(HashMap::new()),
            accepting: AtomicBool::new(true),
            pending_writes: AtomicUsize::new(0),
            ready: AtomicBool::new(false),
            close_requested: AtomicBool::new(false),
            close_approved: AtomicBool::new(false),
            emit: Arc::new(emit),
        }));
        let _ = backend
            .0
            .runner
            .detect(s(&backend.state()["settings"], "svnPath"));
        Ok(backend)
    }

    pub fn state(&self) -> Value {
        self.0.store.lock().unwrap().clone()
    }

    pub fn change(&self, change: impl FnOnce(&mut Value) -> Result<()>) -> Result<Value> {
        let mut store = self.0.store.lock().unwrap();
        let mut next = store.clone();
        change(&mut next)?;
        write_json(&self.0.root.join("workspace.json"), &next)?;
        *store = next.clone();
        Ok(next)
    }

    pub fn wc(&self, id: &str) -> Result<Value> {
        items(&self.state()["workingCopies"])
            .into_iter()
            .find(|v| s(v, "id") == id)
            .ok_or_else(|| error_message("path", "Working copy not found"))
    }

    pub fn repository(&self, wc: &Value) -> Option<Value> {
        items(&self.state()["repositories"])
            .into_iter()
            .find(|v| s(v, "id") == s(wc, "repositoryId"))
    }

    pub fn begin_request(&self, id: Option<&str>) -> Result<Context> {
        let Some(id) = id else {
            return Ok(Context::default());
        };
        if id.is_empty() || id.len() > 200 {
            return Err(error_message("validation", "Invalid request identifier"));
        }
        let mut cancelled = self.0.cancelled.lock().unwrap();
        cancelled.retain(|_, time| time.elapsed() < Duration::from_secs(60));
        if cancelled.remove(id).is_some() {
            return Err(error("cancelled", "common.connectionStopped"));
        }
        drop(cancelled);
        let mut requests = self.0.requests.lock().unwrap();
        if requests.contains_key(id) {
            return Err(error("validation", "svn.duplicateRequestIdentifier"));
        }
        let ctx = Context::default();
        requests.insert(id.into(), ctx.clone());
        Ok(ctx)
    }

    pub fn cancel_request(&self, id: &str) {
        if let Some(ctx) = self.0.requests.lock().unwrap().get(id) {
            ctx.cancel.store(true, Ordering::Relaxed);
        } else {
            let mut cancelled = self.0.cancelled.lock().unwrap();
            if cancelled.len() >= 200 {
                if let Some(oldest) = cancelled
                    .iter()
                    .min_by_key(|(_, time)| **time)
                    .map(|(id, _)| id.clone())
                {
                    cancelled.remove(&oldest);
                }
            }
            cancelled.insert(id.into(), Instant::now());
        }
    }

    pub fn cancel(&self, id: &str) {
        if let Some(ctx) = self.0.controls.lock().unwrap().get(id) {
            ctx.cancel.store(true, Ordering::Relaxed);
        }
    }

    pub fn busy(&self) -> bool {
        self.0.operations.lock().unwrap().iter().any(active)
    }

    pub fn shutdown(&self) {
        self.0.accepting.store(false, Ordering::SeqCst);
        self.0.runner.shutting_down.store(true, Ordering::Relaxed);
        for ctx in self.0.controls.lock().unwrap().values() {
            ctx.cancel.store(true, Ordering::Relaxed);
        }
        for ctx in self.0.requests.lock().unwrap().values() {
            ctx.cancel.store(true, Ordering::Relaxed);
        }
    }

    pub fn update_operation(&self, id: &str, change: impl FnOnce(&mut Value)) {
        let mut operations = self.0.operations.lock().unwrap();
        let Some(op) = operations.iter_mut().find(|v| s(v, "id") == id) else {
            return;
        };
        change(op);
        op["sequence"] = json!(op["sequence"].as_u64().unwrap_or(0) + 1);
        let event = op.clone();
        if let Err(e) = write_json(&self.0.root.join("operations.json"), &json!(*operations)) {
            (self.0.emit)("svnbox:error", json!(e));
        }
        drop(operations);
        (self.0.emit)("svnbox:operation", event);
    }

    pub fn append_log(&self, id: &str, text: &str) {
        self.update_operation(id, |op| {
            let logs = op["logs"].as_array_mut().unwrap();
            let omitted = tr("operationLogs.svnboxEarlierCommandOutputWasOmittedApproximatelyThe");
            let mut truncated = logs.first().and_then(Value::as_str) == Some(omitted.as_str());
            if truncated {
                logs.remove(0);
            }
            let text = crate::runner::redact(text);
            if let Some(last) = logs
                .last_mut()
                .filter(|v| v.as_str().unwrap_or("").len() + text.len() <= 8192)
            {
                *last = json!(format!("{}{}", last.as_str().unwrap_or(""), text));
            } else {
                logs.push(json!(text));
            }
            let mut size: usize = logs.iter().map(|v| v.as_str().unwrap_or("").len()).sum();
            while size > 1024 * 1024 && !logs.is_empty() {
                truncated = true;
                let head = logs[0].as_str().unwrap_or("");
                let excess = size - 1024 * 1024;
                if head.len() <= excess {
                    size -= head.len();
                    logs.remove(0);
                } else {
                    let mut boundary = excess;
                    while !head.is_char_boundary(boundary) {
                        boundary += 1;
                    }
                    logs[0] = json!(&head[boundary..]);
                    size -= boundary;
                }
            }
            if truncated {
                logs.insert(0, json!(omitted));
            }
        });
    }

    pub fn enqueue(
        &self,
        key: String,
        wc: Option<String>,
        action: &str,
        request: &Context,
        work: impl FnOnce(Context) -> Result<usize> + Send + 'static,
    ) -> Result<Value> {
        request.check()?;
        if !self.0.accepting.load(Ordering::SeqCst) {
            return Err(error("cancelled", "runner.theAppIsShuttingDown"));
        }
        let identifier = id();
        let action = action.to_owned();
        let operation = json!({
            "id": identifier,
            "wcId": wc,
            "label": action,
            "action": action,
            "state": "waiting",
            "sequence": 0,
            "startedAt": now(),
            "logs": [],
        });
        {
            let mut operations = self.0.operations.lock().unwrap();
            operations.insert(0, operation.clone());
            let mut completed = 0;
            operations.retain(|op| {
                if active(op) {
                    true
                } else {
                    completed += 1;
                    completed <= 100
                }
            });
        }
        self.update_operation(&identifier, |_| {});
        let ctx = Context {
            cancel: request.cancel.clone(),
            operation: Some(identifier.clone()),
        };
        self.0
            .controls
            .lock()
            .unwrap()
            .insert(identifier.clone(), ctx.clone());
        let backend = self.clone();
        let job: Job = Box::new(move || {
            let mut started = false;
            let outcome = ctx.check().and_then(|_| {
                started = true;
                backend.update_operation(&identifier, |o| o["state"] = json!("running"));
                work(ctx.clone())
            });
            backend.update_operation(&identifier, |op| {
                match outcome {
                    Ok(conflicts) => {
                        op["state"] = json!("success");
                        op["conflictCount"] = json!(conflicts);
                    }
                    Err(e) => {
                        let uncertain = action == "commit"
                            && started
                            && ![
                                "stale",
                                "validation",
                                "path",
                                "conflict",
                                "auth",
                                "certificate",
                                "outdated",
                            ]
                            .contains(&e.kind.as_str());
                        op["state"] = json!(if uncertain {
                            "uncertain"
                        } else if e.kind == "cancelled" {
                            "cancelled"
                        } else {
                            "failed"
                        });
                        op["error"] = json!(e);
                        if uncertain {
                            op["logs"]
                                .as_array_mut()
                                .unwrap()
                                .push(json!(tr("operations.uncertainCommit")));
                        }
                    }
                }
                op["endedAt"] = json!(now());
            });
            backend.0.controls.lock().unwrap().remove(&identifier);
            backend
                .0
                .requests
                .lock()
                .unwrap()
                .retain(|_, request| !Arc::ptr_eq(&request.cancel, &ctx.cancel));
        });
        let mut queues = self.0.queues.lock().unwrap();
        let sender = queues.entry(key).or_insert_with(|| {
            let (send, receive) = mpsc::channel::<Job>();
            thread::spawn(move || {
                for job in receive {
                    job();
                }
            });
            send
        });
        sender
            .send(job)
            .map_err(|_| error("command", "runner.theAppIsShuttingDown"))?;
        Ok(operation)
    }
}
