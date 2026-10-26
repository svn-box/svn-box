import { useTranslation } from 'react-i18next';
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
	const { t } = useTranslation();
	const messageId = useId();
	const session = useWorkspaceSession(copy.id);
	const save = useWorkspaceStore((state) => state.sessionWrites[copy.id]);

	const onPatch = (patch: Partial<typeof session>) => workspaceStore.getState().patchSession(patch, copy.id);

	const selected = files.filter((file) => session.selected.includes(file.path));

	function toggle(path: string) {
		onPatch({ selected: session.selected.includes(path) ? session.selected.filter((item) => item !== path) : [...session.selected, path] });
	}

	return (
		<Modal
			title={t('commitPanel.commitTo', {
				name: copy.name,
			})}
			description={t('commitPanel.writeACommitMessageAndSelectTheFiles')}
			wide
			className="commit-modal"
			onClose={onClose}
		>
			<div className="commit-layout">
				<div className="commit-editor">
					<div className="commit-editor-heading">
						<label htmlFor={messageId}>{t('commitPanel.commitMessage')}</label>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="sm"
									aria-label={t('commitPanel.recentCommitMessages')}
									title={t('commitPanel.reuseARecentCommitMessage')}
									disabled={!recentMessages.length}
								>
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
					<textarea
						id={messageId}
						autoFocus
						value={session.draft}
						placeholder={t('commitPanel.describeThePurposeAndImpactOfTheseChanges')}
						onChange={(event) => onPatch({ draft: event.target.value })}
					/>
					<div className="draft-save">
						<ShieldCheck size={12} />
						{save?.error ? t('commitPanel.theDraftCouldNotBeSavedYourText') : save?.pending ? t('commitPanel.saving') : t('commitPanel.draftSavedAutomatically')}
					</div>
				</div>
				<div className="commit-selection">
					<div className="commit-list-title">
						{t('commitPanel.changedFiles', {
							count: files.length,
						})}
					</div>
					<div className="commit-file-list">
						<div className="commit-file-header table-head">
							<label className="commit-select-all">
								<input
									type="checkbox"
									aria-label={t('commitPanel.selectAllCommitFiles')}
									checked={!!files.length && selected.length === files.length}
									disabled={!files.length}
									ref={(input) => {
										if (input) {
											input.indeterminate = selected.length > 0 && selected.length < files.length;
										}
									}}
									onChange={() => onPatch({ selected: selected.length === files.length ? [] : files.map((file) => file.path) })}
								/>
								{t('commitPanel.commit')}
							</label>
							<span>{t('common.status')}</span>
							<span>{t('commitPanel.path')}</span>
						</div>
						{files.length ? (
							<VirtualList
								items={files}
								label={t('commitPanel.selectFilesToCommit')}
								height={26}
								render={(file) => (
									<label className="commit-file file-row">
										<span className="commit-file-check">
											<input
												type="checkbox"
												aria-label={t('commitPanel.commit2', {
													path: file.path,
												})}
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
							<div className="empty">{t('commitPanel.noLocalChangesAreReadyToCommit')}</div>
						)}
					</div>
				</div>
			</div>
			{blocked > 0 && (
				<p className="hint">
					{t('commitPanel.blockedPathsResolveConflictsMissingFilesOrExternals', {
						blocked: blocked,
					})}
				</p>
			)}
			<div className="dialog-footer">
				<span className="muted mr-auto">
					{t('commitPanel.selectedOf', {
						count: selected.length,
						count2: files.length,
					})}
				</span>
				<Button variant="outline" onClick={onClose}>
					{t('commitPanel.continueLater')}
				</Button>
				<Button disabled={!session.draft.trim() || !selected.length || busy} onClick={() => onReview(selected.map((file) => file.path))}>
					{busy ? <LoaderCircle className="spin" /> : <ShieldCheck />}
					{t('commitPanel.reviewCommitScope')}
				</Button>
			</div>
		</Modal>
	);
}
