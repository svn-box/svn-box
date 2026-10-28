use crate::model::*;
use regex::Regex;
use serde_json::{json, Value};
use std::os::unix::process::CommandExt;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Default)]
pub struct Context {
    pub cancel: Arc<AtomicBool>,
    pub operation: Option<String>,
}

impl Context {
    pub fn check(&self) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(error(
                "cancelled",
                "runner.operationCancelledCompletedChangesWillNotBeUndone",
            ))
        } else {
            Ok(())
        }
    }
}

pub struct Runner {
    pub executable: Mutex<PathBuf>,
    pub bundled: PathBuf,
    pub shutting_down: AtomicBool,
    readers: Mutex<usize>,
    read_signal: Condvar,
}

pub struct Output {
    pub bytes: Vec<u8>,
    pub stderr: String,
    pub code: i32,
}

impl Output {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
}

pub fn redact(value: &str) -> String {
    let user = Regex::new(r"(https?://)[^/@\s]+@")
        .unwrap()
        .replace_all(value, "$1[hidden]@");
    Regex::new(r"(?i)(password|passwd|token)([=: ]+)\S+")
        .unwrap()
        .replace_all(&user, "$1$2[hidden]")
        .into_owned()
}

pub fn classify(detail: &str) -> AppError {
    let patterns = [
        (
            "outdated",
            r"(?i)E160028|out of date",
            "runner.theWorkingCopyIsOutOfDateUpdate",
        ),
        (
            "auth",
            r"(?i)E170001|E215004|E170013.*auth|Authentication failed|authorization failed",
            "runner.authenticationFailedCheckTheRepositorySCredentials",
        ),
        (
            "certificate",
            r"(?i)certificate|E230001",
            "runner.serverCertificateVerificationFailedVerifyTheCertificateBefore",
        ),
        (
            "locked",
            r"(?i)E155004|E155037|locked",
            "runner.theWorkingCopyIsLockedRunCleanupFrom",
        ),
        (
            "path",
            r"(?i)E155007|E155010|ENOENT|not found|does not exist|not a working copy",
            "runner.thePathIsInvalidOrIsNotA",
        ),
        (
            "network",
            r"(?i)E170013|E175002|E7300|connection|resolve hostname|network|timed out",
            "runner.unableToConnectToTheRepositoryCheckYour",
        ),
        (
            "conflict",
            r"(?i)E155015|conflict",
            "runner.resolveTheWorkingCopyConflictsFirst",
        ),
    ];
    let (kind, key) = patterns
        .iter()
        .find(|(_, r, _)| Regex::new(r).unwrap().is_match(detail))
        .map(|(k, _, v)| (*k, *v))
        .unwrap_or(("command", "runner.svnCommandFailed"));
    let mut result = error(kind, key);
    result.detail = Some(redact(detail));
    result
}

impl Runner {
    pub fn new(bundled: PathBuf) -> Self {
        Self {
            executable: Mutex::new(PathBuf::new()),
            bundled,
            shutting_down: AtomicBool::new(false),
            readers: Mutex::new(0),
            read_signal: Condvar::new(),
        }
    }

