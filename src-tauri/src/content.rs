use crate::{model::*, paths::*, runner::Context, state::Backend};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::os::unix::fs::MetadataExt;
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

pub const LIMIT: usize = 32 * 1024 * 1024;

pub fn regular_content(path: &Path) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > LIMIT as u64 {
        return Err(error("validation", "fileVersions.regularOnly"));
    }
    Ok(fs::read(path)?)
}

pub fn text_content(bytes: &[u8]) -> Option<&str> {
    if bytes.contains(&0) {
        None
    } else {
        std::str::from_utf8(bytes).ok()
    }
}

pub fn writable(path: &Path) -> Result<()> {
    let info = fs::symlink_metadata(path)?;
    if !info.is_file() || info.mode() & 0o222 == 0 {
        return Err(error("path", "fileVersions.readOnly"));
    }
    Ok(())
}

pub fn markers(bytes: &[u8]) -> bool {
    regex::Regex::new(r"(?m)^(?:<{7}|>{7}|\|{7})(?: |$)")
        .unwrap()
        .is_match(text_content(bytes).unwrap_or(""))
}

impl Backend {
    pub fn content_diff(&self, before: &[u8], after: &[u8], ctx: &Context) -> Result<Value> {
        if text_content(before).is_none() || text_content(after).is_none() {
            return Ok(json!({
                "text": "",
                "unsupported": tr("fileVersions.binaryPreview"),
            }));
        }
        let directory = self.0.root.join("previews");
        fs::create_dir_all(&directory)?;
        let left = directory.join(format!("{}-before", id()));
        let right = directory.join(format!("{}-selected", id()));
        let result = (|| {
            atomic_write(&left, before, 0o600)?;
            atomic_write(&right, after, 0o600)?;
            let output = self.0.runner.run_at(
                Path::new("/usr/bin/diff"),
                &[
                    "-u".into(),
                    "-L".into(),
                    "current".into(),
                    "-L".into(),
                    "selected".into(),
                    left.to_string_lossy().into(),
                    right.to_string_lossy().into(),
                ],
                None,
                None,
                ctx,
                Duration::from_secs(120),
                true,
                &mut |_| {},
            )?;
            Ok(json!({"text": output.text()}))
        })();
        let _ = fs::remove_file(left);
        let _ = fs::remove_file(right);
        result
    }

    pub fn historical_content(
        &self,
        wc: &Value,
        path: &str,
        revision: u64,
        ctx: &Context,
    ) -> Result<Vec<u8>> {
        let target = self.local(wc, path)?;
        let repo = self.repository(wc);
        Ok(self
            .command(
                vec![
                    "cat".into(),
                    "-r".into(),
                    revision.to_string(),
                    "--".into(),
                    peg(&target.to_string_lossy()),
                ],
                Some(Path::new(s(wc, "path"))),
                repo.as_ref(),
                ctx,
            )?
            .bytes)
    }

    pub fn create_backup(&self, wc: &str, path: &str, reason: &str, bytes: &[u8]) -> Result<Value> {
        let record = json!({
            "id": id(),
            "wcId": wc,
            "path": path,
            "reason": reason,
            "bytes": bytes.len(),
            "createdAt": now(),
            "hash": hash(bytes),
        });
        let directory = self.0.root.join("file-backups");
        atomic_write(
            &directory.join(format!("{}.data", s(&record, "id"))),
            bytes,
            0o600,
        )?;
        write_json(
            &directory.join(format!("{}.json", s(&record, "id"))),
            &record,
        )?;
        Ok(record)
    }

