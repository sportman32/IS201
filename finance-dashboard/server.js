'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');
const { Vault, WrongPassphraseError } = require('./lib/vault');
const { simplifyAccount, summarize } = require('./lib/summary');

const PORT = Number(process.env.PORT || 3000);
const HOST = '127.0.0.1'; // Never listen on the network: only this computer can reach the app.
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';
const IDLE_LOCK_MS = Number(process.env.IDLE_LOCK_MINUTES || 15) * 60 * 1000;
const VAULT_PATH = process.env.VAULT_PATH || path.join(__dirname, 'data', 'vault.json');

if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
  console.error('Missing PLAID_CLIENT_ID / PLAID_SECRET. Copy .env.example to .env and fill them in.');
  process.exit(1);
}
if (!PlaidEnvironments[PLAID_ENV]) {
  console.error(`PLAID_ENV must be one of: ${Object.keys(PlaidEnvironments).join(', ')}`);
  process.exit(1);
}

const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: { 'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID, 'PLAID-SECRET': process.env.PLAID_SECRET },
  },
}));

const vault = new Vault(VAULT_PATH);

// --- Session: one session at a time, held only in memory ---------------------

let session = null; // { token, lastSeen }
let idleTimer = null;
let failedUnlocks = 0;
let unlockInProgress = false;

function lockEverything() {
  vault.lock();
  session = null;
  clearTimeout(idleTimer);
}

function touchSession() {
  session.lastSeen = Date.now();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(lockEverything, IDLE_LOCK_MS);
  idleTimer.unref();
}

function startSession(res) {
  session = { token: crypto.randomBytes(32).toString('base64url') };
  touchSession();
  res.cookie('sid', session.token, { httpOnly: true, sameSite: 'strict', path: '/' });
}

function sessionValid(req) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (!session || !sid || !vault.isUnlocked()) return false;
  const a = Buffer.from(sid);
  const b = Buffer.from(session.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter(([k, v]) => k && v));
}

// --- Middleware --------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

app.use((req, res, next) => {
  // Blocks DNS-rebinding attacks, where a malicious website points its domain at 127.0.0.1.
  if (!allowedHosts.has(req.headers.host)) return res.status(403).send('Forbidden host');
  // Blocks other websites from sending requests to this app (CSRF).
  if (req.method !== 'GET' && req.method !== 'HEAD' && !allowedOrigins.has(req.headers.origin)) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://cdn.plaid.com",
      "frame-src https://cdn.plaid.com",
      "connect-src 'self' https://*.plaid.com",
      "img-src 'self' data:",
      "style-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
});

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireSession(req, res, next) {
  if (!sessionValid(req)) return res.status(401).json({ error: 'Locked' });
  touchSession();
  next();
}

const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// --- Vault / session routes --------------------------------------------------

app.get('/api/status', (req, res) => {
  res.json({ vaultExists: vault.exists(), unlocked: sessionValid(req), plaidEnv: PLAID_ENV });
});

