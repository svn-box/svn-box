<div align="center">
  <img src="resources/icon.png" width="128" height="128" alt="svnbox app icon" />
  <h1>svnbox</h1>
  <p>
    <a href="README.md"><strong>English</strong></a> · <a href="README.zh-CN.md">简体中文</a>
  </p>
  <p>A home for your SVN repositories and working copies on macOS.</p>
  <p>
    <a href="#screenshots">Screenshots</a> ·
    <a href="https://github.com/svn-box/svn-box/issues">Report an issue</a>
  </p>
  <p><sub>v0.4.0 · macOS 13.3+ · Apple Silicon (arm64)</sub></p>
</div>

svnbox (仓盒) brings your Subversion projects into one desktop workspace. Switch between working copies, review changes, commit selected paths, and explore history without losing your place.

The app interface supports **English and Simplified Chinese**, with instant switching in Settings.

## Features

- **Multiple working copies** — group, search, favorite, and reorder projects. Each working copy keeps its own file selection, filters, expanded folders, history context, and commit draft.
- **Repository bookmarks** — organize remote URLs, expand folders in a compact tree with per-folder loading and cancellation, and check out selected directories into separate local working copies.
- **Change review** — browse a compact file tree, filter SVN states, and compare text and property changes with unified or side-by-side diffs.
- **Selective commits** — choose paths, review the actual commit scope, reuse recent messages, and recover drafts after restarting the app.
- **History** — explore a collapsible timeline, load earlier revisions, inspect changed paths, and view differences within each commit.
- **File recovery** — compare any two revisions or a revision with local contents, then recover an existing file with an automatic local backup.
- **Text conflicts** — keep pre-update local contents, accept incoming contents, or use FileMerge for three-way merging. Review and apply the result explicitly.
- **SVN operations** — update, add, rename, delete, ignore, discard local changes, and clean up working copies. Inspect conflicts and open an external comparison or merge tool.
- **Connection credentials** — save encrypted credentials for a connection or repository path and share them across matching child URLs.
- **Operation logs** — inspect progress and command output, cancel running tasks, filter or copy logs, and clear completed records.
- **Desktop controls** — keyboard navigation, context menus, Finder and Terminal actions, and seven appearance themes.
- **Bundled SVN** — use the included Subversion client or choose a local executable in Settings.

## Screenshots

Captured from the running app at **1920 × 1200** using fictional projects in isolated local SVN repositories. All project names, changes, commit messages, and accounts shown are demo data. The screenshots show the current Chinese interface.

**Your workspace** — Keep multiple working copies together, browse a compact file tree, and review changes with a side-by-side diff and file inspector.

![svnbox desktop workspace with grouped working copies, a file tree, and a side-by-side diff](resources/screenshots/workspace.png)

<details>
<summary>History and commit differences</summary>

Browse revisions by date, expand changed paths, and open a commit's diff directly in the timeline. Shown with the Graphite theme.

![svnbox history timeline with dated commits and an inline commit diff in the Gray theme](resources/screenshots/history.png)

</details>

<details>
<summary>Review a selective commit</summary>

Write a commit message, reuse a recent message, and choose the paths to include before reviewing the final scope. Differences stay in the workspace.

![svnbox commit dialog with a message draft and a selectable list of changed paths and statuses](resources/screenshots/commit.png)

</details>

<details>
<summary>Repository bookmarks and browsing</summary>

Keep remote paths alongside their local working copies. Browse a repository and choose a directory to check out. The loopback address shown belongs to the local demo server.

![svnbox repository browser with saved remote paths and checkout controls](resources/screenshots/repositories.png)

</details>

<details>
<summary>Make the workspace yours</summary>

Choose White, Graphite, Navy, Teal, Violet, Orange, or Classic Green in Settings. Appearance changes apply immediately.

![svnbox appearance settings](resources/screenshots/appearance.png)

</details>

## Usage

### Add projects

Press **⌘O** to add an existing working copy. svnbox identifies its root and repository automatically. Use the sidebar context menu to rename, group, favorite, or reorder it. Removing an entry only removes it from svnbox.

