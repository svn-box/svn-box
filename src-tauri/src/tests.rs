use crate::{
    model::*,
    rpc::validate,
    runner::{Context, Runner},
    state::Backend,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

struct Fixture {
    _root: tempfile::TempDir,
    backend: Backend,
    a: PathBuf,
    b: PathBuf,
    first: String,
    second: String,
    url: String,
}

fn svn(args: &[&str]) -> String {
    let result = Command::new("/opt/homebrew/bin/svn")
        .args(args)
        .env("LC_ALL", "en_US.UTF-8")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}

fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let repository = root.path().join("repository");
    assert!(Command::new("/opt/homebrew/bin/svnadmin")
        .arg("create")
        .arg(&repository)
        .status()
        .unwrap()
        .success());
    let url = url::Url::from_directory_path(&repository)
        .unwrap()
        .to_string()
        .trim_end_matches('/')
        .to_owned();
    svn(&["mkdir", &format!("{url}/trunk"), "-m", "Create trunk"]);
    let a = root.path().join("a");
    let b = root.path().join("b");
    svn(&["checkout", &format!("{url}/trunk"), a.to_str().unwrap()]);
    fs::write(a.join("README.md"), "initial\n").unwrap();
    fs::write(a.join("other.txt"), "other\n").unwrap();
    fs::create_dir(a.join("目录 空格")).unwrap();
    fs::write(a.join("目录 空格/中文 @ 文件.txt"), "第一行\n初始内容\n").unwrap();
    svn(&["add", "--force", a.to_str().unwrap()]);
    svn(&["commit", a.to_str().unwrap(), "-m", "Initial files"]);
    svn(&["checkout", &format!("{url}/trunk"), b.to_str().unwrap()]);
    let bundled =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/svn/darwin-arm64/bin/svn");
    let backend = Backend::load(root.path().join("data"), bundled, |_, _| {}).unwrap();
    let first = backend
        .add_working_copy(a.to_str().unwrap(), "A", &Context::default())
        .unwrap()["activeId"]
        .as_str()
        .unwrap()
        .to_owned();
    let second = backend
        .add_working_copy(b.to_str().unwrap(), "B", &Context::default())
        .unwrap()["activeId"]
        .as_str()
        .unwrap()
        .to_owned();
    Fixture {
        _root: root,
        backend,
        a,
        b,
        first,
        second,
        url,
    }
}

fn call(f: &Fixture, method: &str, input: Value) -> Value {
    f.backend.call(method, &input, &Context::default()).unwrap()
}

