import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Toaster } from './components/ui/sonner';
import { AuthenticationHost } from './components/AuthenticationHost';
import './styles.css';

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
		<App />
		<AuthenticationHost />
		<Toaster />
	</ErrorBoundary>,
);
