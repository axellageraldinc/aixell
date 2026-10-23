// Network guard for tests: any outgoing request to a host that is not loopback fails at once.
// Load it first (`import './helpers/fetch-guard.js'`) or with `node --import`. Violations are also kept in
// globalThis.__networkViolations and printed with the marker NETWORK-GUARD so a spawned server's log can be checked.
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const violations = (globalThis.__networkViolations ??= []);

function check(host, how) {
  const name = String(host ?? '').toLowerCase();
  if (LOCAL.has(name) || /^127\.\d+\.\d+\.\d+$/.test(name)) return;
  const message = `network guard: ${how} to "${name}" blocked (tests may only talk to localhost)`;
  violations.push(message);
  console.error(`NETWORK-GUARD ${message}`);
  throw new TypeError(message);
}

if (!globalThis.__fetchGuardInstalled) {
  globalThis.__fetchGuardInstalled = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function guardedFetch(input, init) {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    check(new URL(raw).hostname, 'fetch');
    return realFetch(input, init);
  };
  // Name resolution is a network call too.
  const realLookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname, ...rest) {
    check(String(hostname), 'dns.lookup');
    return realLookup.call(this, hostname, ...rest);
  };
  const realPromiseLookup = dnsPromises.lookup;
  dnsPromises.lookup = async function guardedPromiseLookup(hostname, ...rest) {
    check(String(hostname), 'dns.promises.lookup');
    return realPromiseLookup.call(this, hostname, ...rest);
  };
  for (const [module, label] of [[http, 'http.request'], [https, 'https.request']]) {
    const real = module.request;
    module.request = function guardedRequest(...args) {
      const first = args[0];
      const host = typeof first === 'string' ? new URL(first).hostname : first instanceof URL ? first.hostname : (first?.hostname ?? first?.host ?? 'localhost');
      check(String(host).replace(/:\d+$/, ''), label);
      return real.apply(this, args);
    };
  }
}
export const networkViolations = () => violations;
