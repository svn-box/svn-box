# Code style

- Follow `.prettierrc.json` for TS/TSX files.
- Use braces for control statements. Leave a blank line between function, method, and standalone callback definitions.
- Declare variables close to where they are used, with one variable per statement except in loop initializers.
- Order class members as fields, constructors, public methods, then private methods. Keep related functions together and preserve dependency order and the execution order of React Hooks.
- Prefer `?.`, `??`, and `?:` when they are clear and semantically equivalent, preserving the meaning of `0`, `false`, and empty strings.
- Keep comments concise, explaining intent and boundary conditions only where needed.