app.post('/api/setup', asyncRoute(async (req, res) => {
  if (vault.exists()) return res.status(409).json({ error: 'Vault already set up.' });
  try {
    await vault.create(req.body?.passphrase);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  startSession(res);
  res.json({ ok: true });
}));

app.post('/api/unlock', asyncRoute(async (req, res) => {
  if (!vault.exists()) return res.status(404).json({ error: 'No vault yet.' });
  if (unlockInProgress) return res.status(429).json({ error: 'Unlock already in progress.' });
  unlockInProgress = true;
  try {
    await attemptUnlock(req, res);
  } finally {
    unlockInProgress = false;
  }
}));

async function attemptUnlock(req, res) {
  // Slow down repeated guesses: 0s, 1s, 2s, 4s ... up to 30s.
  const delay = failedUnlocks ? Math.min(1000 * 2 ** (failedUnlocks - 1), 30000) : 0;
  await new Promise((r) => setTimeout(r, delay));
  try {
    lockEverything();
    await vault.unlock(req.body?.passphrase);
  } catch (err) {
    if (err instanceof WrongPassphraseError) {
      failedUnlocks++;
      return res.status(401).json({ error: 'Wrong passphrase.' });
    }
    throw err;
  }
  failedUnlocks = 0;
  startSession(res);
  res.json({ ok: true });
}

app.post('/api/lock', (req, res) => {
  lockEverything();
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

// --- Plaid routes ------------------------------------------------------------

// Creates a token for Plaid Link (the secure bank-login popup). With an itemId it
// opens Link in "update mode" to re-authenticate a connection that has expired.
app.post('/api/link-token', requireSession, asyncRoute(async (req, res) => {
  const request = {
    user: { client_user_id: 'local-user' },
    client_name: 'My Finance Dashboard',
    country_codes: [CountryCode.Us],
    language: 'en',
  };
  const itemId = req.body?.itemId;
  if (itemId) {
    const item = vault.listItems().find((i) => i.itemId === itemId);
    if (!item) return res.status(404).json({ error: 'Unknown connection.' });
    request.access_token = item.accessToken;
  } else {
    request.products = [Products.Transactions];
  }
  const { data } = await plaid.linkTokenCreate(request);
  res.json({ linkToken: data.link_token });
}));

app.post('/api/exchange', requireSession, asyncRoute(async (req, res) => {
  const publicToken = req.body?.publicToken;
  if (typeof publicToken !== 'string') return res.status(400).json({ error: 'Missing publicToken.' });
  const { data } = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  const institution = req.body?.institution || {};
  vault.addItem({
    itemId: data.item_id,
    accessToken: data.access_token,
    institutionName: String(institution.name || 'Unknown institution').slice(0, 100),
    institutionId: institution.institution_id ? String(institution.institution_id).slice(0, 50) : null,
    addedAt: new Date().toISOString(),
  });
  res.json({ ok: true });
}));

// Fetches balances for every connection. Access tokens never leave the server.
app.get('/api/accounts', requireSession, asyncRoute(async (req, res) => {
  const items = vault.listItems();
  const results = await Promise.all(items.map(async (item) => {
    try {
      const { data } = await plaid.accountsGet({ access_token: item.accessToken });
      return { item, accounts: data.accounts.map((a) => simplifyAccount(a, item.institutionName)) };
    } catch (err) {
      const code = err.response?.data?.error_code || 'UNKNOWN_ERROR';
      console.error(`Plaid error for ${item.institutionName}: ${code}`);
      return { item, accounts: [], error: code };
    }
  }));

  const accounts = results.flatMap((r) => r.accounts);
  res.json({
    updatedAt: new Date().toISOString(),
    totals: summarize(accounts),
    connections: results.map(({ item, accounts: accts, error }) => ({
      itemId: item.itemId,
      institutionName: item.institutionName,
      addedAt: item.addedAt,
      error: error || null,
      needsReconnect: error === 'ITEM_LOGIN_REQUIRED' || error === 'PENDING_EXPIRATION',
      accounts: accts,
    })),
  });
}));

app.delete('/api/items/:itemId', requireSession, asyncRoute(async (req, res) => {
  const item = vault.listItems().find((i) => i.itemId === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Unknown connection.' });
  try {
    // Tells Plaid to revoke the token so it can never be used again.
    await plaid.itemRemove({ access_token: item.accessToken });
  } catch (err) {
    console.error(`Could not revoke at Plaid (${err.response?.data?.error_code || err.message}); removing locally anyway.`);
  }
  vault.removeItem(item.itemId);
  res.json({ ok: true });
}));

// Log only the error code, never request details that could contain tokens.
app.use((err, req, res, next) => {
  const plaidCode = err.response?.data?.error_code;
  console.error('Request failed:', plaidCode || err.message);
  res.status(500).json({ error: plaidCode ? `Plaid error: ${plaidCode}` : 'Internal error' });
});

app.listen(PORT, HOST, () => {
  console.log(`Finance dashboard running at http://localhost:${PORT} (Plaid ${PLAID_ENV})`);
});
