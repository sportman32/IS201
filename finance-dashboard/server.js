'use strict';

// Local-only finance dashboard server. Uses only Node's built-in modules:
// no third-party code runs in this app.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Vault, WrongPassphraseError } = require('./lib/vault');
const { createPlaidClient, PlaidError, PLAID_ENVS } = require('./lib/plaid');
const { simplifyAccount, summarize } = require('./lib/summary');

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
      if (current && current.env !== env) {
        const oldPlaid = createPlaidClient(current);
        await Promise.all(vault.listItems().map((item) => revoke(oldPlaid, item)));
        vault.clearItems();
      }
      vault.setPlaidConfig({ env, clientId, secret });
      return { ok: true };
    },

    // Creates a token for Plaid Link (the secure bank-login popup). With an itemId it
    // opens Link in "update mode" to re-authenticate a connection that has expired.
    'POST /api/link-token': async (req, res, body) => {
      requireSession(req);
      const request = {
        user: { client_user_id: 'local-user' },
        client_name: 'My Finance Dashboard',
        country_codes: ['US'],
        language: 'en',
      };
      if (body.itemId) request.access_token = findItem(body.itemId).accessToken;
      else request.products = ['transactions'];
      const data = await plaidClient().linkTokenCreate(request);
      return { linkToken: data.link_token };
    },

    'POST /api/exchange': async (req, res, body) => {
      requireSession(req);
      if (typeof body.publicToken !== 'string') throw new HttpError(400, 'Missing publicToken.');
      const data = await plaidClient().itemPublicTokenExchange({ public_token: body.publicToken });
      const institution = body.institution || {};
      vault.addItem({
        itemId: data.item_id,
        accessToken: data.access_token,
        institutionName: String(institution.name || 'Unknown institution').slice(0, 100),
        institutionId: institution.institution_id ? String(institution.institution_id).slice(0, 50) : null,
        addedAt: new Date().toISOString(),
      });
      return { ok: true };
    },

    // Fetches balances for every connection. Access tokens never leave the server.
    'GET /api/accounts': async (req) => {
      requireSession(req);
      const items = vault.listItems();
      const plaid = items.length ? plaidClient() : null;
      const results = await Promise.all(items.map(async (item) => {
        try {
          const data = await plaid.accountsGet({ access_token: item.accessToken });
          return { item, accounts: data.accounts.map((a) => simplifyAccount(a, item.institutionName)) };
        } catch (err) {
          const code = err.code || 'UNKNOWN_ERROR';
          console.error(`Plaid error for ${item.institutionName}: ${code}`);
          return { item, accounts: [], error: code };
        }
      }));

      return {
        updatedAt: new Date().toISOString(),
        totals: summarize(results.flatMap((r) => r.accounts)),
        connections: results.map(({ item, accounts, error }) => ({
          itemId: item.itemId,
          institutionName: item.institutionName,
          addedAt: item.addedAt,
          error: error || null,
          needsReconnect: error === 'ITEM_LOGIN_REQUIRED' || error === 'PENDING_EXPIRATION',
          accounts,
        })),
      };
    },

    'POST /api/items/remove': async (req, res, body) => {
      requireSession(req);
      const item = findItem(body.itemId);
      await revoke(plaidClient(), item);
      vault.removeItem(item.itemId);
      return { ok: true };
    },
  };

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
  app.listen(port, HOST, () => {
    console.log(`Finance dashboard running at http://localhost:${port}`);
    console.log('Press Ctrl+C to stop.');
  });
}
