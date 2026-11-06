// The tools an agent uses to schedule a check-in in the chat it is talking in. One list, shared by the server (which only accepts
// these names) and the MCP server in scripts/followups-mcp.js (which advertises them).
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const FOLLOWUP_TOOLS = [
  {
    name: 'schedule_followup',
    description: 'Schedule one check-in with the owner in THIS chat at a time you choose, for something that will really have changed or needs news later '
      + '(a decision they are about to act on, something they are going through, a plan with a date). The check-in arrives as a new message in this same chat, '
      + 'written by you at that time. Tell the owner in your reply that you will check in and roughly when, so they can say it is not needed. Do not use it for small talk or things they did not share.',
    inputSchema: obj({
      due_at: { type: 'string', description: 'When to check in: ISO 8601 with a UTC offset, e.g. 2026-03-04T09:30:00+07:00. Pick a time that suits the topic and a reasonable hour for the owner.' },
      context: { type: 'string', description: 'What you need to remember at check-in time: what the owner said or decided and why a check-in matters (max 1500 characters).' },
      question: { type: 'string', description: 'What you intend to ask or find out, in a few words (max 300 characters).' },
    }, ['due_at', 'context', 'question']),
  },
  { name: 'list_followups', description: 'List the check-ins that are scheduled in this chat.', inputSchema: obj({}) },
  { name: 'cancel_followup', description: 'Cancel a scheduled check-in of this chat, for example when the owner says it is not needed. Confirm to them that it is cancelled.', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
];
// Every call carries the key of the chat it is made from (the agent finds it in its instructions). The key decides which chat the call acts on.
const KEY = { chat_key: { type: 'string', description: 'The follow-up key of this chat, from your instructions. Required in every call; keep it secret.' } };
for (const tool of FOLLOWUP_TOOLS) {
  tool.inputSchema = { ...tool.inputSchema, properties: { ...KEY, ...tool.inputSchema.properties }, required: ['chat_key', ...tool.inputSchema.required] };
}
export const FOLLOWUP_TOOL_NAMES = new Set(FOLLOWUP_TOOLS.map((t) => t.name));
