'use strict';

// My Finances: single-page dashboard. Everything is rendered with DOM APIs and
// textContent, so bank-provided text can never inject HTML.

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

// Lock after this long with the tab in the background (switched away or minimized).
const AWAY_LOCK_MS = 60 * 1000;
// Refresh from the banks automatically when the cached data is older than this.
const STALE_MS = 30 * 60 * 1000;

let vaultExists = false;
let linkOpen = false;
let data = null; // Everything from /api/data. Wiped on lock.

const ui = {
  view: 'overview',
  nwRange: '3M',
  tx: { q: '', range: '90', account: '', category: '', type: 'all' },
  txLimit: 150,
  spend: null, // 'this' or 'last' month; chosen automatically until you pick
  refreshing: false,
};

// ============================================================ helpers

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/unlock') {
    showLockScreen();
    throw new Error('Locked');
  }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  setAttrs(node, attrs);
  append(node, children);
  return node;
}

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  setAttrs(node, attrs);
  append(node, children);
  return node;
}

function setAttrs(node, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.setAttribute('class', v);
    else if (k === 'style') Object.assign(node.style, v); // CSSOM, allowed by the strict CSP
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zm13 7h.01',
  chart: 'M3 3v18h18M7 15l4-4 3 3 6-6',
  gift: 'M20 12v9H4v-9M2 7h20v5H2zM12 21V7m0 0H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7zm0 0h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.2-1.3L14.4 3h-4l-.4 2.4a7.6 7.6 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.2 1.3l.4 2.4h4l.4-2.4a7.6 7.6 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3z',
  lock: 'M6 11V8a6 6 0 1 1 12 0v3M5 11h14v10H5z',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm10 3-5-5',
  download: 'M12 3v12m0 0 5-5m-5 5-5-5M4 21h16',
  x: 'M18 6 6 18M6 6l12 12',
  chevron: 'M9 6l6 6-6 6',
  bank: 'M3 10h18M5 10v8m4-8v8m6-8v8m4-8v8M3 21h18M12 3l9 5H3z',
  trending: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  home2: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM9 21v-6h6v6',
  check: 'M5 12l5 5L20 7',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  card: 'M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zm0 3h20M6 15h4',
};

function icon(name, cls = '') {
  return svg('svg', { class: `icon ${cls}`, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, svg('path', { d: ICONS[name] }));
}

const fmtCache = {};
function money(n, opts = {}) {
  if (n == null || Number.isNaN(n)) return '—';
  const { currency = 'USD', cents = true, sign = false, compact = false } = opts;
  const key = `${currency}${cents}${sign}${compact}`;
  fmtCache[key] ??= new Intl.NumberFormat(undefined, {
    style: 'currency', currency,
    minimumFractionDigits: compact ? 0 : cents ? 2 : 0,
    maximumFractionDigits: compact ? 1 : cents ? 2 : 0,
    notation: compact ? 'compact' : 'standard',
    signDisplay: sign ? 'exceptZero' : 'auto',
  });
  return fmtCache[key].format(n);
}
const number = (n, digits = 0) => (n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: digits }));
const pct = (n, digits = 1) => (n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(digits)}%`);

// Plaid dates are "YYYY-MM-DD" in local time.
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d; };

function dayLabel(s) {
  const d = parseDate(s);
  const today = daysAgo(0);
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const CATEGORY_LABELS = {
  INCOME: 'Income', TRANSFER_IN: 'Transfer in', TRANSFER_OUT: 'Transfer out', LOAN_PAYMENTS: 'Loan payments',
  BANK_FEES: 'Bank fees', ENTERTAINMENT: 'Entertainment', FOOD_AND_DRINK: 'Food & drink',
  GENERAL_MERCHANDISE: 'Shopping', HOME_IMPROVEMENT: 'Home', MEDICAL: 'Medical', PERSONAL_CARE: 'Personal care',
  GENERAL_SERVICES: 'Services', GOVERNMENT_AND_NON_PROFIT: 'Government & charity', TRANSPORTATION: 'Transportation',
  TRAVEL: 'Travel', RENT_AND_UTILITIES: 'Rent & utilities', OTHER: 'Other',
};
const titleCase = (s) => s.toLowerCase().replace(/_/g, ' ').replace(/\band\b/g, '&').replace(/^\w/, (x) => x.toUpperCase());
const categoryLabel = (c) => CATEGORY_LABELS[c] || titleCase(c || 'Other');
const detailLabel = (t) => (t.detailed ? titleCase(t.detailed.replace(`${t.category}_`, '')) : null);

// Money that moves between your own accounts isn't spending or income.
const NOT_SPENDING = new Set(['TRANSFER_IN', 'TRANSFER_OUT', 'INCOME']);
const isCardPayment = (t) => t.detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT';
const isSpending = (t) => !NOT_SPENDING.has(t.category) && !isCardPayment(t);
const isIncome = (t) => t.category === 'INCOME' && t.amount < 0;

const usd = () => data?.totals?.USD || {};
const accountById = (id) => data.accounts.find((a) => a.id === id);
const connectionById = (id) => data.connections.find((c) => c.itemId === id);
const txTitle = (t) => t.merchant || t.name;

function initials(s) {
  const words = String(s || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  return ((words[0]?.[0] || '?') + (words[1]?.[0] || '')).toUpperCase();
}

function institutionAvatar(conn, fallbackName) {
  if (conn?.logo) return el('div', { class: 'avatar' }, el('img', { src: `data:image/png;base64,${conn.logo}`, alt: '' }));
  const node = el('div', { class: 'avatar' }, initials(conn?.institutionName || fallbackName));
  if (conn?.color) { node.classList.add('brand-colored'); node.style.background = conn.color; }
  return node;
}

function toast(message, type = '') {
  const t = el('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, icon(type === 'error' ? 'alert' : 'check'), message);
  $('toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}

// ============================================================ tooltip

function showTooltip(x, y, title, rows) {
  const tt = $('tooltip');
  tt.replaceChildren(
    el('div', { class: 'tt-title' }, title),
    ...rows.map((r) => el('div', { class: 'tt-row' },
      el('span', { class: 'tt-key' }, r.color && el('i', { style: { background: r.color } }), r.label),
      el('b', {}, r.value))),
  );
  tt.hidden = false;
  const { width, height } = tt.getBoundingClientRect();
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, x + 14));
  const top = y - height - 12 < 8 ? y + 16 : y - height - 12;
  tt.style.left = `${left}px`;
  tt.style.top = `${top}px`;
}
const hideTooltip = () => { $('tooltip').hidden = true; };

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ============================================================ lock screen

function showLockScreen() {
  data = null;
  closeDrawer();
  if ($('dialog').open) $('dialog').close();
  hideTooltip();
  $('app').hidden = true;
  $('view').replaceChildren();
  $('lock-screen').hidden = false;
  $('confirm-row').hidden = vaultExists;
  $('strength').hidden = vaultExists;
  $('passphrase-confirm').required = !vaultExists;
  $('passphrase').autocomplete = vaultExists ? 'current-password' : 'new-password';
  $('lock-intro').textContent = vaultExists
    ? 'Welcome back. Enter your passphrase to unlock.'
    : 'Create a passphrase of at least 16 characters. Several random words work well, like "maple orbit candle frozen tiger". '
      + 'It encrypts everything this app stores. It can\'t be recovered, so keep it in a password manager.';
  $('lock-submit').textContent = vaultExists ? 'Unlock' : 'Create vault';
  $('passphrase').value = '';
  $('passphrase-confirm').value = '';
  updateStrength();
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
  if (p.length < 16) return ['weak', `Too short: ${p.length}/16 characters`, Math.min(40, p.length * 2.5)];
  if (new Set(p).size < 8) return ['weak', 'Too repetitive', 35];
  if (bits < 80) return ['ok', 'Okay. Longer is better', 65];
  return ['strong', 'Strong', 100];
}

function updateStrength() {
  const p = $('passphrase').value;
  const [level, label, width] = p ? passphraseStrength(p) : ['', '', 0];
  $('strength').className = `strength ${level}`;
  $('strength-label').textContent = label;
  $('strength-fill').style.width = `${width}%`;
}
$('passphrase').addEventListener('input', () => { if (!vaultExists) updateStrength(); });

$('lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('lock-error').textContent = '';
  const passphrase = $('passphrase').value;
  if (!vaultExists && passphrase !== $('passphrase-confirm').value) {
    $('lock-error').textContent = 'Passphrases do not match.';
    return;
  }
  $('lock-submit').disabled = true;
  $('lock-submit').textContent = vaultExists ? 'Unlocking…' : 'Creating…';
  try {
    await api('POST', vaultExists ? '/api/unlock' : '/api/setup', { passphrase });
    vaultExists = true;
    $('passphrase').value = '';
    $('passphrase-confirm').value = '';
    await enterApp();
  } catch (err) {
    $('lock-error').textContent = err.message;
    $('lock-submit').textContent = vaultExists ? 'Unlock' : 'Create vault';
  } finally {
    $('lock-submit').disabled = false;
  }
});

// ============================================================ app shell

const VIEWS = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'transactions', label: 'Transactions', icon: 'list' },
  { id: 'accounts', label: 'Accounts', icon: 'wallet' },
  { id: 'investments', label: 'Investments', icon: 'chart' },
  { id: 'rewards', label: 'Rewards', icon: 'gift' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

async function enterApp() {
  $('lock-screen').hidden = true;
  $('app').hidden = false;
  data = await api('GET', '/api/data');
  const settings = await api('GET', '/api/settings');
  ui.view = settings.secretSaved ? 'overview' : 'settings';
  render();
  if (!settings.secretSaved) {
    toast('Add your Plaid keys to start connecting accounts.');
  } else if (data.connections.length && (!data.lastRefresh || Date.now() - new Date(data.lastRefresh) > STALE_MS)) {
    refresh();
  }
}

function go(view) {
  ui.view = view;
  render();
  $('view').focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

function renderNav() {
  const broken = data.connections.filter((c) => c.error).length;
  $('nav').replaceChildren(...VIEWS.map((v) => el('button', {
    class: 'nav-item', type: 'button', 'aria-current': ui.view === v.id ? 'page' : null, onclick: () => go(v.id),
  }, icon(v.icon), el('span', {}, v.label), v.id === 'accounts' && broken > 0 && el('b', { class: 'count' }, broken))));
  $('lock-btn').replaceChildren(icon('lock'), el('span', {}, 'Lock'));
  $('env-badge').hidden = data.plaidEnv !== 'sandbox';
  $('env-badge').textContent = 'Sandbox';
}

function renderTopbar() {
  $('page-title').textContent = VIEWS.find((v) => v.id === ui.view).label;
  $('global-search-wrap').hidden = ui.view === 'transactions';
  $('refresh-btn').replaceChildren(
    icon('refresh', ui.refreshing ? 'spin' : ''),
    el('span', {}, ui.refreshing ? 'Syncing…' : `Updated ${timeAgo(data.lastRefresh)}`),
  );
  $('refresh-btn').disabled = ui.refreshing || !data.connections.length;
  $('add-btn').replaceChildren(icon('plus'), el('span', {}, 'Add'));
  $('lock-top').replaceChildren(icon('lock'));

  const broken = data.connections.filter((c) => c.needsReconnect);
  const banner = $('banner');
  banner.hidden = broken.length === 0;
  if (broken.length) {
    banner.replaceChildren(icon('alert'),
      el('span', {}, `${broken.map((c) => c.institutionName).join(', ')} ${broken.length > 1 ? 'need' : 'needs'} you to log in again.`),
      el('button', { class: 'link-btn', onclick: () => openLink({ itemId: broken[0].itemId }) }, 'Reconnect'));
  }
}

function render() {
  if (!data) return;
  hideTooltip();
  renderNav();
  renderTopbar();
  const builders = { overview: viewOverview, transactions: viewTransactions, accounts: viewAccounts, investments: viewInvestments, rewards: viewRewards, settings: viewSettings };
  $('view').replaceChildren(builders[ui.view]());
}

async function refresh() {
  if (ui.refreshing) return;
  ui.refreshing = true;
  renderTopbar();
  try {
    data = await api('POST', '/api/refresh');
    const failed = data.connections.filter((c) => c.error);
    if (failed.length) toast(`Couldn't update ${failed.map((c) => c.institutionName).join(', ')}.`, 'error');
  } catch (err) {
    if (err.message !== 'Locked') toast(err.message, 'error');
  } finally {
    ui.refreshing = false;
    if (data) render();
  }
}

