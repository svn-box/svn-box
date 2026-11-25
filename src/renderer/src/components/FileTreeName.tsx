import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { FileStatus } from '../../../shared/types';
import { FileIcon } from './FileIcon';

export function FileTreeName({
	file,
	name,
	depth,
	expanded,
	showParent,
	checkbox,
	onSelect,
	onToggle,
	onOpen,
}: {
	file: FileStatus;
	name: string;
	depth: number;
	expanded: boolean;
	showParent: boolean;
	checkbox?: ReactNode;
	onSelect: () => void;
	onToggle: () => void;
	onOpen: () => void;
}) {
	const { t } = useTranslation();
	const parent = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : '';
	return (
		<div className="file-entry" style={{ paddingLeft: depth * 16 }}>
			{checkbox ??
				(file.kind === 'dir' && !showParent ? (
					<button
						className="tree-disclosure"
						tabIndex={-1}
						aria-label={`${expanded ? t('fileTreeName.collapse') : t('fileTreeName.expand')} ${file.path === '.' ? name : file.path}`}
						aria-expanded={expanded}
						onClick={onToggle}
					>
						<ChevronRight size={12} className={expanded ? 'rotated' : ''} />
					</button>
				) : (
					<span className="tree-disclosure-placeholder" />
				))}
			<button
				className="file-name"
				title={file.path}
				onClick={(event) => {
					event.currentTarget.closest<HTMLElement>('.file-pane')?.focus();
					onSelect();
				}}
				onDoubleClick={file.kind === 'dir' ? (!showParent ? onToggle : undefined) : onOpen}
			>
				<FileIcon path={file.path} kind={file.kind} />
				<span className="file-label truncate">
					{name}
					{checkbox && file.kind === 'dir' && <small>{t('filePane.includesChildren')}</small>}
					{showParent && parent && <small>{parent}</small>}
				</span>
				{file.movedFrom && (
					<span
						className="moved-hint"
						title={t('fileTreeName.movedFrom', {
							movedFrom: file.movedFrom,
						})}
					>
						↗
					</span>
				)}
			</button>
		</div>
	);
}
