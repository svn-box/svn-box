use crate::{
    model::*,
    paths::*,
    runner::{Context, Output},
    state::Backend,
};
use roxmltree::{Document, Node};
use serde_json::{json, Map, Value};
use std::{fs, path::Path, time::Duration};

fn child_text(node: Node<'_, '_>, name: &str) -> String {
    node.children()
        .find(|c| c.has_tag_name(name))
        .and_then(|c| c.text())
        .unwrap_or("")
        .into()
}

fn attr(node: Node<'_, '_>, name: &str) -> String {
    node.attribute(name).unwrap_or("").into()
}

fn xml_object(node: Node<'_, '_>) -> Value {
    let mut value = Map::new();
    for a in node.attributes() {
        value.insert(a.name().into(), json!(a.value()));
    }
    for child in node.children().filter(Node::is_element) {
        let name = child.tag_name().name();
        let data = if child.attributes().len() == 0 && !child.children().any(|c| c.is_element()) {
            json!(child.text().unwrap_or(""))
        } else {
            xml_object(child)
        };
        if let Some(existing) = value.get_mut(name) {
            if let Some(array) = existing.as_array_mut() {
                array.push(data);
            } else {
                *existing = json!([existing.clone(), data]);
            }
        } else {
            value.insert(name.into(), data);
        }
    }
    if let Some(text) = node.text() {
        if !text.trim().is_empty() {
            value.insert("#text".into(), json!(text));
        }
    }
    Value::Object(value)
}

fn parse_xml(text: &str) -> Result<Document<'_>> {
    Document::parse(text).map_err(|_| error_message("command", "Invalid SVN XML response"))
}

impl Backend {
    pub fn command(
        &self,
        args: Vec<String>,
        cwd: Option<&Path>,
        repo: Option<&Value>,
        ctx: &Context,
    ) -> Result<Output> {
        ctx.check()?;
        let target = args
            .iter()
            .skip(1)
            .find(|v| {
                ["file://", "https://", "http://", "svn://", "svn+ssh://"]
                    .iter()
                    .any(|scheme| v.starts_with(scheme))
            })
            .map(|v| {
                regex::Regex::new(r"@(?:\d+)?$")
                    .unwrap()
                    .replace(v, "")
                    .into_owned()
            })
            .or_else(|| repo.map(|r| s(r, "rootUrl").to_owned()));
        let profile = if let Some(target) = target.as_ref() {
            find_credential(
                &self.state()["credentials"],
                target,
                repo.map(|r| s(r, "credentialId")).unwrap_or(""),
            )?
        } else {
            None
        };
        let password = profile
            .as_ref()
            .map(|p| self.0.vault.get(s(p, "id")))
            .transpose()?
            .flatten();
        let username = profile
            .as_ref()
            .map(|p| s(p, "username").to_owned())
            .unwrap_or_else(|| {
                target
                    .as_ref()
                    .and_then(|u| address(u).ok())
                    .map(|u| {
                        percent_encoding::percent_decode_str(u.username())
                            .decode_utf8_lossy()
                            .to_string()
                    })
                    .unwrap_or_default()
            });
        let mut argv = vec![
            args[0].clone(),
            "--non-interactive".into(),
            "--no-auth-cache".into(),
        ];
        if !username.is_empty() {
            argv.extend(["--username".into(), username.clone()]);
            if password.is_some() {
                argv.push("--password-from-stdin".into());
            }
        }
        argv.extend(args.iter().skip(1).cloned());
        let executable = self.0.runner.executable.lock().unwrap().clone();
        let timeout = if ctx.operation.is_some() {
            3600
        } else if target.as_ref().is_some_and(|u| !u.starts_with("file:")) {
            30
        } else {
            120
        };
        let outcome = self.0.runner.run_at(
            &executable,
            &argv,
            cwd,
            password.as_deref(),
            ctx,
            Duration::from_secs(timeout),
            false,
            &mut |text| {
                if [
                    "commit", "update", "add", "move", "delete", "propset", "resolve", "cleanup",
                    "checkout",
                ]
                .contains(&args[0].as_str())
                {
                    if let Some(id) = ctx.operation.as_ref() {
                        self.append_log(id, text);
                    }
                }
            },
        );
        match outcome {
            Ok(value) => {
                ctx.check()?;
                Ok(value)
            }
            Err(mut e) => {
                if let Some(password) = password.as_ref() {
                    e.message = e.message.replace(password, "[hidden]");
                    e.detail = e.detail.map(|v| v.replace(password, "[hidden]"));
                }
                if e.kind == "auth" {
                    if let Some(target) = target {
                        let retry_safe =
                            ["info", "list", "log", "diff", "status", "cat", "proplist"]
                                .contains(&args[0].as_str());
                        e.auth = Some(json!({
                            "url": target,
                            "rootUrl": profile.as_ref()
                                .map(|p| s(p, "rootUrl").to_owned())
                                .unwrap_or(connection_root(&target)?),
                            "username": username,
                            "credentialId": profile.as_ref().map(|p| p["id"].clone()),
                            "repositoryRoot": repo.map(|r| r["rootUrl"].clone())
                                .unwrap_or(json!(credential_root(&target)?)),
                            "reason": "rejected",
                            "retrySafe": retry_safe,
                        }));
                    }
                }
                Err(e)
            }
        }
    }

