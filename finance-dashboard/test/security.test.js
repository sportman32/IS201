'use strict';

// Attack-style tests: each one tries something a hostile website or another
// program on the same computer might do, and checks that it fails.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

global.fetch = async (url, opts) => {
  const endpoint = new URL(url).pathname;
  const body = JSON.parse(opts.body);
  const reply = (data) => ({ ok: true, status: 200, json: async () => data });
  switch (endpoint) {
    case '/item/public_token/exchange': return reply({ item_id: 'item-1', access_token: 'access-sandbox-SECRET' });
    // A hostile logo value must never reach the page.
    case '/institutions/get_by_id': return reply({ institution: { logo: '"><script>alert(1)</script>', primary_color: 'red;background:url(x)' } });
    case '/accounts/get': return reply({ accounts: [] });
    case '/transactions/sync': return reply({ added: [], modified: [], removed: [], next_cursor: 'c', has_more: false });
    default: return reply({ body });
  }
};

let server;
let port;
const vaultPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sec-')), 'vault.json');
const PASS = 'correct horse battery';

function request(method, urlPath, { body, headers = {}, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
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
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let owner; // The legitimate session cookie.

test.before(async () => {
  server = createApp({ vaultPath, idleLockMs: 60000, vaultOptions: { scryptParams: { N: 2 ** 10, r: 8, p: 1 } } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  owner = (await request('POST', '/api/setup', { body: { passphrase: PASS } })).cookie;
  await request('PUT', '/api/settings', { cookie: owner, body: { env: 'sandbox', clientId: 'client123456', secret: 'goodsecret12345' } });
});
test.after(() => server.close());

const ownerOk = async () => (await request('POST', '/api/ping', { cookie: owner, body: {} })).status === 200;

test('the app page loads no outside code', async () => {
  const res = await request('GET', '/');
  const csp = res.headers['content-security-policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /connect-src 'self';/);
  assert.ok(!csp.includes('plaid'), 'Plaid must not be allowed on the app page');
  assert.ok(!res.text.includes('cdn.plaid.com/link'), 'the app page must not load Plaid\'s script');
  assert.strictEqual(res.headers['cross-origin-resource-policy'], 'same-origin');
  assert.match(res.headers['permissions-policy'], /camera=\(\)/);
  assert.strictEqual(res.headers['x-frame-options'], 'DENY');
  assert.strictEqual(res.headers['cache-control'], 'no-store');
});

test('the Plaid window lives on a separate site and serves nothing else', async () => {
  const linkHost = { Host: `127.0.0.1:${port}` };
  const page = await request('GET', '/link', { headers: linkHost });
  assert.strictEqual(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'self' https:\/\/cdn\.plaid\.com/);
  assert.strictEqual(page.headers['cross-origin-opener-policy'], 'unsafe-none');
  // From that site, the API and the app's code are unreachable, even with a stolen cookie.
  for (const p of ['/api/data', '/api/settings', '/app.js', '/index.html']) {
    assert.strictEqual((await request('GET', p, { headers: linkHost, cookie: owner })).status, 404, p);
  }
  const post = await request('POST', '/api/refresh', { headers: { ...linkHost, Origin: `http://127.0.0.1:${port}` }, cookie: owner, body: {} });
  assert.strictEqual(post.status, 404);
  // And the app's site doesn't serve the Plaid page.
  assert.strictEqual((await request('GET', '/link')).status, 404);
});

test('other websites (including other apps on localhost) cannot call the API', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const res = await request('GET', '/api/data', { cookie: owner, headers: { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } });
    assert.strictEqual(res.status, 403, site);
    assert.ok(!res.text.includes('client123456'));
  }
  // A form or fetch POST from another localhost port is rejected by origin.
  const post = await request('PUT', '/api/manual', { cookie: owner, headers: { Origin: 'http://localhost:9999' }, body: { kind: 'asset', name: 'x', balance: 1 } });
  assert.strictEqual(post.status, 403);
  // Embedding the app's script on another site is refused.
  assert.strictEqual((await request('GET', '/app.js', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' } })).status, 403);
  // Framing the app inside another site is refused.
  assert.strictEqual((await request('GET', '/', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' } })).status, 403);
  // The app's own requests still work.
  assert.strictEqual((await request('GET', '/api/data', { cookie: owner, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  // Opening the app from a link or bookmark still works.
  assert.strictEqual((await request('GET', '/', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } })).status, 200);
});

test('a DNS-rebinding website cannot reach the app', async () => {
  assert.strictEqual((await request('GET', '/api/status', { headers: { Host: `attacker.example:${port}` } })).status, 403);
  assert.strictEqual((await request('GET', '/', { headers: { Host: `localhost.attacker.example:${port}` } })).status, 403);
});

test('a wrong passphrase from another program does not kick you out', async () => {
  const res = await request('POST', '/api/unlock', { body: { passphrase: 'a guess from malware' } });
  assert.strictEqual(res.status, 401);
  assert.ok(await ownerOk(), 'owner session must survive a failed guess');
});

test('another program cannot lock you out without your session', async () => {
  await request('POST', '/api/lock', { body: {} });
  await request('POST', '/api/lock', { body: {}, cookie: 'sid=forged-value' });
  assert.ok(await ownerOk(), 'owner session must survive a lock request from outside');
});

test('session cookies are random, HttpOnly, SameSite=Strict and host-only', async () => {
  const a = await request('POST', '/api/unlock', { body: { passphrase: PASS } });
  const header = a.headers['set-cookie'][0];
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.ok(!/Domain=/i.test(header), 'no Domain attribute, so 127.0.0.1 never receives it');
  assert.ok(a.cookie.length > 40);
  // Unlocking again issues a new token and invalidates the old one.
  assert.ok(!(await ownerOk()), 'old session ends when a new one starts');
  owner = a.cookie;
  assert.ok(await ownerOk());
});

test('hostile institution branding from Plaid is dropped', async () => {
  const d = (await request('POST', '/api/exchange', { cookie: owner, body: { publicToken: 'p', institution: { name: 'Bank', institution_id: 'ins_1' } } })).json;
  assert.strictEqual(d.connections[0].logo, null);
  assert.strictEqual(d.connections[0].color, null);
});

test('access tokens and the Plaid secret never appear in any response or in the vault file', async () => {
  for (const [m, p] of [['GET', '/api/data'], ['GET', '/api/settings'], ['GET', '/api/status'], ['POST', '/api/refresh']]) {
    const res = await request(m, p, { cookie: owner, body: m === 'GET' ? undefined : {} });
    assert.ok(!res.text.includes('access-sandbox-SECRET') && !res.text.includes('goodsecret12345'), `${m} ${p}`);
  }
  const raw = fs.readFileSync(vaultPath, 'utf8');
  assert.ok(!raw.includes('access-sandbox-SECRET') && !raw.includes('goodsecret12345') && !raw.includes('client123456'));
});

test('the server refuses to start with certificate checks disabled', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', PORT: '0', VAULT_PATH: vaultPath }, encoding: 'utf8', timeout: 10000,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Refusing to start/);
});
