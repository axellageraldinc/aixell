// "Share as story": one prompt and its reply drawn as a 1080x1920 picture (a chat on a flat card) and handed to the system
// Share sheet, where Instagram is on phones, or downloaded. A long exchange is first shortened by the server (src/story.js);
// the person can edit both texts before sharing.
import { api, agentPath } from './api.js';
import { state } from './state.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { notify } from './ui.js';
import { t } from './i18n.js';
import { APP_NAME } from './brand.js';
import { agentLabel } from './format.js';

const W = 1080;
const H = 1920;
const FONT = '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
// Instagram draws its own bar over the top and the reply box over the bottom: nothing important goes there.
const TOP = 250;
const BOTTOM = H - 250;
const SIDE = 80;
const COLORS = { bg: '#2748e0', card: '#14161b', text: '#f3f4f7', accent: '#7f9bff', muted: '#a3a9b6', rule: '#2a2e38' };

// Greedy word wrap; a word longer than the line is broken by letters.
export function wrap(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= maxWidth) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      while (ctx.measureText(line).width > maxWidth && line.length > 1) {
        let n = line.length - 1;
        while (n > 1 && ctx.measureText(line.slice(0, n)).width > maxWidth) n -= 1;
        lines.push(line.slice(0, n));
        line = line.slice(n);
      }
    }
    lines.push(line);
  }
  return lines;
}

// The look of the "share to story" cards of Spotify, Netflix and Prime Video: a flat brand-colour background, one big rounded
// card in the middle that holds the content (the sticker), and the brand mark above and below it, all clear of the strips
// Instagram covers. Inside the card the prompt is the headline and the reply is plain text under an avatar and name.
const CARD_X = 64;
const CARD_W = W - CARD_X * 2;
const PAD = 60;
const INNER = CARD_W - PAD * 2;
const BRAND_H = 110; // brand row above the card
const FOOT_H = 100; // line below the card

// The largest font (down to 28 px) at which the whole card fits between the two safe lines.
function layout(ctx, prompt, reply) {
  const avail = BOTTOM - TOP - BRAND_H - FOOT_H;
  for (let size = 54; size >= 28; size -= 2) {
    const lead = Math.round(size * 1.45);
    const pSize = Math.round(size * 1.12);
    const pLead = Math.round(pSize * 1.3);
    ctx.font = `700 ${pSize}px ${FONT}`;
    const p = wrap(ctx, prompt, INNER);
    ctx.font = `400 ${size}px ${FONT}`;
    const r = wrap(ctx, reply, INNER);
    const label = 50;
    const head = 96;
    const rule = 56;
    const total = PAD + label + p.length * pLead + rule + head + r.length * lead + PAD;
    if (total <= avail || size === 28) return { size, lead, pSize, pLead, p, r, label, head, rule, total };
  }
  return null;
}