    pub fn info_at(
        &self,
        target: &str,
        cwd: Option<&Path>,
        repo: Option<&Value>,
        ctx: &Context,
    ) -> Result<Value> {
        let output = self
            .command(
                vec!["info".into(), "--xml".into(), peg(target)],
                cwd,
                repo,
                ctx,
            )?
            .text();
        let doc = parse_xml(&output)?;
        let entry = doc
            .descendants()
            .find(|n| n.has_tag_name("entry"))
            .ok_or_else(|| error("command", "svn.unableToReadSvnWorkingCopyInformation"))?;
        let wc = entry.children().find(|n| n.has_tag_name("wc-info"));
        let repository = entry.children().find(|n| n.has_tag_name("repository"));
        let conflicts = entry
            .children()
            .filter(|node| node.has_tag_name("conflict") || node.has_tag_name("tree-conflict"))
            .map(xml_object)
            .collect::<Vec<_>>();
        let mut result = json!({
            "path": attr(entry, "path"),
            "rootPath": wc.map(|n| child_text(n, "wcroot-abspath")).unwrap_or_default(),
            "url": child_text(entry, "url"),
            "rootUrl": repository.map(|n| child_text(n, "root")).unwrap_or_default(),
            "uuid": repository.map(|n| child_text(n, "uuid")).unwrap_or_default(),
            "revision": attr(entry, "revision"),
            "depth": wc.map(|n| child_text(n, "depth"))
                .filter(|s| !s.is_empty())
                .unwrap_or("infinity".into()),
            "kind": attr(entry, "kind"),
            "conflicts": conflicts,
        });
        if let Some(conflict) = entry
            .children()
            .find(|n| n.has_tag_name("conflict") && n.attribute("type") == Some("text"))
        {
            let version = |side: &str| {
                conflict
                    .children()
                    .find(|n| n.has_tag_name("version") && n.attribute("side") == Some(side))
                    .map(|n| attr(n, "revision"))
                    .unwrap_or_default()
            };
            result["textConflict"] = json!({
                "baseRevision": version("source-left"),
                "incomingRevision": version("source-right"),
            });
        }
        Ok(result)
    }

