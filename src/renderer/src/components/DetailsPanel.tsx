import { Fragment } from 'react';
import { CircleAlert, Folder, History, Info, LoaderCircle, X } from 'lucide-react';
import { isConflict, type Action, type WorkingCopy, type WorkspaceSession } from '../../../shared/types';
import { useFileInfo, useHistoryEntries, useStatus } from '../queries/hooks';
import { useSessionSlice, useWorkspaceStore, workspaceStore } from '../state/workspace';
import { api } from '../lib/api';
import { notifyError } from '../lib/feedback';
import { Button } from './ui/button';
import { FileIcon } from './FileIcon';
import { fmtDate, leaf, StatusBadge } from './file-presentation';

export function DetailsPanel({ wc, requestReview, refresh }: { wc: WorkingCopy; requestReview: (action: Action, paths: string[]) => unknown; refresh: (id: string) => unknown }) {
	const session = useSessionSlice(wc.id, ['view']);
	const detailsWidth = useWorkspaceStore((state) => state.detailsWidth);
	const setShowDetails = (value: boolean) => workspaceStore.getState().setPanel('showDetails', value);
	return (
		<aside className="details-panel" style={{ width: detailsWidth }}>
			<div className="details-title">
				<Info size={13} />
				{session.view === 'history' ? '提交详情' : '文件详情'}
				<button aria-label="收起详情" onClick={() => setShowDetails(false)}>
					<X size={13} />
				</button>
			</div>
			{session.view === 'history' ? <HistoryDetails wcId={wc.id} /> : <FileDetails wc={wc} requestReview={requestReview} refresh={refresh} />}
		</aside>
	);
}

function HistoryDetails({ wcId }: { wcId: string }) {
	const session = useSessionSlice(wcId, ['historyTarget', 'historySearch', 'historyRevision']);
	const { filteredLogs } = useHistoryEntries(wcId, session.historyTarget, session.historySearch ?? '');
	const selectedLog = filteredLogs.find((entry) => entry.revision === session.historyRevision);
	if (!selectedLog) {
		return <DetailsEmpty history />;
	}
	return (
		<>
			<div className="detail-identity">
				<div className="detail-file-icon">
					<History size={27} />
				</div>
				<h2>版本 r{selectedLog.revision}</h2>
				<p className="detail-subtitle">{selectedLog.author || '未知作者'}</p>
			</div>
			<dl>
				<dt>提交日期</dt>
				<dd>{fmtDate(selectedLog.date)}</dd>
			</dl>
			<div className="detail-section-title">提交说明</div>
			<pre className="commit-message">{selectedLog.message || '（无提交说明）'}</pre>
			<div className="detail-section-title">变更范围</div>
			<dl>
				<dt>全部路径</dt>
				<dd>{selectedLog.paths.length}</dd>
				{[
					['A', '新增'],
					['M', '修改'],
					['D', '删除'],
					['R', '替换'],
				].map(([action, label]) => (
					<Fragment key={action}>
						<dt>{label}</dt>
						<dd>{selectedLog.paths.filter((path) => path.action === action).length}</dd>
					</Fragment>
				))}
			</dl>
		</>
	);
}

