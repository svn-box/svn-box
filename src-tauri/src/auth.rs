use crate::{model::*, paths::*, state::Backend};
use serde_json::{json, Value};

pub trait Vault: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<String>>;

    fn set(&self, id: &str, password: &str) -> Result<()>;

    fn delete(&self, id: &str) -> Result<()>;
}

#[cfg(not(test))]
pub struct Keychain;

#[cfg(not(test))]
impl Vault for Keychain {
    fn get(&self, id: &str) -> Result<Option<String>> {
        match security_framework::passwords::get_generic_password(
            "app.svnbox.desktop.credentials",
            id,
        ) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| error("auth", "desktop.macosSecureStorageIsUnavailable")),
            Err(e) if e.code() == -25300 => Ok(None),
            Err(_) => Err(error("auth", "desktop.macosSecureStorageIsUnavailable")),
        }
    }

    fn set(&self, id: &str, password: &str) -> Result<()> {
        security_framework::passwords::set_generic_password(
            "app.svnbox.desktop.credentials",
            id,
            password.as_bytes(),
        )
        .map_err(|_| {
            error(
                "auth",
                "desktop.macosSecureStorageIsUnavailableThePasswordWas",
            )
        })
    }

    fn delete(&self, id: &str) -> Result<()> {
        match security_framework::passwords::delete_generic_password(
            "app.svnbox.desktop.credentials",
            id,
        ) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == -25300 => Ok(()),
            Err(_) => Err(error("auth", "desktop.macosSecureStorageIsUnavailable")),
        }
    }
}

impl Backend {
    pub fn authentication(&self, input: &Value) -> Result<Value> {
        let mut url = s(input, "url").to_owned();
        let mut repository = None;
        if !s(input, "reviewId").is_empty() {
            let reviews = self.0.reviews.lock().unwrap();
            let review = reviews
                .get(s(input, "reviewId"))
                .ok_or_else(|| error("stale", "svn.thisReviewHasExpiredReviewTheScopeAgain"))?;
            if !["commit", "update"].contains(&s(&review.value, "action")) {
                return Ok(Value::Null);
            }
            let wc = self.wc(s(&review.value, "wcId"))?;
            url = s(&wc, "url").into();
            repository = self.repository(&wc);
        } else if !s(input, "wcId").is_empty() {
            let wc = self.wc(s(input, "wcId"))?;
            url = s(&wc, "url").into();
            repository = self.repository(&wc);
        } else if !url.is_empty() {
            repository = self.remote_repo(&url, s(input, "repositoryId"))?;
        }
        if url.is_empty() {
            return Err(error("validation", "svn.missingAuthenticationTarget"));
        }
        let address = address(&url)?;
        if address.scheme() == "file" {
            return Ok(Value::Null);
        }
        let profile = find_credential(
            &self.state()["credentials"],
            &url,
            repository
                .as_ref()
                .map(|v| s(v, "credentialId"))
                .unwrap_or(""),
        )?;
        let available = profile
            .as_ref()
            .map(|p| self.0.vault.get(s(p, "id")))
            .transpose()?
            .flatten()
            .is_some();
        let username = percent_encoding::percent_decode_str(address.username())
            .decode_utf8_lossy()
            .to_string();
        let mut value = json!({
            "url": url,
            "rootUrl": profile.as_ref()
                .map(|p| s(p, "rootUrl").to_owned())
                .unwrap_or(connection_root(&url)?),
            "username": if !username.is_empty() {
                username
            } else {
                profile.as_ref()
                    .map(|p| s(p, "username").to_owned())
                    .unwrap_or_default()
            },
            "repositoryRoot": repository.as_ref()
                .map(|r| s(r, "rootUrl").to_owned())
                .unwrap_or(credential_root(&url)?),
        });
        if available {
            value["credentialId"] = profile.unwrap()["id"].clone();
        } else {
            value["reason"] = json!("missing");
        }
        Ok(value)
    }

