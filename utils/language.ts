import { resolveLocale, setLocale, type LanguagePreference } from './i18n';

export const LANGUAGE_KEY = 'dal:language';

export function languagePreference(value: unknown): LanguagePreference {
  return value === 'en' || value === 'zh-CN' ? value : 'auto';
}

export async function saveLanguage(preference: LanguagePreference): Promise<void> {
  await browser.storage.sync.set({ [LANGUAGE_KEY]: preference });
}

/** Shared popup/content preference. Repaint cached data when the language changes. */
export async function watchLanguage(
  render: (preference: LanguagePreference) => void,
): Promise<() => void> {
  const apply = (value: unknown) => {
    const preference = languagePreference(value);
    setLocale(resolveLocale(preference, navigator.language));
    render(preference);
  };
  const stored = await browser.storage.sync.get(LANGUAGE_KEY);
  apply(stored[LANGUAGE_KEY]);
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'sync' && LANGUAGE_KEY in changes) apply(changes[LANGUAGE_KEY].newValue);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
