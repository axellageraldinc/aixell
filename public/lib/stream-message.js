// The assistant reply that is being streamed. Thinking steps and tool calls fill the Activity group as they happen,
// the answer streams below it, and a ticking line shows how long the reply has been running.
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { renderMarkdown, hydrateOpenUI, hasOpenVisualFence } from './markdown.js';
import { stepRow, argPreview, inputText } from './tools.js';
import { createActivity } from './activity.js';
import { assistantMeta } from './message-nodes.js';
import { scrollToEnd } from './scroll.js';
import { fmtClock } from './format.js';
import { onTick } from './clock.js';
import { t } from './i18n.js';

// actions: [{ label, onClick }] shown as ghost buttons after the note.
function noteNode(message, { error = false, actions = [] } = {}) {
  return h(
    'p',
    { className: error ? 'msg-note is-error' : 'msg-note', role: error ? 'alert' : 'status' },
    error ? icon('alert-circle', 14) : null,
    h('span', {}, message),
    actions.map((a) => h('button', { type: 'button', className: 'btn btn-sm btn-ghost', onClick: a.onClick }, a.label)),
  );
}

// startMs: when the run began on the client clock. skew: server clock minus client clock (ms).
export function createAssistantMessage({ startMs = Date.now(), skew = 0 } = {}) {
  const toClient = (ts) => (ts == null ? Date.now() : ts * 1000 - skew);
  const activity = createActivity();
  const segments = [];
  let current = null;
  let frame = 0;
  let phase = { kind: 'thinking', label: t('chat.activity.thinking') };
  let thinking = null; // { row, startTs }
  let lastThinkingRow = null;
  let calls = 0; // model calls so far: one per thinking phase
  const tools = []; // { row, name, startTs }
  let streamedSinceTool = false; // the text after the last tool call arrived as a stream, so setText must not add it again

  const workingText = h('span', {});
  const working = h('p', { className: 'working', 'data-testid': 'working' }, h('span', { className: 'loading loading-dots loading-sm', 'aria-hidden': 'true' }), workingText);
  const content = h('div', { className: 'stream-content' });
  const meta = assistantMeta(() => segments.map((s) => s.text).join('\n\n'));
  const node = h('article', { className: 'msg msg-assistant is-streaming', 'data-testid': 'message-assistant' }, activity.node, content, working, meta.el);
  const stopWorking = onTick(() => {
    if (!node.isConnected && !node.classList.contains('is-streaming')) return false;
    workingText.textContent = `${phase.label}… ${fmtClock((Date.now() - startMs) / 1000)}`;
    return node.classList.contains('is-streaming');
  });
  // A reply that keeps streaming while another chat is open must not scroll the thread that is on screen.
  const follow = () => {
    if (node.isConnected) scrollToEnd();
  };

  // Re-rendering the whole answer on every token is quadratic: at most ~8 repaints a second.
  let lastPaint = 0;
  const paint = () => {
    frame = 0;
    lastPaint = performance.now();
    const streaming = node.classList.contains('is-streaming');
    for (const segment of segments) {
      // While a reply streams, a segment is only rebuilt when its text changed — but the closing fence of a visual
      // block lands in a repaint where the block's own text did not change, so the DOM would keep the element built
      // from the still-open (partial) program. Watch the transition and rebuild once when the fence closes.
      const openFence = streaming && hasOpenVisualFence(segment.text);
      if (segment.openFence && !openFence) segment.dirty = true;
      segment.openFence = openFence;
      if (segment.dirty) clear(segment.el).append(renderMarkdown(segment.text));
      segment.dirty = false;
    }
    // A visual block mounts after it is in the document (React renders into a live node, not a fragment).
    hydrateOpenUI(content, { streaming });
    follow();
    if (streaming && segments.some((segment) => segment.openFence)) schedule();
  };
  const schedule = () => {
    if (frame) return;
    const wait = Math.max(0, 120 - (performance.now() - lastPaint));
    // A hidden tab fires no animation frames, so a reply that streams in the background would freeze mid-word.
    frame = wait || document.hidden ? setTimeout(paint, wait) : requestAnimationFrame(paint);
  };
  const openSegment = () => {
    current = { el: h('div', {}), text: '', dirty: false };
    segments.push(current);
    content.append(current.el);
  };

  function startThinking(ts) {
    const row = stepRow({ kind: 'thinking', title: t('chat.activity.thinking'), status: 'running' });
    row.runFrom(toClient(ts));
    activity.add(row.node);
    thinking = { row, startTs: ts };
    calls += 1;
    lastThinkingRow = row;
    phase = { kind: 'thinking', label: t('chat.activity.thinking') };
  }
  // final: the run is over, so a row titled "Answer" stays that way; otherwise (a tool call follows) it was thinking.
  function closeThinking(ts, final = false) {
    if (!thinking) return;
    if (!final && thinking.row.getTitle() === t('chat.activity.answer')) thinking.row.setTitle(t('chat.activity.thinking'));
    const seconds = ts != null && thinking.startTs != null ? ts - thinking.startTs : (Date.now() - toClient(thinking.startTs)) / 1000;
    thinking.row.stop('done', seconds);
    thinking = null;
  }
  // Text streamed before a tool call ("let me check ...") is part of the reply and stays in the chat. The segment is
  // closed so what comes after the tool call starts a new paragraph.
  function endSegment() {
    current = null;
    streamedSinceTool = false;
  }

  return {
    node,
    llmCalls: () => calls,
    begin(ts) {
      startThinking(ts);
    },
    toolStarted(name, args, ts) {
      closeThinking(ts);
      endSegment();
      const row = stepRow({ kind: 'tool', title: name, summary: argPreview(args), status: 'running', input: inputText(args) });
      row.runFrom(toClient(ts));
      activity.add(row.node, { tool: true });
      tools.push({ row, name, startTs: ts });
      phase = { kind: 'tool', label: t('chat.activity.runningTool', { name }) };
      follow();
    },
    toolDone(name, status, ts) {
      const entry = tools.find((tool) => tool.name === name && tool.row.isRunning()) ?? tools.find((tool) => tool.row.isRunning());
      if (!entry) return;
      entry.row.stop(status, ts != null && entry.startTs != null ? ts - entry.startTs : null);
      if (!tools.some((tool) => tool.row.isRunning())) startThinking(ts);
    },
    thinkingDelta(delta) {
      (thinking?.row ?? lastThinkingRow)?.appendText(delta);
    },
    appendDelta(delta, ts) {
      // The model call that writes the answer stays one row ("Answer") until the answer is complete, so the
      // rows add up to the total instead of dropping the time spent writing.
      if (thinking) thinking.row.setTitle(t('chat.activity.answer'));
      phase = { kind: 'answer', label: t('chat.activity.writing') };
      if (!current) openSegment();
      streamedSinceTool = true;
      current.text += String(delta);
      current.dirty = true;
      schedule();
    },
    // Final text replaces the stream only when it is a single segment; otherwise the stream already shows it.
    setText(final) {
      // After tool calls the final text is its own paragraph; when it was streamed it is already on screen.
      if (tools.length > 0) {
        if (!streamedSinceTool && String(final).trim()) {
          openSegment();
          current.text = final;
          current.dirty = true;
          schedule();
        }
        return;
      }
      if (segments.length === 0) openSegment();
      if (segments.length !== 1) return;
      current = segments[0];
      current.text = final;
      current.dirty = true;
      schedule();
    },
    addPart(el) {
      current = null;
      content.append(el);
      follow();
    },
    addCommentary(text) {
      this.addPart(h('p', { className: 'commentary' }, text));
    },
    setNote(message, options) {
      content.append(noteNode(message, options));
      follow();
    },
    // totalSeconds: server-side run time when known.
    // partial: the reply continues in a new message (a steer split it), so this one gets no "Replied in" line.
    finish(totalSeconds = null, endTs = null, { partial = false } = {}) {
      closeThinking(endTs, true);
      for (const t of tools) if (t.row.isRunning()) t.row.stop('failed', null);
      stopWorking();
      working.remove();
      node.classList.remove('is-streaming');
      // A last pass so a block that arrived in the final chunk gets mounted.
      paint();
      const elapsed = totalSeconds ?? (Date.now() - startMs) / 1000;
      // A reply that was a single model call with no tools and no reasoning has nothing worth listing.
      if (tools.length === 0 && !lastThinkingRow?.hasText()) activity.node.hidden = true;
      activity.setTotal(elapsed);
      if (!partial && (segments.some((s) => s.text.trim()) || !activity.isEmpty())) meta.update({ timestamp: Date.now() / 1000, duration: elapsed });
    },
  };
}
