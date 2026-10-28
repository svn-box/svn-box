use crate::{model::*, paths::*, runner::Context, state::Backend};
use serde_json::{json, Value};
use std::{fs, path::Path};

impl Backend {
    pub fn settings(&self, input: &Value) -> Result<Value> {
        if let Some(path) = input.get("svnPath") {
            let result = self.0.runner.detect(path.as_str().unwrap_or(""));
            if result["ok"] != true {
                return Err(error_message("path", s(&result, "error")));
            }
        }
        if !s(input, "mergeTool").is_empty() && !Path::new(s(input, "mergeTool")).is_absolute() {
            return Err(error("validation", "svn.theMergeToolPathMustBeAbsolute"));
        }
        let state = self.change(|state| {
            state["settings"]
                .as_object_mut()
                .unwrap()
                .extend(input.as_object().unwrap().clone());
            Ok(())
        })?;
        if let Some(language) = input.get("language") {
            set_language(language.as_str().unwrap_or("zh-CN"));
            (self.0.emit)("svnbox:language", language.clone());
        }
        Ok(state)
    }

    pub fn add_working_copy(&self, path: &str, name: &str, ctx: &Context) -> Result<Value> {
        let canonical = fs::canonicalize(path)?;
        let info = self.info_at(&canonical.to_string_lossy(), None, None, ctx)?;
        if s(&info, "rootPath").is_empty() {
            return Err(error("path", "svn.theSelectedFolderIsNotAWorkingCopy"));
        }
        let root = fs::canonicalize(s(&info, "rootPath"))?;
        let root_info = if canonical == root {
            info.clone()
        } else {
            self.info_at(&root.to_string_lossy(), None, None, ctx)?
        };
        ctx.check()?;
        let address = address(s(&info, "rootUrl"))?;
        let repository_name = address
            .path_segments()
            .and_then(Iterator::last)
            .filter(|segment| !segment.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| tr("svn.svnRepository"));
        self.change(|state| {
            if let Some(existing) = state["workingCopies"]
                .as_array()
                .unwrap()
                .iter()
                .find(|copy| s(copy, "path") == root.to_string_lossy())
            {
                state["activeId"] = existing["id"].clone();
                return Ok(());
            }
            let repository = if let Some(repository) = items(&state["repositories"])
                .into_iter()
                .find(|repository| repository["uuid"] == info["uuid"])
            {
                repository
            } else {
                let repository = json!({
                    "id": id(),
                    "name": repository_name,
                    "rootUrl": info["rootUrl"],
                    "uuid": info["uuid"],
                    "favorite": false,
                });
                state["repositories"]
                    .as_array_mut()
                    .unwrap()
                    .push(repository.clone());
                repository
            };
            let identifier = id();
            let default_name = root.file_name().unwrap_or_default().to_string_lossy();
            let copy_name = if name.trim().is_empty() {
                default_name.as_ref()
            } else {
                name.trim()
            };
            let copy = json!({
                "id": identifier,
                "name": copy_name,
                "path": root,
                "repositoryId": repository["id"],
                "url": root_info["url"],
                "depth": root_info["depth"],
                "favorite": false,
            });
            state["workingCopies"].as_array_mut().unwrap().push(copy);
            state["sessions"][&identifier] = empty_session();
            state["activeId"] = json!(identifier);
            Ok(())
        })
    }

