'use strict';

// Local-only finance dashboard server. Uses only Node's built-in modules:
// no third-party code runs in this app.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Vault, WrongPassphraseError } = require('./lib/vault');
const { createPlaidClient, PlaidError, PLAID_ENVS } = require('./lib/plaid');
const { simplifyAccount, simplifyTransaction, simplifyHoldings, simplifyCredit, summarize } = require('./lib/summary');

const HOST = '127.0.0.1'; // Never listen on the network: only this computer can reach the app.
const MAX_BODY_BYTES = 10 * 1024;

// The only files the server will ever send; no path from the URL touches the filesystem.
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://cdn.plaid.com",
    'frame-src https://cdn.plaid.com',
    "connect-src 'self' https://*.plaid.com",
    "img-src 'self' data:",
    "style-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Cache-Control': 'no-store',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createApp({ vaultPath, idleLockMs, vaultOptions }) {
  const vault = new Vault(vaultPath, vaultOptions);

  // --- Session: one session at a time, held only in memory -------------------

  let session = null;
  let idleTimer = null;
  let failedUnlocks = 0;
  let unlockInProgress = false;

  function lockEverything() {
    vault.lock();
    session = null;
    clearTimeout(idleTimer);
  }

  function touchSession() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(lockEverything, idleLockMs);
    idleTimer.unref();
  }

  function startSession(res) {
    session = { token: crypto.randomBytes(32).toString('base64url') };
    touchSession();
    res.setHeader('Set-Cookie', `sid=${session.token}; HttpOnly; SameSite=Strict; Path=/`);
  }

  function sessionValid(req) {
    const sid = parseCookies(req.headers.cookie).sid;
    if (!session || !sid || !vault.isUnlocked()) return false;
    const a = Buffer.from(sid);
    const b = Buffer.from(session.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function requireSession(req) {
    if (!sessionValid(req)) throw new HttpError(401, 'Locked');
    touchSession();
  }

  function plaidClient() {
    const config = vault.getPlaidConfig();
    if (!config) throw new HttpError(400, 'Add your Plaid keys in Settings first.');
    return createPlaidClient(config);
  }

  function findItem(itemId) {
    const item = vault.listItems().find((i) => i.itemId === itemId);
    if (!item) throw new HttpError(404, 'Unknown connection.');
    return item;
  }

  // Tells Plaid to permanently revoke a token. Failures are logged but don't block removal.
  async function revoke(plaid, item) {
    try {
      await plaid.itemRemove({ access_token: item.accessToken });
    } catch (err) {
      console.error(`Could not revoke ${item.institutionName} at Plaid (${err.code || err.message}).`);
    }
  }

  // --- Routes ----------------------------------------------------------------

  const routes = {
    'GET /api/status': async (req) => {
      const unlocked = sessionValid(req);
      const plaid = unlocked ? vault.getPlaidConfig() : null;
      return { vaultExists: vault.exists(), unlocked, plaidEnv: plaid?.env || null };
    },

    'POST /api/setup': async (req, res, body) => {
      if (vault.exists()) throw new HttpError(409, 'Vault already set up.');
      try {
        await vault.create(body.passphrase);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      startSession(res);
      return { ok: true };
    },

    'POST /api/unlock': async (req, res, body) => {
      if (!vault.exists()) throw new HttpError(404, 'No vault yet.');
      if (unlockInProgress) throw new HttpError(429, 'Unlock already in progress.');
      unlockInProgress = true;
      try {
        // Slow down repeated guesses: 0s, 1s, 2s, 4s ... up to 30s.
        const delay = failedUnlocks ? Math.min(1000 * 2 ** (failedUnlocks - 1), 30000) : 0;
        await new Promise((r) => setTimeout(r, delay));
        lockEverything();
        await vault.unlock(String(body.passphrase ?? ''));
      } catch (err) {
        if (!(err instanceof WrongPassphraseError)) throw err;
        failedUnlocks++;
        throw new HttpError(401, 'Wrong passphrase.');
      } finally {
        unlockInProgress = false;
      }
      failedUnlocks = 0;
      startSession(res);
      return { ok: true };
    },

    'POST /api/lock': async (req, res) => {
      lockEverything();
      res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return { ok: true };
    },

    // Never returns the secret itself, only whether one is saved.
    'GET /api/settings': async (req) => {
      requireSession(req);
      const config = vault.getPlaidConfig();
      return { env: config?.env || 'sandbox', clientId: config?.clientId || '', secretSaved: Boolean(config?.secret) };
    },

    'PUT /api/settings': async (req, res, body) => {
      requireSession(req);
      const current = vault.getPlaidConfig();
      const env = body.env;
      const clientId = String(body.clientId ?? '').trim();
      // A blank secret means "keep the saved one" unless the environment changes.
      const secret = String(body.secret ?? '').trim() || (current?.env === env ? current.secret : '');
      if (!PLAID_ENVS.includes(env)) throw new HttpError(400, 'Choose sandbox or production.');
      if (!/^[A-Za-z0-9]{10,64}$/.test(clientId)) throw new HttpError(400, 'That client ID doesn\'t look right.');
      if (!/^[A-Za-z0-9]{10,64}$/.test(secret)) throw new HttpError(400, 'Enter the secret for this environment.');

      // Connections only work in the environment they were made in, so revoke them when switching.
      // Test data (transactions, history) from the old environment is cleared too.
      if (current && current.env !== env) {
        const oldPlaid = createPlaidClient(current);
        await Promise.all(vault.listItems().map((item) => revoke(oldPlaid, item)));
        for (const name of ['cache', 'transactions', 'history', 'meta']) delete vault.data[name];
        vault.clearItems();
      }
      vault.setPlaidConfig({ env, clientId, secret });
      return { ok: true };
    },

    // Creates a token for Plaid Link (the secure bank-login popup). With an itemId it
    // opens Link in "update mode" to re-authenticate a connection that has expired.
    'POST /api/link-token': async (req, res, body) => {
      requireSession(req);
      const plaid = plaidClient();
      const base = {
        user: { client_user_id: 'local-user' },
        client_name: 'My Finance Dashboard',
        country_codes: ['US'],
        language: 'en',
      };
      if (body.itemId) {
        const data = await plaid.linkTokenCreate({ ...base, access_token: findItem(body.itemId).accessToken });
        return { linkToken: data.link_token };
      }
      const kind = body.kind === 'investments' ? 'investments' : 'bank';
      const minimal = { ...base, products: kind === 'investments' ? ['investments'] : ['transactions'] };
      // Banks: ask for 2 years of history and card due dates where the bank supports them.
      const full = kind === 'bank'
        ? { ...minimal, optional_products: ['liabilities'], transactions: { days_requested: 730 } }
        : minimal;
      try {
        return { linkToken: (await plaid.linkTokenCreate(full)).link_token };
      } catch (err) {
        // If Plaid rejects the extras, connecting should still work without them.
        if (full === minimal || err.type !== 'INVALID_REQUEST') throw err;
        console.error(`Link token extras rejected (${err.code}); retrying without them.`);
        return { linkToken: (await plaid.linkTokenCreate(minimal)).link_token };
      }
    },

    'POST /api/exchange': async (req, res, body) => {
      requireSession(req);
      if (typeof body.publicToken !== 'string') throw new HttpError(400, 'Missing publicToken.');
      const plaid = plaidClient();
      const data = await plaid.itemPublicTokenExchange({ public_token: body.publicToken });
      const institution = body.institution || {};
      const item = {
        itemId: data.item_id,
        accessToken: data.access_token,
        kind: body.kind === 'investments' ? 'investments' : 'bank',
        institutionName: String(institution.name || 'Unknown institution').slice(0, 100),
        institutionId: institution.institution_id ? String(institution.institution_id).slice(0, 50) : null,
        logo: null,
        color: null,
        cursor: null,
        addedAt: new Date().toISOString(),
      };
      Object.assign(item, await institutionBranding(plaid, item.institutionId));
      vault.addItem(item);
      await refreshItem(plaid, item);
      recordHistory();
      vault.save();
      return buildState();
    },

    // Everything the dashboard shows, from the encrypted cache (no Plaid calls, so it's instant).
    'GET /api/data': async (req) => {
      requireSession(req);
      return buildState();
    },

    // Fetches fresh balances, holdings, card details and new transactions from Plaid.
    'POST /api/refresh': async (req) => {
      requireSession(req);
      const items = vault.listItems();
      if (items.length) {
        const plaid = plaidClient();
        await Promise.all(items.map((item) => refreshItem(plaid, item)));
      }
      vault.section('meta', {}).lastRefresh = new Date().toISOString();
      recordHistory();
      vault.save();
      return buildState();
    },

    'POST /api/items/remove': async (req, res, body) => {
      requireSession(req);
      const item = findItem(body.itemId);
      await revoke(plaidClient(), item);
      forgetItemData(item.itemId);
      vault.removeItem(item.itemId);
      return buildState();
    },

    // Manual entries: points programs (miles, hotel points) and other assets or debts.
    'PUT /api/manual': async (req, res, body) => {
      requireSession(req);
      const manual = vault.section('manual', []);
      const entry = validateManual(body);
      const existing = manual.findIndex((m) => m.id === body.id);
      if (body.id && existing < 0) throw new HttpError(404, 'Unknown entry.');
      if (existing >= 0) manual[existing] = { ...manual[existing], ...entry };
      else manual.push({ id: crypto.randomUUID(), ...entry });
      recordHistory();
      vault.save();
      return buildState();
    },

    'POST /api/manual/remove': async (req, res, body) => {
      requireSession(req);
      const manual = vault.section('manual', []);
      const index = manual.findIndex((m) => m.id === body.id);
      if (index < 0) throw new HttpError(404, 'Unknown entry.');
      manual.splice(index, 1);
      recordHistory();
      vault.save();
      return buildState();
    },

    // Keeps the session alive while you're actively using the page.
    'POST /api/ping': async (req) => {
      requireSession(req);
      return { ok: true };
    },
  };

  // --- Data ------------------------------------------------------------------

  async function institutionBranding(plaid, institutionId) {
    if (!institutionId) return {};
    try {
      const { institution } = await plaid.institutionsGetById({
        institution_id: institutionId,
        country_codes: ['US'],
        options: { include_optional_metadata: true },
      });
      const logo = typeof institution.logo === 'string' && institution.logo.length < 100000 ? institution.logo : null;
      const color = /^#[0-9a-f]{6}$/i.test(institution.primary_color || '') ? institution.primary_color : null;
      return { logo, color };
    } catch {
      return {};
    }
  }

  // Refreshes one connection. On failure the last known data is kept and the error shown.
  async function refreshItem(plaid, item) {
    const cache = vault.section('cache', {});
    const entry = (cache[item.itemId] ??= { accounts: [], holdings: [], credit: {} });
    const access = { access_token: item.accessToken };
    try {
      if (item.kind === 'investments') {
        const data = await plaid.investmentsHoldingsGet(access);
        entry.accounts = data.accounts.map((a) => simplifyAccount(a, item.institutionName));
        entry.holdings = simplifyHoldings(data);
      } else {
        const data = await plaid.accountsGet(access);
        entry.accounts = data.accounts.map((a) => simplifyAccount(a, item.institutionName));
        entry.credit = await plaid.liabilitiesGet(access).then(simplifyCredit, () => entry.credit || {});
        await syncTransactions(plaid, item);
      }
      entry.error = null;
      entry.fetchedAt = new Date().toISOString();
    } catch (err) {
      entry.error = err.code || 'UNKNOWN_ERROR';
      console.error(`Plaid error for ${item.institutionName}: ${entry.error}`);
    }
  }

  // Pulls only new and changed transactions since the last sync (Plaid's cursor).
  async function syncTransactions(plaid, item) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let cursor = item.cursor;
      const added = [];
      const modified = [];
      const removed = [];
      try {
        let more = true;
        while (more) {
          const data = await plaid.transactionsSync({ access_token: item.accessToken, count: 500, ...(cursor ? { cursor } : {}) });
          added.push(...data.added);
          modified.push(...data.modified);
          removed.push(...data.removed);
          cursor = data.next_cursor;
          more = data.has_more;
        }
      } catch (err) {
        // Data changed mid-way: start this sync over from the saved cursor.
        if (err.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') continue;
        throw err;
      }
      const txns = vault.section('transactions', {});
      for (const t of [...added, ...modified]) txns[t.transaction_id] = simplifyTransaction(t, item.itemId);
      for (const t of removed) delete txns[t.transaction_id];
      item.cursor = cursor || null;
      return;
    }
    throw new PlaidError('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
  }

  function forgetItemData(itemId) {
    delete vault.section('cache', {})[itemId];
    const txns = vault.section('transactions', {});
    for (const [id, t] of Object.entries(txns)) if (t.itemId === itemId) delete txns[id];
  }

  // One snapshot per day of the headline totals, for the net worth chart.
  function recordHistory() {
    const t = currentTotals();
    const history = vault.section('history', []);
    const date = localDate();
    const point = {
      date,
      netWorth: t.netWorth, cash: t.cash, investments: t.investments,
      credit: t.creditCardDebt, loans: t.loans, otherAssets: t.manualAssets + t.other, otherDebts: t.manualDebts,
    };
    if (history.at(-1)?.date === date) history[history.length - 1] = point;
    else history.push(point);
    if (history.length > 1500) history.splice(0, history.length - 1500);
  }

  function allAccounts() {
    const cache = vault.section('cache', {});
    return vault.listItems().flatMap((item) => (cache[item.itemId]?.accounts || []).map((a) => ({
      ...a,
      itemId: item.itemId,
      credit: cache[item.itemId]?.credit?.[a.id] || null,
    })));
  }

  function currentTotals() {
    const totals = summarize(allAccounts(), vault.section('manual', []));
    return totals.USD || { cash: 0, investments: 0, other: 0, creditCardDebt: 0, loans: 0, manualAssets: 0, manualDebts: 0, netWorth: 0 };
  }

  function buildState() {
    const cache = vault.section('cache', {});
    const accounts = allAccounts();
    const manual = vault.section('manual', []);
    return {
      lastRefresh: vault.section('meta', {}).lastRefresh || null,
      plaidEnv: vault.getPlaidConfig()?.env || null,
      connections: vault.listItems().map((item) => {
        const entry = cache[item.itemId] || {};
        return {
          itemId: item.itemId,
          kind: item.kind || 'bank',
          institutionName: item.institutionName,
          logo: item.logo || null,
          color: item.color || null,
          addedAt: item.addedAt,
          fetchedAt: entry.fetchedAt || null,
          error: entry.error || null,
          needsReconnect: entry.error === 'ITEM_LOGIN_REQUIRED' || entry.error === 'PENDING_EXPIRATION',
        };
      }),
      accounts,
      holdings: vault.listItems().flatMap((item) => cache[item.itemId]?.holdings || []),
      totals: summarize(accounts, manual),
      manual,
      history: vault.section('history', []),
      transactions: Object.values(vault.section('transactions', {}))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    };
  }

  function validateManual(body) {
    const kinds = ['points', 'asset', 'liability'];
    if (!kinds.includes(body.kind)) throw new HttpError(400, 'Choose points, asset or debt.');
    const name = String(body.name ?? '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Give it a name.');
    const balance = Number(body.balance);
    if (!Number.isFinite(balance) || Math.abs(balance) > 1e12) throw new HttpError(400, 'Enter a valid balance.');
    const entry = { kind: body.kind, name, balance, updatedAt: new Date().toISOString() };
    if (body.kind === 'points') {
      const cpp = body.centsPerPoint === '' || body.centsPerPoint == null ? null : Number(body.centsPerPoint);
      if (cpp !== null && (!Number.isFinite(cpp) || cpp < 0 || cpp > 100)) throw new HttpError(400, 'Value per point must be 0–100 cents.');
      entry.centsPerPoint = cpp;
      entry.unit = String(body.unit ?? 'points').trim().slice(0, 20) || 'points';
    }
    return entry;
  }

  // --- Request handling ------------------------------------------------------

  async function handle(req, res) {
    const port = req.socket.localPort;
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    // Blocks DNS-rebinding attacks, where a malicious website points its domain at 127.0.0.1.
    const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (!allowedHosts.includes(req.headers.host)) throw new HttpError(403, 'Forbidden host');

    const { pathname } = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && STATIC_FILES[pathname]) {
      const [file, type] = STATIC_FILES[pathname];
      res.writeHead(200, { 'Content-Type': type });
      res.end(fs.readFileSync(path.join(PUBLIC_DIR, file)));
      return;
    }

    const route = routes[`${req.method} ${pathname}`];
    if (!route) throw new HttpError(404, 'Not found');

    let body = {};
    if (req.method !== 'GET') {
      // Blocks other websites from sending requests to this app (CSRF).
      if (!allowedHosts.map((h) => `http://${h}`).includes(req.headers.origin)) {
        throw new HttpError(403, 'Forbidden origin');
      }
      body = await readJson(req);
    }
    sendJson(res, 200, await route(req, res, body));
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof PlaidError) {
        // Log only the error code, never request details that could contain tokens.
        console.error('Plaid request failed:', err.code);
        const hint = err.code === 'INVALID_API_KEYS' ? ' Check your Plaid keys in Settings.' : '';
        return sendJson(res, 502, { error: `Plaid error: ${err.code}.${hint}` });
      }
      console.error('Request failed:', err.message);
      sendJson(res, 500, { error: 'Internal error' });
    });
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
      return reject(new HttpError(415, 'Expected JSON'));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // Keep reading (and discarding) so the 413 reply reaches the client.
      if (size > MAX_BODY_BYTES) reject(new HttpError(413, 'Request too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter(([k, v]) => k && v));
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp({
    vaultPath: process.env.VAULT_PATH || path.join(__dirname, 'data', 'vault.json'),
    idleLockMs: Number(process.env.IDLE_LOCK_MINUTES || 15) * 60 * 1000,
  });
  const url = `http://localhost:${port}`;
  const openBrowser = process.argv.includes('--open');

  app.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && openBrowser) {
      // Double-clicked the start file again: the app is already running, so just show it.
      console.log(`Finance dashboard is already running. Opening ${url}`);
      openInBrowser(url);
      return;
    }
    if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Is the app already running?`);
    else console.error(err.message);
    process.exit(1);
  });

  app.listen(port, HOST, () => {
    console.log(`Finance dashboard running at ${url}`);
    console.log('Press Ctrl+C to stop.');
    if (openBrowser) openInBrowser(url);
  });
}

// Opens the default browser. The URL is built from a number, never from user input.
function openInBrowser(url) {
  const command = { win32: 'explorer.exe', darwin: 'open' }[process.platform] || 'xdg-open';
  spawn(command, [url], { detached: true, stdio: 'ignore' }).on('error', () => {
    console.log(`Open ${url} in your browser.`);
  }).unref();
}

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