export function renderStory({ prompt, reply, assistant }) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx || !prompt?.trim() || !reply?.trim()) return Promise.reject(new Error('nothing to draw'));
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  const m = layout(ctx, prompt.trim(), reply.trim());
  const block = BRAND_H + m.total + FOOT_H;
  const top = TOP + Math.max(0, (BOTTOM - TOP - block) / 2);

  // brand row: a round mark and the name, on the background colour
  ctx.beginPath();
  ctx.arc(W / 2 - 78, top + 42, 22, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.card;
  ctx.fill();
  ctx.fillStyle = COLORS.bg;
  ctx.font = `800 26px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(APP_NAME[0].toUpperCase(), W / 2 - 78, top + 51);
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 40px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(APP_NAME, W / 2 - 44, top + 56);

  // the card
  let y = top + BRAND_H;
  ctx.beginPath();
  ctx.roundRect(CARD_X, y, CARD_W, m.total, 64);
  ctx.fillStyle = COLORS.card;
  ctx.fill();
  const x = CARD_X + PAD;
  y += PAD;

  ctx.fillStyle = COLORS.accent;
  ctx.font = `700 26px ${FONT}`;
  ctx.fillText(t('story.you').toUpperCase(), x, y + 26);
  y += m.label;
  ctx.fillStyle = COLORS.text;
  ctx.font = `700 ${m.pSize}px ${FONT}`;
  m.p.forEach((line, i) => ctx.fillText(line, x, y + m.pSize + i * m.pLead - m.pSize * 0.1));
  y += m.p.length * m.pLead;

  ctx.fillStyle = COLORS.rule;
  ctx.fillRect(x, y + m.rule / 2 - 1, INNER, 2);
  y += m.rule;

  const name = assistant || APP_NAME;
  ctx.beginPath();
  ctx.arc(x + 31, y + 31, 31, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.bg;
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 32px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText([...name][0]?.toUpperCase() ?? '', x + 31, y + 42);
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.muted;
  ctx.font = `600 34px ${FONT}`;
  ctx.fillText(name, x + 84, y + 43);
  y += m.head;
  ctx.fillStyle = COLORS.text;
  ctx.font = `400 ${m.size}px ${FONT}`;
  m.r.forEach((line, i) => ctx.fillText(line, x, y + m.size + i * m.lead - m.size * 0.1));

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `600 32px ${FONT}`;
  ctx.fillText(t('story.tagline'), W / 2, top + BRAND_H + m.total + 72);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve({ blob: b, canvas }) : reject(new Error('could not render the image'))), 'image/png'));
}

// Opens the share sheet where files are supported, else downloads the picture.
export async function shareImage(blob) {
  const file = new File([blob], `${APP_NAME}-story.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

// The dialog: shortens the exchange, shows the picture, lets the person edit the two texts, then shares.
export async function openStoryDialog({ prompt, reply }) {
  const opener = document.activeElement;
  const shut = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); opener?.focus?.(); };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); shut(); } };
  const close = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('common.close'), onClick: shut }, icon('x', 18));
  const body = h('div', { className: 'dlg-body story-dlg' }, h('p', { className: 'dlg-note' }, t('story.shortening')));
  const panel = h('div', { className: 'modal-box dlg-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('story.title'), 'data-testid': 'story-dialog' },
    h('div', { className: 'dlg-head' }, h('h2', {}, t('story.title')), h('span', { className: 'dlg-spacer' }), close), body);
  const overlay = h('div', { className: 'dlg modal modal-open' }, panel);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) shut(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);

  let text;
  try {
    text = await api(`${agentPath(state.agent)}/story`, { method: 'POST', body: { prompt, reply } });
  } catch (err) {
    body.replaceChildren(h('p', { className: 'dlg-note', role: 'alert' }, err.message));
    return;
  }
  const you = h('textarea', { className: 'textarea story-text', rows: 3, maxLength: 400, 'aria-label': t('story.you'), 'data-testid': 'story-prompt' }, text.prompt);
  const bot = h('textarea', { className: 'textarea story-text', rows: 6, maxLength: 800, 'aria-label': t('story.reply'), 'data-testid': 'story-reply' }, text.reply);
  const preview = h('div', { className: 'story-preview', 'data-testid': 'story-preview' });
  const message = h('p', { className: 'dlg-note', role: 'status' }, text.shortened ? t('story.shortened') : '');
  const go = h('button', { type: 'button', className: 'btn btn-primary btn-sm', 'data-testid': 'story-share' }, t('story.share'));
  let made = null;
  let timer = 0;
  const draw = async () => {
    try {
      made = await renderStory({ prompt: you.value, reply: bot.value, assistant: agentLabel(state.agent) });
      made.canvas.className = 'story-canvas';
      preview.replaceChildren(made.canvas);
      go.disabled = false;
    } catch { made = null; go.disabled = true; }
  };
  const redraw = () => { clearTimeout(timer); timer = setTimeout(draw, 200); };
  you.addEventListener('input', redraw);
  bot.addEventListener('input', redraw);
  go.addEventListener('click', async () => {
    if (!made) return;
    go.disabled = true;
    try {
      const result = await shareImage(made.blob);
      if (result === 'downloaded') notify(t('story.downloaded'));
      if (result !== 'cancelled') shut();
    } catch (err) { message.textContent = err.message; }
    go.disabled = false;
  });
  body.replaceChildren(
    preview,
    h('div', { className: 'share-field' }, h('span', { className: 'share-label' }, t('story.you')), you),
    h('div', { className: 'share-field' }, h('span', { className: 'share-label' }, t('story.reply')), bot),
    message,
    h('div', { className: 'dlg-row' }, go),
  );
  draw();
}
