// What a provider throws when the remote service refuses or fails. `status` is the HTTP status when there was one;
// `kind` is one of 'nokey' (no API key configured), 'http' (the service answered with an error), 'timeout',
// 'empty' (the service answered without usable content).
export class ProviderError extends Error {
  constructor(message, { status = 0, kind = 'http', retryAfter = 0, detail = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.kind = kind;
    this.retryAfter = retryAfter; // seconds, from a Retry-After header (0 = none)
    this.detail = detail;
  }
}

export const noKey = (message = 'no key') => new ProviderError(message, { kind: 'nokey' });
export const retryAfterOf = (response) => Number(response?.headers?.get?.('retry-after')) || 0;
