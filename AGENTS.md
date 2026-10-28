# Scope

- Maintain Tauri SVNBox on `main` in this project. Preserve the Electron implementation on `electron-legacy`; use that branch and Tauri Diffolio as references.
- Preserve the existing renderer, RPC contracts, SVN operation review rules, cancellation behavior, credential scopes and persisted workspace data during migration.

# Code style

- Use UTF-8 without a BOM, LF line endings and a final newline, as configured in `.editorconfig` and `.gitattributes`.
- Follow `.prettierrc.json` for TS/TSX files.
- Use braces for control statements. Leave a blank line between function, method and standalone callback definitions.
- Declare variables close to where they are used, with one variable per statement except in loop initializers.
- Order class members as fields, constructors, public methods, then private methods. Keep related functions together and preserve dependency order and the execution order of React Hooks.
- Prefer `?.`, `??` and `?:` when semantically equivalent, preserving the meaning of `0`, `false` and empty strings.
- Keep comments concise, explaining intent and boundary conditions only where needed.

# Rust

- Follow `src-tauri/rustfmt.toml`: four spaces, Unix newlines and the configured line width. Apply `cargo fmt` instead of aligning Rust by hand.
- Use idiomatic snake_case identifiers, explicit serialized field names for the existing TypeScript contract, and structured errors across commands.
- Group constructors and public methods before private helpers within an `impl`; separate function and method definitions with a blank line.
- Use `Result` and propagate expected I/O, parsing and process errors. Keep untrusted paths and SVN arguments validated in Rust.
- Run the project's formatting checks, Rust tests and Clippy for changed native code; run the relevant renderer checks for frontend changes.

# Releases

- After successfully pushing a release tag and triggering its workflow, report the version and workflow URL as triggered, then end the turn while the remote job continues. Wait for remote completion or monitor its progress only when the user explicitly asks.
