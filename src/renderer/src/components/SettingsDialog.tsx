import { useTranslation } from 'react-i18next';
import { isUiLanguage, translate, UI_LANGUAGE, type UiLanguage } from '../../../shared/i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { Check, CircleAlert, LoaderCircle, Settings, ShieldCheck, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { themes } from '../../../shared/themes';
import type { AppState, Detection, Theme } from '../../../shared/types';
import { api, errorText } from '../lib/api';
import { notifyError } from '../lib/feedback';
import type { WorkspaceCatalog } from '../state/workspace-store';
import { Button } from './ui/button';
import { Select } from './ui/select';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { AppUpdateSection } from './AppUpdateSection';
const pages = [
	{
		id: 'general',

		get label() {
			return translate('settings.general');
		},

		icon: Settings,
	},
	{
		id: 'tools',

		get label() {
			return translate('settings.tools');
		},

		icon: Wrench,
	},
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
	const { t, i18n } = useTranslation();
	const id = useId();
	const [page, setPage] = useState<(typeof pages)[number]['id']>('general');
	const [path, setPath] = useState(state.settings.svnPath);
	const [tool, setTool] = useState(state.settings.mergeTool);
	const [detection, setDetection] = useState<Detection>();
	const [busy, setBusy] = useState(false);
	const [toolError, setToolError] = useState('');
	const [savingTheme, setSavingTheme] = useState<Theme>();
	const [savingLanguage, setSavingLanguage] = useState(false);
	const saveLock = useRef(false);
	const themeLock = useRef(false);
	const languageLock = useRef(false);
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
				toast.success(t('settingsDialog.settingsSaved'));
			} else {
				toast.error(detected.error || t('settingsDialog.svnDetectionFailed'));
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

	async function changeLanguage(language: UiLanguage) {
		if (languageLock.current || i18n.resolvedLanguage === language) {
			return;
		}
		languageLock.current = true;
		setSavingLanguage(true);
		try {
			onState(await api.call('settings', { language }));
		} catch (error) {
			notifyError(error);
		} finally {
			languageLock.current = false;
			setSavingLanguage(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="settings-dialog">
				<header className="settings-header">
					<DialogTitle className="dialog-title">{t('common.settings')}</DialogTitle>
					<DialogDescription className="sr-only">{t('settingsDialog.manageLanguageAppearanceAndLocalSvnTools')}</DialogDescription>
				</header>
				<div className="settings-layout">
					<div
						className="settings-navigation"
						role="tablist"
						aria-label={t('settingsDialog.settingsCategories')}
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
										<h3>{t('settings.language')}</h3>
										<p>{t('settings.languageHint')}</p>
									</div>
									<Select
										label={t('settings.languageSelector')}
										value={i18n.resolvedLanguage ?? UI_LANGUAGE}
										options={[
											{
												value: 'zh-CN',
												label: t('settings.languageChinese'),
											},
											{ value: 'en', label: t('settings.languageEnglish') },
										]}
										onValueChange={(language) => {
											if (isUiLanguage(language)) {
												void changeLanguage(language);
											}
										}}
										disabled={savingLanguage}
									/>
								</div>
								<div className="settings-row settings-appearance">
									<div className="settings-row-copy">
										<h3 id={`${id}-appearance`}>{t('settingsDialog.appearance')}</h3>
										<p>{t('settingsDialog.chooseAColorThemeForTheEntireWorkspace')}</p>
									</div>
									<div className="settings-themes" role="group" aria-labelledby={`${id}-appearance`}>
										{themes.map(({ id: value }) => (
											<Button
												key={value}
												variant="ghost"
												aria-label={t(`themes.${value}.label`)}
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
													<span>{t(`themes.${value}.label`)}</span>
													{savingTheme === value ? (
														<LoaderCircle className="spin" aria-hidden="true" />
													) : state.settings.theme === value ? (
														<Check aria-hidden="true" />
													) : null}
												</span>
												<span className="settings-theme-description">{t(`themes.${value}.description`)}</span>
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
										<h3>{t('settingsDialog.svnCommandLineTool')}</h3>
										<p>{t('settingsDialog.useTheBundledSvnClientOrSelectA')}</p>
									</div>
									<label>
										{t('settingsDialog.executablePath')}
										<input
											value={path}
											onChange={(event) => setPath(event.target.value)}
											placeholder={t('settingsDialog.leaveBlankToUseBundledSvn')}
											disabled={busy}
											spellCheck={false}
										/>
									</label>
									<div className={`settings-detection ${detection?.ok ? 'good' : detection ? 'error-text' : 'muted'}`} role="status">
										{busy || !detection ? <LoaderCircle className="spin" /> : detection.ok ? <ShieldCheck /> : <CircleAlert />}
										<div>
											{busy || !detection
												? t('settingsDialog.detectingSvn')
												: detection.ok
													? `Subversion ${detection.version}`
													: t('settingsDialog.svnUnavailable')}
											{!busy && detection && <p>{detection.ok ? detection.path : detection.error}</p>}
										</div>
									</div>
								</div>
								<div className="settings-row settings-tool">
									<label>
										{t('settingsDialog.externalMergeTool')}
										<input
											value={tool}
											onChange={(event) => setTool(event.target.value)}
											placeholder={t('settingsDialog.forExampleApplicationsKaleidoscopeApp')}
											disabled={busy}
											spellCheck={false}
										/>
									</label>
									<p className="settings-help">{t('settingsDialog.useItToMergeConflictFilesSaveReturn')}</p>
								</div>
							</>
						)}
					</section>
				</div>
				<footer className="settings-footer">
					<span>
						{dirty
							? t('settingsDialog.unsavedChangesOnTheToolsPage')
							: page === 'general'
								? t('settingsDialog.appearanceChangesSaveAutomatically')
								: t('settingsDialog.toolSettingsAreStoredOnThisMac')}
					</span>
					<Button variant="outline" onClick={onClose}>
						{t('common.close')}
					</Button>
					{page === 'tools' && (
						<Button disabled={busy} aria-busy={busy || undefined} onClick={() => void save()}>
							{busy && <LoaderCircle className="spin" />}
							{t('settingsDialog.saveAndDetect')}
						</Button>
					)}
				</footer>
			</DialogContent>
		</Dialog>
	);
}
