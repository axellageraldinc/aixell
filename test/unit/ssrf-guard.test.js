// src/fresh/net.js: everything Fresh downloads comes from addresses found inside feeds, so each hop must be public http(s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import '../helpers/fetch-guard.js';
import { assertPublic, safeFetch } from '../../src/fresh/net.js';

const realLookup = dns.lookup;
const resolvesTo = (...addresses) => { dns.lookup = async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })); };
test.afterEach(() => { dns.lookup = realLookup; });

test('rejects non-http protocols and garbage', async () => {
  for (const bad of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com', 'javascript:alert(1)', 'not a url', '']) {
    await assert.rejects(() => assertPublic(bad), /bad (url|protocol)/, bad);
  }
});

test('rejects private, loopback, link-local and carrier-grade NAT IPv4 literals', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', ['192', '168', '1', '1'].join('.'), '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1']) {
    await assert.rejects(() => assertPublic(`http://${ip}/`), /private address/, ip);
  }
});

test('rejects private IPv6 literals, including IPv4-mapped ones', async () => {
  for (const ip of ['[::1]', '[::]', '[fd00::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]']) {
    await assert.rejects(() => assertPublic(`http://${ip}/`), /private address/, ip);
  }
});

test('accepts public IP literals', async () => {
  for (const ip of ['93.184.216.34', '172.32.0.1', '100.128.0.1', '[2606:2800:220:1::1]']) {
    const url = await assertPublic(`https://${ip}/x`);
    assert.equal(url.protocol, 'https:');
  }
});

test('rejects local-looking names without resolving them', async () => {
  dns.lookup = async () => { throw new Error('must not be called'); };
  for (const host of ['localhost', 'printer.local', 'db.internal']) await assert.rejects(() => assertPublic(`http://${host}/`), /private address/, host);
});

test('a public name that resolves to a private address is rejected (DNS rebinding)', async () => {
  resolvesTo('10.0.0.5');
  await assert.rejects(() => assertPublic('http://rebind.example/'), /private address/);
  resolvesTo('93.184.216.34', ['192', '168', '0', '9'].join('.')); // one bad answer is enough
  await assert.rejects(() => assertPublic('http://mixed.example/'), /private address/);
});

test('a public name that resolves to public addresses is accepted', async () => {
  resolvesTo('93.184.216.34');
  assert.equal((await assertPublic('https://news.example/feed')).hostname, 'news.example');
});

test('safeFetch refuses a loopback target before connecting', async () => {
  await assert.rejects(() => safeFetch('http://127.0.0.1:9/feed'), /private address/);
});
