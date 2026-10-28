use crate::{model::*, rpc, runner::Context, state::Backend};
use serde_json::{json, Value};
use std::{path::Path, sync::atomic::Ordering};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn svnbox_call(
    app: AppHandle,
    window: WebviewWindow,
    backend: State<'_, Backend>,
    method: String,
    input: Value,
    options: Option<Value>,
) -> Result<Value> {
    if window.label() != "main" {
        return Err(error("validation", "desktop.ipcOriginValidationFailed"));
    }
    rpc::validate(&method, &input)?;
    if method == "appUpdate" {
        return crate::updates::act(&app, &backend, s(&input, "action")).await;
    }
    let request = options.unwrap_or_else(|| json!({}));
    if !request
        .as_object()
        .is_some_and(|o| o.keys().all(|k| k == "requestId"))
        || request
            .get("requestId")
            .is_some_and(|v| v.as_str().is_none_or(|s| s.is_empty() || s.len() > 200))
    {
        return Err(error_message("validation", "Invalid request options"));
    }
    let backend = backend.inner().clone();
    let context = if ["cancel", "cancelRequest"].contains(&method.as_str()) {
        Context::default()
    } else {
        backend.begin_request(request["requestId"].as_str())?
    };
    let request_id = request["requestId"].as_str().map(str::to_owned);
    tauri::async_runtime::spawn_blocking(move || {
        let _writing = Writing::new(&backend, matches!(method.as_str(), "checkout" | "execute"));
        let outcome = (|| match method.as_str() {
            "pickFolder" => app
                .dialog()
                .file()
                .set_title(tr("desktop.chooseAFolder"))
                .blocking_pick_folder()
                .map(|p| {
                    p.into_path()
                        .map(|p| json!(p))
                        .map_err(|_| error_message("path", "Invalid folder path"))
                })
                .unwrap_or(Ok(Value::Null)),
            "system" => system(&app, &backend, &input, &context),
            "compare" => {
                let (left, right) = backend.comparison(&input, &context)?;
                let executable = backend
                    .external(
                        Path::new("/usr/bin/xcrun"),
                        &["--find".into(), "opendiff".into()],
                        &context,
                        false,
                    )
                    .map_err(|_| error("path", "fileVersions.toolUnavailable"))?;
                backend
                    .external(
                        Path::new(executable.trim()),
                        &[
                            left.to_string_lossy().into(),
                            right.to_string_lossy().into(),
                        ],
                        &context,
                        false,
                    )
                    .map(|_| Value::Null)
            }
            "copyOperation" => {
                let operation = backend
                    .0
                    .operations
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|o| s(o, "id") == s(&input, "id"))
                    .cloned()
                    .ok_or_else(|| error_message("validation", "Operation not found"))?;
                let project = items(&backend.state()["workingCopies"])
                    .iter()
                    .find(|copy| copy["id"] == operation["wcId"])
                    .map(|copy| s(copy, "name").to_owned())
                    .unwrap_or_else(|| tr("common.remoteRepository"));
                let label = if s(&operation, "action").is_empty() {
                    s(&operation, "label").into()
                } else {
                    tr(&format!("operations.{}", s(&operation, "action")))
                };
                let text = [
                    label,
                    project,
                    tr(&format!("operations.{}", s(&operation, "state"))),
                    s(&operation, "startedAt").into(),
                    s(&operation, "endedAt").into(),
                    s(&operation["error"], "message").into(),
                    operation_text(&operation),
                ]
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
                arboard::Clipboard::new()
                    .and_then(|mut clipboard| clipboard.set_text(text))
                    .map_err(|_| error_message("command", "Cannot write to the clipboard"))?;
                Ok(Value::Null)
            }
            _ => backend.call(&method, &input, &context),
        })();
        if let Some(id) = request_id {
            if !["checkout", "execute"].contains(&method.as_str()) || outcome.is_err() {
                backend.0.requests.lock().unwrap().remove(&id);
            }
        }
        if method == "settings" && outcome.is_ok() {
            let _ = crate::menu::install(&app);
            apply_theme(&app, &backend);
        }
        outcome
    })
    .await
    .map_err(|_| error_message("command", "Native command failed"))?
}

pub fn apply_theme(app: &AppHandle, backend: &Backend) {
    let state = backend.state();
    let theme = s(&state["settings"], "theme");
    let dark = ["dark", "iris"].contains(&theme);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_theme(Some(if dark {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }));
        let _ = window.set_title(&tr("desktop.windowTitle"));
    }
}

