// The process-wide configuration: read once, at import, like the old src/config.js did.
// src/config.js re-exports `config`; modules that need the validated settings (push subject,
// app name) import them from here so the file is read once.
import { loadConfig } from './loader.js';

export const loaded = loadConfig();
for (const warning of loaded.warnings) console.warn(`[config] ${warning}`);
export const config = loaded.config;
export const settings = loaded.settings;