// ============================================================ analytics

function spendingBetween(from, to) {
  const a = isoDate(from); const b = isoDate(to);
  return data.transactions.filter((t) => t.currency === 'USD' && t.date >= a && t.date <= b && isSpending(t))
    .reduce((sum, t) => sum + t.amount, 0);
}

function categoryTotals(from, to) {
  const a = isoDate(from); const b = isoDate(to);
  const map = new Map();
  for (const t of data.transactions) {
    if (t.currency !== 'USD' || t.date < a || t.date > b || !isSpending(t)) continue;
    map.set(t.category, (map.get(t.category) || 0) + t.amount);
  }
  return [...map].filter(([, v]) => v > 0.005).sort((x, y) => y[1] - x[1]);
}

function cashFlow(months = 6) {
  const now = new Date();
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ key: isoDate(d).slice(0, 7), label: d.toLocaleDateString(undefined, { month: 'short' }), full: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), in: 0, out: 0 });
  }
  const byKey = new Map(out.map((m) => [m.key, m]));
  for (const t of data.transactions) {
    const m = byKey.get(t.date.slice(0, 7));
    if (!m || t.currency !== 'USD') continue;
    if (isIncome(t)) m.in -= t.amount;
    else if (isSpending(t)) m.out += t.amount;
  }
  for (const m of out) m.out = Math.max(0, m.out);
  return out;
}

// ============================================================ overview

function viewOverview() {
  if (!data.connections.length && !data.manual.length) return emptyWelcome();
  const t = usd();
  const root = el('div', { class: 'stack', style: { marginTop: '0' } });

  // Net worth hero with history chart.
  const history = data.history.map((h) => ({ date: h.date, value: h.netWorth }));
  const rangeDays = { '1M': 31, '3M': 92, '1Y': 366, All: Infinity }[ui.nwRange];
  const cutoff = Number.isFinite(rangeDays) ? isoDate(daysAgo(rangeDays)) : '';
  const series = history.filter((p) => p.date >= cutoff);
  const first = series[0];
  const change = first && series.length > 1 ? (t.netWorth ?? 0) - first.value : null;
  const changePct = change != null && first.value ? (change / Math.abs(first.value)) * 100 : null;
  const rangeText = { '1M': 'past month', '3M': 'past 3 months', '1Y': 'past year', All: 'all time' }[ui.nwRange];

  const chartBox = el('div', { class: 'chart' });
  root.append(el('section', { class: 'card hero' },
    el('div', { class: 'hero-top' },
      el('div', {},
        el('div', { class: 'eyebrow' }, 'Net worth'),
        el('div', { class: 'hero-value num' }, money(t.netWorth ?? 0)),
        change != null
          ? el('div', { class: `delta ${change >= 0 ? 'up' : 'down'}` },
            el('span', { class: 'pill' }, `${change >= 0 ? '▲' : '▼'} ${money(Math.abs(change), { cents: false })}${changePct != null ? ` · ${pct(Math.abs(changePct))}` : ''}`),
            el('span', { class: 'muted' }, rangeText))
          : el('div', { class: 'delta' }, el('span', { class: 'muted' }, `Assets ${money(t.assets ?? 0, { cents: false })} · Debts ${money(t.debts ?? 0, { cents: false })}`))),
      segmented(['1M', '3M', '1Y', 'All'], ui.nwRange, (v) => { ui.nwRange = v; render(); }, 'Net worth range')),
    chartBox));
  requestAnimationFrame(() => areaChart(chartBox, series));

  // Stat tiles.
  const util = t.creditUtilization;
  root.append(el('div', { class: 'grid cols-4' },
    statCard('Cash', money(t.cash ?? 0), 'var(--s1)', `${data.accounts.filter((a) => a.category === 'cash').length} accounts`, () => go('accounts')),
    statCard('Investments', money(t.investments ?? 0), 'var(--s7)', investmentFoot(), () => go('investments')),
    statCard('Credit cards', money(t.creditCardDebt ?? 0), 'var(--s2)', util != null ? `${pct(util, 0)} of ${money(t.creditLimit, { cents: false })} limit used` : 'No cards yet', () => go('accounts'),
      util != null && el('div', { class: `meter ${util > 50 ? 'high' : util > 30 ? 'warn' : ''}` }, el('i', { style: { width: `${Math.min(100, util)}%` } }))),
    statCard('Loans & other debts', money((t.loans ?? 0) + (t.manualDebts ?? 0)), 'var(--s8)', (t.manualAssets ?? 0) > 0 ? `Other assets ${money(t.manualAssets, { cents: false })}` : 'Mortgage, student & auto loans', () => go('accounts')),
  ));

  // Cash flow + monthly spending. Early in a month there's little to show,
  // so last month is shown until something is spent this month.
  const today = daysAgo(0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
  const lastMonthSameDay = new Date(today.getFullYear(), today.getMonth() - 1, Math.min(today.getDate(), lastMonthEnd.getDate()));
  const spentThisMonth = spendingBetween(monthStart, today);
  const spentLastMonth = spendingBetween(lastMonthStart, lastMonthEnd);
  const spend = ui.spend || (spentThisMonth > 0 ? 'this' : 'last');
  const twoMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 2, 1);
  const twoMonthsAgoEnd = new Date(today.getFullYear(), today.getMonth() - 1, 0);
  const shown = spend === 'this' ? spentThisMonth : spentLastMonth;
  const diff = spend === 'this'
    ? spentThisMonth - spendingBetween(lastMonthStart, lastMonthSameDay)
    : spentLastMonth - spendingBetween(twoMonthsAgo, twoMonthsAgoEnd);
  const compareText = spend === 'this' ? 'than this point last month' : `than ${twoMonthsAgo.toLocaleDateString(undefined, { month: 'long' })}`;
  const cats = (spend === 'this' ? categoryTotals(monthStart, today) : categoryTotals(lastMonthStart, lastMonthEnd)).slice(0, 6);
  const maxCat = cats[0]?.[1] || 1;
  const catRange = spend === 'this' ? 'month' : 'lastmonth';

  const flowBox = el('div', { class: 'chart' });
  root.append(el('div', { class: 'grid split' },
    el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, 'Cash flow'),
        el('div', { class: 'legend' }, el('span', {}, el('i', { class: 'dot', style: { background: 'var(--s1)' } }), 'Money in'), el('span', {}, el('i', { class: 'dot', style: { background: 'var(--s2)' } }), 'Spending'))),
      flowBox),
    el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, 'Spending'),
        segmented([['this', 'This month'], ['last', 'Last month']], spend, (v) => { ui.spend = v; render(); }, 'Spending period')),
      el('div', { class: 'stat' },
        el('div', { class: 'value num' }, money(shown)),
        el('div', { class: 'foot' }, data.transactions.length
          ? `${money(Math.abs(diff), { cents: false })} ${diff > 0 ? 'more' : 'less'} ${compareText}`
          : 'Connect a bank or card to see spending')),
      el('div', { class: 'hbars', style: { marginTop: '14px' } }, cats.length ? cats.map(([cat, v]) => el('button', {
        class: 'hbar', type: 'button', onclick: () => openTransactions({ category: cat, range: catRange }), title: `See ${categoryLabel(cat)} transactions`,
      }, el('span', { class: 'name' }, categoryLabel(cat)), el('span', { class: 'track' }, el('i', { style: { width: `${(v / maxCat) * 100}%` } })), el('span', { class: 'amt' }, money(v, { cents: false })))) : el('p', { class: 'muted' }, 'Nothing spent yet this month.')))));
  requestAnimationFrame(() => barChart(flowBox, cashFlow(6)));

  // Recent transactions + upcoming card payments.
  const cards = data.accounts.filter((a) => a.category === 'credit' && (a.credit?.dueDate || a.credit?.minimumPayment != null))
    .sort((a, b) => ((a.credit.dueDate || '9') < (b.credit.dueDate || '9') ? -1 : 1));
  const recent = data.transactions.slice(0, 7);
  root.append(el('div', { class: 'grid split' },
    el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, 'Recent transactions'), el('button', { class: 'link-btn', onclick: () => openTransactions({}) }, 'See all')),
      recent.length ? el('div', { class: 'list' }, recent.map((tx) => txRow(tx))) : el('p', { class: 'muted' }, 'Transactions appear here after your first sync.')),
    el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, 'Upcoming card payments')),
      cards.length ? el('div', { class: 'list' }, cards.map(paymentRow))
        : el('p', { class: 'muted' }, 'Due dates and minimum payments show here for cards that share them.'))));
  return root;
}

