'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { simplifyAccount, summarize } = require('../lib/summary');

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
