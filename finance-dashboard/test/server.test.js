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
const fake = {
  // Transaction sync pages, consumed in order; each call returns the next page.
  syncPages: [],
  rejectLinkExtras: false,
};
const txn = (id, amount, extra = {}) => ({
  transaction_id: id, account_id: 'a1', amount, date: '2026-10-20', authorized_date: null, name: `Txn ${id}`,
  merchant_name: 'Coffee Co', pending: false, payment_channel: 'in store', iso_currency_code: 'USD',
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' }, ...extra,
});

global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const endpoint = new URL(url).pathname;
  plaidCalls.push({ url, endpoint, body });
  const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
  if (body.secret !== 'goodsecret12345') return reply(400, { error_code: 'INVALID_API_KEYS', error_type: 'INVALID_INPUT' });
  switch (endpoint) {
    case '/link/token/create':
      if (fake.rejectLinkExtras && (body.optional_products || body.transactions)) {
        return reply(400, { error_code: 'INVALID_FIELD', error_type: 'INVALID_REQUEST' });
      }
      return reply(200, { link_token: 'link-sandbox-123' });
    case '/item/public_token/exchange':
      return reply(200, { item_id: `item-${body.public_token}`, access_token: `access-sandbox-SECRET-${body.public_token}` });
    case '/institutions/get_by_id':
      return reply(200, { institution: { name: 'Test Bank', logo: 'iVBORw0KGgo=', primary_color: '#123abc' } });
    case '/item/remove': return reply(200, {});
    case '/accounts/get': return reply(200, { accounts: [
      { account_id: 'a1', name: 'Checking', mask: '0001', type: 'depository', subtype: 'checking', balances: { current: 1000, iso_currency_code: 'USD' } },
      { account_id: 'a2', name: 'Card', mask: '4455', type: 'credit', subtype: 'credit card', balances: { current: 250, limit: 1000, iso_currency_code: 'USD' } },
    ] });
    case '/liabilities/get': return reply(200, { liabilities: { credit: [{
      account_id: 'a2', aprs: [{ apr_type: 'purchase_apr', apr_percentage: 24.99 }], minimum_payment_amount: 35,
      next_payment_due_date: '2026-11-15', last_statement_balance: 240, is_overdue: false,
    }] } });
    case '/transactions/sync': {
      const page = fake.syncPages.shift() || { added: [], modified: [], removed: [], next_cursor: body.cursor || 'c0', has_more: false };
      if (page.error) return reply(400, { error_code: page.error, error_type: 'TRANSACTIONS_ERROR' });
      return reply(200, page);
    }
    case '/investments/holdings/get': return reply(200, {
      accounts: [{ account_id: 'inv1', name: 'Brokerage', mask: '9999', type: 'investment', subtype: 'brokerage', balances: { current: 1500, iso_currency_code: 'USD' } }],
      holdings: [{ account_id: 'inv1', security_id: 's1', quantity: 10, institution_price: 150, institution_value: 1500, cost_basis: 1000, iso_currency_code: 'USD' }],
      securities: [{ security_id: 's1', name: 'Vanguard Total Stock Market ETF', ticker_symbol: 'VTI', type: 'etf', close_price: 150 }],
    });
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

test('link token asks for 2 years of history and card details, and retries without them if rejected', async () => {
  plaidCalls.length = 0;
  assert.strictEqual((await request('POST', '/api/link-token', { body: { kind: 'bank' } })).json.linkToken, 'link-sandbox-123');
  const first = plaidCalls.find((c) => c.endpoint === '/link/token/create').body;
  assert.deepStrictEqual(first.products, ['transactions']);
  assert.deepStrictEqual(first.optional_products, ['liabilities']);
  assert.strictEqual(first.transactions.days_requested, 730);

  fake.rejectLinkExtras = true;
  plaidCalls.length = 0;
  assert.strictEqual((await request('POST', '/api/link-token', { body: { kind: 'bank' } })).status, 200);
  const calls = plaidCalls.filter((c) => c.endpoint === '/link/token/create');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].body.optional_products, undefined);
  fake.rejectLinkExtras = false;

  plaidCalls.length = 0;
  await request('POST', '/api/link-token', { body: { kind: 'investments' } });
  assert.deepStrictEqual(plaidCalls[0].body.products, ['investments']);
});