    pub fn detect(&self, configured: &str) -> Value {
        let candidates = if configured.is_empty() {
            vec![
                self.bundled.clone(),
                self.executable.lock().unwrap().clone(),
                "/opt/homebrew/bin/svn".into(),
                "/usr/local/bin/svn".into(),
                "/usr/bin/svn".into(),
            ]
        } else {
            vec![configured.into()]
        };
        let mut last = String::new();
        let version_pattern = Regex::new(r"^1\.\d+\.\d+").unwrap();
        for path in candidates {
            if path.as_os_str().is_empty() {
                continue;
            }
            match self.run_at(
                &path,
                &["--version".into(), "--quiet".into()],
                None,
                None,
                &Context::default(),
                Duration::from_secs(10),
                false,
                &mut |_| {},
            ) {
                Ok(result) if version_pattern.is_match(result.text().trim()) => {
                    *self.executable.lock().unwrap() = path.clone();
                    return json!({
                        "path": path,
                        "version": result.text().trim(),
                        "ok": true,
                    });
                }
                Ok(_) => last = tr("runner.theExecutableIsNotARecognizedSvnClient"),
                Err(e) => last = e.message,
            }
        }
        json!({
            "path": configured,
            "version": "",
            "ok": false,
            "error": last,
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn run_at(
        &self,
        executable: &Path,
        args: &[String],
        cwd: Option<&Path>,
        password: Option<&str>,
        ctx: &Context,
        timeout: Duration,
        allow_diff: bool,
        on_data: &mut dyn FnMut(&str),
    ) -> Result<Output> {
        ctx.check()?;
        let _permit = if ctx.operation.is_none() {
            Some(self.read_permit(ctx)?)
        } else {
            None
        };
        if self.shutting_down.load(Ordering::Relaxed) {
            return Err(error("cancelled", "runner.theAppIsShuttingDown"));
        }
        let mut command = Command::new(executable);
        command
            .args(args)
            .env("LC_ALL", "en_US.UTF-8")
            .env("LANG", "en_US.UTF-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        if let Some(path) = cwd {
            command.current_dir(path);
        }
        let mut child = command.spawn().map_err(|e| classify(&e.to_string()))?;
        let pid = child.id();
        if let Some(mut stdin) = child.stdin.take() {
            if let Some(password) = password {
                let _ = stdin.write_all(format!("{password}\n").as_bytes());
            }
        }
        let (send, receive) = mpsc::sync_channel::<(bool, Vec<u8>)>(32);
        for (is_error, mut stream) in [
            (
                false,
                Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
            ),
            (
                true,
                Box::new(child.stderr.take().unwrap()) as Box<dyn Read + Send>,
            ),
        ] {
            let send = send.clone();
            thread::spawn(move || {
                let mut buffer = [0; 8192];
                while let Ok(count) = stream.read(&mut buffer) {
                    if count == 0 || send.send((is_error, buffer[..count].to_vec())).is_err() {
                        break;
                    }
                }
            });
        }
        drop(send);
        let start = Instant::now();
        let mut output = Output {
            bytes: vec![],
            stderr: String::new(),
            code: -1,
        };
        let mut pending = [Vec::<u8>::new(), Vec::<u8>::new()];
        let mut error_bytes = Vec::new();
        let mut failure = None;
        let mut killed = None;
        let mut status = None;
        loop {
            if failure.is_none() {
                failure = if ctx.cancel.load(Ordering::Relaxed)
                    || self.shutting_down.load(Ordering::Relaxed)
                {
                    Some(error(
                        "cancelled",
                        "runner.operationCancelledCompletedChangesWillNotBeUndone",
                    ))
                } else if start.elapsed() > timeout {
                    Some(error(
                        "network",
                        "runner.theSvnCommandTimedOutAndItsProcess",
                    ))
                } else if output.bytes.len() + error_bytes.len() > 32 * 1024 * 1024 {
                    Some(error_message("command", "SVN output exceeds 32 MiB"))
                } else {
                    None
                };
                if failure.is_some() {
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGTERM);
                    }
                    killed = Some(Instant::now());
                }
            }
            if killed.is_some_and(|time| time.elapsed() > Duration::from_secs(2)) {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            match receive.recv_timeout(Duration::from_millis(20)) {
                Ok((is_error, bytes)) => {
                    if failure.is_none() {
                        if ctx.operation.is_some() {
                            let buffer = &mut pending[usize::from(is_error)];
                            buffer.extend_from_slice(&bytes);
                            if let Some(end) = buffer.iter().rposition(|v| *v == b'\n') {
                                let remainder = buffer.split_off(end + 1);
                                let text = String::from_utf8_lossy(buffer);
                                let hidden = password
                                    .map(|p| text.replace(p, "[hidden]"))
                                    .unwrap_or_else(|| text.into_owned());
                                on_data(&redact(&hidden));
                                *buffer = remainder;
                            }
                        }
                        if is_error {
                            error_bytes.extend(&bytes);
                        } else {
                            output.bytes.extend(bytes);
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    status = child.try_wait()?;
                    if status.is_some() {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if status.is_none() {
                status = child.try_wait()?;
            }
        }
        let status = match status {
            Some(v) => v,
            None => child.wait()?,
        };
        output.stderr = String::from_utf8_lossy(&error_bytes).into_owned();
        for bytes in pending {
            if !bytes.is_empty() {
                let text = String::from_utf8_lossy(&bytes);
                let hidden = password
                    .map(|p| text.replace(p, "[hidden]"))
                    .unwrap_or_else(|| text.into_owned());
                on_data(&redact(&hidden));
            }
        }
        if let Some(password) = password {
            output.stderr = output.stderr.replace(password, "[hidden]");
        }
        if let Some(error) = failure {
            return Err(error);
        }
        output.code = status.code().unwrap_or(-1);
        if !status.success() && !(allow_diff && output.code == 1) {
            return Err(classify(&output.stderr));
        }
        Ok(output)
    }

    fn read_permit(&self, context: &Context) -> Result<ReadPermit<'_>> {
        let mut readers = self.readers.lock().unwrap();
        while *readers >= 3 {
            context.check()?;
            if self.shutting_down.load(Ordering::Relaxed) {
                return Err(error("cancelled", "runner.theAppIsShuttingDown"));
            }
            readers = self
                .read_signal
                .wait_timeout(readers, Duration::from_millis(50))
                .unwrap()
                .0;
        }
        *readers += 1;
        Ok(ReadPermit(self))
    }
}

struct ReadPermit<'a>(&'a Runner);

impl Drop for ReadPermit<'_> {
    fn drop(&mut self) {
        *self.0.readers.lock().unwrap() -= 1;
        self.0.read_signal.notify_one();
    }
}
