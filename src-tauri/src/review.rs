use crate::{
    content::{markers, regular_content, text_content, writable},
    model::*,
    runner::Context,
    state::{Backend, SavedReview},
};
use serde_json::{json, Value};
use std::{collections::BTreeSet, fs, path::Path, time::Instant};

pub const FILE_ACTIONS: [&str; 6] = [
    "recover",
    "restore-backup",
    "resolve-local",
    "resolve-incoming",
    "merge",
    "apply-merge",
];

impl Backend {
    pub fn review(&self, input: &Value, ctx: &Context) -> Result<Value> {
        let wc = self.wc(s(input, "wcId"))?;
        let action = s(input, "action");
        let requested = strings(&input["paths"]);
        if requested.is_empty() && !["update", "cleanup"].contains(&action) {
            return Err(error("validation", "svn.selectAnOperationTarget"));
        }
        for path in &requested {
            self.local(&wc, path)?;
        }
        let snapshot = self.scan(&wc, false, None, ctx)?;
        let files = items(&snapshot["files"]);
        if files.iter().any(|file| {
            file["external"] == true
                && requested.iter().any(|p| {
                    contains(s(file, "path"), p)
                        || ([
                            "delete",
                            "rename",
                            "revert",
                            "add",
                            "recover",
                            "restore-backup",
                            "merge",
                            "apply-merge",
                            "resolve-local",
                            "resolve-incoming",
                        ]
                        .contains(&action)
                            && contains(p, s(file, "path")))
                })
        }) {
            return Err(error(
                "validation",
                "svn.theScopeIncludesAnExternalManageDirectoryExternals",
            ));
        }
        let mut paths = requested.iter().cloned().collect::<BTreeSet<_>>();
        let mut reasons = vec![];
        if action == "commit" {
            if s(input, "message").trim().is_empty() {
                return Err(error("validation", "svn.enterACommitMessage"));
            }
            let tracked = files.iter().filter(|f| changed(f)).collect::<Vec<_>>();
            if let Some(path) = paths
                .iter()
                .find(|path| !tracked.iter().any(|file| s(file, "path") == *path))
            {
                return Err(error_message(
                    "stale",
                    &tr("svn.fileStatusHasChangedRefreshFirst").replace("{{path}}", path),
                ));
            }
            loop {
                let mut added = vec![];
                for file in &tracked {
                    let mandatory = paths.iter().any(|path| {
                        let source = tracked.iter().find(|f| s(f, "path") == path);
                        (s(file, "item") == "added" && contains(s(file, "path"), path))
                            || source.is_some_and(|source| {
                                (s(source, "kind") == "dir"
                                    && ["added", "deleted", "replaced"]
                                        .contains(&s(source, "item"))
                                    && contains(path, s(file, "path")))
                                    || s(source, "movedFrom") == s(file, "path")
                                    || s(source, "movedTo") == s(file, "path")
                            })
                    });
                    if mandatory && !paths.contains(s(file, "path")) {
                        added.push(s(file, "path").to_owned());
                    }
                }
                if added.is_empty() {
                    break;
                }
                for path in added {
                    paths.insert(path.clone());
                    reasons.push(
                        tr("svn.relatedPathAddedParentDirectoryDescendantOrOther")
                            .replace("{{path}}", &path),
                    );
                }
            }
            if files.iter().any(|f| {
                paths.contains(s(f, "path"))
                    && (conflict(f)
                        || ["missing", "obstructed", "incomplete"].contains(&s(f, "item")))
            }) {
                return Err(error(
                    "conflict",
                    "svn.theCommitScopeIncludesConflictedMissingOrObstructed",
                ));
            }
        } else if ["revert", "delete", "add"].contains(&action) {
            for file in &files {
                if requested.iter().any(|p| contains(p, s(file, "path")))
                    && (changed(file) || ["unversioned", "ignored"].contains(&s(file, "item")))
                {
                    paths.insert(s(file, "path").into());
                }
            }
        }
        if ["add", "delete", "rename"].contains(&action) {
            let disk = self.disk_paths(&wc, &requested, ctx)?;
            if disk.len() > 2000 {
                return Err(error(
                    "validation",
                    "svn.theScopeExceedsDiskEntriesSelectASmaller",
                ));
            }
            if disk.len() > requested.len() {
                reasons.push(tr(
                    "svn.thisDirectoryOperationIncludesTheFollowingDescendantsOn",
                ));
            }
            paths.extend(disk);
        }
        if action == "add" {
            for path in &requested {
                let mut parent = Path::new(path).parent();
                while let Some(ancestor) = parent {
                    let name = ancestor.to_string_lossy();
                    if name.is_empty() || name == "." {
                        break;
                    }
                    if files.iter().any(|f| {
                        s(f, "path") == name && !["unversioned", "ignored"].contains(&s(f, "item"))
                    }) {
                        break;
                    }
                    if paths.insert(name.to_string()) {
                        reasons.push(
                            tr("svn.addingToVersionControlRequiresThisParentDirectory")
                                .replace("{{ancestor}}", &name),
                        );
                    }
                    parent = ancestor.parent();
                }
            }
        }
        if action == "rename" {
            if requested.len() != 1 || requested[0] == "." {
                return Err(error("validation", "svn.selectOneFileOrDirectoryToRename"));
            }
            if s(input, "destination").is_empty() {
                return Err(error("validation", "svn.enterANewRelativePath"));
            }
            let target = self.local(&wc, s(input, "destination"))?;
            if fs::symlink_metadata(target).is_ok() {
                return Err(error(
                    "validation",
                    "svn.theDestinationExistsAndCannotBeOverwritten",
                ));
            }
            paths.insert(s(input, "destination").into());
            reasons.push(
                tr("svn.moveDestination").replace("{{destination}}", s(input, "destination")),
            );
        }
        if action == "ignore" {
            for path in &requested {
                let basename = Path::new(path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy();
                if basename.contains(['\r', '\n', '*', '?', '[', ']']) {
                    return Err(error(
                        "validation",
                        "svn.thisFilenameContainsSvnIgnoreWildcardsAndCannot",
                    ));
                }
                let parent = Path::new(path)
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or(Path::new("."))
                    .to_string_lossy()
                    .into_owned();
                if paths.insert(parent.clone()) {
                    reasons.push(
                        tr("svn.theSvnIgnorePropertyOfParentDirectoryWill")
                            .replace("{{path}}", &parent),
                    );
                }
            }
        }
        if ["delete", "rename"].contains(&action) && paths.contains(".") {
            return Err(error("validation", "svn.theWorkingCopyRootCannotBeUsedFor"));
        }
        let paths = paths.into_iter().collect::<Vec<_>>();
        let mut content = None;
        let mut source_fingerprint = None;
        let mut preview = None;
        if FILE_ACTIONS.contains(&action) {
            if paths.len() != 1 || paths[0] == "." {
                return Err(error("validation", "fileVersions.singleFile"));
            }
            let path = &paths[0];
            let file = files
                .iter()
                .find(|f| s(f, "path") == path)
                .ok_or_else(|| error("validation", "fileVersions.existingOnly"))?;
            let target = self.local(&wc, path)?;
            let current = regular_content(&target)?;
            source_fingerprint = Some(self.conflict_fingerprint(&wc, &snapshot, path, ctx)?);
            if s(file, "kind") != "file"
                || file["copied"] == true
                || !s(file, "movedFrom").is_empty()
                || !s(file, "movedTo").is_empty()
                || !["normal", "modified", "conflicted"].contains(&s(file, "item"))
            {
                return Err(error("validation", "fileVersions.existingOnly"));
            }
            if action != "merge" {
                writable(&target)?;
            }
            if ["recover", "restore-backup"].contains(&action) {
                if conflict(file) {
                    return Err(error("conflict", "fileVersions.resolveFirst"));
                }
                content = Some(if action == "recover" {
                    let revision = input["revision"]
                        .as_u64()
                        .filter(|v| *v > 0)
                        .ok_or_else(|| error("validation", "fileVersions.enterRevision"))?;
                    reasons.push(
                        tr("fileVersions.reviewSource")
                            .replace("{{revision}}", &revision.to_string()),
                    );
                    self.historical_content(&wc, path, revision, ctx)?
                } else {
                    reasons.push(tr("fileVersions.reviewBackup"));
                    self.backup_content(s(&wc, "id"), path, s(input, "backupId"))?
                });
            } else {
                let conflict = self.conflict_inputs(&wc, path, &snapshot, ctx)?;
                if action == "apply-merge" {
                    let record = self
                        .merge_record(s(&wc, "id"), path, s(input, "mergeId"))?
                        .ok_or_else(|| error("stale", "fileVersions.mergeStale"))?;
                    if record["fingerprint"]
                        != json!(self.conflict_fingerprint(&wc, &snapshot, path, ctx)?)
                    {
                        return Err(error("stale", "fileVersions.mergeStale"));
                    }
                    let result = regular_content(&self.merge_result(&record))?;
                    if hash(&result) == s(&record, "initialHash")
                        || markers(&result)
                        || text_content(&result).is_none()
                    {
                        return Err(error("validation", "fileVersions.unfinishedMerge"));
                    }
                    content = Some(result);
                    reasons.push(tr("fileVersions.reviewResult"));
                } else if action != "merge" {
                    content = Some(regular_content(Path::new(s(
                        &conflict,
                        if action == "resolve-local" {
                            "local"
                        } else {
                            "incoming"
                        },
                    )))?);
                    reasons.push(tr(if action == "resolve-local" {
                        "fileVersions.reviewLocal"
                    } else {
                        "fileVersions.reviewIncoming"
                    }));
                }
            }
            if let Some(bytes) = content.as_ref() {
                preview = Some(self.content_diff(&current, bytes, ctx)?);
            }
        }
        if action == "resolve" {
            for path in &paths {
                let file = files
                    .iter()
                    .find(|f| s(f, "path") == path)
                    .ok_or_else(|| error("stale", "fileVersions.noConflict"))?;
                if !conflict(file) {
                    return Err(error("stale", "fileVersions.noConflict"));
                }
                if s(file, "item") == "conflicted"
                    && s(file, "kind") == "file"
                    && markers(&regular_content(&self.local(&wc, path)?)?)
                {
                    return Err(error("validation", "fileVersions.unfinishedMerge"));
                }
            }
        }
        if paths.len() > 2000 {
            return Err(error(
                "validation",
                "svn.theOperationExceedsPathsSelectASmallerScope",
            ));
        }
        let mut review = json!({
            "id": id(),
            "wcId": wc["id"],
            "action": action,
            "paths": paths,
            "requested": requested,
            "reasons": reasons,
            "createdAt": now(),
            "fingerprint": self.fingerprint(&wc, &snapshot, &paths, ctx)?,
        });
        for key in ["destination", "message", "revision", "backupId", "mergeId"] {
            if let Some(value) = input.get(key) {
                review[key] = value.clone();
            }
        }
        if let Some(preview) = preview {
            review["preview"] = preview;
        }
        if let Some(fingerprint) = source_fingerprint {
            if fingerprint
                != self.conflict_fingerprint(
                    &wc,
                    &self.scan(&wc, false, None, ctx)?,
                    &paths[0],
                    ctx,
                )?
            {
                return Err(error("stale", "fileVersions.mergeStale"));
            }
            review["sourceFingerprint"] = json!(fingerprint);
        }
        let warning = match action {
            "merge" => Some("fileVersions.mergeWarning"),
            "recover" | "restore-backup" | "resolve-local" | "resolve-incoming" | "apply-merge" => {
                Some("fileVersions.overwriteWarning")
            }
            "revert" => Some("svn.revertingDiscardsUncommittedTextAndPropertyChangesIn"),
            "delete" => Some("svn.deletingRemovesDiskContentAndSchedulesAnSvn"),
            "resolve" => Some("svn.markResolvedOnlyAfterManuallyMergingAndSaving"),
            "cleanup" => Some("svn.makeSureNoOtherSvnClientIsUsing"),
            "update" => Some("svn.updatingAppliesServerChangesAndMayCauseConflicts"),
            _ => None,
        };
        if let Some(warning) = warning {
            review["warning"] = json!(tr(warning));
        }
        ctx.check()?;
        let mut reviews = self.0.reviews.lock().unwrap();
        while reviews.len() >= 20
            || reviews
                .values()
                .map(|r| r.content.as_ref().map(Vec::len).unwrap_or(0))
                .sum::<usize>()
                + content.as_ref().map(Vec::len).unwrap_or(0)
                > 64 * 1024 * 1024
        {
            if let Some(oldest) = reviews
                .iter()
                .min_by_key(|(_, r)| r.created)
                .map(|(k, _)| k.clone())
            {
                reviews.remove(&oldest);
            } else {
                break;
            }
        }
        reviews.insert(
            s(&review, "id").into(),
            SavedReview {
                value: review.clone(),
                content,
                created: Instant::now(),
            },
        );
        Ok(review)
    }
}
