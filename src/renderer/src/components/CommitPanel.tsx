import { useState } from 'react';
import { Clock3, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { FileStatus, WorkingCopy } from '../../../shared/types';
import { useDiff } from '../queries/hooks';
import { workspaceStore, useWorkspaceSession, useWorkspaceStore } from '../state/workspace';
import { Modal } from './Dialogs';
import { Button } from './ui/button';
import { Combobox } from './ui/combobox';
import { VirtualList } from './VirtualList';
import { DiffView } from './DiffView';
import { FileIcon } from './FileIcon';

export function CommitPanel({
	copy,
	files,
	recentMessages,
	blocked,
	busy,
	scannedAt,
	onReview,
	onClose,
}: {
	copy: WorkingCopy;
	files: FileStatus[];
	recentMessages: string[];
	blocked: number;
	busy: boolean;
	scannedAt?: string;
	onReview: (paths: string[]) => void;
	onClose: () => void;
}) {
	const session = useWorkspaceSession(copy.id);
	const save = useWorkspaceStore((state) => state.sessionWrites[copy.id]);
	const onPatch = (patch: Partial<typeof session>) => workspaceStore.getState().patchSession(patch, copy.id);
	const [preview, setPreview] = useState(files.some((file) => file.path === session.currentPath) ? session.currentPath : (files[0]?.path ?? ''));
	const diff = useDiff(copy.id, preview, scannedAt);
	const selected = files.filter((file) => session.selected.includes(file.path));

	function toggle(path: string) {
		onPatch({ selected: session.selected.includes(path) ? session.selected.filter((item) => item !== path) : [...session.selected, path] });
	}

	return (
		<Modal title={`提交到 ${copy.name}`} description="先选择本次要提交的文件，核对本地差异，再填写提交说明。" wide className="commit-modal" onClose={onClose}>
			<div className="commit-layout">
				<div className="commit-file-list">
					<div className="commit-list-title">
						<span>
							本地变更 <b>{files.length}</b>
						</span>
						<button onClick={() => onPatch({ selected: selected.length === files.length ? [] : files.map((file) => file.path) })}>
							{selected.length === files.length && files.length ? '取消全选' : '全选'}
						</button>
					</div>
					{files.length ? (
						<VirtualList
							items={files}
							label="选择提交文件"
							height={34}
							activeIndex={files.findIndex((file) => file.path === preview)}
							render={(file) => (
								<div className={`commit-file ${preview === file.path ? 'active' : ''}`}>
									<input type="checkbox" aria-label={`提交 ${file.path}`} checked={session.selected.includes(file.path)} onChange={() => toggle(file.path)} />
									<FileIcon path={file.path} kind={file.kind} />
									<button onClick={() => setPreview(file.path)} title={file.path}>
										{file.path}
									</button>
								</div>
							)}
						/>
					) : (
						<div className="empty">没有可提交的本地变更</div>
					)}
				</div>
				<div className="commit-editor">
					<label>
						提交说明
						<textarea
							autoFocus
							aria-label="提交说明"
							value={session.draft}
							placeholder="说明修改的目的与影响…"
							onChange={(event) => onPatch({ draft: event.target.value })}
						/>
					</label>
					<div className="recent-messages">
						<Clock3 size={13} />
						<Combobox
							label="近期提交说明"
							value=""
							placeholder="复用近期提交说明…"
							options={recentMessages.map((message) => ({ value: message, label: message.split('\n')[0].slice(0, 100) }))}
							onValueChange={(draft) => onPatch({ draft })}
						/>
					</div>
					<div className="draft-save">
						<ShieldCheck size={12} />
						{save?.error ? '草稿保存失败，内容仍保留在当前窗口' : save?.pending ? '正在保存…' : '草稿已自动保存 · 仅属于此工作副本'}
					</div>
				</div>
			</div>
			<div className="commit-diff">
				<DiffView {...diff} title={preview ? `本地差异 · ${preview}` : '选择文件查看本地差异'} />
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
