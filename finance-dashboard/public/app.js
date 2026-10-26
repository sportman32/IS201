'use strict';

const $ = (id) => document.getElementById(id);
let vaultExists = false;
let linkOpen = false;

// Lock after this long with the tab in the background (switched away or minimized).
const AWAY_LOCK_MS = 60 * 1000;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/unlock') {
    showLockScreen();
    throw new Error('Locked');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const money = (n, currency = 'USD') =>
  n == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);

// Builds DOM elements; text is always set via textContent so bank data can't inject HTML.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// --- Lock screen -------------------------------------------------------------

function showLockScreen() {
  $('dashboard').hidden = true;
  $('settings').hidden = true;
  $('totals').replaceChildren();
  $('connections').replaceChildren();
  $('lock-screen').hidden = false;
  $('confirm-row').hidden = vaultExists;
  $('strength').hidden = vaultExists;
  $('passphrase-confirm').required = !vaultExists;
  $('passphrase').minLength = vaultExists ? 1 : 16;
  $('passphrase').autocomplete = vaultExists ? 'current-password' : 'new-password';
  $('lock-intro').textContent = vaultExists
    ? 'Enter your passphrase to unlock.'
    : 'Create a passphrase of at least 16 characters. Several random words work well, e.g. "maple orbit candle frozen tiger". '
      + 'It encrypts your Plaid keys and bank connections. It can\'t be recovered, so save it in a password manager.';
  $('lock-submit').textContent = vaultExists ? 'Unlock' : 'Create vault';
  $('passphrase').value = '';
  $('passphrase-confirm').value = '';
  $('strength').textContent = '';
  $('passphrase').focus();
}

// Rough strength estimate shown while creating a passphrase. The server enforces the real rules.
function passphraseStrength(p) {
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/[0-9]/.test(p)) pool += 10;
  if (/[^A-Za-z0-9]/.test(p)) pool += 33;
  const bits = Math.round(p.length * Math.log2(pool || 1) * Math.min(1, new Set(p).size / 10));
  if (p.length < 16) return ['weak', `Too short: ${p.length}/16 characters`];
  if (new Set(p).size < 8) return ['weak', 'Too repetitive'];
  if (bits < 80) return ['ok', 'Okay. Longer is better'];
  return ['strong', 'Strong'];
}

$('passphrase').addEventListener('input', () => {
  if (vaultExists) return;
  const [level, label] = passphraseStrength($('passphrase').value);
  $('strength').className = `strength ${level}`;
  $('strength').textContent = $('passphrase').value ? label : '';
});

$('lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('lock-error').textContent = '';
  const passphrase = $('passphrase').value;
  if (!vaultExists && passphrase !== $('passphrase-confirm').value) {
    $('lock-error').textContent = 'Passphrases do not match.';
    return;
  }
  $('lock-submit').disabled = true;
  try {
    await api('POST', vaultExists ? '/api/unlock' : '/api/setup', { passphrase });
    vaultExists = true;
    $('passphrase').value = '';
    $('passphrase-confirm').value = '';
    showDashboard();
  } catch (err) {
    $('lock-error').textContent = err.message;
  } finally {
    $('lock-submit').disabled = false;
  }
});

// --- Dashboard ---------------------------------------------------------------

async function showDashboard() {
  $('lock-screen').hidden = true;
  $('dashboard').hidden = false;
  const settings = await loadSettings();
  if (!settings) return;
  if (!settings.secretSaved) {
    openSettings('Add your Plaid keys to get started. They are stored encrypted in your vault.');
    return;
  }
  await loadAccounts();
}

async function loadAccounts() {
  $('dash-error').textContent = '';
  $('refresh-btn').disabled = true;
  try {
    const data = await api('GET', '/api/accounts');
    renderTotals(data.totals);
    renderConnections(data.connections);
    $('updated-at').textContent = `Updated ${new Date(data.updatedAt).toLocaleString()}`;
  } catch (err) {
    if (err.message !== 'Locked') $('dash-error').textContent = err.message;
  } finally {
    $('refresh-btn').disabled = false;
  }
}

function card(label, value, cls = '', note = null) {
  return el('div', { class: `card ${cls}` },
    el('div', { class: 'card-label' }, label),
    el('div', { class: 'card-value' }, value),
    note && el('div', { class: 'card-note' }, note));
}

function renderTotals(totals) {
  const box = $('totals');
  box.replaceChildren();
  for (const [currency, t] of Object.entries(totals)) {
    const suffix = Object.keys(totals).length > 1 ? ` (${currency})` : '';
    box.append(
      card(`Net worth${suffix}`, money(t.netWorth, currency), t.netWorth < 0 ? 'negative' : 'positive'),
      card(`Cash${suffix}`, money(t.cash, currency)),
      card(`Credit card balances${suffix}`, money(t.creditCardDebt, currency), 'negative',
        t.creditUtilization != null ? `${t.creditUtilization}% of ${money(t.creditLimit, currency)} limit used` : null),
    );
    if (t.investments) box.append(card(`Investments${suffix}`, money(t.investments, currency)));
    if (t.loans) box.append(card(`Loans${suffix}`, money(t.loans, currency), 'negative'));
  }
}

