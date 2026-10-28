import { resolveFileIcon } from '../lib/file-icons';

const icons = import.meta.glob<string>('../assets/file-icons/symbols/icons/**/*.svg', { eager: true, import: 'default', query: '?url&no-inline' });
const iconRoot = '../assets/file-icons/symbols/';

export function FileIcon({ path, kind = 'file', size = 18 }: { path: string; kind?: string; size?: number }) {
	const icon = resolveFileIcon(path, kind);
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="file-type-icon" data-file-type={icon.id}>
			<image href={icons[`${iconRoot}${icon.path}`]} width="24" height="24" />
			{kind === 'symlink' && <image href={icons[`${iconRoot}icons/files/link.svg`]} x="0" y="12" width="12" height="12" />}
		</svg>
	);
}