    pub fn credential_for_edit(&self, input: &Value) -> Result<Value> {
        let root = credential_root(s(input, "rootUrl"))?;
        let profile = find_credential(
            &self.state()["credentials"],
            s(input, "url"),
            s(input, "id"),
        )?
        .ok_or_else(|| error("validation", "svn.thisCredentialProfileDoesNotBelongToThe"))?;
        if s(&profile, "id") != s(input, "id") || s(&profile, "rootUrl") != root {
            return Err(error(
                "validation",
                "svn.thisCredentialProfileDoesNotBelongToThe",
            ));
        }
        Ok(json!({
            "username": profile["username"],
            "password": self.0.vault.get(s(&profile, "id"))?.unwrap_or_default(),
        }))
    }

    pub fn credential(&self, input: &Value) -> Result<Value> {
        let root = credential_root(s(input, "rootUrl"))?;
        if address(&root)?.scheme() == "file" {
            return Err(error(
                "validation",
                "svn.localFileRepositoriesDoNotNeedAConnection",
            ));
        }
        let existing = items(&self.state()["credentials"]).into_iter().find(|p| {
            if !s(input, "id").is_empty() {
                s(p, "id") == s(input, "id")
            } else {
                s(p, "rootUrl") == root && s(p, "username") == s(input, "username")
            }
        });
        if !s(input, "id").is_empty() && existing.as_ref().is_none_or(|p| s(p, "rootUrl") != root) {
            return Err(error(
                "validation",
                "svn.thisCredentialProfileDoesNotBelongToThe2",
            ));
        }
        let identifier = existing
            .as_ref()
            .map(|p| s(p, "id").to_owned())
            .unwrap_or_else(id);
        if input["remove"] == true {
            if existing.is_none() {
                return Err(error(
                    "validation",
                    "svn.noCredentialsAreSavedForThisConnection",
                ));
            }
            self.0.vault.delete(&identifier)?;
            return self.change(|state| {
                state["credentials"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|p| s(p, "id") != identifier);
                for repo in state["repositories"].as_array_mut().unwrap() {
                    if s(repo, "credentialId") == identifier {
                        repo.as_object_mut().unwrap().remove("credentialId");
                    }
                }
                Ok(())
            });
        }
        let username = s(input, "username");
        let password = s(input, "password");
        if username.trim().is_empty()
            || password.is_empty()
            || username.contains(['\n', '\r', '\0'])
            || password.contains(['\n', '\r', '\0'])
        {
            return Err(error(
                "validation",
                "svn.enterAValidUsernameAndPasswordWithoutLine",
            ));
        }
        let target = if s(input, "url").is_empty() {
            &root
        } else {
            s(input, "url")
        };
        if !within(&root, target)? {
            return Err(error(
                "validation",
                "svn.theVerificationUrlIsOutsideTheCredentialScope",
            ));
        }
        self.0.vault.set(&identifier, password)?;
        let display_name = if s(input, "name").is_empty() {
            format!("{username} · {root}")
        } else {
            s(input, "name").to_owned()
        };
        self.change(|state| {
            let profiles = state["credentials"].as_array_mut().unwrap();
            profiles.retain(|profile| s(profile, "id") != identifier);
            profiles.push(json!({
                "id": identifier,
                "name": display_name,
                "username": username,
                "rootUrl": root,
            }));
            let profiles = state["credentials"].clone();
            for repository in state["repositories"].as_array_mut().unwrap() {
                if within(&root, s(repository, "rootUrl"))? {
                    if let Some(profile) = find_credential(
                        &profiles,
                        s(repository, "rootUrl"),
                        s(repository, "credentialId"),
                    )? {
                        repository["credentialId"] = profile["id"].clone();
                    } else {
                        repository.as_object_mut().unwrap().remove("credentialId");
                    }
                }
            }
            Ok(())
        })
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryVault(std::sync::Mutex<std::collections::HashMap<String, String>>);
#[cfg(test)]
impl Vault for MemoryVault {
    fn get(&self, id: &str) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(id).cloned())
    }

    fn set(&self, id: &str, password: &str) -> Result<()> {
        self.0.lock().unwrap().insert(id.into(), password.into());
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<()> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}
