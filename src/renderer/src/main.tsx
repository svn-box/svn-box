import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { svnQueries } from './queries/runtime';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Toaster } from './components/ui/sonner';
import { AuthenticationHost } from './components/AuthenticationHost';
import './styles.css';
import './styles/macos.css';
import './styles/settings.css';
import './styles/authentication.css';
import './styles/operations.css';

class ErrorBoundary extends React.Component<React.PropsWithChildren, { error: string }> {
	state = { error: '' };
	static getDerivedStateFromError(error: Error) {
		return { error: error.message };
	}
	render() {
		return this.state.error ? (
			<div className="fatal">
				<h1>界面遇到问题</h1>
				<p>{this.state.error}</p>
				<button onClick={() => location.reload()}>重新载入</button>
			</div>
		) : (
			this.props.children
		);
	}
}
createRoot(document.getElementById('root')!).render(
	<ErrorBoundary>
		<QueryClientProvider client={svnQueries.client}>
			<App />
			<AuthenticationHost />
			<Toaster />
		</QueryClientProvider>
	</ErrorBoundary>,
);
