# svnbox

A Subversion client for macOS. Organize repositories and working copies, review changes, and commit selected paths from one desktop workspace.

The interface is currently available in Simplified Chinese.

## Features

- **Multiple working copies** — group, search, favorite, and reorder projects. Each working copy keeps its own file selection, filters, expanded folders, history context, and commit draft.
- **Repository bookmarks** — organize remote URLs, browse directories, and check out branches into separate local working copies.
- **Change review** — browse a compact file tree, filter SVN states, and compare text and property changes with unified or side-by-side diffs.
- **Selective commits** — choose paths, review the actual commit scope, reuse recent messages, and recover drafts after restarting the app.
- **History** — explore a collapsible timeline, load earlier revisions, inspect changed paths, and view differences within each commit.
- **SVN operations** — update, add, rename, delete, ignore, revert, and clean up working copies. Inspect conflicts and open an external comparison or merge tool.
- **Connection credentials** — save encrypted credentials for a connection or repository path and share them across matching child URLs.
- **Operation logs** — inspect progress and command output, cancel running tasks, filter or copy logs, and clear completed records.
- **Desktop controls** — keyboard navigation, context menus, Finder and Terminal actions, and six appearance themes.
- **Bundled SVN** — use the included Subversion client or choose a local executable in Settings.

## Usage

### Add projects

Press **⌘O** to add an existing working copy. svnbox identifies its root and repository automatically. Use the sidebar context menu to rename, group, favorite, or reorder it. Removing an entry only removes it from svnbox.

Press **⌘⇧O** to browse a remote repository and check out a directory. Enter the URL, choose a destination and checkout depth, and provide credentials when prompted. Credentials can apply to the whole connection or only the selected repository path.

### Review and commit

Select a working copy in the sidebar. Browse its files, show only changed items, or filter by SVN state. Select a file to open its diff, then switch between unified and side-by-side views or open FileMerge when available.

Press **⌘↵** to prepare a commit. Write a message, choose the paths to include, and review the actual scope before confirming. Checkboxes select paths for this commit; SVN has no staging area. Drafts are saved separately for each working copy.

### Refresh and update

Press **⌘R** to refresh local status. Press **⌘U** to update the working copy from its repository. Open operation logs with **⌘J** to inspect output or cancel an active task. Cancellation does not undo changes already completed.

Use file context menus for add, rename, delete, ignore, and revert operations. Destructive operations show their impact before confirmation. For conflicts, review the details, use an external tool if needed, refresh the status, and explicitly mark the result as resolved.

### Explore history

Switch to the history view or open a file or directory's history from its context menu. Expand a date or commit to inspect changed paths. Open the comparison inside a commit to review its diff.

The search box filters records already loaded. Use the earlier-history action to query additional revisions from the server.

### Adjust the workspace

Drag the panel dividers to resize the workspace or collapse the inspector. Open Settings with **⌘,** to choose an appearance or configure SVN and an external merge tool. Working-copy context and commit drafts are restored when you reopen svnbox.
