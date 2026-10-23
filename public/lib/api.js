// Fetch wrapper: same-origin credentials, CSRF header on mutations, redirect to the sign-in page on 401.
import { t } from './i18n.js';

let csrf = '';

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'network', retryAfter = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export const setCsrf = (token) => {
  csrf = token ?? '';
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// body: object (sent as JSON), Blob (sent as is) or undefined.
// redirectOn401 is turned off on the sign-in page, where 401 means wrong credentials.
export async function fetchRaw(path, { method = 'GET', body, headers = {}, redirectOn401 = true, signal } = {}) {
  const init = { method, credentials: 'same-origin', headers: { ...headers }, signal };
  // No token before sign-in: the header is skipped and the server rejects if needed.
  if (MUTATING.has(method) && csrf) init.headers['X-CSRF-Token'] = csrf;
  if (body instanceof Blob) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the server.', { code: 'network' });
  }
  if (res.status === 401 && redirectOn401) {
    location.href = '/login.html';
    throw new ApiError(t('api.error.sessionExpired'), { status: 401, code: 'unauthorized' });
  }
  return res;
}

export async function toApiError(res) {
  let message = `Request failed (HTTP ${res.status}).`;
  let code = 'http_error';
  let retryAfter = null;
  try {
    const body = await res.json();
    if (typeof body.error === 'string') {
      message = body.error;
    } else if (body.error?.message) {
      message = body.error.message;
      code = body.error.code ?? code;
    }
    retryAfter = body.retryAfter ?? null;
  } catch {
    // Body is not JSON: keep the generic message.
  }
  if (retryAfter == null) {
    const header = Number(res.headers.get('Retry-After'));
    if (header) retryAfter = header;
  }
  return new ApiError(message, { status: res.status, code, retryAfter });
}

export const agentPath = (name) => `/api/agents/${encodeURIComponent(name)}`;

// JSON request: throws ApiError on a non-2xx status.
export async function api(path, options = {}) {
  const res = await fetchRaw(path, options);
  if (!res.ok) throw await toApiError(res);
  return res.json();
}