    pub fn add_repository(&self, input: &Value, ctx: &Context) -> Result<Value> {
        let url = address(s(input, "url"))?;
        let credential = if !s(input, "credentialId").is_empty() {
            Some(json!(s(input, "credentialId")))
        } else {
            find_credential(&self.state()["credentials"], url.as_str(), "")?
                .map(|v| v["id"].clone())
        };
        let default_name = url
            .host_str()
            .filter(|host| !host.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                url.path_segments()
                    .and_then(Iterator::last)
                    .filter(|part| !part.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| tr("svn.svnRepository"));
        let name = if s(input, "name").trim().is_empty() {
            default_name
        } else {
            s(input, "name").trim().to_owned()
        };
        let mut repository = json!({
            "id": id(),
            "name": name,
            "rootUrl": url.as_str(),
            "uuid": "",
            "favorite": false,
        });
        if let Some(id) = credential {
            repository["credentialId"] = id;
        }
        let info = self.info_at(url.as_str(), None, Some(&repository), ctx)?;
        repository["rootUrl"] = info["rootUrl"].clone();
        repository["uuid"] = info["uuid"].clone();
        ctx.check()?;
        self.change(|state| {
            let repos = state["repositories"].as_array_mut().unwrap();
            if let Some(existing) = repos.iter_mut().find(|r| r["uuid"] == info["uuid"]) {
                if let Some(profile) = repository.get("credentialId") {
                    existing["credentialId"] = profile.clone();
                }
                if !s(input, "name").is_empty() {
                    existing["name"] = input["name"].clone();
                }
            } else {
                repos.push(repository);
            }
            Ok(())
        })
    }

    pub fn manage(&self, input: &Value) -> Result<Value> {
        let entity = s(input, "entity");
        let identifier = s(input, "id");
        let key = match entity {
            "workingCopy" => "workingCopies",
            "repository" => "repositories",
            "group" => "groups",
            _ => return Err(error_message("validation", "Invalid catalog entity")),
        };
        self.change(|state| {
            if identifier.is_empty() {
                if entity != "group" || s(input, "name").trim().is_empty() {
                    return Err(error("validation", "svn.enterAGroupName"));
                }
                state["groups"].as_array_mut().unwrap().push(json!({
                    "id": id(),
                    "name": s(input, "name").trim(),
                }));
                return Ok(());
            }
            let index = state[key]
                .as_array()
                .unwrap()
                .iter()
                .position(|v| s(v, "id") == identifier)
                .ok_or_else(|| error("validation", "svn.managementRecordNotFound"))?;
            if input["remove"] == true {
                if entity == "repository"
                    && state["workingCopies"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|w| s(w, "repositoryId") == identifier)
                {
                    return Err(error(
                        "validation",
                        "svn.removeTheWorkingCopyRecordsLinkedToThis",
                    ));
                }
                if entity == "workingCopy"
                    && self
                        .0
                        .operations
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|o| active(o) && s(o, "wcId") == identifier)
                {
                    return Err(error(
                        "validation",
                        "svn.waitForThisWorkingCopySOperationTo",
                    ));
                }
                state[key].as_array_mut().unwrap().remove(index);
                if entity == "repository" {
                    state["bookmarks"]
                        .as_array_mut()
                        .unwrap()
                        .retain(|b| s(b, "repositoryId") != identifier);
                }
                if entity == "workingCopy" {
                    state["sessions"]
                        .as_object_mut()
                        .unwrap()
                        .remove(identifier);
                    if s(state, "activeId") == identifier {
                        if let Some(first) = state["workingCopies"].as_array().unwrap().first() {
                            state["activeId"] = first["id"].clone();
                        } else {
                            state.as_object_mut().unwrap().remove("activeId");
                        }
                    }
                }
                if entity == "group" {
                    for key in ["repositories", "workingCopies"] {
                        for item in state[key].as_array_mut().unwrap() {
                            if s(item, "groupId") == identifier {
                                item.as_object_mut().unwrap().remove("groupId");
                            }
                        }
                    }
                }
                return Ok(());
            }
            for (field, collection, message) in [
                ("groupId", "groups", "svn.groupNotFound"),
                (
                    "credentialId",
                    "credentials",
                    "svn.credentialProfileNotFound",
                ),
            ] {
                if let Some(value) = input.get(field) {
                    if !value.as_str().unwrap_or("").is_empty()
                        && !state[collection]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|v| v["id"] == *value)
                    {
                        return Err(error("validation", message));
                    }
                }
            }
            let item = &mut state[key][index];
            if !s(input, "name").trim().is_empty() {
                item["name"] = json!(s(input, "name").trim());
            }
            for field in ["favorite", "groupId", "credentialId"] {
                if let Some(value) = input.get(field) {
                    if value == "" {
                        item.as_object_mut().unwrap().remove(field);
                    } else {
                        item[field] = value.clone();
                    }
                }
            }
            let other = if s(input, "direction") == "up" {
                index.checked_sub(1)
            } else if s(input, "direction") == "down" {
                Some(index + 1)
            } else {
                None
            };
            if let Some(other) = other {
                let list = state[key].as_array_mut().unwrap();
                if other < list.len() {
                    list.swap(index, other);
                }
            }
            Ok(())
        })
    }

    pub fn bookmark(&self, input: &Value) -> Result<Value> {
        let repository = self
            .remote_repo(s(input, "url"), s(input, "repositoryId"))?
            .ok_or_else(|| error_message("path", "Repository not found"))?;
        let url = address(s(input, "url"))?;
        let encoded_name = url.path_segments().and_then(Iterator::last).unwrap_or("");
        let default_name = percent_encoding::percent_decode_str(encoded_name)
            .decode_utf8()
            .map_err(|_| error_message("validation", "Invalid bookmark name"))?
            .to_string();
        let name = if s(input, "name").trim().is_empty() {
            if default_name.is_empty() {
                tr("svn.repositoryRoot")
            } else {
                default_name
            }
        } else {
            s(input, "name").trim().to_owned()
        };
        self.change(|state| {
            let bookmarks = state["bookmarks"].as_array_mut().unwrap();
            if input["remove"] == true {
                bookmarks.retain(|bookmark| {
                    s(bookmark, "id") != s(input, "id")
                        || bookmark["repositoryId"] != repository["id"]
                });
                return Ok(());
            }
            if !s(input, "direction").is_empty() {
                let siblings = bookmarks
                    .iter()
                    .enumerate()
                    .filter(|(_, bookmark)| bookmark["repositoryId"] == repository["id"])
                    .map(|(index, _)| index)
                    .collect::<Vec<_>>();
                let current = siblings
                    .iter()
                    .position(|index| s(&bookmarks[*index], "id") == s(input, "id"))
                    .ok_or_else(|| error("validation", "svn.pathBookmarkNotFound"))?;
                let other = if s(input, "direction") == "up" {
                    current.checked_sub(1)
                } else {
                    Some(current + 1)
                };
                if let Some(other) = other.and_then(|index| siblings.get(index)) {
                    bookmarks.swap(siblings[current], *other);
                }
                return Ok(());
            }
            if let Some(existing) = bookmarks.iter_mut().find(|bookmark| {
                bookmark["repositoryId"] == repository["id"]
                    && (s(bookmark, "id") == s(input, "id") || s(bookmark, "url") == url.as_str())
            }) {
                existing["name"] = json!(name);
                existing["url"] = json!(url.as_str());
            } else {
                bookmarks.push(json!({
                    "id": id(),
                    "repositoryId": repository["id"],
                    "name": name,
                    "url": url.as_str(),
                }));
            }
            Ok(())
        })
    }

    pub fn save_session(&self, input: &Value) -> Result<Value> {
        let identifier = s(input, "wcId");
        self.wc(identifier)?;
        let state = self.change(|state| {
            if !state["sessions"][identifier].is_object() {
                state["sessions"][identifier] = empty_session();
            }
            let session = state["sessions"][identifier].as_object_mut().unwrap();
            for (key, value) in input["patch"].as_object().unwrap() {
                if value.is_null() {
                    session.remove(key);
                } else {
                    session.insert(key.clone(), value.clone());
                }
            }
            Ok(())
        })?;
        Ok(state["sessions"][identifier].clone())
    }
}
