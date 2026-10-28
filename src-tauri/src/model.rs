use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

pub type Result<T> = std::result::Result<T, AppError>;
static ENGLISH: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<Value>,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        error_message("path", &error.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(_: serde_json::Error) -> Self {
        error(
            "validation",
            "store.unsupportedDataFormatPreserveWorkspaceJsonBeforeInvestigating",
        )
    }
}

pub fn set_language(language: &str) {
    ENGLISH.store(language == "en", Ordering::Relaxed);
}

pub fn tr(key: &str) -> String {
    static ZH: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    static EN: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    let data = if ENGLISH.load(Ordering::Relaxed) {
        EN.get_or_init(|| {
            serde_json::from_str(include_str!("../../src/shared/i18n/locales/en.json")).unwrap()
        })
    } else {
        ZH.get_or_init(|| {
            serde_json::from_str(include_str!("../../src/shared/i18n/locales/zh-CN.json")).unwrap()
        })
    };
    key.split('.')
        .try_fold(data, |v, k| v.get(k))
        .and_then(Value::as_str)
        .unwrap_or(key)
        .into()
}

pub fn error(kind: &str, key: &str) -> AppError {
    error_message(kind, &tr(key))
}

pub fn error_message(kind: &str, message: &str) -> AppError {
    AppError {
        kind: kind.into(),
        message: message.into(),
        detail: None,
        auth: None,
    }
}

pub fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

pub fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub fn items(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

pub fn contains(parent: &str, child: &str) -> bool {
    parent == "." || parent == child || child.starts_with(&format!("{parent}/"))
}

pub fn changed(file: &Value) -> bool {
    !["normal", "none", "external", "ignored", "unversioned"].contains(&s(file, "item"))
        || ["modified", "conflicted"].contains(&s(file, "props"))
        || file["treeConflicted"] == true
        || file["copied"] == true
}

pub fn conflict(file: &Value) -> bool {
    s(file, "item") == "conflicted"
        || s(file, "props") == "conflicted"
        || file["treeConflicted"] == true
}

pub fn active(operation: &Value) -> bool {
    ["waiting", "running"].contains(&s(operation, "state"))
}

pub fn empty_session() -> Value {
    json!({
        "draft": "",
        "selected": [],
        "filter": "all",
        "expanded": ["."],
        "currentPath": "",
        "view": "changes",
        "historyTarget": ".",
    })
}

pub fn empty_state() -> Value {
    json!({
        "version": 1,
        "repositories": [],
        "workingCopies": [],
        "bookmarks": [],
        "groups": [],
        "sessions": {},
        "credentials": [],
        "recentMessages": [],
        "settings": {
            "svnPath": "",
            "theme": "light",
            "mergeTool": "",
            "language": "zh-CN",
        },
    })
}

pub fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let parent = path
        .parent()
        .ok_or_else(|| error_message("path", "Invalid file location"))?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".svnbox-{}.tmp", id()));
    let outcome = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::set_permissions(&temp, fs::Permissions::from_mode(mode))?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    let _ = fs::remove_file(&temp);
    outcome
}

pub fn write_json(path: &Path, data: &Value) -> Result<()> {
    atomic_write(path, &serde_json::to_vec_pretty(data)?, 0o600)
}

pub fn read_json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

pub fn record(path: &Path) -> Option<Value> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 65536 {
        return None;
    }
    read_json(path).ok()
}

pub fn valid_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}
