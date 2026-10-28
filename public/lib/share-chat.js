// Public link for a chat: a frozen, script-free copy of the thread (same look as in the app) that the server publishes
// to the share host. Only messages are shared: no tool calls, no reasoning, no uploaded files.
import { api } from './api.js';
import { state } from './state.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { segmented } from './segmented.js';
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

const LAST_KEY = 'aixell.share.expiry';
const PRESETS = ['1', '24', '168', '720'];
const rememberChoice = (choice, hours) => { try { localStorage.setItem(LAST_KEY, JSON.stringify({ choice, hours })); } catch { /* storage unavailable: nothing is remembered */ } };
const recallChoice = () => { try { return JSON.parse(localStorage.getItem(LAST_KEY)) ?? null; } catch { return null; } };

// What the expiry pills start on: the link's own expiry when it has one, else what was chosen last time, else one day.
function initialExpiry(share) {
  const last = share ? { choice: share.ttlHours == null ? 'never' : PRESETS.includes(String(share.ttlHours)) ? String(share.ttlHours) : 'custom', hours: share.ttlHours } : recallChoice();
  const choice = last && (PRESETS.includes(last.choice) || last.choice === 'never' || last.choice === 'custom') ? last.choice : '24';
  const hours = Number.isFinite(Number(last?.hours)) && Number(last.hours) >= 1 ? Math.round(Number(last.hours)) : 24;
  return { choice, hours };
}

async function currentShare(sessionId) {
  try { return ((await api('/api/shares')).data ?? []).find((s) => s.sessionId === sessionId) ?? null; } catch { return null; }
}

const fmtExpiry = (share) => (share.expiresAt ? t('share.expires', { date: new Date(share.expiresAt).toLocaleString() }) : t('share.neverExpires'));

// The dialog for one chat: create the link (with its expiry), copy it, publish a fresh snapshot, or take it down.
export async function openShareDialog(session) {
  if (!session?.id) return;
  const opener = document.activeElement;
  const shut = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); opener?.focus?.(); };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); shut(); } };
  const close = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('common.close'), onClick: shut }, icon('x', 18));
  const body = h('div', { className: 'dlg-body share-dlg' }, h('p', { className: 'dlg-note' }, t('common.loading')));
  const panel = h('div', { className: 'modal-box dlg-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('share.title'), 'data-testid': 'share-dialog' },
    h('div', { className: 'dlg-head' }, h('h2', {}, t('share.title')), h('span', { className: 'dlg-spacer' }), close), body);
  const overlay = h('div', { className: 'dlg modal modal-open' }, panel);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) shut(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);

  const draw = (share) => {
    // One tap for the usual choices; "Custom" opens a free hours field.
    const start = initialExpiry(share);
    let choice = start.choice;
    const hours = h('input', { type: 'number', className: 'input input-sm share-hours', min: 1, max: 87600, step: 1, value: start.hours, 'aria-label': t('share.hours'), 'data-testid': 'share-hours' });
    const custom = h('div', { className: 'dlg-row', hidden: choice !== 'custom' }, hours, h('span', { className: 'muted' }, t('share.hoursUnit')));
    const expiry = segmented({
      label: t('share.expiry'),
      options: [['1', t('share.opt.hour')], ['24', t('share.opt.day')], ['168', t('share.opt.week')], ['720', t('share.opt.month')], ['never', t('share.never')], ['custom', t('share.custom')]]
        .map(([value, label]) => ({ value, label, testid: `share-exp-${value}` })),
      onSelect: (value) => { choice = value; expiry.set(choice); custom.hidden = choice !== 'custom'; },
    });
    expiry.set(choice);
    const message = h('p', { className: 'dlg-note', role: 'status' });
    const publish = h('button', { type: 'button', className: 'btn btn-primary btn-sm', 'data-testid': 'share-publish' }, share ? t('share.update') : t('share.create'));
    publish.addEventListener('click', async () => {
      const ttlHours = choice === 'never' ? null : Number(choice === 'custom' ? hours.value : choice);
      if (ttlHours !== null && !(ttlHours >= 1 && ttlHours <= 87600)) return void (message.textContent = t('share.error.hours'));
      rememberChoice(choice, ttlHours);
      publish.disabled = true;
      message.textContent = t('common.loading');
      try {
        const messages = await allMessages(session.id);
        const html = snapshotHtml(messages);
        if (!html) throw new Error(t('share.error.empty'));
        const made = await api('/api/shares', { method: 'POST', body: { agent: state.agent, sessionId: session.id, title: sessionTitle(session), body: html, ttlHours } });
        await copyText(made.url);
        notify(t('share.done'));
        draw(made);
      } catch (err) {
        publish.disabled = false;
        message.textContent = err.code === 'share_not_configured' ? t('share.error.setup') : err.message;
      }
    });
    const rows = [h('p', { className: 'dlg-note' }, t('share.about'))];
    if (share) {
      const link = h('input', { type: 'text', readOnly: true, className: 'input input-sm share-link', value: share.url, 'aria-label': t('share.link'), 'data-testid': 'share-link' });
      link.addEventListener('focus', () => link.select());
      const copy = h('button', { type: 'button', className: 'btn btn-sm', onClick: async () => notify((await copyText(share.url)) ? t('share.copied') : t('common.copyFailed')) }, t('share.copy'));
      rows.push(h('div', { className: 'dlg-row' }, link, copy), h('p', { className: 'dlg-note', 'data-testid': 'share-status' }, fmtExpiry(share)));
    }
    rows.push(
      h('div', { className: 'share-field' }, h('span', { className: 'share-label' }, t('share.expiry')), expiry.el, custom),
      h('div', { className: 'dlg-row' }, publish, h('span', { className: 'dlg-spacer' }), share ? h('button', { type: 'button', className: 'btn btn-error btn-ghost btn-sm', 'data-testid': 'share-stop', onClick: async () => {
        try { await api(`/api/shares/${encodeURIComponent(share.token)}`, { method: 'DELETE' }); notify(t('share.stopped')); draw(null); } catch (err) { message.textContent = err.message; }
      } }, t('share.stop')) : null),
      message,
    );
    body.replaceChildren(...rows);
  };
  draw(await currentShare(session.id));
}
