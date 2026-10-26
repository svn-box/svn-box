import { useEffect, useId, useRef, useState } from 'react';
import { Check, CircleAlert, LoaderCircle, Settings, ShieldCheck, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { themes } from '../../../shared/themes';
import type { AppState, Detection, Theme } from '../../../shared/types';
import { api, errorText } from '../lib/api';
import { notifyError } from '../lib/feedback';
import type { WorkspaceCatalog } from '../state/workspace-store';
import { Button } from './ui/button';
import { Combobox } from './ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { AppUpdateSection } from './AppUpdateSection';

const pages = [
	{ id: 'general', label: '通用设置', icon: Settings },
	{ id: 'tools', label: '工具', icon: Wrench },
] as const;

export function SettingsDialog({
	state,
	onState,
	onClose,
	updateRequest = 0,
}: {
	state: WorkspaceCatalog;
	onState: (state: AppState) => void;
	onClose: () => void;
	updateRequest?: number;
}) {
	const id = useId();
	const [page, setPage] = useState<(typeof pages)[number]['id']>('general');
	const [path, setPath] = useState(state.settings.svnPath);
	const [tool, setTool] = useState(state.settings.mergeTool);
	const [detection, setDetection] = useState<Detection>();
	const [busy, setBusy] = useState(false);
	const [toolError, setToolError] = useState('');
	const [savingTheme, setSavingTheme] = useState<Theme>();
	const saveLock = useRef(false);
	const themeLock = useRef(false);
	const detectionRequest = useRef(0);
	const dirty = path !== state.settings.svnPath || tool !== state.settings.mergeTool;

	useEffect(() => {
		if (updateRequest) {
			setPage('general');
		}
	}, [updateRequest]);

	useEffect(() => {
		const request = ++detectionRequest.current;
		void api
			.call('detect', {})
			.then((value) => {
				if (request === detectionRequest.current) {
					setDetection(value);
				}
			})
			.catch((error) => {
				if (request === detectionRequest.current) {
					setDetection({ ok: false, path: '', version: '', error: errorText(error) });
				}
			});
		return () => {
			detectionRequest.current++;
		};
	}, []);

	async function save() {
		if (saveLock.current) {
			return;
		}
		saveLock.current = true;
		const request = ++detectionRequest.current;
		setBusy(true);
		setToolError('');
		try {
			onState(await api.call('settings', { svnPath: path, mergeTool: tool }));
			const detected = await api.call('detect', { path });
			if (request === detectionRequest.current) {
				setDetection(detected);
			}
			if (detected.ok) {
				toast.success('设置已保存');
			} else {
				toast.error(detected.error || 'SVN 检测未通过');
			}
		} catch (error) {
			setToolError(errorText(error));
			notifyError(error);
		} finally {
			saveLock.current = false;
			setBusy(false);
		}
	}

	async function changeTheme(theme: Theme) {
		if (themeLock.current || state.settings.theme === theme) {
			return;
		}
		themeLock.current = true;
		setSavingTheme(theme);
		try {
			onState(await api.call('settings', { theme }));
		} catch (error) {
			notifyError(error);
		} finally {
			themeLock.current = false;
			setSavingTheme(undefined);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="settings-dialog">
				<header className="settings-header">
					<DialogTitle className="dialog-title">设置</DialogTitle>
					<DialogDescription className="sr-only">管理语言、界面外观与本机 SVN 工具。</DialogDescription>
				</header>
				<div className="settings-layout">
					<div
						className="settings-navigation"
						role="tablist"
						aria-label="设置分类"
						aria-orientation="vertical"
						onKeyDown={(event) => {
							if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) {
								return;
							}
							event.preventDefault();
							const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
							const index = tabs.indexOf(event.target as HTMLButtonElement);
							const next =
								event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
							tabs[next]?.click();
							tabs[next]?.focus();
						}}
					>
						{pages.map(({ id: key, label, icon: Icon }) => (
							<Button
								key={key}
								id={`${id}-${key}-tab`}
								role="tab"
								variant="ghost"
								aria-controls={`${id}-${key}-panel`}
								aria-selected={page === key}
								tabIndex={page === key ? 0 : -1}
								onClick={() => setPage(key)}
							>
								<Icon aria-hidden="true" />
								{label}
							</Button>
						))}
					</div>
					<section className="settings-page" role="tabpanel" id={`${id}-${page}-panel`} aria-labelledby={`${id}-${page}-tab`} tabIndex={0}>
						{page === 'general' ? (
							<>
								<div className="settings-row">
									<div className="settings-row-copy">
										<h3>语言</h3>
										<p>当前仅支持简体中文，更多语言将在后续版本提供。</p>
									</div>
									<Combobox label="界面语言" value="zh-CN" options={[{ value: 'zh-CN', label: '简体中文' }]} onValueChange={() => undefined} disabled />
								</div>
								<div className="settings-row settings-appearance">
									<div className="settings-row-copy">
										<h3 id={`${id}-appearance`}>外观</h3>
										<p>选择喜欢的配色，整个工作空间即时切换。</p>
									</div>
									<div className="settings-themes" role="group" aria-labelledby={`${id}-appearance`}>
										{themes.map(({ id: value, label, description }) => (
											<Button
												key={value}
												variant="ghost"
												aria-label={label}
												aria-pressed={state.settings.theme === value}
												aria-busy={savingTheme === value || undefined}
												disabled={!!savingTheme}
												onClick={() => void changeTheme(value)}
											>
												<span className="theme-preview" data-theme={value} aria-hidden="true">
													<span className="theme-preview-chrome">
														<i />
														<i />
														<i />
													</span>
													<span className="theme-preview-sidebar">
														<i />
														<i />
														<i />
													</span>
													<span className="theme-preview-content">
														<i />
														<i />
														<i />
														<b />
													</span>
												</span>
												<span className="settings-theme-caption">
													<span>{label}</span>
													{savingTheme === value ? (
														<LoaderCircle className="spin" aria-hidden="true" />
													) : state.settings.theme === value ? (
														<Check aria-hidden="true" />
													) : null}
												</span>
												<span className="settings-theme-description">{description}</span>
											</Button>
										))}
									</div>
								</div>
								<AppUpdateSection focusRequest={updateRequest} />
							</>
						) : (
							<>
								{toolError && (
									<p className="settings-tool-error" role="alert">
										{toolError}
									</p>
								)}
								<div className="settings-row settings-tool">
									<div className="settings-row-copy">
										<h3>SVN 命令行工具</h3>
										<p>默认使用仓盒内置 SVN，也可指定本机的可执行文件。</p>
									</div>
									<label>
										可执行文件路径
										<input
											value={path}
											onChange={(event) => setPath(event.target.value)}
											placeholder="留空使用仓盒内置 SVN"
											disabled={busy}
											spellCheck={false}
										/>
									</label>
									<div className={`settings-detection ${detection?.ok ? 'good' : detection ? 'error-text' : 'muted'}`} role="status">
										{busy || !detection ? <LoaderCircle className="spin" /> : detection.ok ? <ShieldCheck /> : <CircleAlert />}
										<div>
											{busy || !detection ? '正在检测 SVN…' : detection.ok ? `Subversion ${detection.version}` : 'SVN 不可用'}
											{!busy && detection && <p>{detection.ok ? detection.path : detection.error}</p>}
										</div>
									</div>
								</div>
								<div className="settings-row settings-tool">
									<label>
										外部合并工具
										<input
											value={tool}
											onChange={(event) => setTool(event.target.value)}
											placeholder="例如 /Applications/Kaleidoscope.app"
											disabled={busy}
											spellCheck={false}
										/>
									</label>
									<p className="settings-help">用于打开冲突文件；保存后回到仓盒检查，再明确标记为已解决。普通差异比较使用 FileMerge。</p>
								</div>
							</>
						)}
					</section>
				</div>
				<footer className="settings-footer">
					<span>{dirty ? '工具页有未保存的更改' : page === 'general' ? '外观更改自动保存' : '工具配置保存在本机'}</span>
					<Button variant="outline" onClick={onClose}>
						关闭
					</Button>
					{page === 'tools' && (
						<Button disabled={busy} aria-busy={busy || undefined} onClick={() => void save()}>
							{busy && <LoaderCircle className="spin" />}保存并检测
						</Button>
					)}
				</footer>
			</DialogContent>
		</Dialog>
	);
}