test('connecting syncs balances, card details and transactions without exposing tokens', async () => {
  fake.syncPages.push(
    { added: [txn('t1', 4.5), txn('t2', 12)], modified: [], removed: [], next_cursor: 'c1', has_more: true },
    { added: [txn('t3', -2000, { name: 'Payroll', merchant_name: null, personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_WAGES' } })], modified: [], removed: [], next_cursor: 'c2', has_more: false },
  );
  const res = await request('POST', '/api/exchange', { body: { publicToken: 'p1', institution: { name: 'Test Bank', institution_id: 'ins_1' } } });
  assert.strictEqual(res.status, 200);
  const d = res.json;
  assert.strictEqual(d.totals.USD.netWorth, 750);
  assert.strictEqual(d.totals.USD.creditUtilization, 25);
  assert.strictEqual(d.connections[0].logo, 'iVBORw0KGgo=');
  assert.strictEqual(d.connections[0].color, '#123abc');
  assert.strictEqual(d.accounts.find((a) => a.id === 'a2').credit.apr, 24.99);
  assert.strictEqual(d.accounts.find((a) => a.id === 'a2').credit.dueDate, '2026-11-15');
  assert.deepStrictEqual(d.transactions.map((t) => t.id).sort(), ['t1', 't2', 't3']);
  assert.strictEqual(d.transactions.find((t) => t.id === 't3').category, 'INCOME');
  assert.strictEqual(d.history.length, 1);
  assert.strictEqual(d.history[0].netWorth, 750);
  assert.ok(!res.text.includes('access-sandbox-SECRET'), 'access token must never reach the browser');
  const raw = fs.readFileSync(vaultPath, 'utf8');
  assert.ok(!raw.includes('access-sandbox-SECRET') && !raw.includes('Coffee Co'), 'vault must be encrypted');
});

test('refresh applies added, modified and removed transactions from the saved cursor', async () => {
  plaidCalls.length = 0;
  fake.syncPages.push({ added: [txn('t4', 8)], modified: [txn('t1', 5.25)], removed: [{ transaction_id: 't2' }], next_cursor: 'c3', has_more: false });
  const d = (await request('POST', '/api/refresh', { body: {} })).json;
  assert.strictEqual(plaidCalls.find((c) => c.endpoint === '/transactions/sync').body.cursor, 'c2');
  assert.deepStrictEqual(d.transactions.map((t) => t.id).sort(), ['t1', 't3', 't4']);
  assert.strictEqual(d.transactions.find((t) => t.id === 't1').amount, 5.25);
  assert.ok(d.lastRefresh);
});

test('a sync interrupted by changing data restarts from the saved cursor', async () => {
  plaidCalls.length = 0;
  fake.syncPages.push(
    { added: [txn('t5', 1)], modified: [], removed: [], next_cursor: 'c4', has_more: true },
    { error: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' },
    { added: [txn('t5', 1), txn('t6', 2)], modified: [], removed: [], next_cursor: 'c5', has_more: false },
  );
  const d = (await request('POST', '/api/refresh', { body: {} })).json;
  const cursors = plaidCalls.filter((c) => c.endpoint === '/transactions/sync').map((c) => c.body.cursor);
  assert.deepStrictEqual(cursors, ['c3', 'c4', 'c3']);
  assert.ok(d.transactions.some((t) => t.id === 't6'));
  assert.strictEqual(d.connections[0].error, null);
});

test('cached data loads without calling Plaid', async () => {
  plaidCalls.length = 0;
  const d = (await request('GET', '/api/data')).json;
  assert.strictEqual(plaidCalls.length, 0);
  assert.strictEqual(d.accounts.length, 2);
});

test('investment accounts show holdings with cost basis', async () => {
  const d = (await request('POST', '/api/exchange', { body: { publicToken: 'inv', kind: 'investments', institution: { name: 'Broker' } } })).json;
  assert.strictEqual(d.connections.find((c) => c.itemId === 'item-inv').kind, 'investments');
  assert.deepStrictEqual(d.holdings[0], {
    accountId: 'inv1', securityId: 's1', name: 'Vanguard Total Stock Market ETF', ticker: 'VTI', type: 'etf',
    quantity: 10, price: 150, value: 1500, costBasis: 1000, currency: 'USD',
  });
  assert.strictEqual(d.totals.USD.investments, 1500);
  assert.strictEqual(d.totals.USD.netWorth, 2250);
});

test('manual points, assets and debts', async () => {
  let d = (await request('PUT', '/api/manual', { body: { kind: 'points', name: 'Delta SkyMiles', balance: '84500', unit: 'miles', centsPerPoint: '1.2' } })).json;
  const miles = d.manual.find((m) => m.name === 'Delta SkyMiles');
  assert.strictEqual(miles.balance, 84500);
  assert.strictEqual(miles.centsPerPoint, 1.2);
  assert.strictEqual(d.totals.USD.netWorth, 2250, 'points are not counted in net worth');

  d = (await request('PUT', '/api/manual', { body: { kind: 'asset', name: 'Car', balance: 20000 } })).json;
  d = (await request('PUT', '/api/manual', { body: { kind: 'liability', name: 'Car loan', balance: 5000 } })).json;
  assert.strictEqual(d.totals.USD.netWorth, 2250 + 20000 - 5000);

  d = (await request('PUT', '/api/manual', { body: { id: miles.id, kind: 'points', name: 'Delta SkyMiles', balance: 90000, unit: 'miles', centsPerPoint: 1.2 } })).json;
  assert.strictEqual(d.manual.find((m) => m.id === miles.id).balance, 90000);
  assert.strictEqual(d.manual.length, 3);

  const car = d.manual.find((m) => m.name === 'Car');
  d = (await request('POST', '/api/manual/remove', { body: { id: car.id } })).json;
  assert.strictEqual(d.totals.USD.netWorth, 2250 - 5000);

  for (const bad of [{ kind: 'stocks', name: 'x', balance: 1 }, { kind: 'asset', name: '', balance: 1 }, { kind: 'asset', name: 'x', balance: 'abc' },
    { kind: 'points', name: 'x', balance: 1, centsPerPoint: 500 }]) {
    assert.strictEqual((await request('PUT', '/api/manual', { body: bad })).status, 400, JSON.stringify(bad));
  }
  assert.strictEqual((await request('PUT', '/api/manual', { body: { id: 'nope', kind: 'asset', name: 'x', balance: 1 } })).status, 404);
  assert.ok(!fs.readFileSync(vaultPath, 'utf8').includes('SkyMiles'));
});

test('history keeps one point per day', async () => {
  const d = (await request('GET', '/api/data')).json;
  assert.strictEqual(d.history.length, 1);
  assert.strictEqual(d.history[0].netWorth, d.totals.USD.netWorth);
});

test('keeps the saved secret when left blank', async () => {
  const res = await request('PUT', '/api/settings', { body: { env: 'sandbox', clientId: 'client123456', secret: '' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await request('GET', '/api/data')).json.connections.length, 2);
});

test('lock ends the session', async () => {
  const saved = cookie;
  await request('POST', '/api/lock', { body: {} });
  cookie = saved; // Even a stolen old cookie no longer works.
  for (const [m, p] of [['GET', '/api/data'], ['GET', '/api/settings'], ['POST', '/api/refresh'], ['PUT', '/api/manual'], ['POST', '/api/ping']]) {
    assert.strictEqual((await request(m, p, { body: m === 'GET' ? undefined : {} })).status, 401, `${m} ${p}`);
  }
});

test('wrong passphrase is rejected; right one unlocks', async () => {
  assert.strictEqual((await request('POST', '/api/unlock', { body: { passphrase: 'wrong passphrase here' } })).status, 401);
  assert.strictEqual((await request('POST', '/api/unlock', { body: { passphrase: 'correct horse battery' } })).status, 200);
  const d = (await request('GET', '/api/data')).json;
  assert.strictEqual(d.connections.length, 2);
  assert.ok(d.transactions.length > 0);
});

test('removing a connection revokes it and deletes its data', async () => {
  plaidCalls.length = 0;
  const d = (await request('POST', '/api/items/remove', { body: { itemId: 'item-p1' } })).json;
  assert.ok(plaidCalls.some((c) => c.endpoint === '/item/remove' && c.body.access_token === 'access-sandbox-SECRET-p1'));
  assert.deepStrictEqual(d.connections.map((c) => c.itemId), ['item-inv']);
  assert.strictEqual(d.transactions.length, 0);
  assert.ok(d.accounts.every((a) => a.itemId === 'item-inv'));
});

test('switching environment revokes connections and clears test data but keeps manual entries', async () => {
  plaidCalls.length = 0;
  const res = await request('PUT', '/api/settings', { body: { env: 'production', clientId: 'client123456', secret: 'goodsecret12345' } });
  assert.strictEqual(res.status, 200);
  const revoke = plaidCalls.find((c) => c.endpoint === '/item/remove');
  assert.ok(revoke && revoke.url.startsWith('https://sandbox.plaid.com'), 'old token revoked with old environment');
  const d = (await request('GET', '/api/data')).json;
  assert.strictEqual(d.connections.length, 0);
  assert.strictEqual(d.holdings.length, 0);
  assert.strictEqual(d.manual.length, 2);
  assert.strictEqual(d.plaidEnv, 'production');
});

test('bad Plaid keys give a helpful error', async () => {
  await request('PUT', '/api/settings', { body: { env: 'production', clientId: 'client123456', secret: 'wrongsecret12345' } });
  const res = await request('POST', '/api/link-token', { body: {} });
  assert.strictEqual(res.status, 502);
  assert.match(res.json.error, /INVALID_API_KEYS.*Settings/);
});
