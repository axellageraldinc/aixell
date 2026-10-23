// Deployment settings. Read once at import, from config.json (or config.jsonc) plus the
// HERMES_WEB_* environment variables; see src/config/loader.js and docs/configuration.md.
// The exported shape is unchanged from before P5a, so every caller keeps working.
import { loaded } from './config/instance.js';

export const config = loaded.config;

export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const SERVICE_TIERS = ['default', 'priority'];
