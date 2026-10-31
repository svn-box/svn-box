import { useEffect, useState } from 'react';
import { Toaster as Sonner } from 'sonner';
import { CircleCheck, CircleAlert, Info, LoaderCircle, TriangleAlert } from 'lucide-react';

export function Toaster() {
	const [dark, setDark] = useState(document.documentElement.classList.contains('dark'));
	useEffect(() => {
		const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
		return () => observer.disconnect();
	}, []);
	return (
		<Sonner
			theme={dark ? 'dark' : 'light'}
			position="top-center"
			closeButton
			visibleToasts={3}
			offset={{ top: 'calc(var(--titlebar-height) + 12px)' }}
			icons={{
				success: <CircleCheck size={17} />,
				error: <CircleAlert size={17} />,
				warning: <TriangleAlert size={17} />,
				info: <Info size={17} />,
				loading: <LoaderCircle size={17} className="spin" />,
			}}
			toastOptions={{
				className: 'app-toast',
				style: { background: 'var(--raised)', color: 'var(--text)', border: '1px solid var(--border)', fontFamily: 'var(--font-sans)', fontSize: 12 },
				duration: 4500,
			}}
		/>
	);
}
