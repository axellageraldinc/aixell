// SSE parser for a ReadableStream (a POST fetch cannot use EventSource).
// Yields { event, data } per block; data is parsed as JSON when possible.

function parseData(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// onActivity runs for every chunk, comments (keep-alive pings) included, so a caller can tell a quiet stream from a dead one.
export async function* readSse(body, onActivity) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let event = 'message';
  let dataLines = [];

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onActivity?.();
    buffer += value;

    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);

      if (line === '') {
        // A blank line ends one event. Events without data are skipped.
        if (dataLines.length > 0) yield { event, data: parseData(dataLines.join('\n')) };
        event = 'message';
        dataLines = [];
      } else if (line[0] !== ':') {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let text = colon === -1 ? '' : line.slice(colon + 1);
        if (text[0] === ' ') text = text.slice(1);
        if (field === 'event') event = text;
        else if (field === 'data') dataLines.push(text);
      }
    }
  }
}