fn finish(backend: &Backend, operation: Value) -> Value {
    let start = Instant::now();
    loop {
        let operation = backend
            .0
            .operations
            .lock()
            .unwrap()
            .iter()
            .find(|v| v["id"] == operation["id"])
            .unwrap()
            .clone();
        if !active(&operation) {
            return operation;
        }
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "Operation did not finish: {operation}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn execute(f: &Fixture, review: Value) -> Value {
    let operation = call(f, "execute", json!({"reviewId": review["id"]}));
    finish(&f.backend, operation)
}

#[test]
fn selective_commit_preserves_other_edits_and_detects_stale_reviews() {
    let f = fixture();
    assert_eq!(
        f.backend.state()["repositories"].as_array().unwrap().len(),
        1
    );
    fs::write(f.a.join("目录 空格/中文 @ 文件.txt"), "第一行\n本地修改\n").unwrap();
    fs::write(f.a.join("other.txt"), "keep local\n").unwrap();
    let snapshot = call(&f, "status", json!({"wcId": f.first}));
    assert!(items(&snapshot["files"])
        .iter()
        .any(|v| s(v, "path") == "目录 空格/中文 @ 文件.txt" && s(v, "item") == "modified"));
    let review = call(
        &f,
        "review",
        json!({
            "wcId": f.first,
            "action": "commit",
            "paths": ["目录 空格/中文 @ 文件.txt"],
            "message": "提交中文路径",
        }),
    );
    assert_eq!(review["paths"], json!(["目录 空格/中文 @ 文件.txt"]));
    let result = execute(&f, review);
    assert_eq!(result["state"], "success", "{result}");
    let update = call(
        &f,
        "review",
        json!({
            "wcId": f.second,
            "action": "update",
            "paths": [],
        }),
    );
    let result = execute(&f, update);
    assert_eq!(result["state"], "success", "{result}");
    assert!(fs::read_to_string(f.b.join("目录 空格/中文 @ 文件.txt"))
        .unwrap()
        .contains("本地修改"));
    assert_eq!(
        fs::read_to_string(f.b.join("other.txt")).unwrap(),
        "other\n"
    );
    assert_eq!(
        call(&f, "log", json!({"wcId": f.first}))[0]["message"],
        "提交中文路径"
    );
    call(
        &f,
        "session",
        json!({
            "wcId": f.first,
            "patch": {"draft": "preserve draft", "selected": ["other.txt"]},
        }),
    );
    let stale = call(
        &f,
        "review",
        json!({
            "wcId": f.first,
            "action": "commit",
            "paths": ["other.txt"],
            "message": "preserve draft",
        }),
    );
    fs::write(f.a.join("other.txt"), "changed after review\n").unwrap();
    let result = execute(&f, stale);
    assert_eq!(result["state"], "failed", "{result}");
    assert_eq!(result["error"]["kind"], "stale");
    assert_eq!(
        f.backend.state()["sessions"][&f.first]["draft"],
        "preserve draft"
    );
}

#[test]
fn recovery_creates_a_verified_backup_and_restores_it() {
    let f = fixture();
    fs::write(f.a.join("README.md"), "uncommitted content\n").unwrap();
    let review = call(
        &f,
        "review",
        json!({
            "wcId": f.first,
            "action": "recover",
            "paths": ["README.md"],
            "revision": 2,
        }),
    );
    assert!(review["preview"]["text"]
        .as_str()
        .unwrap()
        .contains("initial"));
    let result = execute(&f, review);
    assert_eq!(result["state"], "success", "{result}");
    assert_eq!(
        fs::read_to_string(f.a.join("README.md")).unwrap(),
        "initial\n"
    );
    let backups = call(
        &f,
        "backups",
        json!({
            "wcId": f.first,
            "path": "README.md",
        }),
    );
    assert_eq!(backups.as_array().unwrap().len(), 1);
    let restore = call(
        &f,
        "review",
        json!({
            "wcId": f.first,
            "action": "restore-backup",
            "paths": ["README.md"],
            "backupId": backups[0]["id"],
        }),
    );
    let result = execute(&f, restore);
    assert_eq!(result["state"], "success", "{result}");
    assert_eq!(
        fs::read_to_string(f.a.join("README.md")).unwrap(),
        "uncommitted content\n"
    );
    let identifier = backups[0]["id"].as_str().unwrap();
    fs::write(
        f.backend
            .0
            .root
            .join("file-backups")
            .join(format!("{identifier}.data")),
        "tampered",
    )
    .unwrap();
    assert!(f
        .backend
        .backup_content(&f.first, "README.md", identifier)
        .is_err());
}

#[test]
fn added_directories_moves_ignore_and_revert_preserve_scope() {
    let f = fixture();
    fs::create_dir(f.a.join("新增目录")).unwrap();
    fs::write(f.a.join("新增目录/甲.txt"), "a").unwrap();
    fs::write(f.a.join("新增目录/乙.txt"), "b").unwrap();
    let add = call(
        &f,
        "review",
        json!({
            "wcId": f.first,
            "action": "add",
            "paths": ["新增目录"],
        }),
    );
    assert_eq!(execute(&f, add)["state"], "success");
    let commit = call(
        &f,
        "review",
        json!({
            "wcId": f.first,
            "action": "commit",
            "paths": ["新增目录/甲.txt"],
            "message": "add files",
        }),
    );
    assert!(strings(&commit["paths"]).contains(&"新增目录/乙.txt".into()));
    assert_eq!(execute(&f, commit)["state"], "success");
    let rename = call(
        &f,
        "review",
        json!({
            "wcId": f.first,
            "action": "rename",
            "paths": ["README.md"],
            "destination": "说明 @ 新.md",
        }),
    );
    let result = execute(&f, rename);
    assert_eq!(result["state"], "success", "{result}");
    let commit = call(
        &f,
        "review",
        json!({
            "wcId": f.first,
            "action": "commit",
            "paths": ["说明 @ 新.md"],
            "message": "rename",
        }),
    );
    assert!(strings(&commit["paths"]).contains(&"README.md".into()));
    assert_eq!(execute(&f, commit)["state"], "success");
    fs::write(f.a.join("cache.tmp"), "cache").unwrap();
    let ignore = call(
        &f,
        "review",
        json!({
            "wcId": f.first,
            "action": "ignore",
            "paths": ["cache.tmp"],
        }),
    );
    assert!(strings(&ignore["paths"]).contains(&".".into()));
    let result = execute(&f, ignore);
    assert_eq!(result["state"], "success", "{result}");
    let revert = call(
        &f,
        "review",
        json!({
            "wcId": f.first,
            "action": "revert",
            "paths": ["."],
        }),
    );
    let result = execute(&f, revert);
    assert_eq!(result["state"], "success", "{result}");
    assert_eq!(fs::read_to_string(f.a.join("cache.tmp")).unwrap(), "cache");
}

#[test]
fn path_guards_stop_traversal_symlink_escape_and_nested_working_copies() {
    let f = fixture();
    let wc = f.backend.wc(&f.first).unwrap();
    for path in [
        "../outside",
        ".svn/wc.db",
        ".SVN/wc.db",
        "/etc/passwd",
        "folder\nname",
    ] {
        assert!(f.backend.local(&wc, path).is_err(), "{path}");
    }
    let outside = f._root.path().join("outside-folder");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("README.md"), "outside").unwrap();
    std::os::unix::fs::symlink(outside, f.a.join("outside")).unwrap();
    assert!(f.backend.local(&wc, "outside/README.md").is_err());
    assert!(f.backend.local(&wc, "outside").is_ok());
    svn(&[
        "checkout",
        &format!("{}/trunk", f.url),
        f.a.join("nested").to_str().unwrap(),
    ]);
    assert!(f.backend.local(&wc, "nested/README.md").is_err());
    assert!(f
        .backend
        .remote_repo(
            "file:///etc",
            s(&f.backend.state()["repositories"][0], "id")
        )
        .is_err());
}

