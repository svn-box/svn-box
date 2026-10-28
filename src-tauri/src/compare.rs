use crate::{
    content::{regular_content, text_content},
    model::*,
    paths::*,
    runner::Context,
    state::Backend,
};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

impl Backend {
    pub fn comparison(&self, input: &Value, context: &Context) -> Result<(PathBuf, PathBuf)> {
        let wc = self.wc(s(input, "wcId"))?;
        let path = s(input, "path");
        if path.is_empty() || path == "." {
            return Err(error("validation", "svn.selectAFileToCompareInFilemerge"));
        }
        let target = self.local(&wc, path)?;
        let repository = self.repository(&wc);
        let root = Path::new(s(&wc, "path"));
        let cat = |revision: u64| -> Result<Option<Vec<u8>>> {
            if revision == 0 {
                return Ok(None);
            }
            let url = self.target_url(&wc, path)?;
            match self.command(
                vec![
                    "cat".into(),
                    "-r".into(),
                    revision.to_string(),
                    "--".into(),
                    format!("{url}@{revision}"),
                ],
                None,
                repository.as_ref(),
                context,
            ) {
                Ok(output) => Ok(Some(output.bytes)),
                Err(error)
                    if error.detail.as_ref().is_some_and(|detail| {
                        [
                            "E160013",
                            "W160013",
                            "E160006",
                            "non-existent",
                            "not found in revision",
                        ]
                        .iter()
                        .any(|pattern| detail.contains(pattern))
                    }) =>
                {
                    Ok(None)
                }
                Err(error) => Err(error),
            }
        };
        let (left, right) = if let Some(range) = input.get("range") {
            let from = range["from"]
                .as_u64()
                .ok_or_else(|| error("validation", "fileVersions.enterRevision"))?;
            let left = self.historical_content(&wc, path, from, context)?;
            let right = if range["to"] == "WORKING" {
                regular_content(&target)?
            } else {
                let to = range["to"]
                    .as_u64()
                    .ok_or_else(|| error("validation", "fileVersions.enterRevision"))?;
                self.historical_content(&wc, path, to, context)?
            };
            (left, right)
        } else if let Some(revision) = input["revision"].as_u64() {
            let before = cat(revision.saturating_sub(1))?;
            let after = cat(revision)?;
            if before.is_none() && after.is_none() {
                return Err(error(
                    "path",
                    "svn.noComparableFileExistsAtTheSelectedRevision",
                ));
            }
            (before.unwrap_or_default(), after.unwrap_or_default())
        } else {
            let snapshot = self.scan(&wc, false, None, context)?;
            let files = items(&snapshot["files"]);
            let file = files.iter().find(|file| s(file, "path") == path);
            if file.is_some_and(|file| ["dir", "symlink"].contains(&s(file, "kind"))) {
                return Err(error(
                    "validation",
                    "svn.filemergeSupportsRegularFilesOnlySelectAFile",
                ));
            }
            let before = if file
                .is_some_and(|file| ["added", "unversioned", "ignored"].contains(&s(file, "item")))
            {
                vec![]
            } else {
                self.command(
                    vec![
                        "cat".into(),
                        "-r".into(),
                        "BASE".into(),
                        "--".into(),
                        peg(&target.to_string_lossy()),
                    ],
                    Some(root),
                    repository.as_ref(),
                    context,
                )?
                .bytes
            };
            let after = if !target.exists()
                && file.is_some_and(|file| ["deleted", "missing"].contains(&s(file, "item")))
            {
                vec![]
            } else {
                regular_content(&target)?
            };
            (before, after)
        };
        if text_content(&left).is_none() || text_content(&right).is_none() {
            return Err(error("validation", "fileVersions.binaryPreview"));
        }
        let directory = self
            .0
            .root
            .join("comparisons")
            .join(format!("compare-{}", id()));
        fs::create_dir_all(&directory)?;
        let extension = Path::new(path)
            .extension()
            .map(|extension| format!(".{}", extension.to_string_lossy()))
            .unwrap_or_default();
        let left_path = directory.join(format!("before{extension}"));
        let right_path = directory.join(format!("after{extension}"));
        atomic_write(&left_path, &left, 0o400)?;
        atomic_write(&right_path, &right, 0o400)?;
        Ok((left_path, right_path))
    }
}