    pub fn scan(
        &self,
        wc: &Value,
        remote: bool,
        ignored: Option<&str>,
        ctx: &Context,
    ) -> Result<Value> {
        let root = self.local(wc, ".")?;
        let repo = self.repository(wc);
        let mut args = vec![
            "status".into(),
            "--xml".into(),
            "--verbose".into(),
            "--no-ignore".into(),
            "--ignore-externals".into(),
        ];
        if remote {
            args.push("--show-updates".into());
        }
        args.push(peg(&root.to_string_lossy()));
        let output = self.command(args, Some(&root), repo.as_ref(), ctx)?.text();
        let doc = parse_xml(&output)?;
        let mut files = vec![];
        let mut remote_changes = 0;
        for entry in doc.descendants().filter(|n| n.has_tag_name("entry")) {
            let Some(status) = entry.children().find(|n| n.has_tag_name("wc-status")) else {
                continue;
            };
            if entry.children().any(|n| {
                n.has_tag_name("repos-status")
                    && (n.attribute("item").unwrap_or("none") != "none"
                        || n.attribute("props").unwrap_or("none") != "none")
            }) {
                remote_changes += 1;
            }
            let path = attr(entry, "path");
            let target = if Path::new(&path).is_absolute() {
                Path::new(&path).to_path_buf()
            } else {
                root.join(&path)
            };
            let Ok(path) = relative(&root, &target) else {
                continue;
            };
            if ignored == Some(path.as_str()) {
                continue;
            }
            let item = attr(status, "item");
            let kind = match fs::symlink_metadata(&target) {
                Ok(m) => {
                    if m.is_dir() {
                        "dir".into()
                    } else if m.is_symlink() {
                        "symlink".into()
                    } else {
                        "file".into()
                    }
                }
                Err(_) if ["deleted", "missing", "replaced"].contains(&item.as_str()) => self
                    .info_at(&target.to_string_lossy(), Some(&root), repo.as_ref(), ctx)
                    .map(|v| s(&v, "kind").to_owned())
                    .unwrap_or("unknown".into()),
                Err(_) => "unknown".into(),
            };
            let commit = status.children().find(|n| n.has_tag_name("commit"));
            let mut file = json!({
                "path": path,
                "item": item,
                "props": attr(status, "props"),
                "revision": attr(status, "revision"),
                "author": commit.map(|n| child_text(n, "author")).unwrap_or_default(),
                "date": commit.map(|n| child_text(n, "date")).unwrap_or_default(),
                "kind": kind,
                "copied": status.attribute("copied") == Some("true"),
                "switched": status.attribute("switched") == Some("true"),
                "treeConflicted": status.attribute("tree-conflicted") == Some("true"),
                "external": item == "external" || status.attribute("file-external") == Some("true"),
            });
            for (source, dest) in [("moved-from", "movedFrom"), ("moved-to", "movedTo")] {
                if let Some(value) = status.attribute(source) {
                    let path = if Path::new(value).is_absolute() {
                        Path::new(value).to_path_buf()
                    } else {
                        root.join(value)
                    };
                    file[dest] = json!(relative(&root, &path)?);
                }
            }
            files.push(file);
        }
        files.sort_by(|a, b| s(a, "path").cmp(s(b, "path")));
        let mut result = json!({
            "wcId": wc["id"],
            "fingerprint": hash(serde_json::to_vec(&files)?),
            "files": files,
            "scannedAt": now(),
            "remote": remote,
        });
        if remote {
            result["remoteChanges"] = json!(remote_changes);
            result["remoteRevision"] = json!(doc
                .descendants()
                .find(|n| n.has_tag_name("against"))
                .map(|n| attr(n, "revision"))
                .unwrap_or_default());
        }
        Ok(result)
    }

    pub fn status(&self, id: &str, remote: bool, ctx: &Context) -> Result<Value> {
        let outcome = self.scan(&self.wc(id)?, remote, None, ctx);
        self.change(|state| {
            if let Some(wc) = state["workingCopies"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|w| s(w, "id") == id)
            {
                match &outcome {
                    Ok(snapshot) => {
                        wc["lastScan"] = snapshot["scannedAt"].clone();
                        wc["changeCount"] = json!(items(&snapshot["files"])
                            .iter()
                            .filter(|v| changed(v))
                            .count());
                        wc["conflicts"] = json!(items(&snapshot["files"])
                            .iter()
                            .filter(|v| conflict(v))
                            .count());
                        wc.as_object_mut().unwrap().remove("error");
                    }
                    Err(e) => wc["error"] = json!(e.message),
                }
            }
            Ok(())
        })?;
        outcome
    }

    pub fn properties(&self, wc: &Value, path: &str, ctx: &Context) -> Result<Value> {
        let target = self.local(wc, path)?;
        let repo = self.repository(wc);
        let output = self
            .command(
                vec![
                    "proplist".into(),
                    "--xml".into(),
                    "--verbose".into(),
                    peg(&target.to_string_lossy()),
                ],
                Some(Path::new(s(wc, "path"))),
                repo.as_ref(),
                ctx,
            )?
            .text();
        let doc = parse_xml(&output)?;
        Ok(json!(doc
            .descendants()
            .filter(|n| n.has_tag_name("property"))
            .map(|n| json!({
                "name": attr(n, "name"),
                "value": n.text().unwrap_or(""),
            }))
            .collect::<Vec<_>>()))
    }

