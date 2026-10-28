use crate::{model::*, runner::Context, state::Backend};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;

const ACTIONS: [&str; 15] = [
    "commit",
    "update",
    "add",
    "rename",
    "delete",
    "ignore",
    "revert",
    "resolve",
    "cleanup",
    "recover",
    "restore-backup",
    "resolve-local",
    "resolve-incoming",
    "merge",
    "apply-merge",
];

pub fn validate(method: &str, input: &Value) -> Result<()> {
    let fields: &[&str] = match method {
        "state" | "pickFolder" | "operations" => {
            if !input.is_null() {
                return Err(error_message(
                    "validation",
                    "This command takes no arguments",
                ));
            }
            return Ok(());
        }
        "detect" => &["path"],
        "settings" => &["svnPath", "theme", "mergeTool", "language"],
        "addWorkingCopy" => &["path", "name"],
        "addRepository" => &["url", "name", "credentialId"],
        "bookmark" => &["repositoryId", "url", "name", "id", "remove", "direction"],
        "compare" => &["wcId", "path", "revision", "range"],
        "manage" => &[
            "entity",
            "id",
            "name",
            "remove",
            "favorite",
            "groupId",
            "direction",
            "credentialId",
        ],
        "session" => &["wcId", "patch"],
        "activate" => &["wcId"],
        "status" => &["wcId", "remote"],
        "info" | "properties" | "backups" | "mergeState" => &["wcId", "path"],
        "diff" => &["wcId", "path", "revision"],
        "rangeDiff" => &["wcId", "path", "from", "to"],
        "log" => &["wcId", "path", "before"],
        "list" => &["url", "repositoryId"],
        "checkout" => &["url", "destination", "repositoryId", "depth"],
        "review" => &[
            "wcId",
            "action",
            "paths",
            "destination",
            "message",
            "revision",
            "backupId",
            "mergeId",
        ],
        "execute" => &["reviewId"],
        "copyOperation" | "cancel" | "cancelRequest" => &["id"],
        "clearOperations" => &["ids"],
        "authentication" => &["url", "repositoryId", "wcId", "reviewId"],
        "credential" => &[
            "rootUrl", "url", "name", "username", "password", "id", "remove",
        ],
        "credentialForEdit" => &["id", "rootUrl", "url"],
        "system" => &["wcId", "path", "action"],
        "appUpdate" => &["action"],
        _ => return Err(error("validation", "desktop.unsupportedOperation")),
    };
    let object = input
        .as_object()
        .ok_or_else(|| error_message("validation", "Expected command arguments"))?;
    if object.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err(error_message("validation", "Unexpected command argument"));
    }
    for (key, value) in object {
        match key.as_str() {
            "patch" | "range" => {
                if !value.is_object() {
                    return Err(error_message("validation", "Invalid nested arguments"));
                }
            }
            "paths" | "ids" => {
                let values = value.as_array().ok_or_else(|| {
                    error_message("validation", "Expected path or identifier list")
                })?;
                if values.len() > if key == "ids" { 1000 } else { 2000 }
                    || values.iter().any(|v| {
                        v.as_str()
                            .is_none_or(|s| s.len() > 32768 || s.contains(['\n', '\r', '\0']))
                    })
                {
                    return Err(error_message(
                        "validation",
                        "Invalid path or identifier list",
                    ));
                }
            }
            "remote" | "remove" | "favorite" => {
                if !value.is_boolean() {
                    return Err(error_message("validation", "Expected boolean value"));
                }
            }
            "revision" | "before" | "from" | "to" => {
                if !(key == "to" && value == "WORKING")
                    && value.as_u64().is_none_or(|v| v > 9007199254740991)
                {
                    return Err(error("validation", "fileVersions.enterRevision"));
                }
            }
            _ => {
                let text = value
                    .as_str()
                    .ok_or_else(|| error_message("validation", "Expected text argument"))?;
                if text.contains('\0') || text.len() > if key == "message" { 100000 } else { 32768 }
                {
                    return Err(error_message(
                        "validation",
                        "Text argument exceeds the allowed size",
                    ));
                }
                if [
                    "path",
                    "destination",
                    "svnPath",
                    "mergeTool",
                    "username",
                    "password",
                ]
                .contains(&key.as_str())
                    && text.contains(['\n', '\r'])
                {
                    return Err(error(
                        "validation",
                        "validation.pathsCannotContainLineBreaks",
                    ));
                }
            }
        }
    }
    let required: &[&str] = match method {
        "addWorkingCopy" => &["path"],
        "addRepository" | "list" => &["url"],
        "bookmark" => &["repositoryId", "url", "name"],
        "compare" | "info" | "properties" | "diff" | "rangeDiff" | "backups" | "mergeState"
        | "system" => &["wcId", "path"],
        "session" | "activate" | "status" | "log" | "review" => &["wcId"],
        "checkout" => &["url", "destination", "depth"],
        "execute" => &["reviewId"],
        "copyOperation" | "cancel" | "cancelRequest" => &["id"],
        "credential" => &["rootUrl", "username", "password"],
        "credentialForEdit" => &["id", "rootUrl", "url"],
        "manage" => &["entity"],
        "appUpdate" => &["action"],
        _ => &[],
    };
    for key in required {
        if !input.get(*key).is_some_and(Value::is_string) {
            return Err(error_message(
                "validation",
                &format!("Missing argument: {key}"),
            ));
        }
    }
    let valid = match method {
        "settings" => {
            input.get("theme").is_none_or(|v| {
                ["light", "dark", "ocean", "mint", "iris", "sunset"]
                    .contains(&v.as_str().unwrap_or(""))
            }) && input
                .get("language")
                .is_none_or(|v| ["en", "zh-CN"].contains(&v.as_str().unwrap_or("")))
        }
        "manage" => ["workingCopy", "repository", "group"].contains(&s(input, "entity")),
        "checkout" => ["infinity", "immediates", "files", "empty"].contains(&s(input, "depth")),
        "review" => ACTIONS.contains(&s(input, "action")) && input["paths"].is_array(),
        "system" => ["reveal", "copy", "terminal", "merge"].contains(&s(input, "action")),
        "clearOperations" => input["ids"].is_array(),
        "authentication" => {
            ["url", "wcId", "reviewId"]
                .iter()
                .filter(|key| !s(input, key).is_empty())
                .count()
                == 1
        }
        "appUpdate" => {
            ["status", "check", "download", "install", "release"].contains(&s(input, "action"))
        }
        "session" => valid_session(&input["patch"]),
        "rangeDiff" => valid_range(input),
        _ => true,
    };
    if !valid
        || input.get("range").is_some_and(|range| !valid_range(range))
        || input
            .get("direction")
            .is_some_and(|direction| !["up", "down"].contains(&direction.as_str().unwrap_or("")))
    {
        return Err(error_message("validation", "Invalid command arguments"));
    }
    Ok(())
}

