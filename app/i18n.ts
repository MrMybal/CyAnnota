export type AppLocale = 'en' | 'fr';

export const DEFAULT_LOCALE: AppLocale = 'en';
export const LOCALE_STORAGE_KEY = 'cyannota.locale';

export function isAppLocale(value: unknown): value is AppLocale {
  return value === 'en' || value === 'fr';
}

export function translate(locale: AppLocale, english: string, french: string) {
  return locale === 'fr' ? french : english;
}

export function localeLabel(locale: AppLocale) {
  return locale === 'fr' ? 'Français' : 'English';
}
