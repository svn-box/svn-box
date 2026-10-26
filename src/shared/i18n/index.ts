import { createInstance } from 'i18next';
import zhCN from './locales/zh-CN.json';
import en from './locales/en.json';

export const UI_LANGUAGE = 'zh-CN';
export const UI_LANGUAGES = ['zh-CN', 'en'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];
export const UI_RESOURCES = { 'zh-CN': { translation: zhCN }, en: { translation: en } };

export function isUiLanguage(value: unknown): value is UiLanguage {
	return UI_LANGUAGES.some((language) => language === value);
}

export function normalizeUiLanguage(value: unknown): UiLanguage {
	return isUiLanguage(value) ? value : UI_LANGUAGE;
}

export const uiI18n = createInstance();

// Both processes use bundled resources before schemas or the first render need them.
void uiI18n.init({
	lng: UI_LANGUAGE,
	fallbackLng: UI_LANGUAGE,
	supportedLngs: [...UI_LANGUAGES],
	load: 'currentOnly',
	resources: UI_RESOURCES,
	defaultNS: 'translation',
	initAsync: false,
	interpolation: { escapeValue: false, skipOnVariables: true },
	returnNull: false,
	returnEmptyString: false,
});

export const translate = uiI18n.t.bind(uiI18n);