    pub fn diff(&self, input: &Value, range: bool, ctx: &Context) -> Result<Value> {
        let wc = self.wc(s(input, "wcId"))?;
        let target = self.local(&wc, s(input, "path"))?;
        let repo = self.repository(&wc);
        let root = Path::new(s(&wc, "path"));
        let output = if range {
            let from = input["from"]
                .as_u64()
                .ok_or_else(|| error("validation", "fileVersions.enterRevision"))?;
            let revisions = if input["to"] == "WORKING" {
                from.to_string()
            } else {
                format!(
                    "{from}:{}",
                    input["to"]
                        .as_u64()
                        .ok_or_else(|| error("validation", "fileVersions.enterRevision"))?
                )
            };
            self.command(
                vec![
                    "diff".into(),
                    "-r".into(),
                    revisions,
                    "--".into(),
                    peg(&target.to_string_lossy()),
                ],
                Some(root),
                repo.as_ref(),
                ctx,
            )?
            .text()
        } else if let Some(revision) = input["revision"].as_u64() {
            let url = self.target_url(&wc, s(input, "path"))?;
            self.command(
                vec![
                    "diff".into(),
                    "-c".into(),
                    revision.to_string(),
                    format!("{url}@{revision}"),
                ],
                None,
                repo.as_ref(),
                ctx,
            )?
            .text()
        } else {
            let mut result = self
                .command(
                    vec![
                        "diff".into(),
                        "--ignore-properties".into(),
                        "--".into(),
                        target.to_string_lossy().into(),
                    ],
                    Some(root),
                    repo.as_ref(),
                    ctx,
                )?
                .text();
            result.push_str(
                &self
                    .command(
                        vec![
                            "diff".into(),
                            "--properties-only".into(),
                            "--".into(),
                            target.to_string_lossy().into(),
                        ],
                        Some(root),
                        repo.as_ref(),
                        ctx,
                    )?
                    .text(),
            );
            result
        };
        let mut result = json!({"text": output.replace(&format!("{}/", s(&wc, "path")), "")});
        if output.contains("Cannot display: file marked as a binary type") {
            result["unsupported"] = json!(tr("fileVersions.binaryPreview"));
        }
        Ok(result)
    }

    pub fn target_url(&self, wc: &Value, path: &str) -> Result<String> {
        let mut url = address(s(wc, "url"))?;
        if path != "." && !path.is_empty() {
            url.path_segments_mut()
                .map_err(|_| error_message("validation", "Invalid repository URL"))?
                .pop_if_empty()
                .extend(path.split('/'));
        }
        Ok(url.into())
    }

    pub fn log(&self, input: &Value, ctx: &Context) -> Result<Value> {
        if input["before"] == 0 {
            return Ok(json!([]));
        }
        let wc = self.wc(s(input, "wcId"))?;
        let path = if s(input, "path").is_empty() {
            "."
        } else {
            s(input, "path")
        };
        self.local(&wc, path)?;
        let url = self.target_url(&wc, path)?;
        let repo = self.repository(&wc);
        let revisions = format!(
            "{}:0",
            input["before"]
                .as_u64()
                .map(|v| v.to_string())
                .unwrap_or("HEAD".into())
        );
        let output = self
            .command(
                vec![
                    "log".into(),
                    "--xml".into(),
                    "--verbose".into(),
                    "--limit".into(),
                    "50".into(),
                    "-r".into(),
                    revisions,
                    peg(&url),
                ],
                None,
                repo.as_ref(),
                ctx,
            )?
            .text();
        let doc = parse_xml(&output)?;
        let entries = doc
            .descendants()
            .filter(|entry| entry.has_tag_name("logentry"))
            .map(|entry| {
                let paths = entry
                    .descendants()
                    .filter(|path| path.has_tag_name("path"))
                    .map(|path| {
                        let mut value = json!({
                            "path": path.text().unwrap_or(""),
                            "action": attr(path, "action"),
                            "kind": attr(path, "kind"),
                        });
                        if let Some(source) = path.attribute("copyfrom-path") {
                            value["copyFrom"] = json!(source);
                        }
                        value
                    })
                    .collect::<Vec<_>>();
                let revision = attr(entry, "revision").parse::<u64>().unwrap_or(0);
                json!({
                    "revision": revision,
                    "author": child_text(entry, "author"),
                    "date": child_text(entry, "date"),
                    "message": child_text(entry, "msg"),
                    "paths": paths,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!(entries))
    }

    pub fn list(&self, input: &Value, ctx: &Context) -> Result<Value> {
        let repo = self.remote_repo(s(input, "url"), s(input, "repositoryId"))?;
        let url = address(s(input, "url"))?;
        let output = self
            .command(
                vec!["list".into(), "--xml".into(), peg(url.as_str())],
                None,
                repo.as_ref(),
                ctx,
            )?
            .text();
        let doc = parse_xml(&output)?;
        let entries = doc
            .descendants()
            .filter(|entry| entry.has_tag_name("entry"))
            .map(|entry| {
                let commit = entry.children().find(|child| child.has_tag_name("commit"));
                let size = child_text(entry, "size").parse::<u64>().unwrap_or(0);
                let revision = commit
                    .map(|node| attr(node, "revision"))
                    .unwrap_or_default();
                let author = commit
                    .map(|node| child_text(node, "author"))
                    .unwrap_or_default();
                let date = commit
                    .map(|node| child_text(node, "date"))
                    .unwrap_or_default();
                json!({
                    "name": child_text(entry, "name"),
                    "kind": attr(entry, "kind"),
                    "size": size,
                    "revision": revision,
                    "author": author,
                    "date": date,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!(entries))
    }
}