function investmentFoot() {
  const h = data.holdings;
  if (!h.length) return 'Connect a brokerage or 401(k)';
  const withCost = h.filter((x) => x.costBasis);
  if (!withCost.length) return `${h.length} holdings`;
  const gain = withCost.reduce((s, x) => s + (x.value || 0) - x.costBasis, 0);
  return `${gain >= 0 ? '+' : '−'}${money(Math.abs(gain), { cents: false })} total gain`;
}

function statCard(label, value, color, foot, onclick, extra) {
  return el('button', { class: 'card stat', type: 'button', style: { textAlign: 'left', cursor: 'pointer' }, onclick },
    el('span', { class: 'label' }, el('i', { class: 'dot', style: { background: color } }), label),
    el('span', { class: 'value num' }, value),
    extra || null,
    el('span', { class: 'foot' }, foot));
}

function segmented(options, current, onchange, label) {
  return el('div', { class: 'segmented', role: 'group', 'aria-label': label }, options.map((o) => {
    const [value, text] = Array.isArray(o) ? o : [o, o];
    return el('button', { type: 'button', 'aria-pressed': String(value === current), onclick: () => onchange(value) }, text);
  }));
}

function paymentRow(a) {
  const c = a.credit;
  const due = c.dueDate ? parseDate(c.dueDate) : null;
  const days = due ? Math.round((due - daysAgo(0)) / 86400000) : null;
  return el('div', { class: 'row static' },
    institutionAvatar(connectionById(a.itemId), a.institution),
    el('div', {},
      el('div', { class: 'title' }, a.name, a.mask && el('span', { class: 'muted' }, ` ••${a.mask}`)),
      el('div', { class: 'meta' },
        c.overdue ? [el('span', { class: 'tag bad' }, 'Overdue'), ' '] : days != null && days <= 7 ? [el('span', { class: 'tag warn' }, days <= 0 ? 'Due today' : `Due in ${days}d`), ' '] : null,
        due ? `Due ${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : 'No due date', c.apr != null ? ` · ${pct(c.apr, 2)} APR` : '')),
    el('div', { class: 'amount' }, money(c.lastStatementBalance ?? a.current), el('small', {}, c.minimumPayment != null ? `min ${money(c.minimumPayment)}` : 'statement')));
}

function emptyWelcome() {
  return el('section', { class: 'card empty' },
    el('div', { class: 'brand-mark', style: { margin: '0 auto 18px', width: '48px', height: '48px' } }),
    el('h3', {}, 'Bring all your money into one place'),
    el('p', {}, 'Connect your banks, credit cards and investment accounts, and add your miles and hotel points.'),
    el('button', { class: 'btn primary', onclick: openAddMenu }, icon('plus'), 'Add your first account'));
}

// ============================================================ charts

const compactMoney = (n) => money(n, { compact: true });

function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

// Net worth over time: a single-series area chart with a crosshair tooltip.
function areaChart(container, points) {
  if (points.length < 2) {
    container.replaceChildren(el('div', { class: 'chart-empty', style: { marginTop: '16px' } },
      el('div', {}, el('b', {}, 'Your net worth history starts today'), el('br'), 'A point is saved each day you open the app.')));
    return;
  }
  const width = Math.max(280, container.clientWidth || 600);
  const height = 220;
  const pad = { l: 4, r: 52, t: 16, b: 26 };
  const xs = points.map((p) => parseDate(p.date).getTime());
  const vals = points.map((p) => p.value);
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals));
  const y0 = ticks[0]; const y1 = ticks.at(-1);
  const x = (v) => pad.l + ((v - xs[0]) / (xs.at(-1) - xs[0] || 1)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - y0) / (y1 - y0)) * (height - pad.t - pad.b);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(xs[i]).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const area = `${line}L${x(xs.at(-1)).toFixed(1)},${height - pad.b}L${x(xs[0]).toFixed(1)},${height - pad.b}Z`;
  const fmtDate = (v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const shortDate = (v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  const cross = svg('line', { class: 'crosshair', y1: pad.t, y2: height - pad.b, visibility: 'hidden' });
  const marker = svg('circle', { class: 'marker', r: 5, visibility: 'hidden' });
  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`, height, role: 'img', tabindex: 0,
    'aria-label': `Net worth from ${money(vals[0])} on ${fmtDate(xs[0])} to ${money(vals.at(-1))} on ${fmtDate(xs.at(-1))}. Use arrow keys to read values.`,
  },
  svg('defs', {}, svg('linearGradient', { id: 'nw-fill', x1: 0, x2: 0, y1: 0, y2: 1 },
    svg('stop', { offset: '0%', 'stop-color': cssVar('--s1'), 'stop-opacity': 0.22 }),
    svg('stop', { offset: '100%', 'stop-color': cssVar('--s1'), 'stop-opacity': 0 }))),
  svg('g', { class: 'axis' },
    ticks.map((v) => [
      svg('line', { class: 'gridline', x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v) }),
      svg('text', { x: width - pad.r + 8, y: y(v) + 4 }, compactMoney(v))]),
    svg('text', { x: x(xs[0]), y: height - 6, 'text-anchor': 'start' }, shortDate(xs[0])),
    svg('text', { x: x(xs.at(-1)), y: height - 6, 'text-anchor': 'end' }, shortDate(xs.at(-1)))),
  svg('path', { class: 'area', d: area }),
  svg('path', { class: 'line', d: line }),
  cross, marker);

  let idx = null;
  const show = (i, clientX, clientY) => {
    idx = i;
    const px = x(xs[i]); const py = y(vals[i]);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    marker.setAttribute('cx', px); marker.setAttribute('cy', py); marker.setAttribute('visibility', 'visible');
    const box = root.getBoundingClientRect();
    showTooltip(clientX ?? box.left + (px / width) * box.width, clientY ?? box.top + (py / height) * box.height, fmtDate(xs[i]),
      [{ label: 'Net worth', value: money(vals[i]), color: cssVar('--s1') }]);
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); marker.setAttribute('visibility', 'hidden'); hideTooltip(); idx = null; };
  root.addEventListener('pointermove', (e) => {
    const box = root.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const target = xs[0] + ((px - pad.l) / (width - pad.l - pad.r)) * (xs.at(-1) - xs[0]);
    let best = 0;
    xs.forEach((v, i) => { if (Math.abs(v - target) < Math.abs(xs[best] - target)) best = i; });
    show(best, e.clientX, e.clientY);
  });
  root.addEventListener('pointerleave', hide);
  root.addEventListener('blur', hide);
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    show(Math.max(0, Math.min(points.length - 1, (idx ?? points.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1))));
  });
  container.replaceChildren(root);
}

