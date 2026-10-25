import { useId } from 'react';

const types: Record<string, { label: string; color: string; kind: string }> = {
	ts: { label: 'TS', color: '#2870b5', kind: 'typescript' },
	tsx: { label: 'TS', color: '#2870b5', kind: 'typescript' },
	js: { label: 'JS', color: '#88651e', kind: 'javascript' },
	jsx: { label: 'JS', color: '#88651e', kind: 'javascript' },
	json: { label: '{}', color: '#946521', kind: 'json' },
	jsonc: { label: '{}', color: '#946521', kind: 'json' },
	xml: { label: '<>', color: '#a15e32', kind: 'xml' },
	html: { label: '<>', color: '#a15e32', kind: 'html' },
	vue: { label: 'V', color: '#337b61', kind: 'vue' },
	svelte: { label: 'S', color: '#af5a35', kind: 'svelte' },
	css: { label: '#', color: '#6e56a4', kind: 'stylesheet' },
	scss: { label: '#', color: '#9b4f7d', kind: 'stylesheet' },
	less: { label: '#', color: '#6e56a4', kind: 'stylesheet' },
	md: { label: 'M↓', color: '#46677e', kind: 'markdown' },
	mdx: { label: 'M↓', color: '#46677e', kind: 'markdown' },
	swift: { label: 'Sw', color: '#ad5430', kind: 'swift' },
	py: { label: 'Py', color: '#376c9b', kind: 'python' },
	rs: { label: 'Rs', color: '#85614c', kind: 'rust' },
	go: { label: 'Go', color: '#33758a', kind: 'go' },
	java: { label: 'J', color: '#956238', kind: 'java' },
	c: { label: 'C', color: '#5a6b9a', kind: 'code' },
	cpp: { label: 'C+', color: '#5a6b9a', kind: 'code' },
	h: { label: 'H', color: '#6c6e95', kind: 'code' },
	cs: { label: 'C#', color: '#71539b', kind: 'code' },
	rb: { label: 'Rb', color: '#a94d52', kind: 'ruby' },
	php: { label: 'P', color: '#6a6595', kind: 'php' },
	sh: { label: '>_', color: '#4d7463', kind: 'shell' },
	zsh: { label: '>_', color: '#4d7463', kind: 'shell' },
	bash: { label: '>_', color: '#4d7463', kind: 'shell' },
	yml: { label: 'Y', color: '#627087', kind: 'config' },
	yaml: { label: 'Y', color: '#627087', kind: 'config' },
	toml: { label: 'T', color: '#627087', kind: 'config' },
	ini: { label: '≡', color: '#627087', kind: 'config' },
	conf: { label: '≡', color: '#627087', kind: 'config' },
	plist: { label: '≡', color: '#627087', kind: 'config' },
	sql: { label: 'DB', color: '#4f7786', kind: 'database' },
	db: { label: 'DB', color: '#4f7786', kind: 'database' },
	csv: { label: '▦', color: '#3e7b60', kind: 'spreadsheet' },
	xlsx: { label: '▦', color: '#3e7b60', kind: 'spreadsheet' },
	pdf: { label: 'PDF', color: '#ad4a4f', kind: 'pdf' },
};

export function FileIcon({ path, kind = 'file', size = 18 }: { path: string; kind?: string; size?: number }) {
	const gradient = useId();
	if (kind === 'dir') {
		return (
			<svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" className="file-type-icon" data-file-type="folder">
				<defs>
					<linearGradient id={gradient} x2="0" y2="1">
						<stop stopColor="#82ccef" />
						<stop offset="1" stopColor="#389bcf" />
					</linearGradient>
				</defs>
				<path d="M2 4.5c0-.7.6-1.3 1.3-1.3h4.4l1.6 1.9h7.4c.7 0 1.3.6 1.3 1.3v8.7c0 .9-.7 1.6-1.6 1.6H3.6c-.9 0-1.6-.7-1.6-1.6Z" fill="#348fbd" />
				<path d="M2 7.2h16v8.1c0 .8-.6 1.4-1.4 1.4H3.4c-.8 0-1.4-.6-1.4-1.4Z" fill={`url(#${gradient})`} stroke="#3988b2" strokeWidth=".5" />
				<path d="M2.7 7.8h14.6" stroke="#c3ecff" strokeOpacity=".7" strokeWidth=".6" />
			</svg>
		);
	}
	const name = path.split('/').at(-1)?.toLowerCase() ?? '';
	const extension = name.includes('.') ? name.split('.').at(-1)! : '';
	const image = /^(png|jpe?g|gif|webp|svg|ico|icns|heic|tiff?)$/.test(extension);
	const archive = /^(zip|gz|tgz|bz2|xz|7z|rar|tar)$/.test(extension);
	const media = /^(mp3|m4a|wav|ogg|flac|mp4|mov|mkv|webm)$/.test(extension);
	const appearance =
		types[extension] ?? (/^(\.env(?:\.|$)|\.gitignore$|\.svnignore$|dockerfile$|makefile$)/.test(name) ? { label: '≡', color: '#627087', kind: 'config' } : undefined);
	const category = kind === 'symlink' ? 'symlink' : image ? 'image' : archive ? 'archive' : media ? 'media' : (appearance?.kind ?? 'document');
	return (
		<svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" className="file-type-icon" data-file-type={category}>
			<path
				d="M4 1.5h7.8l4.7 4.7v11.2c0 .7-.5 1.2-1.2 1.2H4.7c-.7 0-1.2-.5-1.2-1.2V2.7C3.5 2 3.7 1.5 4 1.5Z"
				fill="var(--file-paper)"
				stroke="var(--file-paper-border)"
				strokeWidth=".7"
			/>
			<path d="M11.7 1.9v4.4h4.4" fill="var(--file-fold)" stroke="var(--file-paper-border)" strokeWidth=".65" strokeLinejoin="round" />
			{image ? (
				<g stroke="#8563ad" strokeWidth="1" fill="none">
					<rect x="5.7" y="8.1" width="8.7" height="7.4" rx=".8" />
					<circle cx="8.1" cy="10.4" r=".8" />
					<path d="m6 14 2.5-2.2 1.4 1 1.7-2.1 2.7 3.5" />
				</g>
			) : archive ? (
				<g fill="#977246">
					<path d="M8 5h2v2H8zm2 2h2v2h-2zm-2 2h2v2H8zm2 2h2v2h-2z" />
					<rect x="8.2" y="13.5" width="3.5" height="3" rx=".7" fill="none" stroke="#977246" />
				</g>
			) : media ? (
				<path d="m8 8 5 3.5L8 15Z" fill="#8b5793" />
			) : appearance ? (
				<g>
					<rect x="2.5" y="10" width="15" height="7" rx="1.2" fill={appearance.color} />
					<text
						x="10"
						y="15.3"
						fill="white"
						textAnchor="middle"
						fontSize={appearance.label.length > 2 ? '5.1' : '6.3'}
						fontFamily="system-ui, sans-serif"
						fontWeight="750"
						letterSpacing="-.25"
					>
						{appearance.label}
					</text>
				</g>
			) : (
				<path d="M6.3 9.5h7.2m-7.2 2.8h7.2m-7.2 2.8h5.1" fill="none" stroke="#7c8a9b" strokeWidth=".85" />
			)}
			{kind === 'symlink' && <path d="M2 15h5m-2-2 2 2-2 2" fill="none" stroke="var(--text)" strokeWidth="1.4" />}
		</svg>
	);
}
