import { ChevronRight } from 'lucide-react';
import type { FileStatus } from '../../../shared/types';
import { FileIcon } from './FileIcon';

export function FileTreeName({
	file,
	name,
	depth,
	expanded,
	showParent,
	onSelect,
	onToggle,
	onOpen,
}: {
	file: FileStatus;
	name: string;
	depth: number;
	expanded: boolean;
	showParent: boolean;
	onSelect: () => void;
	onToggle: () => void;
	onOpen: () => void;
}) {
	const parent = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : '';
	return (
		<div className="file-entry" style={{ paddingLeft: depth * 16 }}>
			{file.kind === 'dir' && !showParent ? (
				<button
					className="tree-disclosure"
					tabIndex={-1}
					aria-label={`${expanded ? '收起' : '展开'} ${file.path === '.' ? name : file.path}`}
					aria-expanded={expanded}
					onClick={onToggle}
				>
					<ChevronRight size={12} className={expanded ? 'rotated' : ''} />
				</button>
			) : (
				<span className="tree-disclosure-placeholder" />
			)}
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
					{showParent && parent && <small>{parent}</small>}
				</span>
				{file.movedFrom && (
					<span className="moved-hint" title={`从 ${file.movedFrom} 移动`}>
						↗
					</span>
				)}
			</button>
		</div>
	);
}
