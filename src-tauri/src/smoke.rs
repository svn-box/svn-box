use crate::{model::*, state::Backend};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Manager, State};

static STARTED: AtomicBool = AtomicBool::new(false);

pub fn start(app: &AppHandle) {
    let Some(output) = std::env::var_os("SVNBOX_SMOKE_OUTPUT") else {
        return;
    };
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let script = format!(
        "window.__SVNBOX_SMOKE__ = {};\n{}",
        serde_json::json!({"output": output}),
        include_str!("../../scripts/native-smoke.js")
    );
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(script);
    }
}

#[tauri::command]
pub fn smoke_report(
    app: AppHandle,
    backend: State<'_, Backend>,
    report: serde_json::Value,
) -> std::result::Result<(), String> {
    let output = PathBuf::from(
        std::env::var_os("SVNBOX_SMOKE_OUTPUT").ok_or("Smoke verification is not enabled")?,
    );
    write_json(&output.join("report.json"), &report).map_err(|e| e.to_string())?;
    backend.0.close_approved.store(true, Ordering::SeqCst);
    app.exit(if report["success"] == true { 0 } else { 1 });
    Ok(())
}

#[tauri::command]
pub fn smoke_menu(app: AppHandle, action: String) -> std::result::Result<(), String> {
    if std::env::var_os("SVNBOX_SMOKE_OUTPUT").is_none()
        || !["settings", "app-update"].contains(&action.as_str())
    {
        return Err("Invalid smoke menu action".into());
    }
    crate::menu::handle(&app, &action);
    Ok(())
}

#[tauri::command]
pub async fn smoke_snapshot(
    window: tauri::WebviewWindow,
    name: String,
) -> std::result::Result<(), String> {
    if !["workspace", "commit", "settings", "failure"].contains(&name.as_str()) {
        return Err("Unknown snapshot".into());
    }
    let output = PathBuf::from(
        std::env::var_os("SVNBOX_SMOKE_OUTPUT").ok_or("Smoke verification is not enabled")?,
    )
    .join(format!("{name}.png"));
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .with_webview(move |webview| unsafe {
            use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
            use objc2_foundation::{NSDictionary, NSError, NSString};
            use objc2_web_kit::WKWebView;
            let view = &*webview.inner().cast::<WKWebView>();
            let completion =
                block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    let outcome = (|| -> std::result::Result<(), String> {
                        if !error.is_null() || image.is_null() {
                            return Err("WebKit snapshot failed".into());
                        }
                        let tiff = (&*image).TIFFRepresentation().ok_or("Missing TIFF")?;
                        let bitmap =
                            NSBitmapImageRep::imageRepWithData(&tiff).ok_or("Missing bitmap")?;
                        let png = bitmap
                            .representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &NSDictionary::new(),
                            )
                            .ok_or("Missing PNG")?;
                        if !png.writeToFile_atomically(
                            &NSString::from_str(output.to_str().ok_or("Invalid output path")?),
                            true,
                        ) {
                            return Err("Snapshot write failed".into());
                        }
                        Ok(())
                    })();
                    let _ = sender.send(outcome);
                });
            view.takeSnapshotWithConfiguration_completionHandler(None, &completion);
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(std::time::Duration::from_secs(15))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??
}