#[test]
fn sessions_survive_restart_and_operations_are_cancellable() {
    let f = fixture();
    call(
        &f,
        "session",
        json!({
            "wcId": f.first,
            "patch": {"draft": "A 草稿", "filter": "modified"},
        }),
    );
    call(
        &f,
        "session",
        json!({
            "wcId": f.second,
            "patch": {"draft": "B draft", "view": "history"},
        }),
    );
    let restored = Backend::load(
        f.backend.0.root.clone(),
        f.backend.0.runner.bundled.clone(),
        |_, _| {},
    )
    .unwrap();
    assert_eq!(restored.state()["sessions"][&f.first]["draft"], "A 草稿");
    assert_eq!(restored.state()["sessions"][&f.second]["view"], "history");
    let ctx = f
        .backend
        .begin_request(Some("cancel-before-start"))
        .unwrap();
    f.backend.cancel_request("cancel-before-start");
    assert_eq!(ctx.check().unwrap_err().kind, "cancelled");
    f.backend.cancel_request("early-cancel");
    assert_eq!(
        f.backend
            .begin_request(Some("early-cancel"))
            .err()
            .unwrap()
            .kind,
        "cancelled"
    );
    let runner = Runner::new("/usr/bin/true".into());
    let ctx = Context::default();
    ctx.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    assert_eq!(
        runner
            .run_at(
                Path::new("/bin/sleep"),
                &["10".into()],
                None,
                None,
                &ctx,
                Duration::from_secs(30),
                false,
                &mut |_| {}
            )
            .err()
            .unwrap()
            .kind,
        "cancelled"
    );
}

