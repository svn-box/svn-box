use crate::{commands, model::*};
use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager,
};

fn item(
    app: &AppHandle,
    id: &str,
    key: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<tauri::Wry>> {
    MenuItem::with_id(app, id, tr(key), true, accelerator)
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let separator = PredefinedMenuItem::separator(app)?;
    let about = PredefinedMenuItem::about(
        app,
        Some(&tr("desktop.aboutSvnbox")),
        Some(AboutMetadata {
            name: Some(tr("desktop.aboutApplicationName")),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            copyright: Some("© 2026 svnbox contributors".into()),
            ..Default::default()
        }),
    )?;
    let application = Submenu::with_items(
        app,
        tr("common.appName"),
        true,
        &[
            &about,
            &item(app, "app-update", "desktop.checkForUpdates", None)?,
            &separator,
            &item(app, "settings", "desktop.settings", Some("CmdOrCtrl+,"))?,
            &separator,
            &PredefinedMenuItem::hide(app, Some(&tr("desktop.hideSvnbox")))?,
            &PredefinedMenuItem::hide_others(app, Some(&tr("desktop.hideOthers")))?,
            &PredefinedMenuItem::show_all(app, Some(&tr("desktop.showAll")))?,
            &separator,
            &item(app, "quit", "desktop.quitSvnbox", Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        tr("common.file"),
        true,
        &[
            &item(app, "add", "desktop.addWorkingCopy", Some("CmdOrCtrl+O"))?,
            &item(
                app,
                "remote",
                "desktop.browseAndCheckOut",
                Some("CmdOrCtrl+Shift+O"),
            )?,
            &separator,
            &item(app, "commit", "desktop.commit", Some("CmdOrCtrl+Enter"))?,
            &item(app, "update", "desktop.update", Some("CmdOrCtrl+U"))?,
            &item(
                app,
                "refresh",
                "common.refreshLocalStatus",
                Some("CmdOrCtrl+R"),
            )?,
            &separator,
            &item(app, "close", "desktop.closeWindow", Some("CmdOrCtrl+W"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        tr("desktop.edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(&tr("desktop.undo")))?,
            &PredefinedMenuItem::redo(app, Some(&tr("desktop.redo")))?,
            &separator,
            &PredefinedMenuItem::cut(app, Some(&tr("desktop.cut")))?,
            &PredefinedMenuItem::copy(app, Some(&tr("common.copy")))?,
            &PredefinedMenuItem::paste(app, Some(&tr("desktop.paste")))?,
            &PredefinedMenuItem::select_all(app, Some(&tr("desktop.selectAll")))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        tr("desktop.view"),
        true,
        &[
            &item(app, "changes", "desktop.changes", Some("CmdOrCtrl+1"))?,
            &item(app, "files", "common.files", Some("CmdOrCtrl+2"))?,
            &item(app, "history", "desktop.history", Some("CmdOrCtrl+3"))?,
            &item(app, "operations", "desktop.operations", Some("CmdOrCtrl+J"))?,
            &separator,
            &item(
                app,
                "fullscreen",
                "desktop.fullScreen",
                Some("Ctrl+Super+F"),
            )?,
        ],
    )?;
    app.set_menu(Menu::with_items(app, &[&application, &file, &edit, &view])?)?;
    Ok(())
}

pub fn handle(app: &AppHandle, id: &str) {
    match id {
        "quit" | "close" => commands::request_close(app),
        "fullscreen" => {
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(value) = window.is_fullscreen() {
                    let _ = window.set_fullscreen(!value);
                }
            }
        }
        "app-update" | "settings" | "add" | "remote" | "commit" | "update" | "refresh"
        | "changes" | "files" | "history" | "operations" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit("svnbox:navigate", id);
        }
        _ => {}
    }
}
