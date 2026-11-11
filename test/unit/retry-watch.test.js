import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRetryState, parseFatalError } from '../../src/retry-watch.js';

const S = 'api_1_abc';
const log = (lines) => lines.join('\n');
const FAIL = (t, n) => `2026-11-11 03:${t},141 WARNING [${S}] agent.conversation_loop: API call failed (attempt ${n}/3) error_type=InternalServerError thread=x provider=custom base_url=https://example.test/v1 model=m-1 summary=HTTP 503: upstream unavailable for model m-1`;
const WAIT = (t, n) => `2026-11-11 03:${t},144 WARNING [${S}] agent.conversation_loop: Retrying API call in 30.0s (attempt ${n}/3) thread=x provider=custom policy=default error=Error code: 503 - {'error': {}}`;
const OK = (t) => `2026-11-11 03:${t},500 INFO [${S}] agent.conversation_loop: API call #2: model=m-2 provider=custom in=10 out=5`;

test('a failing call with its wait is reported with attempt, wait, model and reason', () => {
  const state = parseRetryState(log([FAIL('54:52', 1), WAIT('54:52', 1)]), S);
  assert.deepEqual(state, { attempt: 1, max: 3, waitSeconds: 30, model: 'm-1', reason: 'HTTP 503: upstream unavailable for model m-1', recovery: null });
});

test('the newest attempt wins, a recovery round is added, and a call that goes through clears it', () => {
  const lines = [FAIL('54:52', 1), WAIT('54:52', 1), FAIL('55:22', 2), WAIT('55:22', 2), `2026-11-11 03:55:54,316 WARNING [${S}] agent.conversation_loop: Provider unavailable (overloaded) — auto-recovery cycle 1/5, retrying in 30s thread=x`];
  const state = parseRetryState(log(lines), S);
  assert.equal(state.attempt, 2);
  assert.deepEqual(state.recovery, { cycle: 1, of: 5 });
  assert.equal(parseRetryState(log([...lines, OK('56:30')]), S), null);
});

test('other chats, old lines and noise are ignored', () => {
  const other = FAIL('54:52', 1).replace(S, 'api_2_zzz');
  assert.equal(parseRetryState(log([other, 'garbage line']), S), null);
  const since = new Date(2026, 10, 11, 3, 55, 0).getTime();
  assert.equal(parseRetryState(log([FAIL('54:52', 1)]), S, since), null);
});

const FATAL = (t) => `2026-11-11 03:${t},141 WARNING [${S}] agent.conversation_loop: API call failed (attempt 1/3, not retryable) error_type=PermissionDeniedError thread=x provider=custom base_url=https://example.test/v1 model=m-9 summary=HTTP 403: client may not call m-9`;

test('a call that failed for good gives its model and reason; a later good call or an old line clears it', () => {
  assert.deepEqual(parseFatalError(log([FATAL('10:00')]), S), { model: 'm-9', reason: 'HTTP 403: client may not call m-9' });
  assert.equal(parseFatalError(log([FATAL('10:00'), OK('10:05')]), S), null);
  assert.equal(parseFatalError(log([FATAL('10:00')]), S, new Date(2026, 10, 11, 3, 30, 0).getTime()), null);
  assert.equal(parseFatalError(log([FATAL('10:00').replace(S, 'api_2_zzz')]), S), null);
  assert.equal(parseFatalError(log([FAIL('10:00', 1)]), S), null, 'a retryable failure is not final');
});