#[test]
fn bookmarks_update_existing_urls_and_reorder_only_repository_siblings() {
    let f = fixture();
    let repository = f.backend.state()["repositories"][0].clone();
    let first_url = format!("{}/trunk", f.url);
    let mut first = json!({
        "repositoryId": repository["id"],
        "url": first_url,
        "name": "  First  ",
    });
    let state = call(&f, "bookmark", first.clone());
    assert_eq!(state["bookmarks"][0]["name"], "First");
    first["id"] = state["bookmarks"][0]["id"].clone();
    first["name"] = json!("Renamed");
    let state = call(&f, "bookmark", first.clone());
    assert_eq!(items(&state["bookmarks"]).len(), 1);
    assert_eq!(state["bookmarks"][0]["name"], "Renamed");

    let other_repository = json!({
        "id": id(),
        "name": "Other repository",
        "rootUrl": "https://example.invalid/other",
    });
    f.backend
        .change(|state| {
            state["repositories"]
                .as_array_mut()
                .unwrap()
                .push(other_repository.clone());
            Ok(())
        })
        .unwrap();
    call(
        &f,
        "bookmark",
        json!({
            "repositoryId": other_repository["id"],
            "url": "https://example.invalid/other/trunk",
            "name": "Other bookmark",
        }),
    );
    let mut second = json!({
        "repositoryId": repository["id"],
        "url": format!("{}/trunk/%E4%B8%AD%E6%96%87", f.url),
        "name": "",
    });
    let state = call(&f, "bookmark", second.clone());
    assert_eq!(state["bookmarks"][2]["name"], "中文");
    second["id"] = state["bookmarks"][2]["id"].clone();
    second["direction"] = json!("up");
    let state = call(&f, "bookmark", second.clone());
    assert_eq!(state["bookmarks"][0]["id"], second["id"]);
    assert_eq!(
        state["bookmarks"][1]["repositoryId"],
        other_repository["id"]
    );
    assert_eq!(state["bookmarks"][2]["id"], first["id"]);

    second["direction"] = json!("sideways");
    assert!(validate("bookmark", &second).is_err());
    second.as_object_mut().unwrap().remove("direction");
    second["remove"] = json!(true);
    let state = call(&f, "bookmark", second.clone());
    assert_eq!(items(&state["bookmarks"]).len(), 2);
    let unchanged = call(&f, "bookmark", second);
    assert_eq!(state["bookmarks"], unchanged["bookmarks"]);
}

#[test]
fn credential_scopes_and_rpc_validation_are_enforced() {
    let f = fixture();
    let profile = call(
        &f,
        "credential",
        json!({
            "rootUrl": "https://example.invalid/svn",
            "url": "https://example.invalid/svn/project",
            "username": "alice",
            "password": "private-password",
        }),
    );
    assert!(!profile.to_string().contains("private-password"));
    let context = call(
        &f,
        "authentication",
        json!({"url": "https://example.invalid/svn/project"}),
    );
    assert_eq!(context["username"], "alice");
    assert!(context["credentialId"].is_string());
    let other = call(
        &f,
        "authentication",
        json!({"url": "https://example.invalid/svn-other"}),
    );
    assert_eq!(other["reason"], "missing");
    assert!(f
        .backend
        .credential_for_edit(&json!({
            "id": context["credentialId"],
            "rootUrl": "https://example.invalid",
            "url": "https://example.invalid/svn/project",
        }))
        .is_err());
    assert!(validate(
        "review",
        &json!({
            "wcId": "x",
            "action": "shell",
            "paths": [],
        })
    )
    .is_err());
    assert!(validate(
        "session",
        &json!({
            "wcId": "x",
            "patch": {"settings": {}},
        })
    )
    .is_err());
    assert!(validate(
        "appUpdate",
        &json!({
            "action": "check",
            "url": "https://evil.invalid",
        })
    )
    .is_err());
}

