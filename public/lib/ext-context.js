// When the app is shown in the aixell browser extension's side panel, the extension says which of its sessions is selected. Every request
// carries it, so a chat started here is tied to that session on the server (src/ext-chats.js). Outside the extension nothing is set.
let session = null;

export function setExtensionSession(value) {
  session = value && /^[A-Za-z0-9_-]{1,40}$/.test(String(value.id ?? '')) ? { id: String(value.id), name: String(value.name ?? '').slice(0, 40) } : null;
}

export function extensionHeaders() {
  return session ? { 'X-Aixell-Ext-Session': session.id, 'X-Aixell-Ext-Session-Name': encodeURIComponent(session.name) } : {};
}
