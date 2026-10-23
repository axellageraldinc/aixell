import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message, code = 'error', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
};

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

export function sendError(res, error) {
  if (error instanceof HttpError) {
    return sendJson(res, error.status, { error: { message: error.message, code: error.code }, ...error.extra });
  }
  console.error('[hermes-web] unhandled', error);
  return sendJson(res, 500, { error: { message: 'Internal server error.', code: 'internal' } });
}

export async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'Request body is too large.', 'too_large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large.', 'too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = config.jsonBodyMaxBytes) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new HttpError(400, 'Invalid JSON.', 'bad_json');
  }
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

export const ID_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
export const requireId = (value, label = 'id') => {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new HttpError(400, `Invalid ${label}.`, 'bad_id');
  return value;
};
