'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { simplifyAccount, simplifyTransaction, simplifyCredit, summarize } = require('../lib/summary');

const acct = (type, current, extra = {}) => simplifyAccount({
  account_id: Math.random().toString(36),
  name: type,
  type,
  balances: { current, available: null, limit: null, iso_currency_code: 'USD', ...extra },
}, 'Bank');

test('computes net worth with cards and loans as debts', () => {
  const totals = summarize([
    acct('depository', 1000.10),
    acct('depository', 250.20),
    acct('investment', 5000),
    acct('credit', 300.30, { limit: 3000 }),
    acct('loan', 2000),
  ]).USD;
  assert.strictEqual(totals.cash, 1250.30);
  assert.strictEqual(totals.creditCardDebt, 300.30);
  assert.strictEqual(totals.creditUtilization, 10);
  assert.strictEqual(totals.netWorth, 1250.30 + 5000 - 300.30 - 2000);
});

test('keeps currencies separate and tolerates missing balances', () => {
  const totals = summarize([acct('depository', null), acct('depository', 10, { iso_currency_code: 'CAD' })]);
  assert.strictEqual(totals.USD.cash, 0);
  assert.strictEqual(totals.CAD.cash, 10);
  assert.strictEqual(totals.USD.creditUtilization, null);
});

test('manual assets and debts count toward USD net worth; points do not', () => {
  const totals = summarize([acct('depository', 100)], [
    { kind: 'asset', balance: 1000 }, { kind: 'liability', balance: 300 }, { kind: 'points', balance: 50000 },
  ]).USD;
  assert.strictEqual(totals.netWorth, 800);
  assert.strictEqual(totals.manualAssets, 1000);
  assert.strictEqual(totals.manualDebts, 300);
});

test('pending transactions use the authorized date', () => {
  const t = simplifyTransaction({ transaction_id: 'x', account_id: 'a', amount: 5, date: '2026-10-21', authorized_date: '2026-10-20', pending: true, name: 'X' }, 'item');
  assert.strictEqual(t.date, '2026-10-20');
  assert.strictEqual(t.category, 'OTHER');
  assert.strictEqual(t.itemId, 'item');
});

test('credit details prefer the purchase APR', () => {
  const c = simplifyCredit({ liabilities: { credit: [{ account_id: 'c', aprs: [{ apr_type: 'cash_apr', apr_percentage: 29 }, { apr_type: 'purchase_apr', apr_percentage: 21 }] }] } });
  assert.strictEqual(c.c.apr, 21);
  assert.strictEqual(c.c.dueDate, null);
});
