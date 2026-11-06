import { EN_MESSAGES } from './messages';

export type Locale = 'en' | 'zh-CN';
export type LanguagePreference = 'auto' | Locale;

let locale: Locale = 'zh-CN';

export function resolveLocale(preference: LanguagePreference, browserLanguage: string): Locale {
  return preference === 'auto'
    ? browserLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
    : preference;
}

export const getLocale = (): Locale => locale;
export const setLocale = (value: Locale): void => { locale = value; };

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = Object.entries(EN_MESSAGES)
  .filter(([key]) => /\{\d+\}/.test(key))
  .sort(([a], [b]) => b.replace(/\{\d+\}/g, '').length - a.replace(/\{\d+\}/g, '').length)
  .map(([key, english]) => ({
    pattern: new RegExp(`^${key.split(/\{\d+\}/).map(escapeRegex).join('(.*?)')}$`, 's'),
    english,
    compound: /[：；]/.test(key),
  }));
const punctuation: Record<string, string> = { '；': '; ', '：': ': ', '、': ', ', '（': ' (', '）': ')' };

/** Translate cached source messages at the presentation boundary, never in rate caches. */
function translate(message: string): string {
  if (locale === 'zh-CN') return message;
  if (!/\p{Script=Han}/u.test(message)) return message.replace(/[；：、（）]/g, (c) => punctuation[c]);
  if (EN_MESSAGES[message]) return EN_MESSAGES[message];
  for (const { pattern, english, compound } of patterns) {
    if (!compound && /[：；]/.test(message)) continue;
    const match = pattern.exec(message);
    if (match) return english.replace(/\{(\d+)\}/g, (_, n) => translate(match[Number(n) + 1]));
  }
  if (message.startsWith('⚠ ')) return `⚠ ${translate(message.slice(2))}`;
  // Source details can combine independent messages. Preserve unknown upstream names.
  const parts = message.split(/(；|：|、|\n| \+ | · |（|）)/);
  if (parts.length === 1) return message;
  return parts.map((part) => punctuation[part] ?? translate(part)).join('');
}

/** Format a source template, or translate a preformatted message from the worker. */
export function tr(message: string, ...values: unknown[]): string {
  if (!values.length) return translate(message);
  const template = locale === 'en' ? EN_MESSAGES[message] ?? message : message;
  return template.replace(/\{(\d+)\}/g, (_, n) => translate(String(values[Number(n)])));
}