#[test]
fn text_conflicts_support_local_incoming_and_reviewed_merge_results() {
    let f = fixture();
    fs::write(f.b.join("README.md"), "local before update\n").unwrap();
    fs::write(f.a.join("README.md"), "incoming server\n").unwrap();
    let commit = call(
        &f,
        "review",
        json!({
            "wcId": f.first,
            "action": "commit",
            "paths": ["README.md"],
            "message": "server edit",
        }),
    );
    assert_eq!(execute(&f, commit)["state"], "success");
    let update = call(
        &f,
        "review",
        json!({
            "wcId": f.second,
            "action": "update",
            "paths": [],
        }),
    );
    let result = execute(&f, update);
    assert_eq!(result["state"], "success", "{result}");
    assert_eq!(result["conflictCount"], 1);
    let info = call(
        &f,
        "info",
        json!({
            "wcId": f.second,
            "path": "README.md",
        }),
    );
    assert!(!items(&info["conflicts"]).is_empty());
    assert!(info["textConflict"]["incomingRevision"]
        .as_str()
        .is_some_and(|v| !v.is_empty()));
    call(&f, "settings", json!({"mergeTool": "/usr/bin/true"}));
    let merge = call(
        &f,
        "review",
        json!({
            "wcId": f.second,
            "action": "merge",
            "paths": ["README.md"],
        }),
    );
    let result = execute(&f, merge);
    assert_eq!(result["state"], "success", "{result}");
    let record = f
        .backend
        .merge_record(&f.second, "README.md", "")
        .unwrap()
        .unwrap();
    let output = f.backend.merge_result(&record);
    fs::write(&output, "reviewed merged content\n").unwrap();
    let merge_state = call(
        &f,
        "mergeState",
        json!({
            "wcId": f.second,
            "path": "README.md",
        }),
    );
    assert_eq!(merge_state["hasResult"], true);
    assert_eq!(merge_state["markers"], false);
    let apply = call(
        &f,
        "review",
        json!({
            "wcId": f.second,
            "action": "apply-merge",
            "paths": ["README.md"],
            "mergeId": record["id"],
        }),
    );
    fs::write(&output, "changed after merge review\n").unwrap();
    let result = execute(&f, apply);
    assert_eq!(result["state"], "failed", "{result}");
    assert_eq!(result["error"]["kind"], "stale");
    let local = call(
        &f,
        "review",
        json!({
            "wcId": f.second,
            "action": "resolve-local",
            "paths": ["README.md"],
        }),
    );
    let result = execute(&f, local);
    assert_eq!(result["state"], "success", "{result}");
    assert_eq!(
        fs::read_to_string(f.b.join("README.md")).unwrap(),
        "local before update\n"
    );
    assert!(
        items(&call(&f, "status", json!({"wcId": f.second}))["files"])
            .iter()
            .all(|f| !conflict(f))
    );
}

