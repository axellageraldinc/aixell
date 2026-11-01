// "Share as story": a few turns of a chat (each a prompt and its reply) drawn as a 1080x1920 picture and handed to the system
// Share sheet, where Instagram is on phones, or downloaded. The turns are first condensed by the server (src/story.js); the
// person can edit the texts by hand or ask the AI to change them before sharing.
import { api, agentPath } from './api.js';
import { groupTurns } from './turns.js';
import { parseUserContent } from './message-nodes.js';
import { allMessages, answerOf } from './export.js';
import { state } from './state.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { segmented } from './segmented.js';
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
const COLORS = { bg: '#2b5ce6', card: '#14161b', text: '#f3f4f7', accent: '#7f9bff', muted: '#a3a9b6', rule: '#2a2e38' };

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
// Instagram covers. Inside the card each turn is a bold prompt over a plain reply, under one avatar and name.
const CARD_X = 64;
const CARD_W = W - CARD_X * 2;
const PAD = 60;
const INNER = CARD_W - PAD * 2;
const BRAND_H = 110; // brand row above the card
const FOOT_H = 100; // line below the card
const LABEL = 50; // "YOU" above the first prompt
const HEAD = 96; // avatar row above the first reply
const RULE = 56; // between a prompt and its reply
const TURN_GAP = 64; // between two turns

// The largest font (down to 24 px) at which the whole card fits between the two safe lines.
function layout(ctx, turns) {
  const avail = BOTTOM - TOP - BRAND_H - FOOT_H;
  for (let size = 54; size >= 24; size -= 2) {
    const lead = Math.round(size * 1.45);
    const pSize = Math.round(size * 1.12);
    const pLead = Math.round(pSize * 1.3);
    const rows = turns.map((turn) => {
      ctx.font = `700 ${pSize}px ${FONT}`;
      const p = wrap(ctx, turn.prompt.trim(), INNER);
      ctx.font = `400 ${size}px ${FONT}`;
      return { p, r: wrap(ctx, turn.reply.trim(), INNER) };
    });
    const total = PAD * 2 + LABEL + HEAD + (rows.length - 1) * TURN_GAP + rows.reduce((sum, row) => sum + row.p.length * pLead + RULE + row.r.length * lead, 0);
    if (total <= avail || size === 24) return { size, lead, pSize, pLead, rows, total };
  }
  return null;
}

export function renderStory({ turns, assistant }) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const usable = (turns ?? []).filter((x) => x.prompt?.trim() && x.reply?.trim());
  if (!ctx || !usable.length) return Promise.reject(new Error('nothing to draw'));
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  const m = layout(ctx, usable);
  const block = BRAND_H + m.total + FOOT_H;
  const top = TOP + Math.max(0, (BOTTOM - TOP - block) / 2);

  // brand row: the logo (white tile on the brand colour) and the name
  ctx.font = `800 44px ${FONT}`;
  const nameW = ctx.measureText(APP_NAME).width;
  const logoSize = 64;
  const rowW = logoSize + 20 + nameW;
  logo(ctx, W / 2 - rowW / 2, top + 10, logoSize, '#ffffff', COLORS.bg);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.fillText(APP_NAME, W / 2 - rowW / 2 + logoSize + 20, top + 10 + 47);

  // the card
  let y = top + BRAND_H;
  ctx.beginPath();
  ctx.roundRect(CARD_X, y, CARD_W, m.total, 64);
  ctx.fillStyle = COLORS.card;
  ctx.fill();
  const x = CARD_X + PAD;
  y += PAD;
  const name = assistant || APP_NAME;

  m.rows.forEach((row, i) => {
    if (i === 0) {
      ctx.fillStyle = COLORS.accent;
      ctx.font = `700 26px ${FONT}`;
      ctx.fillText(t('story.you').toUpperCase(), x, y + 26);
      y += LABEL;
    }
    ctx.fillStyle = COLORS.text;
    ctx.font = `700 ${m.pSize}px ${FONT}`;
    row.p.forEach((line, k) => ctx.fillText(line, x, y + m.pSize + k * m.pLead - m.pSize * 0.1));
    y += row.p.length * m.pLead;

    ctx.fillStyle = COLORS.rule;
    ctx.fillRect(x, y + RULE / 2 - 1, INNER, 2);
    y += RULE;

    if (i === 0) {
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
      y += HEAD;
    }
    ctx.fillStyle = COLORS.text;
    ctx.font = `400 ${m.size}px ${FONT}`;
    row.r.forEach((line, k) => ctx.fillText(line, x, y + m.size + k * m.lead - m.size * 0.1));
    y += row.r.length * m.lead + (i < m.rows.length - 1 ? TURN_GAP : 0);
  });

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `600 32px ${FONT}`;
  ctx.fillText(t('story.tagline'), W / 2, top + BRAND_H + m.total + 72);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve({ blob: b, canvas }) : reject(new Error('could not render the image'))), 'image/png'));
}