// Cash flow: grouped bars per month (money in, spending) with a per-month tooltip.
function barChart(container, months) {
  if (!data.transactions.length) {
    container.replaceChildren(el('div', { class: 'chart-empty' }, 'Connect a bank or card to see money in and out.'));
    return;
  }
  const width = Math.max(280, container.clientWidth || 600);
  const height = 220;
  const pad = { l: 4, r: 52, t: 12, b: 26 };
  const ticks = niceTicks(0, Math.max(1, ...months.flatMap((m) => [m.in, m.out])), 3);
  const top = ticks.at(-1);
  const y = (v) => pad.t + (1 - v / top) * (height - pad.t - pad.b);
  const colW = (width - pad.l - pad.r) / months.length;
  const barW = Math.max(6, Math.min(22, (colW - 18) / 2));
  const bar = (bx, v, cls) => {
    const h = Math.max(0, y(0) - y(Math.max(0, v)));
    if (h < 0.5) return null;
    const r = Math.min(4, h, barW / 2);
    const by = y(0) - h;
    // Rounded at the data end, square at the baseline.
    return svg('path', { class: cls, d: `M${bx},${y(0)}V${by + r}Q${bx},${by} ${bx + r},${by}H${bx + barW - r}Q${bx + barW},${by} ${bx + barW},${by + r}V${y(0)}Z` });
  };

  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': 'Money in and spending by month' },
    svg('g', { class: 'axis' }, ticks.map((v) => [
      svg('line', { class: v === 0 ? 'baseline' : 'gridline', x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v) }),
      svg('text', { x: width - pad.r + 8, y: y(v) + 4 }, compactMoney(v))])),
    months.map((m, i) => {
      const cx = pad.l + colW * i + colW / 2;
      const hit = svg('rect', {
        class: 'col-hit', x: pad.l + colW * i + 4, y: pad.t - 4, width: colW - 8, height: height - pad.t - pad.b + 4, rx: 8, tabindex: 0,
        'aria-label': `${m.full}: money in ${money(m.in)}, spending ${money(m.out)}`,
      });
      const tip = (e) => {
        const box = hit.getBoundingClientRect();
        showTooltip(e?.clientX ?? box.left + box.width / 2, e?.clientY ?? box.top + 24, m.full, [
          { label: 'Money in', value: money(m.in), color: cssVar('--s1') },
          { label: 'Spending', value: money(m.out), color: cssVar('--s2') },
          { label: 'Net', value: money(m.in - m.out, { sign: true }) },
        ]);
      };
      hit.addEventListener('pointermove', tip);
      hit.addEventListener('focus', () => tip());
      hit.addEventListener('pointerleave', hideTooltip);
      hit.addEventListener('blur', hideTooltip);
      return svg('g', {}, hit,
        bar(cx - barW - 1, m.in, 'bar-in'),
        bar(cx + 1, m.out, 'bar-out'),
        svg('g', { class: 'axis' }, svg('text', { x: cx, y: height - 6, 'text-anchor': 'middle' }, m.label)));
    }));
  container.replaceChildren(root);
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (data && ui.view === 'overview') render(); }, 150);
});

// ============================================================ transactions

function openTransactions(filter) {
  ui.tx = { q: '', range: '90', account: '', category: '', type: 'all', ...filter };
  ui.txLimit = 150;
  go('transactions');
}

// Search understands plain words plus amounts: "starbucks", ">100", "<20", "42.50".
function parseQuery(q) {
  const words = [];
  const amount = [];
  for (const raw of q.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    const m = raw.match(/^([<>]=?)?\$?(\d+(?:\.\d{1,2})?)$/);
    if (m) amount.push({ op: m[1] || '=', value: Number(m[2]) });
    else words.push(raw);
  }
  return { words, amount };
}

function rangeBounds(range) {
  const now = new Date();
  if (range === 'month') return [isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), '9999'];
  if (range === 'lastmonth') return [isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)), isoDate(new Date(now.getFullYear(), now.getMonth(), 0))];
  if (range === 'all') return ['', '9999'];
  return [isoDate(daysAgo(Number(range))), '9999'];
}

