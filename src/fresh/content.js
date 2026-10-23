// The content settings of the feed: the language the cards are written in, the writer limits and
// the category list as the prompts see it.
//
//   fresh.content { language, languageCode, locale }   defaults English / en / en-US
//   fresh.writer  { titleMax, summaryMaxWords, whyMaxWords }
//
// The UI language is a separate axis (see public/locales/): this is the language of the cards.
import { config } from '../config.js';
import { CATEGORY_DEFS } from './profile.js';

export const CONTENT_DEFAULTS = { language: 'English', languageCode: 'en', locale: 'en-US' };
export const WRITER_DEFAULTS = { titleMax: 90, summaryMaxWords: 55, whyMaxWords: 18 };

export const content = () => ({ ...CONTENT_DEFAULTS, ...(config.fresh?.content ?? {}) });
export const writerLimits = () => ({ ...WRITER_DEFAULTS, ...(config.fresh?.writer ?? {}) });
export const language = () => content().language;

// "id: label (meaning)" lines for the classifier and the writer, in the configured order.
export function categoriesText() {
  return CATEGORY_DEFS.map((category) => `${category.id}: ${category.label}`).join('\n');
}

// The JSON keys the writer answers with. Kept in one place: the prompt shows them, the parser reads them.
export const CARD_SCHEMA = '{"id":"...","title":"...","summary":"...","why":"...","topics":["..."],"substance":true}';
