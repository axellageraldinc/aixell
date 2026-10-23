// YouTube channels: YouTube serves each channel as an Atom feed, so the RSS reader does the work.
// The type exists so Settings can name it and a later phase can add the API (keyed) variant.
import { fetchFeed } from './rss.js';

export const youtube = {
  type: 'youtube',
  title: 'YouTube channel',
  configSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', format: 'uri', description: 'The channel feed, e.g. https://www.youtube.com/feeds/videos.xml?channel_id=...' },
    },
  },
  credentials: [],
  defaultSchedule: { every: '30m' },
  cost: { kind: 'free' },
  fetch: (ctx) => fetchFeed(ctx),
};

export default youtube;
