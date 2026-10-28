use crate::{model::*, state::Backend};
use serde_json::Value;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};
use url::Url;

pub fn address(value: &str) -> Result<Url> {
    let url =
        Url::parse(value).map_err(|_| error("validation", "auth.enterAValidSvnUrlItMayInclude"))?;
    let user = percent_encoding::percent_decode_str(url.username())
        .decode_utf8()
        .map_err(|_| error("validation", "auth.enterAValidSvnUrlItMayInclude"))?;
    if !["file", "https", "http", "svn", "svn+ssh"].contains(&url.scheme())
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || user.contains(['\r', '\n', '\0'])
    {
        return Err(error("validation", "auth.enterAValidSvnUrlItMayInclude"));
    }
    Ok(url)
}

pub fn credential_root(value: &str) -> Result<String> {
    let mut url = address(value)?;
    let _ = url.set_username("");
    if let Some(host) = url.host_str().map(str::to_lowercase) {
        url.set_host(Some(&host))
            .map_err(|_| error("validation", "auth.enterAValidSvnUrlItMayInclude"))?;
    }
    if url.scheme() == "svn" && url.port() == Some(3690) {
        let _ = url.set_port(None);
    }
    Ok(url.as_str().trim_end_matches('/').into())
}

pub fn connection_root(value: &str) -> Result<String> {
    let mut url = address(value)?;
    if url.scheme() != "file" {
        url.set_path("/");
    }
    credential_root(url.as_str())
}

pub fn within(root: &str, target: &str) -> Result<bool> {
    let parent = credential_root(root)?;
    let child = credential_root(target)?;
    Ok(child == parent || child.starts_with(&format!("{parent}/")))
}

pub fn find_credential(profiles: &Value, target: &str, preferred: &str) -> Result<Option<Value>> {
    let url = address(target)?;
    let username = percent_encoding::percent_decode_str(url.username()).decode_utf8_lossy();
    let mut matches = items(profiles)
        .into_iter()
        .filter(|p| {
            !s(p, "rootUrl").is_empty()
                && within(s(p, "rootUrl"), target).unwrap_or(false)
                && (username.is_empty() || username == s(p, "username"))
        })
        .collect::<Vec<_>>();
    let longest = matches
        .iter()
        .map(|p| s(p, "rootUrl").len())
        .max()
        .unwrap_or(0);
    matches.retain(|p| s(p, "rootUrl").len() == longest);
    Ok(matches
        .iter()
        .find(|p| s(p, "id") == preferred)
        .cloned()
        .or_else(|| {
            if matches.len() == 1 {
                matches.pop()
            } else {
                None
            }
        }))
}

pub fn peg(path: &str) -> String {
    format!("{path}@")
}

pub fn relative(root: &Path, path: &Path) -> Result<String> {
    Ok(path
        .strip_prefix(root)
        .map_err(|_| error("validation", "svn.theTargetPathIsOutsideTheWorkingCopy"))?
        .to_string_lossy()
        .to_string())
    .map(|p| if p.is_empty() { ".".into() } else { p })
}

impl Backend {
    pub fn local(&self, wc: &Value, path: &str) -> Result<PathBuf> {
        let path = if path.is_empty() { "." } else { path };
        if Path::new(path).is_absolute()
            || path.contains(['\r', '\n', '\0'])
            || path
                .split(['\\', '/'])
                .any(|p| p == ".." || p.eq_ignore_ascii_case(".svn"))
        {
            return Err(error(
                "validation",
                "svn.theTargetPathIsOutsideTheAllowedScope",
            ));
        }
        let root = PathBuf::from(s(wc, "path"));
        let target = Path::new(path)
            .components()
            .fold(root.clone(), |mut result, part| {
                if let Component::Normal(part) = part {
                    result.push(part);
                }
                result
            });
        let mut ancestor = if fs::symlink_metadata(&target).is_ok_and(|m| m.is_symlink()) {
            target.parent().unwrap().to_path_buf()
        } else {
            target.clone()
        };
        loop {
            match fs::canonicalize(&ancestor) {
                Ok(actual) => {
                    if !actual.starts_with(&root) {
                        return Err(error(
                            "validation",
                            "svn.theTargetSSymbolicLinkPointsOutsideThe",
                        ));
                    }
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    if ancestor == root {
                        return Err(error("path", "svn.theWorkingCopyRootIsNoLongerAccessible"));
                    }
                    ancestor = ancestor
                        .parent()
                        .ok_or_else(|| error("path", "svn.theWorkingCopyRootIsNoLongerAccessible"))?
                        .to_path_buf();
                }
                Err(e) => return Err(e.into()),
            }
        }
        let mut check = target.as_path();
        while check != root {
            if check.join(".svn").is_dir() {
                return Err(error(
                    "validation",
                    "svn.thisTargetBelongsToANestedWorkingCopy",
                ));
            }
            check = check
                .parent()
                .ok_or_else(|| error("validation", "svn.theTargetPathIsOutsideTheWorkingCopy"))?;
        }
        Ok(target)
    }

    pub fn remote_repo(&self, url: &str, id: &str) -> Result<Option<Value>> {
        address(url)?;
        let repositories = items(&self.state()["repositories"]);
        if !id.is_empty() {
            let repository = repositories
                .into_iter()
                .find(|r| s(r, "id") == id)
                .ok_or_else(|| error_message("path", "Repository not found"))?;
            if !within(s(&repository, "rootUrl"), url)? {
                return Err(error(
                    "validation",
                    "svn.theBrowseUrlIsOutsideThisRepositoryRoot",
                ));
            }
            return Ok(Some(repository));
        }
        Ok(repositories
            .into_iter()
            .filter(|r| within(s(r, "rootUrl"), url).unwrap_or(false))
            .max_by_key(|r| s(r, "rootUrl").len()))
    }
}
