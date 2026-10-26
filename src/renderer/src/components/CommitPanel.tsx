import { useId } from 'react';
import { ChevronDown, Clock3, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { FileStatus, WorkingCopy } from '../../../shared/types';
import { workspaceStore, useWorkspaceSession, useWorkspaceStore } from '../state/workspace';
import { Modal } from './Dialogs';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { VirtualList } from './VirtualList';
import { FileIcon } from './FileIcon';
import { StatusBadge } from './file-presentation';

export function CommitPanel({
	copy,
	files,
	recentMessages,
	blocked,
	busy,
	onReview,
	onClose,
}: {
	copy: WorkingCopy;
	files: FileStatus[];
	recentMessages: string[];
	blocked: number;
	busy: boolean;
	onReview: (paths: string[]) => void;
	onClose: () => void;
}) {
	const messageId = useId();
	const session = useWorkspaceSession(copy.id);
	const save = useWorkspaceStore((state) => state.sessionWrites[copy.id]);
	const onPatch = (patch: Partial<typeof session>) => workspaceStore.getState().patchSession(patch, copy.id);
	const selected = files.filter((file) => session.selected.includes(file.path));

	function toggle(path: string) {
		onPatch({ selected: session.selected.includes(path) ? session.selected.filter((item) => item !== path) : [...session.selected, path] });
	}

	return (
		<Modal title={`提交到 ${copy.name}`} description="填写提交说明并选择本次要提交的文件。" wide className="commit-modal" onClose={onClose}>
			<div className="commit-layout">
				<div className="commit-editor">
					<div className="commit-editor-heading">
						<label htmlFor={messageId}>提交说明</label>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="sm" aria-label="近期提交说明" title="复用近期提交说明" disabled={!recentMessages.length}>
									<Clock3 />
									<ChevronDown />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="commit-recent-messages">
								{recentMessages.map((message) => (
									<DropdownMenuItem key={message} onSelect={() => onPatch({ draft: message })}>
										<span className="truncate" title={message}>
											{message.split('\n')[0]}
										</span>
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
					<textarea id={messageId} autoFocus value={session.draft} placeholder="说明修改的目的与影响…" onChange={(event) => onPatch({ draft: event.target.value })} />
					<div className="draft-save">
						<ShieldCheck size={12} />
						{save?.error ? '草稿保存失败，内容仍保留在当前窗口' : save?.pending ? '正在保存…' : '草稿已自动保存'}
					</div>
				</div>
				<div className="commit-selection">
					<div className="commit-list-title">{files.length} 个变更文件</div>
					<div className="commit-file-list">
						<div className="commit-file-header table-head">
							<label className="commit-select-all">
								<input
									type="checkbox"
									aria-label="全选提交文件"
									checked={!!files.length && selected.length === files.length}
									disabled={!files.length}
									ref={(input) => {
										if (input) {
											input.indeterminate = selected.length > 0 && selected.length < files.length;
										}
									}}
									onChange={() => onPatch({ selected: selected.length === files.length ? [] : files.map((file) => file.path) })}
								/>
								提交
							</label>
							<span>状态</span>
							<span>路径</span>
						</div>
						{files.length ? (
							<VirtualList
								items={files}
								label="选择提交文件"
								height={26}
								render={(file) => (
									<label className="commit-file file-row">
										<span className="commit-file-check">
											<input
												type="checkbox"
												aria-label={`提交 ${file.path}`}
												checked={session.selected.includes(file.path)}
												onChange={() => toggle(file.path)}
											/>
										</span>
										<StatusBadge file={file} />
										<span className="commit-file-path" title={file.path}>
											<FileIcon path={file.path} kind={file.kind} />
											<span>{file.path}</span>
										</span>
									</label>
								)}
							/>
						) : (
							<div className="empty">没有可提交的本地变更</div>
						)}
					</div>
				</div>
			</div>
			{blocked > 0 && <p className="hint">另有 {blocked} 个冲突、缺失或外部路径暂不能提交。</p>}
			<div className="dialog-footer">
				<span className="muted mr-auto">
					已选 {selected.length} / {files.length} 项
				</span>
				<Button variant="outline" onClick={onClose}>
					稍后继续
				</Button>
				<Button disabled={!session.draft.trim() || !selected.length || busy} onClick={() => onReview(selected.map((file) => file.path))}>
					{busy ? <LoaderCircle className="spin" /> : <ShieldCheck />}审阅提交范围
				</Button>
			</div>
		</Modal>
	);
}
