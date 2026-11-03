// "Ask the agent about this story": the one place that writes a feed story into a chat message (see untrusted.js).
import { t } from './i18n.js';
import { untrustedBlock } from './untrusted.js';

export const askText = (story) => `${t('feed.ask.prompt')}\n\n${untrustedBlock({ title: story.original || story.title, url: story.url }, t('feed.ask.untrusted'))}`;