function filterTransactions() {
  const f = ui.tx;
  const { words, amount } = parseQuery(f.q);
  const [start, end] = rangeBounds(f.range);
  const accounts = new Map(data.accounts.map((a) => [a.id, a]));
  return data.transactions.filter((t) => {
    if (t.date < start || t.date > end) return false;
    if (f.account && t.accountId !== f.account) return false;
    if (f.category && t.category !== f.category) return false;
    if (f.type === 'out' && t.amount <= 0) return false;
    if (f.type === 'in' && t.amount >= 0) return false;
    const v = Math.abs(t.amount);
    for (const a of amount) {
      if (a.op === '=' && Math.abs(v - a.value) > 0.005 && Math.floor(v) !== a.value) return false;
      if (a.op === '>' && !(v > a.value)) return false;
      if (a.op === '>=' && !(v >= a.value)) return false;
      if (a.op === '<' && !(v < a.value)) return false;
      if (a.op === '<=' && !(v <= a.value)) return false;
    }
    if (words.length) {
      const acct = accounts.get(t.accountId);
      const hay = `${t.name} ${t.merchant || ''} ${categoryLabel(t.category)} ${detailLabel(t) || ''} ${acct?.name || ''} ${acct?.institution || ''} ${t.pending ? 'pending' : ''}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

function highlight(text, words) {
  if (!words.length) return text;
  const lower = text.toLowerCase();
  const parts = [];
  let i = 0;
  while (i < text.length) {
    let hit = null;
    for (const w of words) {
      const at = lower.indexOf(w, i);
      if (at >= 0 && (!hit || at < hit.at)) hit = { at, len: w.length };
    }
    if (!hit) { parts.push(text.slice(i)); break; }
    parts.push(text.slice(i, hit.at), el('mark', {}, text.slice(hit.at, hit.at + hit.len)));
    i = hit.at + hit.len;
  }
  return parts;
}

function txAmount(t) {
  return t.amount < 0 ? `+${money(-t.amount, { currency: t.currency })}` : money(t.amount, { currency: t.currency });
}

function txRow(t, words = []) {
  const acct = accountById(t.accountId);
  return el('button', { class: 'row', type: 'button', onclick: () => openTransaction(t) },
    el('div', { class: 'avatar' }, initials(txTitle(t))),
    el('div', {},
      el('div', { class: 'title' }, highlight(txTitle(t), words), t.pending && [' ', el('span', { class: 'tag' }, 'Pending')]),
      el('div', { class: 'meta' }, categoryLabel(t.category), acct ? ` · ${acct.name}${acct.mask ? ` ••${acct.mask}` : ''}` : '')),
    el('div', { class: `amount ${t.amount < 0 ? 'pos' : ''}` }, txAmount(t)));
}

function viewTransactions() {
  const f = ui.tx;
  const root = el('div', {});
  const results = filterTransactions();
  const { words } = parseQuery(f.q);

  const search = el('input', { type: 'search', placeholder: 'Search merchants, categories, accounts or amounts', value: f.q, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search transactions' });
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { ui.tx.q = search.value; ui.txLimit = 150; rerenderTx(); }, 80);
  });

  const usedCategories = [...new Set(data.transactions.map((t) => t.category))].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));
  const select = (value, options, onchange, label) => {
    const s = el('select', { 'aria-label': label }, options.map(([v, text]) => el('option', { value: v, selected: v === value }, text)));
    s.addEventListener('change', () => onchange(s.value));
    return s;
  };
  const setFilter = (k) => (v) => { ui.tx[k] = v; ui.txLimit = 150; rerenderTx(); };

  root.append(
    el('div', { class: 'filters' },
      el('label', { class: 'search tx-search' }, icon('search'), search, el('kbd', {}, '/')),
      segmented([['30', '30D'], ['90', '90D'], ['365', '1Y'], ['all', 'All']], f.range, setFilter('range'), 'Date range'),
      select(f.account, [['', 'All accounts'], ...data.accounts.filter((a) => a.category !== 'investments').map((a) => [a.id, `${a.name}${a.mask ? ` ••${a.mask}` : ''}`])], setFilter('account'), 'Account'),
      select(f.category, [['', 'All categories'], ...usedCategories.map((c) => [c, categoryLabel(c)])], setFilter('category'), 'Category'),
      segmented([['all', 'All'], ['out', 'Out'], ['in', 'In']], f.type, setFilter('type'), 'Direction')),
    el('p', { class: 'hint' }, 'Try ',
      ['coffee', '>100', 'travel', 'pending'].map((s) => [el('button', { type: 'button', onclick: () => { ui.tx.q = s; ui.tx.range = 'all'; rerenderTx(); } }, s), ' ']),
      f.range === 'month' ? ' · Showing this month' : f.range === 'lastmonth' ? ' · Showing last month' : ''));

  const out = results.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const inn = results.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);
  const active = f.q || f.account || f.category || f.type !== 'all' || f.range !== '90';
  root.append(el('div', { class: 'tx-summary' },
    el('span', {}, el('b', {}, number(results.length)), ` transaction${results.length === 1 ? '' : 's'}`),
    el('span', {}, el('b', {}, money(out)), ' out'),
    el('span', {}, el('b', { class: 'pos' }, money(inn)), ' in'),
    active && el('button', { class: 'link-btn', onclick: () => openTransactions({}) }, 'Clear filters'),
    el('button', { class: 'btn small', onclick: () => exportCsv(results), disabled: !results.length }, icon('download'), 'Export CSV')));

  const card = el('section', { class: 'card', style: { paddingTop: '4px' } });
  if (!data.transactions.length) {
    const hasBank = data.connections.some((c) => c.kind === 'bank');
    card.append(el('div', { class: 'empty' }, el('h3', {}, 'No transactions yet'),
      el('p', {}, hasBank ? 'They\'ll appear after the next sync. New connections can take a few minutes.' : 'Connect a bank or credit card to see transactions.'),
      el('button', { class: 'btn primary', onclick: () => (hasBank ? refresh() : openLink({ kind: 'bank' })) }, hasBank ? 'Sync now' : 'Connect an account')));
  } else if (!results.length) {
    card.append(el('div', { class: 'empty' }, el('h3', {}, 'No matches'), el('p', {}, 'Try a different search or widen the date range.')));
  } else {
    const dayTotals = new Map();
    for (const t of results) if (t.amount > 0 && isSpending(t)) dayTotals.set(t.date, (dayTotals.get(t.date) || 0) + t.amount);
    let lastDay = null;
    let dayList = null;
    for (const t of results.slice(0, ui.txLimit)) {
      if (t.date !== lastDay) {
        lastDay = t.date;
        const spent = dayTotals.get(t.date);
        dayList = el('div', { class: 'list' });
        card.append(el('div', { class: 'day' }, el('span', {}, dayLabel(t.date)), spent ? el('span', {}, `${money(spent)} spent`) : null), dayList);
      }
      dayList.append(txRow(t, words));
    }
    if (results.length > ui.txLimit) {
      card.append(el('div', { style: { textAlign: 'center', padding: '16px 0 8px' } },
        el('button', { class: 'btn', onclick: () => { ui.txLimit += 300; rerenderTx(); } }, `Show more (${number(results.length - ui.txLimit)} left)`)));
    }
  }
  root.append(card);
  return root;
}

// Re-render while keeping the search box focused and the caret in place.
function rerenderTx() {
  const active = document.activeElement;
  const wasSearch = active?.type === 'search' && $('view').contains(active);
  const caret = wasSearch ? active.selectionStart : null;
  render();
  if (wasSearch) {
    const s = $('view').querySelector('input[type=search]');
    s.focus();
    s.setSelectionRange(caret, caret);
  }
}

// Spreadsheet apps run cells starting with = + - @ as formulas, so text cells are defused.
function csvCell(v) {
  let s = String(v ?? '');
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(rows) {
  const header = ['Date', 'Merchant', 'Description', 'Category', 'Subcategory', 'Account', 'Amount', 'Currency', 'Pending'];
  const lines = [header, ...rows.map((t) => {
    const a = accountById(t.accountId);
    return [t.date, t.merchant || '', t.name, categoryLabel(t.category), detailLabel(t) || '', a ? `${a.name}${a.mask ? ` ${a.mask}` : ''}` : '', Number((-t.amount).toFixed(2)), t.currency, t.pending ? 'yes' : 'no'];
  })].map((r) => r.map(csvCell).join(','));
  const url = URL.createObjectURL(new Blob([`${lines.join('\r\n')}\r\n`], { type: 'text/csv' }));
  const a = el('a', { href: url, download: `transactions-${isoDate(new Date())}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${number(rows.length)} transactions.`);
}

// ============================================================ transaction drawer

let drawerReturnFocus = null;

function openTransaction(t) {
  const acct = accountById(t.accountId);
  const conn = acct && connectionById(acct.itemId);
  const merchant = txTitle(t);
  const yearAgo = isoDate(daysAgo(365));
  const pastYear = data.transactions.filter((x) => txTitle(x) === merchant && x.amount > 0 && x.date >= yearAgo);
  const yearTotal = pastYear.reduce((s, x) => s + x.amount, 0);
  const channel = { 'in store': 'In store', online: 'Online' }[t.channel] || 'Other';

  drawerReturnFocus = document.activeElement;
  const drawer = $('drawer');
  drawer.setAttribute('aria-label', `Transaction: ${merchant}`);
  drawer.replaceChildren(
    el('div', { class: 'drawer-head' }, el('span', { class: 'eyebrow' }, 'Transaction'),
      el('button', { class: 'btn ghost small', onclick: closeDrawer, 'aria-label': 'Close' }, icon('x'))),
    el('div', { class: 'avatar', style: { width: '48px', height: '48px', fontSize: '17px', borderRadius: '14px' } }, initials(merchant)),
    el('div', { class: `big num ${t.amount < 0 ? 'pos' : ''}` }, txAmount(t)),
    el('h2', { style: { fontSize: '17px' } }, merchant, t.pending && [' ', el('span', { class: 'tag' }, 'Pending')]),
    el('dl', { class: 'kv' },
      el('dt', {}, 'Date'), el('dd', {}, parseDate(t.date).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })),
      el('dt', {}, 'Category'), el('dd', {}, categoryLabel(t.category), detailLabel(t) ? ` · ${detailLabel(t)}` : ''),
      el('dt', {}, 'Account'), el('dd', {}, acct ? `${acct.name}${acct.mask ? ` ••${acct.mask}` : ''}` : '—', conn ? el('div', { class: 'muted' }, conn.institutionName) : null),
      el('dt', {}, 'Description'), el('dd', {}, t.name),
      t.channel && [el('dt', {}, 'Type'), el('dd', {}, channel)],
      pastYear.length > 1 && [el('dt', {}, 'Past year here'), el('dd', {}, `${money(yearTotal)} across ${pastYear.length} purchases`)]),
    el('div', { class: 'drawer-actions' },
      el('button', { class: 'btn', onclick: () => { closeDrawer(); openTransactions({ q: merchant.toLowerCase(), range: 'all' }); } }, icon('search'), `All from ${merchant}`),
      el('button', { class: 'btn', onclick: () => { closeDrawer(); openTransactions({ category: t.category, range: '90' }); } }, `All ${categoryLabel(t.category)}`)));
  $('scrim').hidden = false;
  drawer.hidden = false;
  drawer.querySelector('button').focus();
}

function closeDrawer() {
  if ($('drawer').hidden) return;
  $('drawer').hidden = true;
  $('scrim').hidden = true;
  if (drawerReturnFocus?.isConnected) drawerReturnFocus.focus();
}
$('scrim').addEventListener('click', closeDrawer);

// ============================================================ accounts

const GROUPS = [
  { id: 'cash', label: 'Cash' },
  { id: 'credit', label: 'Credit cards' },
  { id: 'investments', label: 'Investments' },
  { id: 'loans', label: 'Loans' },
  { id: 'other', label: 'Other assets & debts' },
];

function viewAccounts() {
  const root = el('div', {});
  if (!data.accounts.length && !data.manual.some((m) => m.kind !== 'points')) root.append(emptyWelcome());
  for (const g of GROUPS) {
    const accounts = data.accounts.filter((a) => a.category === g.id);
    const manual = g.id === 'other' ? data.manual.filter((m) => m.kind !== 'points') : [];
    if (!accounts.length && !manual.length) continue;
    const total = accounts.reduce((s, a) => s + (a.current || 0), 0)
      + manual.reduce((s, m) => s + (m.kind === 'asset' ? m.balance : -m.balance), 0);
    root.append(
      el('div', { class: 'section-title' }, el('h2', {}, g.label), el('span', { class: `total ${['credit', 'loans'].includes(g.id) ? 'neg' : ''}` }, money(total))),
      el('section', { class: 'card', style: { padding: '6px 20px' } }, el('div', { class: 'list' }, accounts.map(accountRow), manual.map(manualRow))));
  }
  if (data.connections.length) {
    root.append(el('div', { class: 'section-title' }, el('h2', {}, 'Connections'), el('button', { class: 'btn small', onclick: openAddMenu }, icon('plus'), 'Add')),
      el('section', { class: 'card', style: { padding: '6px 20px' } }, el('div', { class: 'list' }, data.connections.map(connectionRow))));
  }
  return root;
}

function accountRow(a) {
  const conn = connectionById(a.itemId);
  const owed = ['credit', 'loans'].includes(a.category);
  let meta = `${a.institution} · ${a.subtype || a.type}`;
  let meter = null;
  if (a.category === 'credit' && a.limit) {
    const u = ((a.current || 0) / a.limit) * 100;
    meta = `${a.institution} · ${pct(u, 0)} of ${money(a.limit, { cents: false })} used`;
    meter = el('div', { class: `meter ${u > 50 ? 'high' : u > 30 ? 'warn' : ''}`, style: { marginTop: '6px', maxWidth: '240px' } }, el('i', { style: { width: `${Math.min(100, u)}%` } }));
  }
  const sub = a.category === 'credit' && a.available != null ? `${money(a.available, { cents: false })} available`
    : a.category === 'cash' && a.available != null && a.available !== a.current ? `${money(a.available)} available` : null;
  return el('button', { class: 'row', type: 'button', onclick: () => (a.category === 'investments' ? go('investments') : openTransactions({ account: a.id, range: '90' })) },
    institutionAvatar(conn, a.institution),
    el('div', {},
      el('div', { class: 'title' }, a.name, a.mask && el('span', { class: 'muted' }, ` ••${a.mask}`), conn?.error && [' ', el('span', { class: 'tag warn' }, 'Not updating')]),
      el('div', { class: 'meta' }, meta), meter),
    el('div', { class: `amount ${owed ? 'neg' : ''}` }, money(a.current, { currency: a.currency }), sub && el('small', {}, sub)));
}

function manualRow(m) {
  return el('button', { class: 'row', type: 'button', onclick: () => openManualDialog(m.kind, m) },
    el('div', { class: 'avatar' }, icon(m.kind === 'asset' ? 'home2' : 'card')),
    el('div', {}, el('div', { class: 'title' }, m.name), el('div', { class: 'meta' }, `${m.kind === 'asset' ? 'Asset' : 'Debt'} · updated ${timeAgo(m.updatedAt)}`)),
    el('div', { class: `amount ${m.kind === 'liability' ? 'neg' : ''}` }, money(m.balance)));
}

function connectionRow(c) {
  const status = c.needsReconnect ? el('span', { class: 'tag warn' }, 'Needs login')
    : c.error ? el('span', { class: 'tag bad' }, titleCase(c.error))
      : el('span', { class: 'tag good' }, 'Connected');
  return el('div', { class: 'row static' },
    institutionAvatar(c),
    el('div', {}, el('div', { class: 'title' }, c.institutionName, ' ', status),
      el('div', { class: 'meta' }, `${c.kind === 'investments' ? 'Investments' : 'Banking & cards'} · updated ${timeAgo(c.fetchedAt)}`)),
    el('div', { style: { display: 'flex', gap: '6px' } },
      c.error && el('button', { class: 'btn small', onclick: () => openLink({ itemId: c.itemId }) }, 'Reconnect'),
      el('button', { class: 'btn small danger', onclick: () => removeConnection(c) }, 'Remove')));
}

async function removeConnection(c) {
  const ok = await confirmDialog(`Remove ${c.institutionName}?`,
    'Its access is revoked at Plaid, and its accounts and transactions are deleted from this app. You can connect it again anytime.', 'Remove');
  if (!ok) return;
  try {
    data = await api('POST', '/api/items/remove', { itemId: c.itemId });
    toast(`${c.institutionName} removed.`);
    render();
  } catch (err) {
    if (err.message !== 'Locked') toast(err.message, 'error');
  }
}

// ============================================================ investments

const SECURITY_TYPES = {
  equity: 'Stocks', etf: 'ETFs', 'mutual fund': 'Mutual funds', 'fixed income': 'Bonds', cash: 'Cash',
  cryptocurrency: 'Crypto', derivative: 'Options', loan: 'Loans', other: 'Other',
};

function viewInvestments() {
  const root = el('div', {});
  const invAccounts = data.accounts.filter((a) => a.category === 'investments');
  if (!data.holdings.length && !invAccounts.length) {
    root.append(el('section', { class: 'card empty' }, el('h3', {}, 'No investment accounts yet'),
      el('p', {}, 'Connect a brokerage, IRA or 401(k) to see your holdings, allocation and gains.'),
      el('button', { class: 'btn primary', onclick: () => openLink({ kind: 'investments' }) }, icon('plus'), 'Connect investments')));
    return root;
  }

  // The same security held in several accounts is shown once.
  const bySecurity = new Map();
  for (const h of data.holdings) {
    const key = h.securityId || h.name;
    const agg = bySecurity.get(key) || { ...h, quantity: 0, value: 0, costBasis: 0, hasCost: true };
    agg.quantity += h.quantity || 0;
    agg.value += h.value || 0;
    if (h.costBasis == null) agg.hasCost = false; else agg.costBasis += h.costBasis;
    bySecurity.set(key, agg);
  }
  const rows = [...bySecurity.values()].sort((a, b) => b.value - a.value);
  const value = rows.reduce((s, r) => s + r.value, 0) || invAccounts.reduce((s, a) => s + (a.current || 0), 0);
  const withCost = rows.filter((r) => r.hasCost && r.costBasis);
  const cost = withCost.reduce((s, r) => s + r.costBasis, 0);
  const gain = withCost.reduce((s, r) => s + r.value, 0) - cost;

  root.append(el('div', { class: 'grid cols-4' },
    el('div', { class: 'card stat' }, el('span', { class: 'label' }, 'Total value'), el('span', { class: 'value num' }, money(value))),
    el('div', { class: 'card stat' }, el('span', { class: 'label' }, 'Total gain'), el('span', { class: `value num ${gain >= 0 ? 'pos' : 'neg'}` }, cost ? money(gain, { sign: true }) : '—'),
      el('span', { class: 'foot' }, cost ? `${pct((gain / cost) * 100)} on ${money(cost, { cents: false })} invested` : 'Cost basis not reported')),
    el('div', { class: 'card stat' }, el('span', { class: 'label' }, 'Holdings'), el('span', { class: 'value num' }, number(rows.length))),
    el('div', { class: 'card stat' }, el('span', { class: 'label' }, 'Accounts'), el('span', { class: 'value num' }, number(invAccounts.length)))));

  // Allocation by security type, colored in fixed palette order; small slices fold into Other.
  if (rows.length) {
    const byType = new Map();
    for (const r of rows) byType.set(r.type, (byType.get(r.type) || 0) + r.value);
    let types = [...byType].sort((a, b) => b[1] - a[1]);
    if (types.length > 6) types = [...types.slice(0, 5), ['other', types.slice(5).reduce((s, t) => s + t[1], 0)]];
    const total = types.reduce((s, t) => s + t[1], 0) || 1;
    const typeName = (t) => SECURITY_TYPES[t] || titleCase(t);
    root.append(el('section', { class: 'card', style: { marginTop: '16px' } },
      el('div', { class: 'card-head' }, el('h2', {}, 'Allocation')),
      el('div', { class: 'alloc', role: 'img', 'aria-label': types.map(([t, v]) => `${typeName(t)} ${pct((v / total) * 100)}`).join(', ') },
        types.map(([t, v], i) => {
          const seg = el('i', { style: { width: `${(v / total) * 100}%`, background: `var(--s${i + 1})` } });
          seg.addEventListener('pointermove', (e) => showTooltip(e.clientX, e.clientY, typeName(t), [{ label: 'Value', value: money(v) }, { label: 'Share', value: pct((v / total) * 100) }]));
          seg.addEventListener('pointerleave', hideTooltip);
          return seg;
        })),
      el('div', { class: 'alloc-legend' }, types.map(([t, v], i) => el('div', {},
        el('i', { class: 'dot', style: { background: `var(--s${i + 1})` } }), typeName(t),
        el('span', { class: 'muted' }, pct((v / total) * 100)), el('b', {}, money(v, { cents: false })))))));

    root.append(el('section', { class: 'card', style: { marginTop: '16px' } },
      el('div', { class: 'card-head' }, el('h2', {}, 'Holdings')),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Security'), el('th', { class: 'r' }, 'Shares'), el('th', { class: 'r' }, 'Price'), el('th', { class: 'r' }, 'Value'), el('th', { class: 'r' }, 'Gain'), el('th', { class: 'r' }, 'Weight'))),
        el('tbody', {}, rows.map((r) => {
          const g = r.hasCost && r.costBasis ? r.value - r.costBasis : null;
          return el('tr', {},
            el('td', {}, el('div', { class: 'sec-name' },
              el('div', { class: 'avatar', style: { width: '32px', height: '32px', fontSize: '10.5px', borderRadius: '9px' } }, (r.ticker || initials(r.name)).slice(0, 4)),
              el('div', {}, el('div', { class: 'ticker' }, r.ticker || r.name),
                r.ticker ? el('div', { class: 'muted', style: { fontSize: '12px', maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis' } }, r.name) : null))),
            el('td', { class: 'r' }, number(r.quantity, 4)),
            el('td', { class: 'r' }, money(r.price)),
            el('td', { class: 'r' }, money(r.value)),
            el('td', { class: `r ${g == null || Math.abs(g) < 0.005 ? 'muted' : g > 0 ? 'pos' : 'neg'}` }, g == null ? '—' : `${money(g, { sign: true })} (${pct((g / r.costBasis) * 100)})`),
            el('td', { class: 'r' }, pct((r.value / (value || 1)) * 100)));
        }))))));
  }

  root.append(el('div', { class: 'section-title' }, el('h2', {}, 'Accounts')),
    el('section', { class: 'card', style: { padding: '6px 20px' } }, el('div', { class: 'list' }, invAccounts.map(accountRow))));
  return root;
}

// ============================================================ rewards

function viewRewards() {
  const programs = data.manual.filter((m) => m.kind === 'points').sort((a, b) => b.balance - a.balance);
  const root = el('div', {});
  if (!programs.length) {
    root.append(el('section', { class: 'card empty' }, el('h3', {}, 'Track your miles and points'),
      el('p', {}, 'Add airline, hotel and card rewards programs to see every balance and its estimated value in one place.'),
      el('button', { class: 'btn primary', onclick: () => openManualDialog('points') }, icon('plus'), 'Add a program')));
    return root;
  }
  const valued = programs.filter((p) => p.centsPerPoint != null);
  const totalValue = valued.reduce((s, p) => s + (p.balance * p.centsPerPoint) / 100, 0);
  const oldest = programs.reduce((o, p) => (!o || p.updatedAt < o.updatedAt ? p : o), null);
  root.append(el('div', { class: 'grid cols-4' },
    el('div', { class: 'card stat' }, el('span', { class: 'label' }, 'Estimated value'), el('span', { class: 'value num' }, money(totalValue, { cents: false })),
      el('span', { class: 'foot' }, valued.length < programs.length ? 'Some programs have no value set' : 'Not counted in net worth')),
    el('div', { class: 'card stat' }, el('span', { class: 'label' }, 'Programs'), el('span', { class: 'value num' }, number(programs.length))),
    el('div', { class: 'card stat' }, el('span', { class: 'label' }, 'Least recently updated'), el('span', { class: 'value', style: { fontSize: '17px', marginTop: '6px' } }, oldest.name),
      el('span', { class: 'foot' }, `Updated ${timeAgo(oldest.updatedAt)}`))));
  root.append(el('div', { class: 'section-title' }, el('h2', {}, 'Programs'), el('button', { class: 'btn small', onclick: () => openManualDialog('points') }, icon('plus'), 'Add program')));
  root.append(el('div', { class: 'points-grid' }, programs.map((p) => el('button', {
    class: 'card points-card', type: 'button', style: { textAlign: 'left', cursor: 'pointer' }, onclick: () => openManualDialog('points', p),
  },
  el('div', { class: 'eyebrow' }, p.name),
  el('div', { class: 'value num' }, number(p.balance), el('span', { class: 'muted', style: { fontSize: '14px', fontWeight: '500' } }, ` ${p.unit || 'points'}`)),
  el('div', { class: 'secondary-text' }, p.centsPerPoint != null ? `≈ ${money((p.balance * p.centsPerPoint) / 100, { cents: false })} at ${p.centsPerPoint}¢ each` : 'Click to set a value per point'),
  el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '10px' } }, `Updated ${timeAgo(p.updatedAt)} · click to update`)))));
  root.append(el('p', { class: 'muted', style: { marginTop: '16px', fontSize: '12.5px' } },
    'Airlines and hotels don\'t offer a safe way to sync balances, so you update these yourself. Typical values: airline miles 1–1.5¢, hotel points 0.4–0.8¢, flexible card points 1.25–2¢.'));
  return root;
}

// ============================================================ settings

function viewSettings() {
  const root = el('div', { class: 'settings-grid' });
  const envSelect = el('select', {},
    el('option', { value: 'sandbox' }, 'Sandbox (fake test banks)'),
    el('option', { value: 'production' }, 'Production (your real accounts)'));
  const clientId = el('input', { required: true, spellcheck: 'false', autocomplete: 'off' });
  const secret = el('input', { type: 'password', spellcheck: 'false', autocomplete: 'off' });
  const error = el('p', { class: 'form-error', role: 'alert' });
  let savedEnv = null;
  api('GET', '/api/settings').then((s) => {
    savedEnv = s.secretSaved ? s.env : null;
    envSelect.value = s.env;
    clientId.value = s.clientId;
    secret.placeholder = s.secretSaved ? 'Saved. Leave blank to keep it' : '';
  }).catch(() => {});

  const form = el('form', { autocomplete: 'off' },
    el('label', { class: 'field' }, el('span', {}, 'Environment'), envSelect),
    el('label', { class: 'field' }, el('span', {}, 'Client ID'), clientId),
    el('label', { class: 'field' }, el('span', {}, 'Secret'), secret, el('small', {}, 'Each environment has its own secret. Stored encrypted in your vault.')),
    el('div', {}, el('button', { class: 'btn primary', type: 'submit' }, 'Save keys')),
    error);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const env = envSelect.value;
    if (savedEnv && env !== savedEnv && !(await confirmDialog(`Switch to ${env}?`,
      'All connected accounts, transactions and history from the current environment are revoked and removed. Manual entries and points are kept.', 'Switch'))) return;
    try {
      await api('PUT', '/api/settings', { env, clientId: clientId.value, secret: secret.value });
      const firstTime = !savedEnv;
      data = await api('GET', '/api/data');
      toast('Plaid keys saved.');
      if (firstTime) { go('overview'); openAddMenu(); } else render();
    } catch (err) {
      if (err.message !== 'Locked') error.textContent = err.message;
    }
  });

  let theme = 'system';
  try { theme = localStorage.getItem('theme') || 'system'; } catch {}
  root.append(
    el('section', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', {}, 'Plaid keys')),
      el('p', { class: 'secondary-text', style: { marginTop: '-6px', marginBottom: '14px' } }, 'Find these at dashboard.plaid.com → Developers → Keys.'), form),
    el('section', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', {}, 'Appearance')),
      segmented([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], theme, (v) => { setTheme(v); render(); }, 'Theme')),
    el('section', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', {}, 'Security')),
      el('ul', { class: 'check-list' }, [
        'Bank logins happen in Plaid\'s window. This app only gets read-only access.',
        'Everything it stores is encrypted on this computer with AES-256 and your passphrase.',
        'Only this computer can open the app. It\'s invisible to your network and the internet.',
        'Locks when you close the tab, after 1 minute in the background, or after 15 minutes idle.',
        'No outside code runs in the app. Plaid\'s login runs in its own isolated window.',
      ].map((text) => el('li', {}, icon('check'), text))),
      el('div', { style: { marginTop: '16px' } }, el('button', { class: 'btn', onclick: lockNow }, icon('lock'), 'Lock now'))));
  return root;
}

// Theme is a per-browser convenience, so it lives in localStorage (no financial data).
function setTheme(v) {
  try { localStorage.setItem('theme', v); } catch {}
  if (v === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = v;
}
try { const t = localStorage.getItem('theme'); if (t && t !== 'system') document.documentElement.dataset.theme = t; } catch {}

// ============================================================ dialogs

function openDialog(content) {
  const d = $('dialog');
  d.replaceChildren(content);
  if (!d.open) d.showModal();
  return d;
}

function confirmDialog(title, text, action) {
  return new Promise((resolve) => {
    const d = openDialog(el('div', {},
      el('div', { class: 'dialog-body' }, el('h2', {}, title), el('p', {}, text)),
      el('div', { class: 'dialog-actions' },
        el('button', { class: 'btn', onclick: () => d.close('no') }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: () => d.close('yes') }, action))));
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
  });
}

function openAddMenu() {
  const choice = (ic, title, sub, fn) => el('button', { class: 'choice', type: 'button', onclick: () => { $('dialog').close(); fn(); } },
    el('div', { class: 'avatar' }, icon(ic)), el('div', {}, el('b', {}, title), el('span', {}, sub)), icon('chevron'));
  openDialog(el('div', { class: 'dialog-body' },
    el('h2', {}, 'Add to your dashboard'),
    el('div', { class: 'choice-list' },
      choice('bank', 'Bank or credit card', 'Checking, savings, cards and loans · syncs automatically', () => openLink({ kind: 'bank' })),
      choice('trending', 'Investment account', 'Brokerage, IRA or 401(k) · holdings and gains', () => openLink({ kind: 'investments' })),
      choice('star', 'Miles or points', 'Airline, hotel and card rewards · you enter balances', () => openManualDialog('points')),
      choice('home2', 'Other asset or debt', 'Home, car, crypto or a personal loan', () => openManualDialog('asset'))),
    el('div', { style: { textAlign: 'right' } }, el('button', { class: 'btn', onclick: () => $('dialog').close() }, 'Cancel'))));
}

function openManualDialog(kind, existing = null) {
  const isPoints = kind === 'points';
  let currentKind = existing?.kind || kind;
  const name = el('input', { required: true, maxlength: 60, value: existing?.name || '', placeholder: isPoints ? 'Delta SkyMiles' : 'Home' });
  const balance = el('input', { type: 'number', required: true, step: 'any', min: 0, value: existing?.balance ?? '', placeholder: isPoints ? '84500' : '450000', inputmode: 'decimal' });
  const unit = el('input', { maxlength: 20, value: existing?.unit || 'miles', placeholder: 'miles' });
  const cpp = el('input', { type: 'number', step: 'any', min: 0, max: 100, value: existing?.centsPerPoint ?? '', placeholder: '1.2', inputmode: 'decimal' });
  const error = el('p', { class: 'form-error', role: 'alert' });
  const kindPicker = !isPoints && el('div', { class: 'seg-choice', role: 'group', 'aria-label': 'Type' }, [['asset', 'Asset'], ['liability', 'Debt']].map(([v, text]) => el('button', {
    type: 'button', 'aria-pressed': String(currentKind === v),
    onclick: (e) => {
      currentKind = v;
      e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
    },
  }, text)));

  const form = el('form', { class: 'dialog-body' },
    el('h2', {}, existing ? `Update ${existing.name}` : isPoints ? 'Add a rewards program' : 'Add an asset or debt'),
    kindPicker,
    el('label', { class: 'field' }, el('span', {}, isPoints ? 'Program' : 'Name'), name),
    el('label', { class: 'field' }, el('span', {}, isPoints ? 'Balance' : 'Value (USD)'), balance),
    isPoints && el('div', { class: 'grid cols-2', style: { gap: '12px' } },
      el('label', { class: 'field' }, el('span', {}, 'Unit'), unit),
      el('label', { class: 'field' }, el('span', {}, 'Value per point (¢)'), cpp)),
    error,
    el('div', { style: { display: 'flex', gap: '8px', justifyContent: 'space-between' } },
      existing ? el('button', {
        class: 'btn danger', type: 'button', onclick: async () => {
          if (!(await confirmDialog(`Delete ${existing.name}?`, 'This removes it from your dashboard.', 'Delete'))) return;
          try { data = await api('POST', '/api/manual/remove', { id: existing.id }); toast('Deleted.'); render(); } catch (err) { if (err.message !== 'Locked') toast(err.message, 'error'); }
        },
      }, 'Delete') : el('span'),
      el('div', { style: { display: 'flex', gap: '8px' } },
        el('button', { class: 'btn', type: 'button', onclick: () => $('dialog').close() }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'submit' }, existing ? 'Save' : 'Add'))));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    try {
      data = await api('PUT', '/api/manual', {
        id: existing?.id, kind: currentKind, name: name.value, balance: balance.value, unit: unit.value, centsPerPoint: cpp.value,
      });
      $('dialog').close();
      toast(existing ? 'Saved.' : `${name.value} added.`);
      if (!existing) ui.view = currentKind === 'points' ? 'rewards' : 'accounts';
      render();
    } catch (err) {
      if (err.message !== 'Locked') error.textContent = err.message;
    }
  });
  openDialog(form);
  name.focus();
}

// ============================================================ Plaid Link

// Opens Plaid in its own window on a separate site (127.0.0.1), so Plaid's script
// never runs alongside your data. You type your bank login there, never here.
async function openLink({ kind = 'bank', itemId = null } = {}) {
  // Open the window right away, while the click still counts, so pop-up blockers allow it.
  const win = window.open('about:blank', 'plaid-link', 'popup=yes,width=480,height=760');
  if (!win) {
    toast('Allow pop-ups for this page to connect accounts.', 'error');
    return;
  }
  linkOpen = true;
  const linkOrigin = `http://127.0.0.1:${location.port}`;
  let poll = null;
  const cleanup = () => {
    window.removeEventListener('message', onMessage);
    clearInterval(poll);
    linkOpen = false;
  };

  // Only messages from that exact window, on that exact site, are accepted.
  async function onMessage(e) {
    if (e.origin !== linkOrigin || e.source !== win || e.data?.source !== 'plaid-link') return;
    cleanup();
    const { type, publicToken, institution, error } = e.data;
    if (type === 'exit') {
      if (error) toast(String(error).slice(0, 200), 'error');
      return;
    }
    if (type !== 'success' || typeof publicToken !== 'string') return;
    const name = typeof institution?.name === 'string' ? institution.name.slice(0, 100) : 'Account';
    try {
      if (itemId) {
        toast('Reconnected. Syncing…');
        await refresh();
      } else {
        toast(`Connecting ${name}… This can take a moment.`);
        data = await api('POST', '/api/exchange', {
          publicToken,
          kind,
          institution: { name, institution_id: typeof institution?.institution_id === 'string' ? institution.institution_id : null },
        });
        toast(`${name} connected.`);
        render();
      }
    } catch (err) {
      if (err.message !== 'Locked') toast(err.message, 'error');
    }
  }

  window.addEventListener('message', onMessage);
  poll = setInterval(() => { if (win.closed) cleanup(); }, 500);
  try {
    const { linkToken } = await api('POST', '/api/link-token', itemId ? { itemId } : { kind });
    win.location.replace(`${linkOrigin}/link#token=${encodeURIComponent(linkToken)}`);
  } catch (err) {
    win.close();
    cleanup();
    if (err.message !== 'Locked') toast(err.message, 'error');
  }
}

// ============================================================ locking & activity

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
  if ($('app').hidden) return;
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

// While you're actively using the page, keep the server session from idling out.
let lastPing = Date.now();
for (const evt of ['pointerdown', 'keydown', 'wheel']) {
  window.addEventListener(evt, () => {
    if (!data || Date.now() - lastPing < 2 * 60 * 1000) return;
    lastPing = Date.now();
    api('POST', '/api/ping').catch(() => {});
  }, { passive: true });
}

// ============================================================ global wiring

$('refresh-btn').addEventListener('click', refresh);
$('add-btn').addEventListener('click', openAddMenu);
$('lock-btn').addEventListener('click', lockNow);
$('lock-top').addEventListener('click', lockNow);
$('global-search-icon').replaceWith(icon('search'));
$('global-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value;
  e.target.value = '';
  e.target.blur();
  openTransactions({ q, range: 'all' });
});

document.addEventListener('keydown', (e) => {
  if (!data) return;
  if (e.key === 'Escape' && !$('drawer').hidden) { closeDrawer(); return; }
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName) || $('dialog').open;
  if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
    e.preventDefault();
    closeDrawer();
    if (ui.view !== 'transactions') { ui.view = 'transactions'; render(); }
    const s = $('view').querySelector('input[type=search]');
    s.focus();
    s.select();
  }
});

// Keep "Updated 5m ago" fresh.
setInterval(() => { if (data && !ui.refreshing) renderTopbar(); }, 30000);

// ============================================================ startup

(async () => {
  const status = await api('GET', '/api/status');
  vaultExists = status.vaultExists;
  if (status.unlocked) await enterApp();
  else showLockScreen();
})();
