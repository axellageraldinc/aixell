// Groups the flat message list of a session into turns (user message -> agent work -> answer) and builds their nodes.
import { stepRow, argPreview, inputText, outputText } from './tools.js';
import { createActivity } from './activity.js';
import { userNode, assistantNode, systemNode } from './message-nodes.js';
import { t } from './i18n.js';

// A message slipped into a running reply (steer) is stored as a user row wrapped in these markers.
const STEER = /^\s*\[OUT-OF-BAND USER MESSAGE[^\]]*\]\s*([\s\S]*?)\s*\[\/OUT-OF-BAND USER MESSAGE\]\s*$/;

export function groupTurns(messages) {
  const turns = [];
  let turn = null;
  for (const m of messages) {
    if (m.role === 'user') {
      // A steered message is a bubble of its own, between the two halves of the reply it was slipped into.
      const steer = typeof m.content === 'string' ? m.content.match(STEER) : null;
      turn = { user: steer ? { ...m, content: steer[1] } : m, items: [] };
      turns.push(turn);
    } else {
      if (!turn) { turn = { user: null, items: [] }; turns.push(turn); }
      turn.items.push(m);
    }
  }
  return turns;
}

// Timing comes from message timestamps: an assistant message closes a model step (time since the previous message),
// a tool message closes a tool call (time since the message before it).
function buildActivity(turn) {
  const activity = createActivity();
  const toolRows = new Map();
  let previous = turn.user?.timestamp ?? turn.items[0]?.timestamp ?? null;
  let answer = '';
  let answerMessage = null;
  const spoken = []; // text the agent wrote next to tool calls: it belongs in the chat, not in the activity

  const delta = (ts) => (previous != null && ts != null ? Math.max(0, ts - previous) : null);

  for (const m of turn.items) {
    if (m.role === 'assistant') {
      const calls = m.tool_calls ?? [];
      const seconds = delta(m.timestamp);
      // Every model call is a row, so the rows add up to the total: "Thinking" before tool calls, "Answer" for the
      // final call (shown only when there was something before it or it carried reasoning).
      if (calls.length || m.reasoning || !activity.isEmpty()) {
        const row = stepRow({ kind: 'thinking', title: calls.length ? t('chat.activity.thinking') : t('chat.activity.answer'), duration: seconds, text: m.reasoning ?? '' });
        activity.add(row.node);
      }
      if (calls.length) {
        if (m.content?.trim()) spoken.push(m.content.trim());
        for (const call of calls) {
          const args = call.function?.arguments;
          const row = stepRow({ kind: 'tool', title: call.function?.name ?? t('chat.activity.toolFallback'), summary: argPreview(args), status: 'running', input: inputText(args) });
          toolRows.set(call.id, row);
          activity.add(row.node, { tool: true });
        }
      } else {
        answer = m.content ?? '';
        answerMessage = m;
      }
      previous = m.timestamp ?? previous;
    } else if (m.role === 'tool') {
      const row = toolRows.get(m.tool_call_id);
      const result = outputText(m.content);
      if (row) {
        row.setOutput(result.text);
        row.stop(result.failed ? 'failed' : 'done', delta(m.timestamp));
      }
      previous = m.timestamp ?? previous;
    }
  }
  // Calls that never got a result (interrupted run) must not look like they are still running.
  for (const row of toolRows.values()) if (row.isRunning()) row.stop('failed', null);
  // Interrupted runs have no final answer: what was said before the last tool call is then the whole reply.
  answer = [...spoken, answer.trim()].filter(Boolean).join('\n\n');
  return { activity, answer, answerMessage };
}

export function turnNodes(turn) {
  const nodes = [];
  if (turn.user) nodes.push(userNode(turn.user.content, turn.user.timestamp));
  if (turn.items.length === 0) return nodes;
  const { activity, answer, answerMessage } = buildActivity(turn);
  const last = turn.items[turn.items.length - 1];
  const start = turn.user?.timestamp ?? null;
  const duration = start != null && last.timestamp != null && answerMessage ? Math.max(0, last.timestamp - start) : null;
  activity.setTotal(duration);
  if (!answer.trim() && activity.isEmpty()) {
    const text = turn.items.map((m) => m.content).filter(Boolean).join('\n');
    nodes.push(systemNode(text || '(no content)'));
    return nodes;
  }
  nodes.push(assistantNode({ activity: activity.isEmpty() ? null : activity.node, answer, timestamp: answerMessage?.timestamp ?? last.timestamp, duration }));
  return nodes;
}