function renderConnections(connections) {
  const box = $('connections');
  box.replaceChildren();
  $('empty-state').hidden = connections.length > 0;

  for (const c of connections) {
    const header = el('div', { class: 'conn-header' },
      el('h2', {}, c.institutionName),
      el('div', { class: 'actions' },
        c.needsReconnect && el('button', { onclick: () => openLink(c.itemId) }, 'Reconnect'),
        el('button', { class: 'secondary small', onclick: () => removeConnection(c) }, 'Remove')));

    const rows = c.accounts.map((a) => el('tr', {},
      el('td', {}, a.name, a.mask && el('span', { class: 'muted' }, ` ••${a.mask}`)),
      el('td', { class: 'muted' }, a.subtype || a.type),
      el('td', { class: `num ${['credit', 'loans'].includes(a.category) ? 'negative' : ''}` }, money(a.current, a.currency)),
      el('td', { class: 'num muted' },
        a.category === 'credit' && a.limit != null ? `limit ${money(a.limit, a.currency)}`
          : a.available != null ? `available ${money(a.available, a.currency)}` : '')));

    box.append(el('section', { class: 'connection' },
      header,
      c.error && el('p', { class: 'error' },
        c.needsReconnect ? 'This bank needs you to log in again. Click Reconnect.' : `Could not load (${c.error}).`),
      rows.length > 0 && el('table', {}, el('tbody', {}, ...rows))));
  }
}

async function removeConnection(c) {
  if (!confirm(`Remove ${c.institutionName}? Its access will be revoked.`)) return;
  try {
    await api('POST', '/api/items/remove', { itemId: c.itemId });
    await loadAccounts();
  } catch (err) {
    $('dash-error').textContent = err.message;
  }
}

// Opens Plaid Link. You type your bank login into Plaid's window, never this app's.
async function openLink(itemId) {
  $('dash-error').textContent = '';
  if (typeof Plaid === 'undefined') {
    $('dash-error').textContent = 'Could not load the Plaid login window. Check your internet connection or ad blocker.';
    return;
  }
  try {
    const { linkToken } = await api('POST', '/api/link-token', itemId ? { itemId } : {});
    const handler = Plaid.create({
      token: linkToken,
      onSuccess: async (publicToken, metadata) => {
        linkOpen = false;
        try {
          if (!itemId) await api('POST', '/api/exchange', { publicToken, institution: metadata.institution });
          await loadAccounts();
        } catch (err) {
          $('dash-error').textContent = err.message;
        }
      },
      onExit: (err) => {
        linkOpen = false;
        if (err) $('dash-error').textContent = err.display_message || err.error_message || 'Connection cancelled.';
      },
    });
    linkOpen = true;
    handler.open();
  } catch (err) {
    if (err.message !== 'Locked') $('dash-error').textContent = err.message;
  }
}

// --- Settings (Plaid keys) ---------------------------------------------------

let savedEnv = null;

async function loadSettings() {
  try {
    const s = await api('GET', '/api/settings');
    savedEnv = s.secretSaved ? s.env : null;
    $('env-banner').textContent = savedEnv === 'sandbox'
      ? 'Sandbox mode: fake test banks only. Use username "user_good" / password "pass_good".'
      : '';
    $('plaid-env').value = s.env;
    $('plaid-client-id').value = s.clientId;
    $('plaid-secret').value = '';
    $('plaid-secret').placeholder = s.secretSaved ? 'Saved. Leave blank to keep it' : '';
    return s;
  } catch (err) {
    if (err.message !== 'Locked') $('dash-error').textContent = err.message;
    return null;
  }
}

function openSettings(message = '') {
  $('settings-intro').textContent = message;
  $('settings-error').textContent = '';
  $('settings').hidden = false;
  $('plaid-client-id').focus();
}

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('settings-error').textContent = '';
  const env = $('plaid-env').value;
  if (savedEnv && env !== savedEnv
    && !confirm(`Switching to ${env} removes and revokes all connected accounts. Continue?`)) return;
  try {
    await api('PUT', '/api/settings', { env, clientId: $('plaid-client-id').value, secret: $('plaid-secret').value });
    $('plaid-secret').value = '';
    $('settings').hidden = true;
    await loadSettings();
    await loadAccounts();
  } catch (err) {
    if (err.message !== 'Locked') $('settings-error').textContent = err.message;
  }
});

$('settings-cancel').addEventListener('click', () => { $('settings').hidden = true; });

// --- Locking -----------------------------------------------------------------

async function lockNow() {
  clearTimeout(awayTimer);
  await api('POST', '/api/lock').catch(() => {});
  showLockScreen();
}

// Closing, reloading or navigating away from the tab locks immediately.
// keepalive lets the request finish even as the page unloads.
window.addEventListener('pagehide', () => {
  fetch('/api/lock', {
    method: 'POST', keepalive: true, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
});

// Leaving the tab in the background locks after AWAY_LOCK_MS. Plaid's login
// window can briefly background the tab, so that doesn't count.
let awayTimer = null;
let hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if ($('dashboard').hidden) return;
  if (document.visibilityState === 'hidden') {
    if (linkOpen) return;
    hiddenAt = Date.now();
    awayTimer = setTimeout(lockNow, AWAY_LOCK_MS);
  } else {
    clearTimeout(awayTimer);
    // Background tabs can delay timers, so also check how long we were away.
    if (hiddenAt && Date.now() - hiddenAt >= AWAY_LOCK_MS) lockNow();
    hiddenAt = null;
  }
});

$('connect-btn').addEventListener('click', () => openLink());
$('refresh-btn').addEventListener('click', loadAccounts);
$('settings-btn').addEventListener('click', () => openSettings());
$('lock-btn').addEventListener('click', lockNow);

// --- Startup -----------------------------------------------------------------

(async () => {
  const status = await api('GET', '/api/status');
  vaultExists = status.vaultExists;
  if (status.unlocked) showDashboard();
  else showLockScreen();
})();
