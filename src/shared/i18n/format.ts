import { uiI18n, UI_LANGUAGE } from './index';

type DateValue = string | number | Date;

export function currentLocale(): string {
	return uiI18n.resolvedLanguage ?? UI_LANGUAGE;
}

export function formatDate(value: DateValue, options?: Intl.DateTimeFormatOptions): string {
	return new Date(value).toLocaleDateString(currentLocale(), options);
}

export function formatDateTime(value: DateValue, options?: Intl.DateTimeFormatOptions): string {
	return new Date(value).toLocaleString(currentLocale(), options);
}

export function formatTime(value: DateValue, options?: Intl.DateTimeFormatOptions): string {
	return new Date(value).toLocaleTimeString(currentLocale(), options);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
	return new Intl.NumberFormat(currentLocale(), options).format(value);
}

export function formatBytes(value: number): string {
	const unit = value >= 1024 ** 3 ? 'GB' : value >= 1024 ** 2 ? 'MB' : value >= 1024 ? 'KB' : 'B';
	const divisor = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1;
	return `${formatNumber(value / divisor, { maximumFractionDigits: unit === 'B' ? 0 : 1 })} ${unit}`;
}