fn valid_range(input: &Value) -> bool {
    input["from"]
        .as_u64()
        .is_some_and(|v| v <= 9007199254740991)
        && (input["to"] == "WORKING" || input["to"].as_u64().is_some_and(|v| v <= 9007199254740991))
        && input.as_object().is_some_and(|o| {
            o.keys()
                .all(|k| ["wcId", "path", "from", "to"].contains(&k.as_str()))
        })
}

fn valid_session(input: &Value) -> bool {
    const OPTIONAL: &[&str] = &[
        "fileSearch",
        "lastFileView",
        "treeInitialized",
        "historyDiffPath",
        "historyRevision",
        "historySearch",
        "historyCollapsedDates",
        "historyCollapsedRevisions",
        "historyPreviewOpen",
    ];
    input.as_object().is_some_and(|object| {
        object.iter().all(|(key, value)| {
            if value.is_null() && OPTIONAL.contains(&key.as_str()) {
                return true;
            }
            match key.as_str() {
                "draft" => value
                    .as_str()
                    .is_some_and(|text| text.len() <= 100000 && !text.contains('\0')),
                "fileSearch" | "currentPath" | "historyDiffPath" | "historyTarget"
                | "historySearch" => value
                    .as_str()
                    .is_some_and(|text| text.len() <= 32768 && !text.contains('\0')),
                "selected" | "expanded" | "historyCollapsedDates" => {
                    value.as_array().is_some_and(|items| {
                        items.len() <= 10000
                            && items.iter().all(|value| {
                                value
                                    .as_str()
                                    .is_some_and(|text| text.len() <= 32768 && !text.contains('\0'))
                            })
                    })
                }
                "filter" => [
                    "all",
                    "modified",
                    "added",
                    "deleted",
                    "unversioned",
                    "ignored",
                    "conflicted",
                ]
                .contains(&value.as_str().unwrap_or("")),
                "view" => ["changes", "files", "history"].contains(&value.as_str().unwrap_or("")),
                "lastFileView" => ["changes", "files"].contains(&value.as_str().unwrap_or("")),
                "treeInitialized" | "historyPreviewOpen" => value.is_boolean(),
                "historyRevision" => value
                    .as_u64()
                    .is_some_and(|number| number > 0 && number <= 9007199254740991),
                "historyCollapsedRevisions" => value.as_array().is_some_and(|items| {
                    items.len() <= 10000
                        && items.iter().all(|value| {
                            value
                                .as_u64()
                                .is_some_and(|number| number > 0 && number <= 9007199254740991)
                        })
                }),
                _ => false,
            }
        })
    })
}