Press **⌘⇧O** to browse a remote repository and check out a directory. Enter the URL, choose a destination and checkout depth, and provide credentials when prompted. Credentials can apply to the whole connection or only the selected repository path.

### Review and commit

Select a working copy in the sidebar. Browse its files, show only changed items, or filter by SVN state. Select a file to open its diff, then switch between unified and side-by-side views or open FileMerge when available.

Press **⌘↵** to prepare a commit. Write a message, choose the paths to include, and review the actual scope before confirming. Checkboxes select paths for this commit; SVN has no staging area. Drafts are saved separately for each working copy.

### Refresh and update

Returning to svnbox refreshes the current working copy’s local status. Press **⌘R** to refresh it manually. Press **⌘U** to update the working copy from its repository. Open operation logs with **⌘J** to inspect output or cancel an active task. Cancellation does not undo changes already completed.

Use file context menus for add, rename, delete, ignore, and discard operations. **Discard Local Changes** removes uncommitted edits; directory and working-copy actions include their changed descendants. Destructive operations show their impact before confirmation. For conflicts, review the details, use an external tool if needed, refresh the status, and explicitly mark the result as resolved.

### Explore history

Switch to the history view or open a file or directory's history from its context menu. Expand a date or commit to inspect changed paths. Open the comparison inside a commit to review its diff.

The search box filters records already loaded. Use the earlier-history action to query additional revisions from the server.

### Compare and recover versions

Choose **Compare / Recover Versions…** from a file's context menu, or open it from a commit's inline diff. Enter the repository revision numbers to compare, or select Working Copy for the right side. To recover a file, select its source revision and choose **Recover This Version…**. Review the exact changes and confirm the overwrite.

Recovery supports existing versioned regular files up to 32 MiB, including binary files without a text preview. It restores content only; properties and the working copy baseline stay unchanged, and nothing is committed automatically. The Local Backups section lets you review and restore the content saved before an overwrite. Backups remain on this Mac across restarts.

### Resolve text conflicts

Select a conflicted file and use the inspector to keep its complete pre-update local contents, accept the complete incoming contents, or open a three-way merge. FileMerge uses base, local and incoming snapshots with a separate output file. Save in FileMerge, return to svnbox and choose **Check Merge Result**, then review and apply it. Closing the tool does not mark the conflict resolved.

FileMerge requires Xcode. Other configured tools open the source snapshots and output for manual editing. Text conflict actions support UTF-8 text; property, tree and binary conflicts require manual handling. After editing a working file directly, refresh and explicitly mark it resolved.

### Adjust the workspace

Drag the panel dividers to resize the workspace or collapse the inspector. Open Settings with **⌘,** and choose **General → Language** to switch between English and Simplified Chinese. Language and appearance changes apply immediately and are saved on this Mac. Configure SVN and an external merge tool on the **Tools** page. Working-copy context and commit drafts are restored when you reopen svnbox.

### Update the application

Choose **svnbox → Check for Updates** or use **App update** above the repository sidebar. Checking starts a background download when a stable update is available; its ring shows the download progress while you keep working. Dismissing the prompt leaves the download running; cancelling stops it and allows a new check. Once verified, choose **Later** or **Restart to update**. Running SVN operations must finish before installation, and commit drafts are saved before restarting. Settings contains preferences and version information, with no update controls.

Updates come from this repository's stable GitHub Releases. Tauri updates verify the application’s dedicated signature. Switching from Electron requires one manual installation of the Tauri version.

## License

svnbox uses the custom [svnbox Source-Available License 1.0](LICENSE). **Personal use and internal company use, including commercial work, are free**, with no per-user or per-device fees. You may study, modify, build and redistribute the software free of charge; internal modifications do not need to be published.

**Selling the software or its derivatives requires separate written permission**, including renaming, rebranding or repackaging it for sale, paid downloads, subscriptions and paid activation. Genuine installation, training, support and custom development services may be charged separately while the software and the right to use it remain free. Redistribution must retain the license and attribution; modified versions must identify their origin and changes.

