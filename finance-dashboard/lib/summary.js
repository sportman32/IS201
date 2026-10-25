'use strict';

// Turns raw Plaid account data into the totals shown on the dashboard.
// Amounts are summed in integer cents to avoid floating-point drift.

const toCents = (n) => Math.round((Number(n) || 0) * 100);
const fromCents = (c) => c / 100;

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
  const category = categorize(account.type);
  return {
    id: account.account_id,
    institution,
    name: account.official_name || account.name,
    mask: account.mask || null,
    type: account.type,
    subtype: account.subtype || null,
    category,
    currency: b.iso_currency_code || b.unofficial_currency_code || 'USD',
    current: b.current ?? null,
    available: b.available ?? null,
    limit: b.limit ?? null,
  };
}

function summarize(accounts) {
  const byCurrency = {};
  for (const a of accounts) {
    const t = (byCurrency[a.currency] ??= { cash: 0, investments: 0, other: 0, credit: 0, loans: 0, creditLimit: 0 });
    t[a.category] += toCents(a.current);
    if (a.category === 'credit') t.creditLimit += toCents(a.limit);
  }
  const totals = {};
  for (const [currency, t] of Object.entries(byCurrency)) {
    const assets = t.cash + t.investments + t.other;
    const debts = t.credit + t.loans;
    totals[currency] = {
      cash: fromCents(t.cash),
      investments: fromCents(t.investments),
      other: fromCents(t.other),
      creditCardDebt: fromCents(t.credit),
      loans: fromCents(t.loans),
      creditLimit: fromCents(t.creditLimit),
      creditUtilization: t.creditLimit > 0 ? Math.round((t.credit / t.creditLimit) * 1000) / 10 : null,
      assets: fromCents(assets),
      debts: fromCents(debts),
      netWorth: fromCents(assets - debts),
    };
  }
  return totals;
}

module.exports = { simplifyAccount, summarize };