// The aixell mark (public/favicon.svg) drawn directly: a rounded tile with an "a" made of a ring, a stem and a dot.
function logo(ctx, x, y, size, tile, ink) {
  const k = size / 32;
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, 8 * k);
  ctx.fillStyle = tile;
  ctx.fill();
  ctx.save();
  ctx.translate(x, y + 2.5 * k);
  ctx.scale(k, k);
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(16, 16.3, 6.2, 0, Math.PI * 2);
  ctx.moveTo(22.2, 10.1);
  ctx.lineTo(22.2, 22.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(22.2, 4.9, 1.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
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

// The turns of a chat that can go on a story: a user message with the agent's answer. Newest last.
export async function storyTurns(sessionId) {
  const out = [];
  for (const turn of groupTurns(await allMessages(sessionId))) {
    const prompt = turn.user?.content ? parseUserContent(turn.user.content).text.trim() : '';
    const reply = answerOf(turn);
    if (prompt && reply) out.push({ prompt, reply });
  }
  return out;
}

const MAX_TURNS = 5; // keep in step with src/story.js

// The dialog, in two steps: pick the turns, then shorten them, preview the picture, edit by hand or ask the AI, and share.
export async function openStoryDialog(session) {
  if (!session?.id) return;
  const opener = document.activeElement;
  const shut = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); opener?.focus?.(); };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); shut(); } };
  const close = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('common.close'), onClick: shut }, icon('x', 18));
  const body = h('div', { className: 'dlg-body story-dlg' }, h('p', { className: 'dlg-note' }, t('common.loading')));
  const panel = h('div', { className: 'modal-box dlg-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('story.title'), 'data-testid': 'story-dialog' },
    h('div', { className: 'dlg-head' }, h('h2', {}, t('story.title')), h('span', { className: 'dlg-spacer' }), close), body);
  const overlay = h('div', { className: 'dlg modal modal-open' }, panel);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) shut(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);

  let all;
  try { all = await storyTurns(session.id); } catch (err) { body.replaceChildren(h('p', { className: 'dlg-note', role: 'alert' }, err.message)); return; }
  if (!all.length) { body.replaceChildren(h('p', { className: 'dlg-note' }, t('story.empty'))); return; }
  pick(all.length - 1);

  // Step 1: which turns.
  function pick(first) {
    const boxes = all.map((turn, i) => {
      const box = h('input', { type: 'checkbox', className: 'checkbox checkbox-sm', checked: i === first, 'aria-label': t('story.turn', { n: i + 1 }), 'data-testid': `story-turn-${i}` });
      return box;
    });
    const note = h('p', { className: 'dlg-note', role: 'status' });
    const next = h('button', { type: 'button', className: 'btn btn-primary btn-sm', 'data-testid': 'story-continue' }, t('story.continue'));
    const chosen = () => all.filter((_, i) => boxes[i].checked);
    const sync = () => {
      const n = chosen().length;
      note.textContent = n > MAX_TURNS ? t('story.tooMany', { max: MAX_TURNS }) : t('story.picked', { n });
      next.disabled = n < 1 || n > MAX_TURNS;
    };
    boxes.forEach((box) => box.addEventListener('change', sync));
    const rows = all.map((turn, i) => h('label', { className: 'story-pick' }, boxes[i],
      h('span', { className: 'story-pick-text' }, h('b', {}, turn.prompt.slice(0, 90)), h('small', {}, turn.reply.slice(0, 110)))));
    next.addEventListener('click', () => edit(chosen()));
    body.replaceChildren(h('p', { className: 'dlg-note' }, t('story.pick', { max: MAX_TURNS })), h('div', { className: 'story-picks' }, rows), note, h('div', { className: 'dlg-row' }, next));
    sync();
    boxes[first]?.closest('label')?.scrollIntoView?.({ block: 'nearest' });
  }

  // Step 2: shorten, preview, edit.
  async function edit(chosen) {
    body.replaceChildren(h('p', { className: 'dlg-note' }, t('story.shortening')));
    let text;
    try {
      text = await api(`${agentPath(state.agent)}/story`, { method: 'POST', body: { turns: chosen } });
    } catch (err) {
      body.replaceChildren(h('p', { className: 'dlg-note', role: 'alert' }, err.message), h('div', { className: 'dlg-row' }, h('button', { type: 'button', className: 'btn btn-sm', onClick: () => pick(all.length - 1) }, t('story.back'))));
      return;
    }
    const fields = text.turns.map((turn, i) => ({
      you: h('textarea', { className: 'textarea story-text', rows: 2, maxLength: 400, 'aria-label': `${t('story.you')} ${i + 1}`, 'data-testid': `story-prompt-${i}` }, turn.prompt),
      bot: h('textarea', { className: 'textarea story-text', rows: 4, maxLength: 800, 'aria-label': `${t('story.reply')} ${i + 1}`, 'data-testid': `story-reply-${i}` }, turn.reply),
    }));
    const current = () => fields.map((f) => ({ prompt: f.you.value, reply: f.bot.value }));
    const fill = (turns) => turns.forEach((turn, i) => { fields[i].you.value = turn.prompt; fields[i].bot.value = turn.reply; });
    const preview = h('div', { className: 'story-preview', 'data-testid': 'story-preview' });
    const message = h('p', { className: 'dlg-note', role: 'status' }, text.shortened ? t('story.shortened') : '');
    const go = h('button', { type: 'button', className: 'btn btn-primary btn-sm', 'data-testid': 'story-share' }, t('story.share'));
    const back = h('button', { type: 'button', className: 'btn btn-ghost btn-sm', onClick: () => pick(all.length - 1) }, t('story.back'));
    let made = null;
    let timer = 0;
    const draw = async () => {
      try {
        made = await renderStory({ turns: current(), assistant: agentLabel(state.agent) });
        made.canvas.className = 'story-canvas';
        preview.replaceChildren(made.canvas);
        go.disabled = false;
      } catch { made = null; go.disabled = true; }
    };
    const redraw = () => { clearTimeout(timer); timer = setTimeout(draw, 200); };
    fields.forEach((f) => { f.you.addEventListener('input', redraw); f.bot.addEventListener('input', redraw); });

    // The AI edit: say what to change, choose whose text it applies to, then press Apply. Nothing runs until Apply.
    let scope = 'both';
    const scopeSeg = segmented({
      label: t('story.scope'),
      options: [['both', t('story.scope.both')], ['prompt', t('story.scope.prompt')], ['reply', t('story.scope.reply')]].map(([value, label]) => ({ value, label, testid: `story-scope-${value}` })),
      onSelect: (value) => { scope = value; scopeSeg.set(scope); },
    });
    scopeSeg.set(scope);
    const ask = h('input', { type: 'text', className: 'input input-sm story-ask', maxLength: 300, placeholder: t('story.ask.placeholder'), 'aria-label': t('story.ask'), 'data-testid': 'story-ask' });
    const apply = h('button', { type: 'button', className: 'btn btn-sm btn-primary', 'data-testid': 'story-ask-apply' }, t('story.ask.apply'));
    const undo = h('button', { type: 'button', className: 'btn btn-ghost btn-sm', hidden: true, 'data-testid': 'story-undo' }, t('story.undo'));
    let before = null;
    const doneText = { both: t('story.ask.doneBoth'), prompt: t('story.ask.donePrompt'), reply: t('story.ask.doneReply') };
    const run = async () => {
      const instruction = ask.value.trim();
      if (!instruction) { message.textContent = t('story.ask.empty'); ask.focus(); return; }
      apply.disabled = true;
      message.textContent = t('story.ask.working');
      try {
        const next = await api(`${agentPath(state.agent)}/story`, { method: 'POST', body: { turns: current(), instruction, scope } });
        before = current();
        fill(next.turns);
        undo.hidden = false;
        ask.value = '';
        message.textContent = doneText[scope];
        draw();
      } catch (err) { message.textContent = err.message; }
      apply.disabled = false;
    };
    // A suggestion only fills the box (and picks whose text it is about); the person reads it and presses Apply.
    const suggest = (label, forScope) => h('button', { type: 'button', className: 'pill story-chip', onClick: () => { ask.value = label; scope = forScope; scopeSeg.set(scope); ask.focus(); } }, label);
    const chips = [suggest(t('story.chip.english'), 'both'), suggest(t('story.chip.shorter'), 'reply'), suggest(t('story.chip.casual'), 'both'), suggest(t('story.chip.punchy'), 'reply')];
    apply.addEventListener('click', run);
    ask.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); run(); } });
    undo.addEventListener('click', () => { if (!before) return; fill(before); before = null; undo.hidden = true; message.textContent = ''; draw(); });
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
      h('div', { className: 'share-field' }, h('span', { className: 'share-label' }, t('story.ask')),
        h('div', { className: 'dlg-row story-chips' }, chips),
        ask,
        h('div', { className: 'dlg-row' }, h('span', { className: 'muted' }, t('story.scope')), scopeSeg.el),
        h('div', { className: 'dlg-row' }, apply, undo)),
      message,
      ...fields.map((f, i) => h('div', { className: 'share-field' },
        fields.length > 1 ? h('span', { className: 'share-label' }, t('story.turn', { n: i + 1 })) : null,
        h('span', { className: 'muted' }, t('story.you')), f.you, h('span', { className: 'muted' }, t('story.reply')), f.bot)),
      h('div', { className: 'dlg-row' }, go, back),
    );
    draw();
  }
}
