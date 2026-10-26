import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import type { AppUpdateAction, AppUpdateState } from '../../../shared/app-updates';
import { isOperationActive } from '../../../shared/types';
import { api } from '../lib/api';
import { notifyError } from '../lib/feedback';
import { useOperationSummary } from '../queries/hooks';
import { workspaceStore } from '../state/workspace';
import { Button } from './ui/button';

export function AppUpdateSection({ focusRequest = 0 }: { focusRequest?: number }) {
	const [update, setUpdate] = useState<AppUpdateState>();
	const [pending, setPending] = useState(false);
	const section = useRef<HTMLDivElement>(null);
	const busy = useOperationSummary().some(isOperationActive);
	const phase = update?.phase;
	const working = pending || !update || ['checking', 'downloading', 'installing'].includes(phase ?? '');
	const download = phase === 'available' || (phase === 'error' && !!update?.version);
	const action = phase === 'downloaded' ? 'install' : download ? 'download' : 'check';
	const label =
		phase === 'checking'
			? '正在检查…'
			: phase === 'downloading'
				? '正在下载…'
				: phase === 'installing'
					? '正在重新启动…'
					: action === 'install'
						? '重启并安装'
						: download
							? '下载更新'
							: '检查更新';
	const message =
		update?.message ??
		(phase === 'current'
			? '已是最新版本'
			: phase === 'checking'
				? '正在检查可用版本…'
				: phase === 'available'
					? `发现新版本 ${update?.version}`
					: phase === 'downloaded'
						? busy
							? 'SVN 操作进行中，完成后可安装更新。'
							: `版本 ${update?.version} 已下载，重新启动即可安装。`
						: phase === 'downloading'
							? `正在下载 ${update?.version} · ${Math.round(update?.percent ?? 0)}%`
							: phase === 'installing'
								? '正在准备安装更新…'
								: '手动检查新版本，下载后可重新启动安装。');

	useEffect(() => {
		let active = true;
		const accept = (next: AppUpdateState) => {
			if (active) {
				setUpdate((previous) => (!previous || next.revision >= previous.revision ? next : previous));
			}
		};
		const unsubscribe = api.onAppUpdate(accept);
		void api.call('appUpdate', { action: 'status' }).then(accept).catch(notifyError);
		return () => {
			active = false;
			unsubscribe();
		};
	}, []);

	useEffect(() => {
		if (focusRequest || (phase && !['idle', 'disabled', 'current'].includes(phase))) {
			section.current?.scrollIntoView({ block: 'nearest' });
		}
	}, [phase, focusRequest]);

	async function run(action: AppUpdateAction) {
		setPending(true);
		try {
			if (action === 'install') {
				await workspaceStore.getState().flushSessions();
			}
			const next = await api.call('appUpdate', { action });
			setUpdate((previous) => (!previous || next.revision >= previous.revision ? next : previous));
		} catch (error) {
			notifyError(error);
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="settings-row settings-app-update" ref={section}>
			<div className="settings-row-copy">
				<h3>应用更新{update && <span className="settings-app-version">当前版本 {update.currentVersion}</span>}</h3>
				<p role="status" className={update?.message && phase !== 'disabled' ? 'error-text' : undefined}>
					{message}
				</p>
				{phase === 'downloading' && <progress aria-label="应用更新下载进度" max={100} value={update?.percent ?? 0} />}
			</div>
			<div className="settings-update-actions">
				{update?.version && (
					<Button variant="ghost" size="sm" disabled={phase === 'installing'} onClick={() => void run('release')}>
						发布说明
					</Button>
				)}
				<Button
					variant="outline"
					disabled={working || phase === 'disabled' || (action === 'install' && busy)}
					aria-busy={working || undefined}
					onClick={() => void run(action)}
				>
					{working ? <LoaderCircle className="spin" /> : download ? <Download /> : <RefreshCw />}
					{label}
				</Button>
			</div>
		</div>
	);
}
