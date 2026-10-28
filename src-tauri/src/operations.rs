use crate::{
    content::{regular_content, writable},
    model::*,
    paths::*,
    review::FILE_ACTIONS,
    runner::Context,
    state::{Backend, SavedReview},
};
use serde_json::{json, Value};
use std::os::unix::fs::MetadataExt;
use std::{fs, path::Path, time::Duration};

impl Backend {
    pub fn checkout(&self, input: &Value, ctx: &Context) -> Result<Value> {
        let url = address(s(input, "url"))?;
        let repository = self.remote_repo(url.as_str(), s(input, "repositoryId"))?;
        self.info_at(url.as_str(), None, repository.as_ref(), ctx)?;
        let path = Path::new(s(input, "destination"));
        if !path.is_absolute() || path == Path::new("/") {
            return Err(error(
                "validation",
                "svn.chooseAValidAbsoluteDestinationPath",
            ));
        }
        let parent = fs::canonicalize(path.parent().unwrap())?;
        let destination = parent.join(
            path.file_name()
                .ok_or_else(|| error("validation", "svn.chooseAValidAbsoluteDestinationPath"))?,
        );
        for ancestor in parent.ancestors() {
            if ancestor.join(".svn").is_dir() {
                return Err(error(
                    "validation",
                    "svn.theCheckoutDestinationCannotBeInsideAnExisting",
                ));
            }
        }
        if fs::symlink_metadata(&destination).is_ok() {
            return Err(error(
                "validation",
                "svn.theCheckoutDestinationMustNotExistToAvoid",
            ));
        }
        if items(&self.state()["workingCopies"])
            .iter()
            .any(|w| destination.starts_with(s(w, "path")))
        {
            return Err(error(
                "validation",
                "svn.checkOutToAFolderOutsideManagedWorking",
            ));
        }
        let backend = self.clone();
        let input = input.clone();
        self.enqueue(
            format!("checkout:{}", destination.display()),
            None,
            "checkout",
            ctx,
            move |ctx| {
                use std::os::unix::fs::DirBuilderExt;
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&destination)
                    .map_err(|_| {
                        error("path", "svn.theDestinationAlreadyExistsChooseAnotherPath")
                    })?;
                backend.command(
                    vec![
                        "checkout".into(),
                        "--ignore-externals".into(),
                        "--depth".into(),
                        s(&input, "depth").into(),
                        peg(url.as_str()),
                        destination.to_string_lossy().into(),
                    ],
                    None,
                    repository.as_ref(),
                    &ctx,
                )?;
                backend.add_working_copy(&destination.to_string_lossy(), "", &ctx)?;
                Ok(0)
            },
        )
    }

    pub fn execute(&self, identifier: &str, ctx: &Context) -> Result<Value> {
        let value = self
            .0
            .reviews
            .lock()
            .unwrap()
            .get(identifier)
            .map(|r| r.value.clone())
            .ok_or_else(|| error("stale", "svn.thisReviewHasExpiredReviewTheScopeAgain"))?;
        let wc = self.wc(s(&value, "wcId"))?;
        if ["commit", "update"].contains(&s(&value, "action"))
            && address(s(&wc, "url"))?.scheme() != "file"
        {
            self.info_at(s(&wc, "url"), None, self.repository(&wc).as_ref(), ctx)?;
        }
        let review = self
            .0
            .reviews
            .lock()
            .unwrap()
            .remove(identifier)
            .ok_or_else(|| error("stale", "svn.thisReviewWasAlreadyExecutedReviewTheScope"))?;
        let backend = self.clone();
        let action = s(&review.value, "action").to_owned();
        self.enqueue(
            s(&wc, "path").into(),
            Some(s(&wc, "id").into()),
            &action,
            ctx,
            move |ctx| backend.execute_review(wc, review, &ctx),
        )
    }

    pub fn launch_merge(&self, inputs: &Value, ctx: &Context) -> Result<()> {
        let tool = s(&self.state()["settings"], "mergeTool").to_owned();
        let paths = ["base", "local", "incoming", "output"].map(|side| s(inputs, side).to_owned());
        if !tool.is_empty()
            && !tool.trim_end_matches('/').ends_with("FileMerge.app")
            && !tool.ends_with("/opendiff")
        {
            if !Path::new(&tool).is_absolute() {
                return Err(error("path", "fileVersions.toolUnavailable"));
            }
            if tool.ends_with(".app") {
                let mut args = vec!["-a".into(), tool];
                args.extend(paths);
                self.external(Path::new("/usr/bin/open"), &args, ctx, false)?;
            } else {
                self.external(Path::new(&tool), &paths, ctx, true)?;
            }
        } else {
            let found = self
                .external(
                    Path::new("/usr/bin/xcrun"),
                    &["--find".into(), "opendiff".into()],
                    ctx,
                    false,
                )
                .map_err(|_| error("path", "fileVersions.toolUnavailable"))?;
            self.external(
                Path::new(found.trim()),
                &[
                    s(inputs, "local").into(),
                    s(inputs, "incoming").into(),
                    "-ancestor".into(),
                    s(inputs, "base").into(),
                    "-merge".into(),
                    s(inputs, "output").into(),
                ],
                ctx,
                false,
            )?;
        }
        Ok(())
    }

    pub fn external(
        &self,
        tool: &Path,
        args: &[String],
        ctx: &Context,
        detached: bool,
    ) -> Result<String> {
        if detached {
            let mut child = std::process::Command::new(tool)
                .args(args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()?;
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(String::new())
        } else {
            Ok(self
                .0
                .runner
                .run_at(
                    tool,
                    args,
                    None,
                    None,
                    ctx,
                    Duration::from_secs(30),
                    false,
                    &mut |_| {},
                )?
                .text())
        }
    }

    fn execute_review(&self, wc: Value, review: SavedReview, ctx: &Context) -> Result<usize> {
        let value = &review.value;
        let action = s(value, "action");
        let paths = strings(&value["paths"]);
        let requested = strings(&value["requested"]);
        let root = Path::new(s(&wc, "path"));
        let repo = self.repository(&wc);
        let snapshot = self.scan(&wc, false, None, ctx)?;
        if review.created.elapsed() > Duration::from_secs(600) {
            return Err(error("stale", "svn.thisReviewIsOverTenMinutesOldReview"));
        }
        if self.fingerprint(&wc, &snapshot, &paths, ctx)? != s(value, "fingerprint")
            || (!s(value, "sourceFingerprint").is_empty()
                && self.conflict_fingerprint(&wc, &snapshot, &paths[0], ctx)?
                    != s(value, "sourceFingerprint"))
        {
            return Err(error(
                "stale",
                "svn.filesOrPropertiesChangedAfterReviewRefreshAnd",
            ));
        }
        let targets = paths
            .iter()
            .map(|p| self.local(&wc, p).map(|p| peg(&p.to_string_lossy())))
            .collect::<Result<Vec<_>>>()?;
        if FILE_ACTIONS.contains(&action) {
            self.execute_content(&wc, &review, &snapshot, ctx)?;
        } else if action == "commit" {
            let message_file = self.0.root.join(format!("message-{}.txt", s(value, "id")));
            atomic_write(&message_file, s(value, "message").as_bytes(), 0o600)?;
            let mut args = vec![
                "commit".into(),
                "--depth".into(),
                "empty".into(),
                "--file".into(),
                message_file.to_string_lossy().into(),
                "--".into(),
            ];
            args.extend(targets);
            let result = self.command(args, Some(root), repo.as_ref(), ctx);
            let _ = fs::remove_file(message_file);
            result?;
            self.change(|state| {
                let mut messages = vec![json!(s(value, "message"))];
                messages.extend(
                    items(&state["recentMessages"])
                        .into_iter()
                        .filter(|m| m.as_str() != Some(s(value, "message")))
                        .take(19),
                );
                state["recentMessages"] = json!(messages);
                let session = &mut state["sessions"][s(&wc, "id")];
                if session["draft"] == value["message"] {
                    session["draft"] = json!("");
                }
                session["selected"] = json!(strings(&session["selected"])
                    .into_iter()
                    .filter(|p| !paths.contains(p))
                    .collect::<Vec<_>>());
                Ok(())
            })?;
        } else if action == "update" {
            self.command(
                vec![
                    "update".into(),
                    "--ignore-externals".into(),
                    peg(s(&wc, "path")),
                ],
                Some(root),
                repo.as_ref(),
                ctx,
            )?;
        } else if action == "cleanup" {
            self.command(
                vec!["cleanup".into(), peg(s(&wc, "path"))],
                Some(root),
                repo.as_ref(),
                ctx,
            )?;
        } else if action == "rename" {
            let source = self.local(&wc, &requested[0])?;
            let destination = self.local(&wc, s(value, "destination"))?;
            self.command(
                vec![
                    "move".into(),
                    peg(&source.to_string_lossy()),
                    destination.to_string_lossy().into(),
                ],
                Some(root),
                repo.as_ref(),
                ctx,
            )?;
        } else if action == "ignore" {
            for path in &requested {
                let parent = Path::new(path)
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or(Path::new("."))
                    .to_string_lossy()
                    .into_owned();
                let target = self.local(&wc, &parent)?;
                let properties = self.properties(&wc, &parent, ctx)?;
                let properties = items(&properties);
                let current = properties
                    .iter()
                    .find(|p| s(p, "name") == "svn:ignore")
                    .map(|p| s(p, "value"))
                    .unwrap_or("");
                let mut ignores = current
                    .lines()
                    .filter(|l| !l.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                let basename = Path::new(path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                if !ignores.contains(&basename) {
                    ignores.push(basename);
                }
                self.command(
                    vec![
                        "propset".into(),
                        "svn:ignore".into(),
                        ignores.join("\n"),
                        peg(&target.to_string_lossy()),
                    ],
                    Some(root),
                    repo.as_ref(),
                    ctx,
                )?;
            }
        } else {
            let mut args: Vec<String> = match action {
                "resolve" => vec!["resolve", "--accept", "working", "--depth", "empty"],
                "revert" => vec!["revert", "--depth", "infinity"],
                "add" => vec!["add", "--parents", "--no-ignore"],
                "delete" => vec!["delete", "--force"],
                _ => return Err(error_message("validation", "Unsupported SVN operation")),
            }
            .into_iter()
            .map(str::to_owned)
            .collect();
            args.push("--".into());
            for path in &requested {
                if !requested
                    .iter()
                    .any(|other| other != path && contains(other, path))
                {
                    args.push(peg(&self.local(&wc, path)?.to_string_lossy()));
                }
            }
            self.command(args, Some(root), repo.as_ref(), ctx)?;
        }
        let fresh = self.status(s(&wc, "id"), false, ctx)?;
        let count = items(&fresh["files"])
            .iter()
            .filter(|f| conflict(f))
            .count();
        if count > 0 && action == "update" {
            if let Some(id) = ctx.operation.as_ref() {
                self.append_log(
                    id,
                    &tr("operations.updateConflicts").replace("{{count}}", &count.to_string()),
                );
            }
        }
        Ok(count)
    }

    fn validate_content(
        &self,
        wc: &Value,
        review: &Value,
        source: &str,
        temporary: Option<&Path>,
        ctx: &Context,
    ) -> Result<()> {
        let ignored = temporary
            .map(|p| relative(Path::new(s(wc, "path")), p))
            .transpose()?;
        let snapshot = self.scan(wc, false, ignored.as_deref(), ctx)?;
        let paths = strings(&review["paths"]);
        if self.fingerprint(wc, &snapshot, &paths, ctx)? != s(review, "fingerprint")
            || self.conflict_fingerprint(wc, &snapshot, &paths[0], ctx)? != source
        {
            return Err(error("stale", "fileVersions.mergeStale"));
        }
        ctx.check()
    }

    fn execute_content(
        &self,
        wc: &Value,
        review: &SavedReview,
        snapshot: &Value,
        ctx: &Context,
    ) -> Result<()> {
        let value = &review.value;
        let paths = strings(&value["paths"]);
        let path = &paths[0];
        let action = s(value, "action");
        let target = self.local(wc, path)?;
        let current = regular_content(&target)?;
        let fingerprint = self.conflict_fingerprint(wc, snapshot, path, ctx)?;
        self.validate_content(wc, value, &fingerprint, None, ctx)?;
        let backup = self.create_backup(s(wc, "id"), path, action, &current)?;
        if let Some(id) = ctx.operation.as_ref() {
            self.append_log(
                id,
                &tr("fileVersions.backupCreated")
                    .replace("{{id}}", s(&backup, "id"))
                    .replace("{{path}}", path),
            );
        }
        if action == "merge" {
            let source = self.conflict_inputs(wc, path, snapshot, ctx)?;
            let identifier = id();
            let directory = self.0.root.join("merges").join(&identifier);
            let extension = Path::new(path)
                .extension()
                .map(|s| format!(".{}", s.to_string_lossy()))
                .unwrap_or_default();
            let mut inputs = json!({});
            for side in ["base", "local", "incoming"] {
                let target = directory.join(format!("{side}{extension}"));
                atomic_write(
                    &target,
                    &regular_content(Path::new(s(&source, side)))?,
                    0o400,
                )?;
                inputs[side] = json!(target);
            }
            let output = directory.join(format!("result{extension}"));
            atomic_write(&output, &current, 0o600)?;
            inputs["output"] = json!(output);
            write_json(
                &directory.join("session.json"),
                &json!({
                    "id": identifier,
                    "wcId": wc["id"],
                    "path": path,
                    "fingerprint": fingerprint,
                    "baseRevision": source["baseRevision"],
                    "incomingRevision": source["incomingRevision"],
                    "initialHash": hash(&current),
                }),
            )?;
            self.validate_content(wc, value, &fingerprint, None, ctx)?;
            self.launch_merge(&inputs, ctx)?;
        } else {
            let bytes = review
                .content
                .as_ref()
                .ok_or_else(|| error("stale", "fileVersions.reviewExpired"))?;
            let check_result = || -> Result<()> {
                if action == "apply-merge" {
                    let record = self
                        .merge_record(s(wc, "id"), path, s(value, "mergeId"))?
                        .ok_or_else(|| error("stale", "fileVersions.mergeStale"))?;
                    if s(&record, "fingerprint") != fingerprint
                        || hash(regular_content(&self.merge_result(&record))?) != hash(bytes)
                    {
                        return Err(error("stale", "fileVersions.mergeStale"));
                    }
                }
                Ok(())
            };
            check_result()?;
            writable(&target)?;
            let temporary = target
                .parent()
                .unwrap()
                .join(format!(".svnbox-{}.tmp", id()));
            let outcome: Result<()> = (|| {
                atomic_write(
                    &temporary,
                    bytes,
                    fs::symlink_metadata(&target)?.mode() & 0o777,
                )?;
                self.validate_content(wc, value, &fingerprint, Some(&temporary), ctx)?;
                check_result()?;
                writable(&target)?;
                fs::rename(&temporary, &target)?;
                Ok(())
            })();
            let _ = fs::remove_file(&temporary);
            outcome?;
            if ["resolve-local", "resolve-incoming", "apply-merge"].contains(&action) {
                self.command(
                    vec![
                        "resolve".into(),
                        "--accept".into(),
                        "working".into(),
                        "--depth".into(),
                        "empty".into(),
                        "--".into(),
                        peg(&target.to_string_lossy()),
                    ],
                    Some(Path::new(s(wc, "path"))),
                    self.repository(wc).as_ref(),
                    ctx,
                )?;
            }
        }
        Ok(())
    }
}
