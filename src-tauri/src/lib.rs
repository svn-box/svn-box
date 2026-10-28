mod auth;
mod catalog;
mod commands;
mod compare;
mod content;
mod menu;
mod migration;
mod model;
mod operations;
mod paths;
mod review;
mod rpc;
mod runner;
mod state;
mod svn;
mod updates;

#[cfg(test)]
mod tests;

#[cfg(feature = "native-smoke")]
mod smoke;

use state::Backend;
use std::{path::PathBuf, sync::atomic::Ordering};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

pub fn run() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .default_version_comparator(|current, release| {
                    release.version.pre.is_empty() && release.version > current
                })
                .build(),
        )
        .setup(|app| {
            let isolated = std::env::var_os("SVNBOX_DATA_DIR");
            let root = isolated
                .clone()
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            if isolated.is_none() {
                for legacy in migration::default_legacy() {
                    if migration::import_legacy(&root, &legacy)? {
                        break;
                    }
                }
            }
            let bundled = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../resources/svn/darwin-arm64/bin/svn")
            } else {
                app.path().resource_dir()?.join("svn/bin/svn")
            };
            #[cfg(feature = "native-smoke")]
            let bundled = std::env::var_os("SVNBOX_SMOKE_SVN")
                .map(PathBuf::from)
                .unwrap_or(bundled);
            let handle = app.handle().clone();
            let backend = Backend::load(root, bundled, move |name, value| {
                let _ = handle.emit(name, value);
            })?;
            #[cfg(feature = "native-smoke")]
            if let Some(wc) = std::env::var_os("SVNBOX_SMOKE_WC") {
                backend.add_working_copy(
                    &std::path::PathBuf::from(wc).to_string_lossy(),
                    "Native SVNBox",
                    &runner::Context::default(),
                )?;
            }
            app.manage(backend);
            let config = app.config().app.windows[0].clone();
            tauri::WebviewWindowBuilder::from_config(app, &config)?
                .on_navigation(navigation_allowed)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            commands::apply_theme(app.handle(), &app.state::<Backend>());
            app.manage(updates::Updates::new());
            menu::install(app.handle())?;
            Ok(())
        })
        .on_menu_event(|app, event| menu::handle(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let backend = window.state::<Backend>();
                if !backend.0.close_approved.load(Ordering::SeqCst) {
                    api.prevent_close();
                    commands::request_close(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::svnbox_call,
            commands::desktop_ready,
            commands::confirm_close,
            commands::abort_close,
            #[cfg(feature = "native-smoke")]
            smoke::smoke_report,
            #[cfg(feature = "native-smoke")]
            smoke::smoke_snapshot,
            #[cfg(feature = "native-smoke")]
            smoke::smoke_menu,
        ])
        .build(tauri::generate_context!())
        .expect("仓盒无法启动");
    application.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            let backend = app.state::<Backend>();
            if !backend.0.close_approved.load(Ordering::SeqCst) {
                api.prevent_exit();
                commands::request_close(app);
            }
        }
        RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        RunEvent::Exit => app.state::<Backend>().shutdown(),
        _ => {}
    });
}

fn navigation_allowed(url: &url::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (["http", "https"].contains(&url.scheme()) && url.host_str() == Some("tauri.localhost"))
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(1421))
}
