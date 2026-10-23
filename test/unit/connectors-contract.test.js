// The connector contract: the shape check the registry and drop-in loading rely on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConnector } from '../../src/connectors/contract.js';

const good = () => ({
  type: 'example',
  title: 'Example',
  configSchema: { type: 'object', properties: { url: { type: 'string' } } },
  credentials: [{ key: 'token', label: 'Token', secret: true, required: false }],
  defaultSchedule: { every: '30m' },
  cost: { kind: 'free' },
  fetch: async () => [],
});

test('contract: a complete connector has no errors', () => {
  assert.deepEqual(validateConnector(good()), []);
});

test('contract: a connector without fetch is refused', () => {
  const connector = good();
  delete connector.fetch;
  assert.deepEqual(validateConnector(connector), ['fetch: must be a function']);
  assert.ok(validateConnector({ ...good(), fetch: 'nope' }).includes('fetch: must be a function'));
});

test('contract: type and title are required strings', () => {
  assert.ok(validateConnector({ ...good(), type: '' }).some((e) => e.startsWith('type: ')));
  assert.ok(validateConnector({ ...good(), title: 42 }).some((e) => e.startsWith('title: ')));
  assert.ok(validateConnector(null).includes('connector: must be an object'));
});

test('contract: a bad schedule is refused, a missing one is fine', () => {
  assert.ok(validateConnector({ ...good(), defaultSchedule: { every: '30m', cron: '0 0 * * *' } }).some((e) => e.startsWith('defaultSchedule: ')));
  assert.ok(validateConnector({ ...good(), defaultSchedule: { at: '21:00' } }).some((e) => e.startsWith('defaultSchedule.at: ')));
  assert.ok(validateConnector({ ...good(), defaultSchedule: {} }).some((e) => e.startsWith('defaultSchedule: ')));
  assert.ok(validateConnector({ ...good(), defaultSchedule: '30m' }).some((e) => e.startsWith('defaultSchedule: ')));
  const noSchedule = good();
  delete noSchedule.defaultSchedule;
  assert.deepEqual(validateConnector(noSchedule), []);
});

test('contract: cost.kind must be free or metered', () => {
  assert.deepEqual(validateConnector({ ...good(), cost: { kind: 'metered', costPerRunMicro: 100 } }), []);
  assert.ok(validateConnector({ ...good(), cost: { kind: 'cheap' } }).some((e) => e.startsWith('cost.kind: ')));
  assert.ok(validateConnector({ ...good(), cost: { kind: 'free', costPerRunMicro: -1 } }).some((e) => e.startsWith('cost.costPerRunMicro: ')));
  assert.ok(validateConnector({ ...good(), cost: undefined }).some((e) => e.startsWith('cost: ')));
});

test('contract: a push connector may omit fetch', () => {
  const push = { type: 'ingest', title: 'Ingest', push: true, cost: { kind: 'free' } };
  assert.deepEqual(validateConnector(push), []);
  assert.ok(validateConnector({ ...push, push: 'yes' }).some((e) => e.startsWith('push: ')));
});
