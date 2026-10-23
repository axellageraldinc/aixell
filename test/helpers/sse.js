// Splits a text/event-stream body into [{ event, data }] (data is parsed JSON when possible).
export function parseSse(text) {
  return text.split('\n\n').filter((block) => block.trim() && !block.startsWith(':')).map((block) => {
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
    const raw = block.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
    let data = raw;
    try { data = JSON.parse(raw); } catch { /* keep the text */ }
    return { event, data };
  });
}
