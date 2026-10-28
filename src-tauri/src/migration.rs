use crate::model::*;
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn import_legacy(root: &Path, legacy: &Path) -> Result<bool> {
    if root.join("workspace.json").exists()
        || !legacy.join("workspace.json").exists()
        || root == legacy
    {
        return Ok(false);
    }
    let workspace = read_json(&legacy.join("workspace.json"))?;
    if workspace["version"] != 1 || !workspace["workingCopies"].is_array() {
        return Err(error(
            "validation",
            "store.unsupportedDataFormatPreserveWorkspaceJsonBeforeInvestigating",
        ));
    }
    fs::create_dir_all(root)?;
    for name in [
        "operations.json",
        "file-backups",
        "merges",
        "credentials.enc.json",
    ] {
        let path = legacy.join(name);
        if path.exists() {
            copy_tree(&path, &root.join(name))?;
        }
    }
    write_json(
        &root.join("migration.json"),
        &json!({
            "from": legacy,
            "at": now(),
            "source": "Electron SVNBox",
            "credentials": concat!(
                "Original encrypted file preserved; ",
                "reauthenticate to save passwords in the Tauri Keychain.",
            ),
        }),
    )?;
    // Write the workspace last so an interrupted import is retried on the next launch.
    write_json(&root.join("workspace.json"), &workspace)?;
    Ok(true)
}

pub fn default_legacy() -> Vec<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| {
            ["svnbox", "仓盒", "SVNBox"]
                .into_iter()
                .map(|name| home.join("Library/Application Support").join(name))
                .collect()
        })
        .unwrap_or_default()
}

fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.is_symlink() {
        return Err(error_message(
            "path",
            concat!(
                "Legacy data contains a symbolic link; ",
                "preserve and inspect the original profile before importing.",
            ),
        ));
    }
    if metadata.is_dir() {
        fs::create_dir_all(destination)?;
        for item in fs::read_dir(source)? {
            let item = item?;
            copy_tree(&item.path(), &destination.join(item.file_name()))?;
        }
    } else if metadata.is_file() {
        fs::copy(source, destination)?;
    }
    Ok(())
}
