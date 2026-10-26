import { normalizeUiLanguage, uiI18n, type UiLanguage } from '../../shared/i18n';
import React from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { QueryClientProvider } from '@tanstack/react-query';
import { svnQueries } from './queries/runtime';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Toaster } from './components/ui/sonner';
import { AuthenticationHost } from './components/AuthenticationHost';
import { api } from './lib/api';
import './styles.css';
import './styles/macos.css';
import './styles/settings.css';
import './styles/authentication.css';
import './styles/operations.css';
import './styles/file-versions.css';
class ErrorBoundary extends React.Component<React.PropsWithChildren, { error: string }> {
	state = { error: '' };

	static getDerivedStateFromError(error: Error) {
		return { error: error.message };
	}

	render() {
		return this.state.error ? <FatalError error={this.state.error} /> : this.props.children;
	}
}

function FatalError({ error }: { error: string }) {
	const { t } = useTranslation();
	return (
		<div className="fatal">
			<h1>{t('main.somethingWentWrong')}</h1>
			<p>{error}</p>
			<button onClick={() => location.reload()}>{t('main.reload')}</button>
		</div>
	);
}

async function applyLanguage(language: UiLanguage): Promise<void> {
	await uiI18n.changeLanguage(language);
	document.documentElement.lang = language;
}

async function start(): Promise<void> {
	let languageRevision = 0;
	const unsubscribe = api.onLanguage((language) => {
		languageRevision++;
		void applyLanguage(language);
	});
	window.addEventListener('beforeunload', unsubscribe, { once: true });
	const revision = languageRevision;
	const state = await api.call('state', undefined).catch(() => undefined);
	if (revision === languageRevision) {
		await applyLanguage(normalizeUiLanguage(state?.settings.language));
	}
	createRoot(document.getElementById('root')!).render(
		<I18nextProvider i18n={uiI18n}>
			<ErrorBoundary>
				<QueryClientProvider client={svnQueries.client}>
					<App />
					<AuthenticationHost />
					<Toaster />
				</QueryClientProvider>
			</ErrorBoundary>
		</I18nextProvider>,
	);
}

void start();
