// Activity steps: one expandable row per thinking step or tool call, with its duration.
// All server text goes in as text nodes.
import { h } from './dom.js';
import { icon } from './icons.js';
import { truncate, fmtDuration, fmtClock } from './format.js';
import { onTick } from './clock.js';
import { t } from './i18n.js';

const OUTPUT_LIMIT = 4000;
const NOISE_KEYS = new Set(['session_id', 'run_id', 'message_id', 'seq', 'ts', 'tool_name']);
const STATUS_LABEL = { running: t('chat.activity.status.running'), done: t('chat.activity.status.done'), failed: t('chat.activity.status.failed') };

const fields = (data) => Object.entries(data).filter(([key]) => !NOISE_KEYS.has(key));
const asText = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

// Event payload as "key: value" lines (used by approval requests).
export function fieldLines(data) {
  if (data == null || typeof data !== 'object') return String(data ?? '');
  return fields(data)
    .map(([key, value]) => `${key}: ${asText(value)}`)
    .join('\n');
}

// Tool arguments (object or JSON string) as readable input text.
export function inputText(args) {
  let value = args;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return value; }
  }
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  const keys = Object.keys(value);
  if (keys.length === 1 && typeof value[keys[0]] === 'string') return value[keys[0]];
  return JSON.stringify(value, null, 2);
}

// One short line for the row header: the command, query, url or path the tool was called with.
export function argPreview(args) {
  let value = args;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return truncate(value.replace(/\s+/g, ' '), 90); }
  }
  if (value == null || typeof value !== 'object') return '';
  for (const key of ['command', 'query', 'url', 'path', 'file_path', 'name', 'pattern', 'prompt']) {
    if (typeof value[key] === 'string' && value[key]) return truncate(value[key].replace(/\s+/g, ' '), 90);
  }
  if (Array.isArray(value.urls) && value.urls[0]) return truncate(String(value.urls[0]), 90);
  const first = Object.values(value).find((v) => typeof v === 'string' && v);
  return first ? truncate(first.replace(/\s+/g, ' '), 90) : '';
}

// Tool result (usually JSON such as {"output": "...", "exit_code": 0}) as text plus a failed flag.
export function outputText(content) {
  const raw = String(content ?? '');
  let data;
  try { data = JSON.parse(raw); } catch { return { text: raw, failed: false }; }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return { text: raw, failed: false };
  const exit = typeof data.exit_code === 'number' ? data.exit_code : null;
  const failed = (exit != null && exit !== 0) || Boolean(data.error) || data.success === false;
  if (typeof data.output === 'string') {
    const extra = [exit ? `exit code ${exit}` : null, data.error ? String(data.error) : null].filter(Boolean);
    return { text: [data.output, ...extra.map((e) => `[${e}]`)].filter(Boolean).join('\n'), failed };
  }
  return { text: JSON.stringify(data, null, 2), failed };
}

// kind: 'thinking' | 'tool'. The row can be updated while it runs.
export function stepRow({ kind, title, summary = '', status = 'done', duration = null, input = '', output = '', text = '' }) {
  let current = status;
  let expanded = false;
  let outputFull = output;
  let stopTick = null;

  const dot = h('span', { className: 'dot', 'aria-hidden': 'true' });
  const label = h('span', { className: 'sr-only' });
  const time = h('span', { className: 'step-time' });
  const summaryEl = h('span', { className: 'step-summary' });
  const inputPre = h('pre', {});
  const outputPre = h('pre', {});
  const textPre = h('pre', { className: 'step-text' });
  const more = h('button', { type: 'button', className: 'btn btn-sm btn-ghost', onClick: () => { expanded = true; render(); } }, t('common.showMore'));
  const inputBox = h('div', {}, h('span', { className: 'step-label' }, t('chat.activity.input')), inputPre);
  const outputBox = h('div', {}, h('span', { className: 'step-label' }, t('chat.activity.output')), outputPre, more);
  const body = h('div', { className: 'step-body' }, kind === 'tool' ? [inputBox, outputBox] : textPre);
  const titleEl = h('span', { className: kind === 'tool' ? 'step-title is-tool' : 'step-title' }, title);
  const summaryNode = h('summary', {}, icon('chevron-down', 14), titleEl, summaryEl, dot, label, time);
  const node = h('details', { className: `step step-${kind}`, 'data-testid': kind === 'tool' ? 'tool-row' : 'thinking-step' }, summaryNode, body);

  // A row with nothing to show cannot be opened.
  summaryNode.addEventListener('click', (event) => { if (node.classList.contains('no-body')) event.preventDefault(); });

  function render() {
    dot.className = `dot is-${current}`;
    label.textContent = STATUS_LABEL[current];
    node.dataset.status = current;
    summaryEl.textContent = summary;
    const clipped = !expanded && outputFull.length > OUTPUT_LIMIT;
    inputPre.textContent = input;
    outputPre.textContent = clipped ? truncate(outputFull, OUTPUT_LIMIT) : outputFull;
    textPre.textContent = text;
    more.hidden = !clipped;
    inputBox.hidden = input === '';
    outputBox.hidden = outputFull === '' && current === 'running';
    if (kind === 'tool' && outputFull === '' && current !== 'running') outputPre.textContent = '(no output)';
    node.classList.toggle('no-body', kind === 'tool' ? input === '' && outputFull === '' : text === '');
  }
  const setTime = (seconds) => { time.textContent = seconds == null ? '' : fmtDuration(seconds); };
  setTime(duration);
  render();

  return {
    node,
    kind,
    isRunning: () => current === 'running',
    // Counts up from startMs (client clock) until stop() sets the final duration.
    runFrom(startMs) {
      stopTick?.();
      stopTick = onTick(() => {
        if (!node.isConnected && current !== 'running') return false;
        time.textContent = fmtClock((Date.now() - startMs) / 1000);
        return current === 'running';
      });
    },
    stop(nextStatus, seconds) {
      stopTick?.();
      stopTick = null;
      current = nextStatus;
      setTime(seconds);
      render();
    },
    setTitle(value) { titleEl.textContent = value; },
    getTitle: () => titleEl.textContent,
    setSummary(value) { summary = value; render(); },
    setInput(value) { input = value; render(); },
    setOutput(value) { outputFull = value; render(); },
    appendText(delta) { text += String(delta); render(); },
    setText(value) { text = value; render(); },
    hasText: () => text !== '',
  };
}