function FileDetails({ wc, requestReview, refresh }: { wc: WorkingCopy; requestReview: (action: Action, paths: string[]) => unknown; refresh: (id: string) => unknown }) {
	const session = useSessionSlice(wc.id, ['currentPath']);
	const patchSession = (patch: Partial<WorkspaceSession>) => workspaceStore.getState().patchSession(patch, wc.id);
	const showError = notifyError;
	const snapshot = useStatus(wc.id).data;
	const currentFile = snapshot?.files.find((file) => file.path === session.currentPath);
	const fileInfo = useFileInfo(wc.id, session.currentPath, snapshot?.scannedAt);
	if (!session.currentPath) {
		return <DetailsEmpty />;
	}
	return (
		<>
			<div className="detail-identity">
				<div className="detail-file-icon">
					<FileIcon path={session.currentPath} kind={currentFile?.kind} size={40} />
				</div>
				<h2>{session.currentPath === '.' ? wc.name : leaf(session.currentPath)}</h2>
				<p className="detail-subtitle">{currentFile ? <StatusBadge file={currentFile} /> : '状态待刷新'}</p>
			</div>
			<div className="detail-section-title">文件信息</div>
			{fileInfo.loading && (
				<div className="details-loading">
					<LoaderCircle className="spin" size={13} />
					读取 SVN 信息…
				</div>
			)}
			<dl>
				<dt>相对路径</dt>
				<dd className="break-all">{session.currentPath}</dd>
				<dt>版本</dt>
				<dd className="mono">{fileInfo.info?.revision ? `r${fileInfo.info.revision}` : currentFile?.revision || '—'}</dd>
				<dt>最后作者</dt>
				<dd>{currentFile?.author || '—'}</dd>
				<dt>最后修改</dt>
				<dd>{fmtDate(currentFile?.date)}</dd>
				<dt>文件类型</dt>
				<dd>{currentFile?.kind === 'dir' ? '目录' : currentFile?.kind === 'symlink' ? '符号链接' : '文件'}</dd>
				{currentFile?.movedFrom && (
					<>
						<dt>移动来源</dt>
						<dd>{currentFile.movedFrom}</dd>
					</>
				)}
				{currentFile?.movedTo && (
					<>
						<dt>移动目标</dt>
						<dd>{currentFile.movedTo}</dd>
					</>
				)}
			</dl>
			{fileInfo.info?.url && (
				<details className="detail-repository">
					<summary>仓库 URL</summary>
					<p className="break-all">{fileInfo.info.url}</p>
				</details>
			)}
			{currentFile && isConflict(currentFile) && (
				<div className="conflict-box">
					<strong>
						<CircleAlert size={14} />
						冲突需要处理
					</strong>
					<p>
						{currentFile.treeConflicted
							? '树冲突：请核实删除、移动与上游目录结构。'
							: currentFile.props === 'conflicted'
								? '属性冲突：请检查并手动修正冲突属性。'
								: '文本冲突：请在外部工具中合并并保存。'}
					</p>
					{fileInfo.info?.conflicts.length ? <pre>{JSON.stringify(fileInfo.info.conflicts, null, 2)}</pre> : null}
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							void api.call('system', { wcId: wc.id, path: session.currentPath, action: 'merge' }).catch(showError);
						}}
					>
						打开合并工具
					</Button>
					<Button variant="outline" size="sm" onClick={() => void refresh(wc.id)}>
						检查解决结果
					</Button>
					<Button size="sm" variant="outline" onClick={() => void requestReview('resolve', [session.currentPath])}>
						标记已解决…
					</Button>
				</div>
			)}
			<div className="detail-section-title">
				SVN 属性<span>{fileInfo.properties?.length ?? '—'}</span>
			</div>
			{fileInfo.properties?.length ? (
				fileInfo.properties.map((property) => (
					<div className="property" key={property.name}>
						<code>{property.name}</code>
						<pre>{property.value}</pre>
					</div>
				))
			) : (
				<p className="detail-empty">{fileInfo.loading ? '正在读取…' : fileInfo.error ? '此路径暂无可读取的 SVN 属性' : '未设置自定义属性'}</p>
			)}
			{fileInfo.error && (
				<details className="detail-error">
					<summary>查看读取信息</summary>
					<pre>{fileInfo.error}</pre>
				</details>
			)}
			<div className="detail-bottom-actions">
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						void api.call('system', { wcId: wc.id, path: session.currentPath, action: 'reveal' }).catch(showError);
					}}
				>
					<Folder />在 Finder 中显示
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onClick={() =>
						patchSession({
							view: 'history',
							historyTarget: session.currentPath,
							historyDiffPath: session.currentPath,
							historyRevision: undefined,
						})
					}
				>
					<History />
					查看历史
				</Button>
			</div>
		</>
	);
}

function DetailsEmpty({ history = false }: { history?: boolean }) {
	return (
		<div className="details-empty">
			<Info size={27} />
			<strong>{history ? '未选择提交' : '未选择文件'}</strong>
			<p>
				选择{history ? '一条提交记录' : '文件或目录'}查看{history ? '说明及变更路径' : '状态、版本与 SVN 属性'}
			</p>
		</div>
	);
}