#[test]
fn native_queue_is_fifo_and_running_commands_cancel() {
    let f = fixture();
    let (send, receive) = std::sync::mpsc::channel();
    let first = f
        .backend
        .enqueue(
            "queue-test".into(),
            None,
            "update",
            &Context::default(),
            move |_| {
                receive.recv().unwrap();
                Ok(0)
            },
        )
        .unwrap();
    let second = f
        .backend
        .enqueue(
            "queue-test".into(),
            None,
            "update",
            &Context::default(),
            |_| panic!("Cancelled queued work must not run"),
        )
        .unwrap();
    f.backend.cancel(s(&second, "id"));
    let clear = f
        .backend
        .clear_operations(&[s(&first, "id").into(), s(&second, "id").into()])
        .unwrap();
    assert_eq!(clear["removedIds"], json!([]));
    send.send(()).unwrap();
    assert_eq!(finish(&f.backend, first)["state"], "success");
    assert_eq!(finish(&f.backend, second)["state"], "cancelled");
    let context = Context::default();
    let cancel = context.cancel.clone();
    let worker = thread::spawn(move || {
        let runner = Runner::new("/bin/sleep".into());
        runner.run_at(
            Path::new("/bin/sleep"),
            &["10".into()],
            None,
            None,
            &context,
            Duration::from_secs(30),
            false,
            &mut |_| {},
        )
    });
    thread::sleep(Duration::from_millis(100));
    cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    assert_eq!(worker.join().unwrap().err().unwrap().kind, "cancelled");
}

#[test]
fn legacy_import_preserves_the_source_and_refuses_to_overwrite_new_data() {
    let root = tempfile::tempdir().unwrap();
    let legacy = root.path().join("electron");
    let target = root.path().join("tauri");
    fs::create_dir(&legacy).unwrap();
    let mut workspace = empty_state();
    workspace["settings"]["theme"] = json!("dark");
    write_json(&legacy.join("workspace.json"), &workspace).unwrap();
    fs::create_dir(legacy.join("file-backups")).unwrap();
    fs::write(legacy.join("file-backups/test.data"), "backup").unwrap();
    let original = fs::read(legacy.join("workspace.json")).unwrap();
    assert!(crate::migration::import_legacy(&target, &legacy).unwrap());
    assert_eq!(fs::read(legacy.join("workspace.json")).unwrap(), original);
    assert_eq!(
        fs::read_to_string(target.join("file-backups/test.data")).unwrap(),
        "backup"
    );
    assert!(!crate::migration::import_legacy(&target, &legacy).unwrap());
}

