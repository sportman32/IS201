'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

// --- Fake Plaid: intercept fetch calls to Plaid's API --------------------------

const plaidCalls = [];
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const endpoint = new URL(url).pathname;
  plaidCalls.push({ url, endpoint, body });
  const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
  if (body.secret !== 'goodsecret12345') return reply(400, { error_code: 'INVALID_API_KEYS' });
  switch (endpoint) {
    case '/link/token/create': return reply(200, { link_token: 'link-sandbox-123' });
    case '/item/public_token/exchange': return reply(200, { item_id: 'item-1', access_token: 'access-sandbox-SECRET' });
    case '/item/remove': return reply(200, {});
    case '/accounts/get': return reply(200, { accounts: [
      { account_id: 'a1', name: 'Checking', mask: '0001', type: 'depository', subtype: 'checking', balances: { current: 1000, iso_currency_code: 'USD' } },
      { account_id: 'a2', name: 'Card', mask: '4455', type: 'credit', subtype: 'credit card', balances: { current: 250, limit: 1000, iso_currency_code: 'USD' } },
    ] });
    default: return reply(404, { error_code: 'NOT_FOUND' });
  }
};

// --- Helpers -------------------------------------------------------------------

let server;
let port;
let cookie = '';

function request(method, urlPath, { body, headers = {}, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: {
        Host: `localhost:${port}`,
        ...(method !== 'GET' ? { Origin: `http://localhost:${port}`, 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const setCookie = res.headers['set-cookie']?.[0];
        if (setCookie) cookie = setCookie.split(';')[0];
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const vaultPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'server-')), 'vault.json');

test.before(async () => {
  server = createApp({
    vaultPath,
    idleLockMs: 60000,
    vaultOptions: { scryptParams: { N: 2 ** 10, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

test.after(() => server.close());

// Tests run in order and share one server, like a real session.

test('serves the page with security headers', async () => {
  const res = await request('GET', '/');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.strictEqual(res.headers['x-frame-options'], 'DENY');
});

test('does not serve files outside the allowlist', async () => {
  for (const p of ['/server.js', '/../server.js', '/%2e%2e/server.js', '/data/vault.json', '/index.html']) {
    assert.strictEqual((await request('GET', p)).status, 404, p);
  }
});

test('blocks DNS rebinding and cross-site requests', async () => {
  assert.strictEqual((await request('GET', '/api/status', { headers: { Host: `evil.com:${port}` } })).status, 403);
  const res = await request('POST', '/api/setup', {
    body: { passphrase: 'correct horse battery' }, headers: { Origin: 'http://evil.com' },
  });
  assert.strictEqual(res.status, 403);
  assert.ok(!fs.existsSync(vaultPath));
});

test('rejects non-JSON and oversized bodies', async () => {
  assert.strictEqual((await request('POST', '/api/setup', { rawBody: 'x', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.strictEqual((await request('POST', '/api/setup', { rawBody: JSON.stringify({ p: 'x'.repeat(20000) }) })).status, 413);
});

test('enforces a strong passphrase at setup', async () => {
  const res = await request('POST', '/api/setup', { body: { passphrase: 'too short' } });
  assert.strictEqual(res.status, 400);
  assert.match(res.json.error, /16/);
});

test('setup creates the vault and a session', async () => {
  const res = await request('POST', '/api/setup', { body: { passphrase: 'correct horse battery' } });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  assert.strictEqual((await request('GET', '/api/status')).json.unlocked, true);
});

test('requires Plaid keys before connecting', async () => {
  const res = await request('POST', '/api/link-token', { body: {} });
  assert.strictEqual(res.status, 400);
  assert.match(res.json.error, /Plaid keys/);
});

test('saves Plaid keys encrypted and never returns the secret', async () => {
  const bad = await request('PUT', '/api/settings', { body: { env: 'sandbox', clientId: 'client123456', secret: '' } });
  assert.strictEqual(bad.status, 400);
  const res = await request('PUT', '/api/settings', { body: { env: 'sandbox', clientId: 'client123456', secret: 'goodsecret12345' } });
  assert.strictEqual(res.status, 200);
  const settings = await request('GET', '/api/settings');
  assert.deepStrictEqual(settings.json, { env: 'sandbox', clientId: 'client123456', secretSaved: true });
  assert.ok(!settings.text.includes('goodsecret12345'));
  assert.ok(!fs.readFileSync(vaultPath, 'utf8').includes('goodsecret12345'));
});

test('connects an account and shows totals without exposing tokens', async () => {
  assert.strictEqual((await request('POST', '/api/link-token', { body: {} })).json.linkToken, 'link-sandbox-123');
  assert.strictEqual((await request('POST', '/api/exchange', { body: { publicToken: 'public-1', institution: { name: 'Test Bank' } } })).status, 200);
  const res = await request('GET', '/api/accounts');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.totals.USD.netWorth, 750);
  assert.strictEqual(res.json.totals.USD.creditUtilization, 25);
  assert.ok(!res.text.includes('access-sandbox-SECRET'), 'access token must never reach the browser');
  assert.ok(!fs.readFileSync(vaultPath, 'utf8').includes('access-sandbox-SECRET'));
});

test('keeps the saved secret when left blank', async () => {
  const res = await request('PUT', '/api/settings', { body: { env: 'sandbox', clientId: 'client123456', secret: '' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await request('GET', '/api/accounts')).json.connections.length, 1);
});

test('lock ends the session', async () => {
  const saved = cookie;
  await request('POST', '/api/lock', { body: {} });
  cookie = saved; // Even a stolen old cookie no longer works.
  assert.strictEqual((await request('GET', '/api/accounts')).status, 401);
  assert.strictEqual((await request('GET', '/api/settings')).status, 401);
});

test('wrong passphrase is rejected; right one unlocks', async () => {
  assert.strictEqual((await request('POST', '/api/unlock', { body: { passphrase: 'wrong passphrase here' } })).status, 401);
  assert.strictEqual((await request('POST', '/api/unlock', { body: { passphrase: 'correct horse battery' } })).status, 200);
  assert.strictEqual((await request('GET', '/api/accounts')).json.connections.length, 1);
});

test('switching environment revokes and clears connections', async () => {
  plaidCalls.length = 0;
  const res = await request('PUT', '/api/settings', { body: { env: 'production', clientId: 'client123456', secret: 'goodsecret12345' } });
  assert.strictEqual(res.status, 200);
  const revoke = plaidCalls.find((c) => c.endpoint === '/item/remove');
  assert.ok(revoke && revoke.url.startsWith('https://sandbox.plaid.com'), 'old token revoked with old environment');
  assert.strictEqual((await request('GET', '/api/accounts')).json.connections.length, 0);
});

test('removing a connection revokes it at Plaid', async () => {
  await request('POST', '/api/exchange', { body: { publicToken: 'public-2', institution: { name: 'Bank 2' } } });
  plaidCalls.length = 0;
  assert.strictEqual((await request('POST', '/api/items/remove', { body: { itemId: 'item-1' } })).status, 200);
  assert.ok(plaidCalls.some((c) => c.endpoint === '/item/remove' && c.url.startsWith('https://production.plaid.com')));
  assert.strictEqual((await request('GET', '/api/accounts')).json.connections.length, 0);
});

test('bad Plaid keys give a helpful error', async () => {
  await request('PUT', '/api/settings', { body: { env: 'production', clientId: 'client123456', secret: 'wrongsecret12345' } });
  const res = await request('POST', '/api/link-token', { body: {} });
  assert.strictEqual(res.status, 502);
  assert.match(res.json.error, /INVALID_API_KEYS.*Settings/);
});
