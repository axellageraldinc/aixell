// A fake OpenAI-compatible server on localhost (and, with `extras: true`, the extra endpoints of a gateway:
// /classify and /search). Nothing here reaches the network.
//
//   const gw = await startFakeGateway({ extras: true });
//   gw.url            // http://127.0.0.1:PORT/v1
//   gw.requests       // [{ method, path, headers, body }]  every request received
//   gw.handlers[path] // override: (req) => ({ status, body, headers }) for 'POST /chat/completions' style keys (`raw` replaces the JSON body)
//   await gw.close()
import http from 'node:http';

export const GW_KEY = 'test-gateway-key';

// The models the way an OpenAI-style catalogue lists them (OpenRouter prices: USD per token, as strings).
const OPENAI_MODELS = [
  { id: 'chat-a', context_length: 32000, pricing: { prompt: '0.0000015', completion: '0.000006' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
  { id: 'chat-b', context_length: 8000, pricing: { prompt: '0.0000005', completion: '0.000002' } },
];
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(3000, 7)]);

export async function startFakeGateway({ extras = false, key = GW_KEY } = {}) {
  const requests = [];
  const handlers = {};
  const json = (status, body, headers = {}) => ({ status, body, headers });

  const defaults = {
    'GET /models': () => json(200, { data: OPENAI_MODELS }),
    'POST /chat/completions': (req) => {
      const system = String(req.body.messages?.[0]?.content ?? '');
      return json(200, { choices: [{ message: { content: system.includes('classifier') ? JSON.stringify(handlers.classifierAnswer ?? {}) : `echo:${req.body.model}` } }] });
    },
    'POST /images/generations': () => json(200, { data: [{ b64_json: PNG.toString('base64') }] }),
    'POST /audio/transcriptions': () => json(200, { text: ' hello world ' }),
    'POST /audio/speech': () => ({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, raw: Buffer.from('ID3 fake mp3') }),
  };
  if (extras) {
    Object.assign(defaults, {
      'POST /classify': (req) => {
        const answers = {};
        for (const [id, q] of Object.entries(req.body.questions ?? {})) {
          answers[id] = q.type === 'choice' ? { type: 'choice', choice: Object.keys(q.criteria)[0] } : q.type === 'score' ? { type: 'score', score: q.criteria.length - 1 } : { type: 'bool', p: 0.25 };
        }
        return json(200, { answers, model: req.body.model });
      },
      'POST /search': (req) => json(200, { id: 'x1', answer: `- @someone: ${req.body.query} https://example.com/a`, citations: [{ url: 'https://example.com/a' }], cost_micro: 100_000_000 }),
    });
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const route = url.pathname.replace(/^\/v1/, '');
      const raw = Buffer.concat(chunks);
      let body = null;
      if ((req.headers['content-type'] ?? '').includes('json')) { try { body = JSON.parse(raw.toString('utf8')); } catch { /* not json */ } }
      const entry = { method: req.method, path: route, query: url.search, headers: req.headers, body, raw };
      requests.push(entry);
      const send = (r) => {
        res.writeHead(r.status, { 'Content-Type': 'application/json', ...r.headers });
        res.end(r.raw ?? JSON.stringify(r.body));
      };
      if (req.headers.authorization !== `Bearer ${key}`) return send(json(401, { error: { message: 'bad key' } }));
      const handler = handlers[`${req.method} ${route}`] ?? defaults[`${req.method} ${route}`];
      if (!handler) return send(json(404, { error: { message: 'unknown path' } }));
      send(handler(entry));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port, url: `http://127.0.0.1:${port}/v1`, requests, handlers, key,
    count: (route) => requests.filter((r) => `${r.method} ${r.path}` === route).length,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

// Starts a fake gateway with the extras and points the provider layer at it: every capability goes to the mock-gateway
// provider, with the key read from the agent's own .env (GATEWAY_API_KEY), like a real config would do.
export async function startGateway(compat, opts = {}) {
  const gw = await startFakeGateway({ extras: true, ...opts });
  compat.setProviderConfig({
    providers: { gateway: { type: 'mock-gateway', baseUrl: gw.url, apiKey: 'agentEnv:GATEWAY_API_KEY' } },
    capabilities: compat.gatewayCapabilities('gateway'),
  });
  return gw;
}
