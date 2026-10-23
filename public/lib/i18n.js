// Tiny i18n layer: flat keys, {name} placeholders, one shipped locale.
// Other languages can be added later as public/locales/<code>.js files and activated with setMessages(); nothing here
// fetches or waits, and no translation is ever treated as HTML.
import en from '../locales/en.js';

let messages = {};
const warned = new Set();

// Replaces the active messages. Called once at start-up with the shipped locale.
export function setMessages(obj) {
  messages = obj && typeof obj === 'object' ? obj : {};
}

// The active locale. English is the only shipped one for now.
export function locale() {
  return 'en';
}

// Looks a key up and fills {name} placeholders from params. A missing key is returned as-is and warned about once.
export function t(key, params) {
  const message = messages[key];
  if (typeof message !== 'string') {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`i18n: missing key "${key}"`);
    }
    return key;
  }
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

setMessages(en);