This sales restriction makes svnbox **source-available**, rather than open source under the [OSI definition](https://opensource.org/osd). The license does not retroactively revoke rights already granted under earlier licenses. Third-party components retain their own licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md) and the license texts linked there.

## Tauri / Rust development

This is the independent Tauri migration of Electron SVNBox 0.2.1, with Diffolio's Tauri migration as a reference. The React interface remains familiar; Rust now handles SVN execution, workspace storage, operation review, cancellation, backups, credentials, native menus and application updates. The application uses system WebKit and bundles no Electron, Chromium or Node.js runtime. Node.js is used for frontend development and build tooling.

Requirements: macOS 13.3 or later on Apple Silicon, Node.js 26, Rust 1.93 or later, and Xcode / Icon Composer 27 for the existing app icon. Building the pinned SVN runtime requires `scons` and `pkgconf`; native integration tests also use Homebrew `subversion`.

```sh
npm ci
npm run dev
```

The Vite development server binds to `127.0.0.1:1421`. Production builds embed the compiled frontend.

```sh
npm run build
npm test
npm run test:rust
npm run test:native
npm run format:check
npm run check:rust
npm run licenses:check
npm run package:app
npm run package:dmg
```

TypeScript follows `.prettierrc.json`. Rust follows `src-tauri/rustfmt.toml` and is checked with `cargo fmt` and Clippy. Project source files use UTF-8 without a BOM and LF newlines. Original upstream license texts retain their original bytes.

### Existing Electron data

Install the first Tauri version manually. On its first normal launch, it copies workspace records, drafts, operation history, file backups and merge sessions from an existing Electron profile into `~/Library/Application Support/app.svnbox.desktop`, leaving the original profile in place. It never overwrites an existing Tauri workspace. Set `SVNBOX_DATA_DIR` to use an isolated profile and skip automatic import.

Credential names, usernames and scopes are preserved. Electron's encrypted password file is retained as a backup; passwords must be entered once again and are then stored in macOS Keychain under `app.svnbox.desktop.credentials`. Passwords are not written to workspace JSON or command-line arguments.

### Packaging and updates

Local packaging creates an ad-hoc signed app under `src-tauri/target/release/bundle/macos/仓盒.app`. Preview artifacts are placed under `release/preview/<version>/macos/arm64/`. A public release uses `npm run release:mac`, requires Developer ID and notarization credentials, and never falls back to an ad-hoc build. Packaging produces local artifacts; publication is a separate action.

Tauri updates use this application's dedicated public key, signed `.app.tar.gz` artifacts and `latest.json`. Signatures bind the archive to the announced version, stable versions must increase, checks are manual, and active SVN writes block installation. New versions download automatically after a check, and require explicit confirmation to install. Development and native verification builds disable updates.

The signing private key stays outside the repository at `~/.config/svnbox/signing/tauri-updater.key` on the migration machine. Other builders may supply `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Preserve the private key for future releases; do not commit or publish it. A builder without the signing key can still create a local app without updater artifacts.

The Tauri feed differs from Electron's `latest-mac.yml`; Electron clients need one manual installation of the Tauri release. The same repository keeps Tauri on `main` and Electron on `electron-legacy`. See [the migration notes](docs/migration.md) for the native module map and verification coverage.

### GitHub Actions releases

This project retains the history of `svn-box/svn-box`. Release notes live in `docs/releases/<version>.md`; npm, Cargo and Tauri versions must agree.

Pushing the matching version tag, such as `v0.4.0`, triggers `Release macOS arm64`. The `xcode-27` build signs and notarizes the app and DMG, verifies the extracted updater archive and read-only mounted DMG, then uploads and checks a draft before publishing the GitHub Release and `latest.json`. Existing releases are never overwritten.

Validation CI runs for pull requests or manual dispatch. Pushing `main` alongside a release tag starts only the release workflow, which runs the source checks once. Both workflows share toolchain and resource preparation. The release builds the production frontend and signed application once, then runs native regression with an isolated debug test binary against that frontend; test features are not shipped. The verified distribution transfer artifact is retained for one day, while failure diagnostics remain available for seven days.

The workflow uses repository Secrets `BUILD_CERTIFICATE_BASE64`, `P12_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and the dedicated SVNBox `TAURI_SIGNING_PRIVATE_KEY`. Set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when the key has a nonempty password. Signing material is imported into a temporary keychain and removed after the build, restoring the original keychain search list.
