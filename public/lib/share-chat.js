// Public link for a chat: a frozen, script-free copy of the thread (same look as in the app) that the server publishes
// to the share host. Only messages are shared: no tool calls, no reasoning, no uploaded files.
import { api } from './api.js';
import { state } from './state.js';
import { h } from './dom.js';
import { groupTurns } from './turns.js';
import { userNode, assistantNode, parseUserContent } from './message-nodes.js';
import { allMessages, answerOf } from './export.js';
import { copyText } from './clipboard.js';
import { notify } from './ui.js';
import { sessionTitle } from './session-row.js';
import { t } from './i18n.js';

const KEEP = new Set(['A', 'ARTICLE', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DETAILS', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'I', 'IMG', 'LI', 'OL', 'P', 'PRE', 'SPAN', 'STRONG', 'SUMMARY', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'VIDEO', 'AUDIO', 'SOURCE', 'SVG', 'CANVAS', 'LINK', 'META', 'BASE', 'TEMPLATE']);
const ATTRS = new Set(['class', 'colspan', 'rowspan', 'alt', 'title', 'start']);
const SAFE_LINK = /^(https?:|mailto:)/i;
const SAFE_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,/i;

// Rebuilds the tree from an allow-list instead of removing what looks dangerous.
export function cleanNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
  if (node.nodeType !== Node.ELEMENT_NODE || DROP.has(node.tagName.toUpperCase()) || node.classList?.contains('meta') || node.hasAttribute('hidden')) return null;
  const tag = node.tagName.toUpperCase();
  if (tag === 'IMG') {
    const src = node.getAttribute('src') ?? '';
    if (!SAFE_IMAGE.test(src)) return node.alt ? document.createTextNode(`[${node.alt}]`) : null;
  }
  if (!KEEP.has(tag)) return fragmentOf(node);
  const copy = document.createElement(tag.toLowerCase());
  for (const { name, value } of node.attributes) if (ATTRS.has(name)) copy.setAttribute(name, value);
  if (tag === 'IMG') copy.setAttribute('src', node.getAttribute('src'));
  if (tag === 'A') {
    const href = node.getAttribute('href') ?? '';
    if (SAFE_LINK.test(href)) {
      copy.setAttribute('href', href);
      copy.setAttribute('rel', 'noopener noreferrer nofollow');
      copy.setAttribute('target', '_blank');
    }
  }
  for (const child of node.childNodes) {
    const cleaned = cleanNode(child);
    if (cleaned) copy.append(cleaned);
  }
  return copy;
}

function fragmentOf(node) {
  const fragment = document.createDocumentFragment();
  for (const child of node.childNodes) {
    const cleaned = cleanNode(child);
    if (cleaned) fragment.append(cleaned);
  }
  return fragment;
}

export function snapshotHtml(messages) {
  const host = document.createElement('div');
  for (const turn of groupTurns(messages)) {
    if (turn.user?.content) {
      const { text, files } = parseUserContent(turn.user.content);
      const bubble = userNode(text, null, []);
      if (files.length) bubble.prepend(h('div', {}, files.map((f) => h('span', { className: 'share-att' }, t('share.attachment', { name: f.name })))));
      if (text || files.length) host.append(bubble);
    }
    const answer = answerOf(turn);
    if (answer) host.append(assistantNode({ answer }));
  }
  const page = document.createElement('div');
  page.append(fragmentOf(host));
  return page.innerHTML.trim();
}

async function currentShares() {
  try { return (await api('/api/shares')).data ?? []; } catch { return []; }
}

export async function shareChat(session) {
  try {
    const messages = await allMessages(session.id);
    const body = snapshotHtml(messages);
    if (!body) return notify(t('share.error.empty'));
    const share = await api('/api/shares', { method: 'POST', body: { agent: state.agent, sessionId: session.id, title: sessionTitle(session), body } });
    await copyText(share.url);
    notify(t('share.done'));
  } catch (err) {
    notify(err.code === 'share_not_configured' ? t('share.error.setup') : err.message);
  }
}

async function stopSharing(token) {
  try {
    await api(`/api/shares/${encodeURIComponent(token)}`, { method: 'DELETE' });
    notify(t('share.stopped'));
  } catch (err) {
    notify(err.message);
  }
}

// Menu entries for one chat: create the link, or refresh / remove the one that exists.
export async function shareItems(session) {
  const existing = (await currentShares()).find((s) => s.sessionId === session.id);
  if (!existing) return [{ label: t('share.create'), icon: 'external-link', testid: 'share-create', action: () => shareChat(session) }];
  return [
    { label: t('share.update'), icon: 'external-link', testid: 'share-update', action: () => shareChat(session) },
    { label: t('share.stop'), icon: 'trash', destructive: true, testid: 'share-stop', action: () => stopSharing(existing.token) },
  ];
}
