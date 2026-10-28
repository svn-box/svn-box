import theme from '../assets/file-icons/symbols/theme.json';

const definitions: Record<string, { iconPath: string }> = theme.iconDefinitions;
const filenames = associations(theme.fileNames);
const extensions = associations(theme.fileExtensions);
const languages = associations(theme.languageIds);
const folders = associations(theme.folderNames);
const languageExtensions: Record<string, string> = { clj: 'clojure', cljc: 'clojure', pl: 'perl', pm: 'perl' };

function associations(entries: Record<string, string>): Map<string, string> {
	return new Map(Object.entries(entries).map(([name, icon]) => [name.toLowerCase(), icon]));
}

function fileIconId(name: string): string {
	const exact = filenames.get(name);
	if (exact) {
		return exact;
	}
	for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
		const extension = name.slice(dot + 1);
		const icon = extensions.get(extension) ?? languages.get(languageExtensions[extension] ?? extension);
		if (icon) {
			return icon;
		}
	}
	return name.startsWith('.env.') ? (filenames.get('.env') ?? theme.file) : (languages.get(name) ?? theme.file);
}

export function resolveFileIcon(path: string, kind = 'file'): { id: string; path: string } {
	const name = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
	const id = kind === 'dir' ? (folders.get(name) ?? (path === '.' ? theme.rootFolder : theme.folder)) : fileIconId(name);
	return { id, path: definitions[id].iconPath.replace(/^\.\//, '') };
}
