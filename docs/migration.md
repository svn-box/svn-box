# SVNBox Tauri migration

This independent project preserves the Electron SVNBox 0.2.1 interface and contract from commit `a79d4a0`, using the local Tauri Diffolio project as the migration reference. The original Electron checkout remains separate. All native application logic is Rust; Node.js is a build dependency only.

## Native modules

| Module                        | Responsibility                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/renderer/src/desktop/`   | Tauri invoke/events behind the existing `SvnboxApi`; explicit optional-field resets across JSON        |
| `src-tauri/src/commands.rs`   | Native dialogs, clipboard, Finder/Terminal actions, UI lifecycle and draft flush before close          |
| `src-tauri/src/rpc.rs`        | Command and input validation; dispatch to the native implementation                                    |
| `src-tauri/src/state.rs`      | Atomic workspace/history persistence, per-copy FIFO writes, cancellation contexts and operation events |
| `src-tauri/src/runner.rs`     | SVN/tool child processes, bounded output, timeouts, process-group cancellation and password redaction  |
| `src-tauri/src/paths.rs`      | Working-copy boundaries, nested-copy and symlink checks, URL and credential scope normalization        |
| `src-tauri/src/auth.rs`       | macOS Keychain storage and explicit credential editing                                                 |
| `src-tauri/src/catalog.rs`    | Repositories, working copies, bookmarks, groups, preferences and per-copy sessions                     |
| `src-tauri/src/svn.rs`        | XML status/info/properties/history/list parsing and text/property/version diffs                        |
| `src-tauri/src/review.rs`     | Actual operation scope, moved pairs, added parents, descendants, warnings and review fingerprints      |
| `src-tauri/src/operations.rs` | Checkout, reviewed writes, restore/resolve and external merge sessions                                 |
| `src-tauri/src/content.rs`    | Verified backups, safe content replacement, conflict snapshots and merge-result validation             |
| `src-tauri/src/compare.rs`    | Separate comparison snapshots for FileMerge                                                            |
| `src-tauri/src/migration.rs`  | Copy-on-first-launch import into the new profile; original profile retained                            |
| `src-tauri/src/menu.rs`       | Localized native menus and accelerators; exact Chinese update label `检查更新`                         |
| `src-tauri/src/updates.rs`    | Manual check/download/install with signature verification and SVN write guards                         |

## Verification

Frontend tests preserve the existing session, diff, history, refresh and authentication behavior, with additional JSON transport tests. Rust integration tests use temporary repositories and working copies, including authenticated loopback svnserve, stale reviews, selective commits, Unicode and `@` paths, backups, conflicts, merge results, cancellation and profile import.

`npm run test:native` starts the actual Tauri/WebKit application against an isolated profile and a temporary SVN repository. It verifies the workspace, native command bridge, compact commit dialog, menu-to-update-settings flow and persisted drafts. Its screenshot and report commands are compiled only with the `native-smoke` feature and are absent from normal application builds. Reports and screenshots go under ignored `work/native/`.

Packaging validates legal files, the bundled SVN version and dynamic library paths, and checks that the bundle has no Electron framework, app.asar or Node runtime. When an updater signing key is available, the archive signature and signed version are verified locally.

## Distribution boundary

The first migration from Electron is a manual installation. The new profile imports workspace metadata and recovery data without overwriting the Electron profile. Electron-encrypted passwords require one re-entry before storage in macOS Keychain.

A real public update and Developer ID/notarization round trip require a signed release published with the new `latest.json` feed. Local preview builds do not publish releases or replace `/Applications/仓盒.app`. The repository now preserves Electron on `electron-legacy` and continues Tauri on `main`; matching version tags trigger the signed remote release workflow. The dedicated private updater key is stored outside this repository.
