'use strict';

// Turns raw Plaid data into the simplified shapes and totals the dashboard shows.
// Amounts are summed in integer cents to avoid floating-point drift.

const toCents = (n) => Math.round((Number(n) || 0) * 100);
const fromCents = (c) => c / 100;
const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

function categorize(type) {
  switch (type) {
    case 'depository': return 'cash';
    case 'credit': return 'credit';
    case 'loan': return 'loans';
    case 'investment':
    case 'brokerage': return 'investments';
    default: return 'other';
  }
}

// Plaid reports credit card and loan balances as positive "amount owed".
function simplifyAccount(account, institution) {
  const b = account.balances || {};
  return {
    id: account.account_id,
    institution,
    name: account.official_name || account.name,
    mask: account.mask || null,
    type: account.type,
    subtype: account.subtype || null,
    category: categorize(account.type),
    currency: b.iso_currency_code || b.unofficial_currency_code || 'USD',
    current: num(b.current),
    available: num(b.available),
    limit: num(b.limit),
  };
}

// Plaid amounts are positive for money leaving the account, negative for money coming in.
function simplifyTransaction(t, itemId) {
  const pfc = t.personal_finance_category || {};
  return {
    id: t.transaction_id,
    itemId,
    accountId: t.account_id,
    date: t.authorized_date && t.pending ? t.authorized_date : t.date,
    name: t.name || '',
    merchant: t.merchant_name || null,
    amount: num(t.amount) ?? 0,
    currency: t.iso_currency_code || t.unofficial_currency_code || 'USD',
    category: pfc.primary || 'OTHER',
    detailed: pfc.detailed || null,
    pending: Boolean(t.pending),
    channel: t.payment_channel || null,
  };
}

// Joins holdings with their securities so each row is self-describing.
function simplifyHoldings(response) {
  const securities = new Map((response.securities || []).map((s) => [s.security_id, s]));
  return (response.holdings || []).map((h) => {
    const s = securities.get(h.security_id) || {};
    return {
      accountId: h.account_id,
      securityId: h.security_id,
      name: s.name || s.ticker_symbol || 'Unknown security',
      ticker: s.ticker_symbol || null,
      type: s.type || 'other',
      quantity: num(h.quantity),
      price: num(h.institution_price) ?? num(s.close_price),
      value: num(h.institution_value),
      costBasis: num(h.cost_basis),
      currency: h.iso_currency_code || 'USD',
    };
  });
}

// Credit card payment details keyed by account id.
function simplifyCredit(response) {
  const out = {};
  for (const c of response.liabilities?.credit || []) {
    const purchase = (c.aprs || []).find((a) => a.apr_type === 'purchase_apr') || (c.aprs || [])[0];
    out[c.account_id] = {
      apr: num(purchase?.apr_percentage),
      minimumPayment: num(c.minimum_payment_amount),
      dueDate: c.next_payment_due_date || null,
      lastStatementBalance: num(c.last_statement_balance),
      lastPaymentAmount: num(c.last_payment_amount),
      lastPaymentDate: c.last_payment_date || null,
      overdue: Boolean(c.is_overdue),
    };
  }
  return out;
}

// Totals per currency. Manual assets and debts (house, car, a loan from family)
// count toward USD net worth; points programs are tracked separately.
function summarize(accounts, manual = []) {
  const byCurrency = {};
  const bucket = (cur) => (byCurrency[cur] ??= {
    cash: 0, investments: 0, other: 0, credit: 0, loans: 0, creditLimit: 0, manualAssets: 0, manualDebts: 0,
  });
  for (const a of accounts) {
    const t = bucket(a.currency);
    t[a.category] += toCents(a.current);
    if (a.category === 'credit') t.creditLimit += toCents(a.limit);
  }
  for (const m of manual) {
    if (m.kind === 'asset') bucket('USD').manualAssets += toCents(m.balance);
    if (m.kind === 'liability') bucket('USD').manualDebts += toCents(m.balance);
  }
  const totals = {};
  for (const [currency, t] of Object.entries(byCurrency)) {
    const assets = t.cash + t.investments + t.other + t.manualAssets;
    const debts = t.credit + t.loans + t.manualDebts;
    totals[currency] = {
      cash: fromCents(t.cash),
      investments: fromCents(t.investments),
      other: fromCents(t.other),
      creditCardDebt: fromCents(t.credit),
      loans: fromCents(t.loans),
      manualAssets: fromCents(t.manualAssets),
      manualDebts: fromCents(t.manualDebts),
      creditLimit: fromCents(t.creditLimit),
      creditUtilization: t.creditLimit > 0 ? Math.round((t.credit / t.creditLimit) * 1000) / 10 : null,
      assets: fromCents(assets),
      debts: fromCents(debts),
      netWorth: fromCents(assets - debts),
    };
  }
  return totals;
}

module.exports = { simplifyAccount, simplifyTransaction, simplifyHoldings, simplifyCredit, summarize };