impl Backend {
    pub fn call(&self, method: &str, input: &Value, ctx: &Context) -> Result<Value> {
        validate(method, input)?;
        ctx.check()?;
        if !self.0.accepting.load(Ordering::SeqCst) {
            return Err(error(
                "command",
                "desktop.theAppIsPreparingToRestartPleaseWait",
            ));
        }
        match method {
            "state" => Ok(self.state()),
            "detect" => {
                let path = if input.get("path").is_some() {
                    s(input, "path").into()
                } else {
                    s(&self.state()["settings"], "svnPath").to_owned()
                };
                Ok(self.0.runner.detect(&path))
            }
            "settings" => self.settings(input),
            "addWorkingCopy" => self.add_working_copy(s(input, "path"), s(input, "name"), ctx),
            "addRepository" => self.add_repository(input, ctx),
            "manage" => self.manage(input),
            "bookmark" => self.bookmark(input),
            "session" => self.save_session(input),
            "activate" => {
                self.wc(s(input, "wcId"))?;
                self.change(|state| {
                    state["activeId"] = input["wcId"].clone();
                    Ok(())
                })?;
                Ok(Value::Null)
            }
            "status" => self.status(s(input, "wcId"), input["remote"] == true, ctx),
            "info" => {
                let wc = self.wc(s(input, "wcId"))?;
                let target = self.local(&wc, s(input, "path"))?;
                self.info_at(
                    &target.to_string_lossy(),
                    Some(std::path::Path::new(s(&wc, "path"))),
                    self.repository(&wc).as_ref(),
                    ctx,
                )
            }
            "properties" => self.properties(&self.wc(s(input, "wcId"))?, s(input, "path"), ctx),
            "diff" => self.diff(input, false, ctx),
            "rangeDiff" => self.diff(input, true, ctx),
            "log" => self.log(input, ctx),
            "list" => self.list(input, ctx),
            "backups" => self.backups(s(input, "wcId"), s(input, "path")),
            "mergeState" => self.merge_state(&self.wc(s(input, "wcId"))?, s(input, "path"), ctx),
            "checkout" => self.checkout(input, ctx),
            "review" => self.review(input, ctx),
            "execute" => self.execute(s(input, "reviewId"), ctx),
            "operations" => Ok(json!(*self.0.operations.lock().unwrap())),
            "clearOperations" => self.clear_operations(&strings(&input["ids"])),
            "cancel" => {
                self.cancel(s(input, "id"));
                Ok(Value::Null)
            }
            "cancelRequest" => {
                self.cancel_request(s(input, "id"));
                Ok(Value::Null)
            }
            "authentication" => self.authentication(input),
            "credential" => self.credential(input),
            "credentialForEdit" => self.credential_for_edit(input),
            _ => Err(error("validation", "desktop.unsupportedOperation")),
        }
    }

    pub fn clear_operations(&self, ids: &[String]) -> Result<Value> {
        let mut operations = self.0.operations.lock().unwrap();
        let removed = operations
            .iter()
            .filter(|op| ids.iter().any(|id| id == s(op, "id")) && !active(op))
            .map(|op| s(op, "id").to_owned())
            .collect::<Vec<_>>();
        let next = operations
            .iter()
            .filter(|op| !removed.iter().any(|id| id == s(op, "id")))
            .cloned()
            .collect::<Vec<_>>();
        write_json(&self.0.root.join("operations.json"), &json!(next))?;
        *operations = next.clone();
        Ok(json!({
            "removedIds": removed,
            "operations": next,
        }))
    }
}
