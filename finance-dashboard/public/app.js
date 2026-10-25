'use strict';

const $ = (id) => document.getElementById(id);
let vaultExists = false;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
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
  $('lock-screen').hidden = false;
  $('confirm-row').hidden = vaultExists;
  $('passphrase-confirm').required = !vaultExists;
  $('lock-intro').textContent = vaultExists
    ? 'Enter your passphrase to unlock.'
    : 'Create a passphrase (12+ characters). It encrypts your saved bank connections. It cannot be recovered if you forget it. You would just reconnect your accounts.';
  $('lock-submit').textContent = vaultExists ? 'Unlock' : 'Create vault';
  $('passphrase').value = '';
  $('passphrase-confirm').value = '';
  $('passphrase').focus();
}

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
    await api('DELETE', `/api/items/${encodeURIComponent(c.itemId)}`);
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
        try {
          if (!itemId) await api('POST', '/api/exchange', { publicToken, institution: metadata.institution });
          await loadAccounts();
        } catch (err) {
          $('dash-error').textContent = err.message;
        }
      },
      onExit: (err) => { if (err) $('dash-error').textContent = err.display_message || err.error_message || 'Connection cancelled.'; },
    });
    handler.open();
  } catch (err) {
    if (err.message !== 'Locked') $('dash-error').textContent = err.message;
  }
}

$('connect-btn').addEventListener('click', () => openLink());
$('refresh-btn').addEventListener('click', loadAccounts);
$('lock-btn').addEventListener('click', async () => {
  await api('POST', '/api/lock').catch(() => {});
  $('totals').replaceChildren();
  $('connections').replaceChildren();
  showLockScreen();
});

// --- Startup -----------------------------------------------------------------

(async () => {
  const status = await api('GET', '/api/status');
  vaultExists = status.vaultExists;
  $('env-banner').textContent = status.plaidEnv === 'sandbox'
    ? 'Sandbox mode: fake test banks only. Use username "user_good" / password "pass_good".'
    : '';
  if (status.unlocked) showDashboard();
  else showLockScreen();
})();
