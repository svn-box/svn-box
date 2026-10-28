# Symbols file icons

File and folder artwork and associations from [Symbols](https://github.com/miguelsolorio/vscode-symbols), Copyright (c) 2020-22 Miguel Solorio, under the [MIT license](../../../../../resources/licenses/upstream/symbols-icons.txt).

Pinned upstream revision: `2c95b15b0a8ef95ac62855e3784a6024ee6e5d2e`.

- `symbols/icons/`: the complete upstream `src/icons/` SVG collection (261 file and 109 folder icons).
- `symbols/theme.json`: upstream `src/symbol-icon-theme.json`, with formatting applied. Includes 445 extension associations, 797 filename associations and 161 folder-name associations.

The original SVG artwork is retained. Exact filenames take precedence over compound extensions, then ordinary extensions, with case-insensitive matching. Upstream language IDs also resolve extensions such as Vue and PHP; a small alias table covers Clojure and Perl extensions normally identified by an editor. Unknown files and directories use the library defaults. Symbolic links retain their type icon and add the library's link icon as an overlay.

Assets are bundled locally as separate SVG files and loaded only when displayed. No extension runtime is included. Existing icon slots and workspace layout remain unchanged.
