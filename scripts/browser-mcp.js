#!/usr/bin/env node
// MCP server (stdio) that gives a Hermes agent the browser tools. It holds no secret of its own: it reads the bridge token from
// the aixell data directory and talks to aixell on loopback. Add it to the agent's mcp_servers, for example:
//   command: node
//   args: [/path/to/aixell/scripts/browser-mcp.js]
//   env: { AIXELL_URL: "http://127.0.0.1:8300", AIXELL_DATA_DIR: "/path/to/aixell/data" }
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { BROWSER_TOOLS } from '../src/browser-tools.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.env.AIXELL_URL || 'http://127.0.0.1:8300').replace(/\/$/, '');
const dataDir = process.env.AIXELL_DATA_DIR || path.join(root, 'data');
const PROTOCOL = '2024-11-05';

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);

async function callTool(name, args) {
  let token;
  try { token = fs.readFileSync(path.join(dataDir, 'browser-bridge-token'), 'utf8').trim(); } catch { return { isError: true, content: [{ type: 'text', text: 'The browser bridge is not set up on this server.' }] }; }
  let res;
  try { res = await fetch(`${base}/api/browser/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ tool: name, args }), signal: AbortSignal.timeout(160_000) }); }
  catch { return { isError: true, content: [{ type: 'text', text: 'Could not reach aixell.' }] }; }
  const body = await res.json().catch(() => null);
  if (!res.ok) return { isError: true, content: [{ type: 'text', text: body?.error?.message ?? `aixell answered ${res.status}.` }] };
  if (!body?.ok) return { isError: true, content: [{ type: 'text', text: `${body?.error?.code ?? 'failed'}: ${body?.error?.message ?? 'The browser could not do that.'}` }] };
  const out = body.result;
  if (out?.image?.base64) return { content: [{ type: 'image', data: out.image.base64, mimeType: out.image.mime || 'image/jpeg' }, { type: 'text', text: out.note ?? '' }] };
  return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] };
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notifications need no answer
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'aixell-browser', version: '0.1.0' } });
  if (msg.method === 'ping') return reply(msg.id, {});
  if (msg.method === 'tools/list') return reply(msg.id, { tools: BROWSER_TOOLS });
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    if (!BROWSER_TOOLS.some((t) => t.name === name)) return fail(msg.id, -32602, 'Unknown tool.');
    return reply(msg.id, await callTool(name, msg.params?.arguments ?? {}));
  }
  return fail(msg.id, -32601, 'Method not found.');
});
