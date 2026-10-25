import { CheckCircle2, CircleAlert, Clock3, LoaderCircle } from 'lucide-react';
import { useOperations } from '../queries/hooks';
import { useWorkspaceStore, workspaceStore } from '../state/workspace';
import { api } from '../lib/api';
import { notifyError } from '../lib/feedback';
import { Modal } from './Dialogs';
import { Button } from './ui/button';
import { fmtDate, opLabels } from './file-presentation';

export function OperationsDialog({ onVerify }: { onVerify: (id: string) => void }) {
	const operations = useOperations();
	const state = useWorkspaceStore((store) => store.catalog)!;
	const showError = notifyError;
	const setShowOperations = (value: boolean) => workspaceStore.getState().setPanel('showOperations', value);
	return (
		<Modal title="操作记录" description="展示真实命令输出。取消不会回滚；结果待核实时请检查历史后再重试。" wide onClose={() => setShowOperations(false)}>
			<div className="operation-list">
				{!operations.length ? (
					<div className="empty">
						<Clock3 size={28} />
						尚无操作记录
					</div>
				) : (
					operations.map((operation) => (
						<details key={operation.id} className={`operation ${operation.state}`} open={['running', 'uncertain', 'failed'].includes(operation.state)}>
							<summary>
								<span className="operation-symbol">
									{['running', 'waiting'].includes(operation.state) ? (
										<LoaderCircle size={15} className="spin" />
									) : operation.state === 'success' ? (
										<CheckCircle2 size={15} />
									) : (
										<CircleAlert size={15} />
									)}
								</span>
								<strong>{operation.label}</strong>
								<span>{operation.wcId ? state.workingCopies.find((copy) => copy.id === operation.wcId)?.name : '远端仓库'}</span>
								<b>
									{operation.state === 'success' && operation.logs.some((line) => line.includes('个路径存在冲突'))
										? '完成 · 存在冲突'
										: opLabels[operation.state]}
								</b>
								{['waiting', 'running'].includes(operation.state) && (
									<button
										onClick={(event) => {
											event.preventDefault();
											void api.call('cancel', { id: operation.id }).catch(showError);
										}}
									>
										取消
									</button>
								)}
							</summary>
							<p>
								{fmtDate(operation.startedAt)}
								{operation.endedAt ? ` → ${fmtDate(operation.endedAt)}` : ''}
							</p>
							{operation.error && (
								<pre className="inline-error">
									{operation.error.message}
									{operation.error.detail ? `\n${operation.error.detail}` : ''}
								</pre>
							)}
							<pre className="operation-log">
								{operation.logs.join('') || (operation.state === 'waiting' ? '等待同一工作副本的前序写操作完成…' : '无额外命令输出')}
							</pre>
							{operation.state === 'uncertain' && operation.wcId && (
								<Button
									variant="outline"
									onClick={() => {
										onVerify(operation.wcId!);
										setShowOperations(false);
									}}
								>
									刷新并核实历史
								</Button>
							)}
						</details>
					))
				)}
			</div>
			<div className="dialog-footer">
				<Button variant="outline" onClick={() => setShowOperations(false)}>
					关闭记录
				</Button>
			</div>
		</Modal>
	);
}