fn system(app: &AppHandle, backend: &Backend, input: &Value, ctx: &Context) -> Result<Value> {
    let wc = backend.wc(s(input, "wcId"))?;
    let target = backend.local(&wc, s(input, "path"))?;
    match s(input, "action") {
        "copy" => arboard::Clipboard::new()
            .and_then(|mut c| c.set_text(target.to_string_lossy()))
            .map_err(|_| error_message("command", "Cannot write to the clipboard"))?,
        "reveal" => app
            .opener()
            .reveal_item_in_dir(&target)
            .map_err(|_| error_message("path", "Cannot reveal this path"))?,
        "terminal" => {
            let folder = if target.is_dir() {
                target.as_path()
            } else {
                target.parent().unwrap()
            };
            backend.external(
                Path::new("/usr/bin/open"),
                &[
                    "-a".into(),
                    "Terminal".into(),
                    folder.to_string_lossy().into(),
                ],
                ctx,
                false,
            )?;
        }
        "merge" => {
            if std::fs::symlink_metadata(&target)?.is_symlink() {
                return Err(error(
                    "validation",
                    "desktop.verifyTheSymbolicLinkTargetInTerminalBefore",
                ));
            }
            let tool = s(&backend.state()["settings"], "mergeTool").to_owned();
            if tool.is_empty() || !Path::new(&tool).is_absolute() {
                return Err(error(
                    "validation",
                    "desktop.setAnAbsolutePathToYourExternalMerge",
                ));
            }
            if tool.ends_with(".app") {
                backend.external(
                    Path::new("/usr/bin/open"),
                    &["-a".into(), tool, target.to_string_lossy().into()],
                    ctx,
                    false,
                )?;
            } else {
                backend.external(
                    Path::new(&tool),
                    &[target.to_string_lossy().into()],
                    ctx,
                    true,
                )?;
            }
        }
        _ => return Err(error("validation", "desktop.unsupportedOperation")),
    }
    Ok(Value::Null)
}

fn operation_text(operation: &Value) -> String {
    let mut text = strings(&operation["logs"])
        .join("")
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let detail = s(&operation["error"], "detail")
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    for line in detail.lines() {
        if !line.trim().is_empty() && !text.lines().any(|v| v.trim_end() == line.trim_end()) {
            if !text.ends_with('\n') && !text.is_empty() {
                text.push('\n');
            }
            text.push_str(line);
        }
    }
    text
}

#[tauri::command]
pub fn desktop_ready(app: AppHandle, backend: State<'_, Backend>) {
    #[cfg(feature = "native-smoke")]
    crate::smoke::start(&app);
    #[cfg(not(feature = "native-smoke"))]
    let _ = app;
    backend.0.ready.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn confirm_close(app: AppHandle, backend: State<'_, Backend>) {
    if !backend.0.close_requested.load(Ordering::SeqCst) {
        return;
    }
    if backend.busy() {
        let app_clone = app.clone();
        let backend = backend.inner().clone();
        app.dialog()
            .message(tr(
                "desktop.quittingWillStopRunningOperationsCancellationDoesNot",
            ))
            .title(tr("desktop.anSvnOperationIsStillRunning"))
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                tr("desktop.keepWaiting"),
                tr("desktop.quitAndStopOperations"),
            ))
            .show_with_result(move |result| {
                if result
                    == tauri_plugin_dialog::MessageDialogResult::Custom(tr(
                        "desktop.quitAndStopOperations",
                    ))
                {
                    finish_close(app_clone, backend);
                } else {
                    backend.0.close_requested.store(false, Ordering::SeqCst);
                }
            });
    } else {
        finish_close(app, backend.inner().clone());
    }
}

fn finish_close(app: AppHandle, backend: Backend) {
    backend.shutdown();
    backend.0.close_approved.store(true, Ordering::SeqCst);
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        while backend.busy() && start.elapsed() < std::time::Duration::from_secs(4) {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        app.exit(0);
    });
}

pub fn request_close(app: &AppHandle) {
    let backend = app.state::<Backend>();
    if backend.0.close_requested.swap(true, Ordering::SeqCst) {
        return;
    }
    if backend.0.ready.load(Ordering::SeqCst) {
        let _ = app.emit("svnbox:closing", ());
    } else {
        finish_close(app.clone(), backend.inner().clone());
    }
}

struct Writing {
    backend: Backend,
    active: bool,
}

impl Writing {
    fn new(backend: &Backend, active: bool) -> Self {
        if active {
            backend.0.pending_writes.fetch_add(1, Ordering::SeqCst);
        }
        Self {
            backend: backend.clone(),
            active,
        }
    }
}

impl Drop for Writing {
    fn drop(&mut self) {
        if self.active {
            self.backend.0.pending_writes.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
pub fn abort_close(backend: State<'_, Backend>) {
    backend.0.close_requested.store(false, Ordering::SeqCst);
}
