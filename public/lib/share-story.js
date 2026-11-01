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
const TOP = 270;
const BOTTOM = H - 270;
const SIDE = 80;
const COLORS = { bg: '#161719', pill: '#2b2d31', text: '#ececf1', accent: '#2f6bff', muted: '#80858f', name: '#c5c8d0' };

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

// Plain AI-chat look (ChatGPT, Claude, Gemini): the prompt in a soft pill on the right, the answer as bare text under a
// small avatar and name. The largest font (down to 30 px) at which both fit between the two safe lines.
function layout(ctx, prompt, reply) {
  const pad = 40;
  const gap = 70;
  const head = 110; // avatar row above the answer
  const maxPill = W - SIDE * 2 - 120;
  for (let size = 56; size >= 30; size -= 2) {
    const lead = Math.round(size * 1.5);
    ctx.font = `400 ${size}px ${FONT}`;
    const u = wrap(ctx, prompt, maxPill - pad * 2);
    const a = wrap(ctx, reply, W - SIDE * 2);
    const uh = u.length * lead + pad * 2 - (lead - size) ;
    const ah = a.length * lead;
    const total = uh + gap + head + ah;
    if (total <= BOTTOM - TOP || size === 30) return { size, lead, pad, gap, head, u, a, uh, ah, total, maxPill };
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
  ctx.font = `400 ${m.size}px ${FONT}`;
  const uw = Math.min(m.maxPill, Math.max(...m.u.map((l) => ctx.measureText(l).width)) + m.pad * 2);
  let y = TOP + Math.max(0, (BOTTOM - TOP - m.total) / 2);

  // the prompt
  ctx.beginPath();
  ctx.roundRect(W - SIDE - uw, y, uw, m.uh, 44);
  ctx.fillStyle = COLORS.pill;
  ctx.fill();
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'left';
  m.u.forEach((line, i) => ctx.fillText(line, W - SIDE - uw + m.pad, y + m.pad + m.size + i * m.lead - m.size * 0.1));
  y += m.uh + m.gap;

  // the answer: avatar, name, then plain text
  const name = assistant || APP_NAME;
  ctx.beginPath();
  ctx.arc(SIDE + 30, y + 30, 30, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.accent;
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 32px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText([...name][0]?.toUpperCase() ?? '', SIDE + 30, y + 41);
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.name;
  ctx.font = `600 34px ${FONT}`;
  ctx.fillText(name, SIDE + 80, y + 42);
  y += m.head;
  ctx.fillStyle = COLORS.text;
  ctx.font = `400 ${m.size}px ${FONT}`;
  m.a.forEach((line, i) => ctx.fillText(line, SIDE, y + m.size + i * m.lead - m.size * 0.1));

  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.muted;
  ctx.font = `500 30px ${FONT}`;
  ctx.fillText(APP_NAME, W / 2, BOTTOM + 70);

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