#[test]
fn authenticated_network_checkout_uses_stdin_password_and_scoped_credentials() {
    struct Server(std::process::Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let f = fixture();
    let config = f._root.path().join("repository/conf");
    fs::write(
        config.join("svnserve.conf"),
        concat!(
            "[general]\n",
            "anon-access = none\n",
            "auth-access = write\n",
            "password-db = passwd\n",
            "realm = svnbox-native-test\n",
        ),
    )
    .unwrap();
    fs::write(
        config.join("passwd"),
        "[users]\nalice = native-test-password\n",
    )
    .unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let _server = Server(
        Command::new("/opt/homebrew/bin/svnserve")
            .args([
                "--daemon",
                "--foreground",
                "--listen-host",
                "127.0.0.1",
                "--listen-port",
                &port.to_string(),
                "--root",
                f._root.path().to_str().unwrap(),
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let started = Instant::now();
    while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(started.elapsed() < Duration::from_secs(5));
        thread::sleep(Duration::from_millis(20));
    }
    let backend = Backend::load(
        f._root.path().join("network-data"),
        f.backend.0.runner.bundled.clone(),
        |_, _| {},
    )
    .unwrap();
    let url = format!("svn://127.0.0.1:{port}/repository");
    let root = format!("svn://127.0.0.1:{port}");
    let first = backend
        .add_repository(&json!({"url": url}), &Context::default())
        .err()
        .unwrap();
    assert_eq!(first.kind, "auth");
    assert_eq!(first.auth.unwrap()["retrySafe"], true);
    backend
        .credential(&json!({
            "rootUrl": root,
            "url": url,
            "username": "alice",
            "password": "native-test-password",
        }))
        .unwrap();
    let state = backend
        .add_repository(&json!({"url": url}), &Context::default())
        .unwrap();
    let repository = state["repositories"][0].clone();
    let listing = backend
        .list(
            &json!({
                "url": url,
                "repositoryId": repository["id"],
            }),
            &Context::default(),
        )
        .unwrap();
    assert!(items(&listing).iter().any(|e| s(e, "name") == "trunk"));
    let destination = f._root.path().join("network-copy");
    let operation = backend
        .checkout(
            &json!({
                "url": format!("{url}/trunk"),
                "destination": destination,
                "repositoryId": repository["id"],
                "depth": "infinity",
            }),
            &Context::default(),
        )
        .unwrap();
    let result = finish(&backend, operation);
    assert_eq!(result["state"], "success", "{result}");
    assert!(destination.join("README.md").is_file());
    assert!(!backend.state().to_string().contains("native-test-password"));
    assert!(!result.to_string().contains("native-test-password"));
}

#[test]
fn json_optional_field_resets_and_unicode_logs_remain_bounded() {
    let f = fixture();
    call(
        &f,
        "session",
        json!({
            "wcId": f.first,
            "patch": {"historyRevision": 2},
        }),
    );
    let saved = call(
        &f,
        "session",
        json!({
            "wcId": f.first,
            "patch": {"historyRevision": null},
        }),
    );
    assert!(saved.get("historyRevision").is_none());
    let operation = f
        .backend
        .enqueue("logs".into(), None, "update", &Context::default(), |_| {
            Ok(0)
        })
        .unwrap();
    let operation = finish(&f.backend, operation);
    let identifier = s(&operation, "id");
    f.backend
        .append_log(identifier, &"中文内容\n".repeat(100000));
    let stored = f
        .backend
        .0
        .operations
        .lock()
        .unwrap()
        .iter()
        .find(|op| s(op, "id") == identifier)
        .unwrap()
        .clone();
    let logs = strings(&stored["logs"]);
    assert!(logs.iter().map(String::len).sum::<usize>() < 1024 * 1024 + 1024);
    assert!(logs[0].contains("省略") || logs[0].contains("omitted"));
    let runner = Runner::new("/bin/sh".into());
    let context = Context {
        operation: Some("redaction-test".into()),
        ..Default::default()
    };
    let mut logs = String::new();
    let output = runner
        .run_at(
            Path::new("/bin/sh"),
            &[
                "-c".into(),
                "printf 'native-'; sleep 0.05; printf 'test-password\\n'".into(),
            ],
            None,
            Some("native-test-password"),
            &context,
            Duration::from_secs(5),
            false,
            &mut |line| logs.push_str(line),
        )
        .unwrap();
    assert!(output.code == 0);
    assert!(!logs.contains("native-test-password"));
    assert!(logs.contains("[hidden]"));
}

#[test]
fn comparison_snapshots_cover_unversioned_and_deleted_files_without_touching_originals() {
    let f = fixture();
    let context = Context::default();
    fs::write(f.a.join("new @ file.txt"), "new content\n").unwrap();
    let (left, right) = f
        .backend
        .comparison(
            &json!({"wcId": f.first, "path": "new @ file.txt"}),
            &context,
        )
        .unwrap();
    assert_eq!(fs::read_to_string(left).unwrap(), "");
    assert_eq!(fs::read_to_string(right).unwrap(), "new content\n");
    assert_eq!(
        fs::read_to_string(f.a.join("new @ file.txt")).unwrap(),
        "new content\n"
    );
    svn(&["delete", f.a.join("README.md").to_str().unwrap()]);
    let (left, right) = f
        .backend
        .comparison(&json!({"wcId": f.first, "path": "README.md"}), &context)
        .unwrap();
    assert_eq!(fs::read_to_string(left).unwrap(), "initial\n");
    assert_eq!(fs::read_to_string(right).unwrap(), "");
    assert!(!f.a.join("README.md").exists());
}