    pub fn backups(&self, wc: &str, path: &str) -> Result<Value> {
        self.local(&self.wc(wc)?, path)?;
        let mut records = vec![];
        let directory = self.0.root.join("file-backups");
        if !directory.exists() {
            return Ok(json!([]));
        }
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(identifier) = name.strip_suffix(".json") {
                if valid_id(identifier) {
                    if let Some(record) = record(&entry.path()) {
                        if s(&record, "id") == identifier
                            && s(&record, "wcId") == wc
                            && s(&record, "path") == path
                        {
                            records.push(record);
                        }
                    }
                }
            }
        }
        records.sort_by(|a, b| s(b, "createdAt").cmp(s(a, "createdAt")));
        Ok(json!(records))
    }

    pub fn backup_content(&self, wc: &str, path: &str, identifier: &str) -> Result<Vec<u8>> {
        if !valid_id(identifier) {
            return Err(error("validation", "fileVersions.backupInvalid"));
        }
        let directory = self.0.root.join("file-backups");
        let record = record(&directory.join(format!("{identifier}.json")))
            .ok_or_else(|| error("stale", "fileVersions.backupInvalid"))?;
        let bytes = regular_content(&directory.join(format!("{identifier}.data")))?;
        if s(&record, "id") != identifier
            || s(&record, "wcId") != wc
            || s(&record, "path") != path
            || s(&record, "hash") != hash(&bytes)
            || record["bytes"].as_u64() != Some(bytes.len() as u64)
        {
            return Err(error("stale", "fileVersions.backupInvalid"));
        }
        Ok(bytes)
    }

    pub fn disk_paths(&self, wc: &Value, roots: &[String], ctx: &Context) -> Result<Vec<String>> {
        let mut paths = vec![];
        let mut stack = roots.to_vec();
        let mut visited = HashSet::new();
        while let Some(path) = stack.pop() {
            ctx.check()?;
            if !visited.insert(path.clone()) {
                continue;
            }
            if visited.len() > 50000 {
                return Err(error(
                    "validation",
                    "svn.theOperationExceedsDiskEntriesSelectASmaller",
                ));
            }
            let target = self.local(wc, &path)?;
            paths.push(path.clone());
            match fs::symlink_metadata(&target) {
                Ok(m) if m.is_dir() => {
                    let mut children =
                        fs::read_dir(&target)?.collect::<std::result::Result<Vec<_>, _>>()?;
                    children.sort_by_key(|e| e.file_name());
                    for entry in children.into_iter().rev() {
                        if entry.file_name() != ".svn" {
                            stack.push(relative(Path::new(s(wc, "path")), &entry.path())?);
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
                _ => {}
            }
        }
        Ok(paths)
    }

    pub fn fingerprint(
        &self,
        wc: &Value,
        snapshot: &Value,
        paths: &[String],
        ctx: &Context,
    ) -> Result<String> {
        let mut digest = Sha256::new();
        digest.update(s(snapshot, "fingerprint"));
        let mut visited = self.disk_paths(wc, paths, ctx)?;
        visited.sort();
        for path in visited {
            ctx.check()?;
            let target = self.local(wc, &path)?;
            digest.update(&path);
            match fs::symlink_metadata(&target) {
                Ok(m) => {
                    digest.update(format!(
                        "{}:{}:{}:{}",
                        m.mode(),
                        m.len(),
                        m.mtime(),
                        m.mtime_nsec()
                    ));
                    if m.is_symlink() {
                        digest.update(fs::read_link(target)?.to_string_lossy().as_bytes());
                    } else if m.is_file() {
                        let mut file = fs::File::open(target)?;
                        let mut bytes = [0; 65536];
                        loop {
                            ctx.check()?;
                            let count = file.read(&mut bytes)?;
                            if count == 0 {
                                break;
                            }
                            digest.update(&bytes[..count]);
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => digest.update("missing"),
                Err(e) => return Err(e.into()),
            }
        }
        for file in items(&snapshot["files"]) {
            if ["modified", "conflicted"].contains(&s(&file, "props"))
                && paths.iter().any(|p| contains(p, s(&file, "path")))
            {
                digest.update(serde_json::to_vec(&self.properties(
                    wc,
                    s(&file, "path"),
                    ctx,
                )?)?);
            }
        }
        Ok(format!("{:x}", digest.finalize()))
    }

    pub fn conflict_inputs(
        &self,
        wc: &Value,
        path: &str,
        snapshot: &Value,
        ctx: &Context,
    ) -> Result<Value> {
        let file = items(&snapshot["files"])
            .into_iter()
            .find(|f| s(f, "path") == path)
            .ok_or_else(|| error("validation", "fileVersions.textConflictOnly"))?;
        if s(&file, "item") != "conflicted"
            || s(&file, "props") == "conflicted"
            || file["treeConflicted"] == true
            || s(&file, "kind") != "file"
        {
            return Err(error("validation", "fileVersions.textConflictOnly"));
        }
        let target = self.local(wc, path)?;
        let repo = self.repository(wc);
        let info = self.info_at(
            &target.to_string_lossy(),
            Some(Path::new(s(wc, "path"))),
            repo.as_ref(),
            ctx,
        )?;
        let conflict = items(&info["conflicts"])
            .into_iter()
            .find(|c| s(c, "type") == "text")
            .ok_or_else(|| error("validation", "fileVersions.textConflictOnly"))?;
        let mut result = json!({
            "output": target,
            "baseRevision": info["textConflict"]["baseRevision"],
            "incomingRevision": info["textConflict"]["incomingRevision"],
        });
        for (side, key) in [
            ("base", "prev-base-file"),
            ("local", "prev-wc-file"),
            ("incoming", "cur-base-file"),
        ] {
            let value = s(&conflict, key);
            if value.is_empty() {
                return Err(error("validation", "fileVersions.textConflictOnly"));
            }
            let relative = relative(
                Path::new(s(wc, "path")),
                &target.parent().unwrap().join(value),
            )?;
            let source = self.local(wc, &relative)?;
            if text_content(&regular_content(&source)?).is_none() {
                return Err(error("validation", "fileVersions.textConflictOnly"));
            }
            result[side] = json!(source);
        }
        Ok(result)
    }

    pub fn conflict_fingerprint(
        &self,
        wc: &Value,
        snapshot: &Value,
        path: &str,
        ctx: &Context,
    ) -> Result<String> {
        let mut digest = Sha256::new();
        digest.update(self.fingerprint(wc, snapshot, &[path.into()], ctx)?);
        let target = self.local(wc, path)?;
        let info = self.info_at(
            &target.to_string_lossy(),
            Some(Path::new(s(wc, "path"))),
            self.repository(wc).as_ref(),
            ctx,
        )?;
        digest.update(serde_json::to_vec(&info["conflicts"])?);
        for conflict in items(&info["conflicts"]) {
            for key in ["prev-base-file", "prev-wc-file", "cur-base-file"] {
                if !s(&conflict, key).is_empty() {
                    let relative = relative(
                        Path::new(s(wc, "path")),
                        &target.parent().unwrap().join(s(&conflict, key)),
                    )?;
                    digest.update(regular_content(&self.local(wc, &relative)?)?);
                }
            }
        }
        Ok(format!("{:x}", digest.finalize()))
    }

    pub fn merge_record(&self, wc: &str, path: &str, identifier: &str) -> Result<Option<Value>> {
        if !identifier.is_empty() && !valid_id(identifier) {
            return Err(error("validation", "fileVersions.mergeStale"));
        }
        let directory = self.0.root.join("merges");
        if !directory.exists() {
            return Ok(None);
        }
        let mut records = vec![];
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !valid_id(&name) || (!identifier.is_empty() && identifier != name) {
                continue;
            }
            let target = entry.path().join("session.json");
            if let Some(record) = record(&target) {
                if s(&record, "id") == name
                    && s(&record, "wcId") == wc
                    && s(&record, "path") == path
                    && s(&record, "fingerprint").len() == 64
                {
                    records.push((fs::symlink_metadata(target)?.modified()?, record));
                }
            }
        }
        records.sort_by_key(|record| std::cmp::Reverse(record.0));
        Ok(records.into_iter().next().map(|(_, record)| record))
    }

    pub fn merge_state(&self, wc: &Value, path: &str, ctx: &Context) -> Result<Value> {
        let target = self.local(wc, path)?;
        let Some(record) = self.merge_record(s(wc, "id"), path, "")? else {
            return Ok(Value::Null);
        };
        let result = self.merge_result(&record);
        let bytes = regular_content(&result)?;
        Ok(json!({
            "id": record["id"],
            "path": path,
            "baseRevision": record["baseRevision"],
            "incomingRevision": record["incomingRevision"],
            "hasResult": hash(&bytes) != s(&record, "initialHash")
                && text_content(&bytes).is_some(),
            "markers": markers(&bytes),
            "preview": self.content_diff(&regular_content(&target)?, &bytes, ctx)?,
        }))
    }

    pub fn merge_result(&self, record: &Value) -> PathBuf {
        let extension = Path::new(s(record, "path"))
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        self.0
            .root
            .join("merges")
            .join(s(record, "id"))
            .join(format!("result{extension}"))
    }
}
