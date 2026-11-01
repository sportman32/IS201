'use strict';

// Minimal Plaid API client using Node's built-in fetch, so the app has no
// third-party dependencies. Only the endpoints the app needs are here.
// API reference: https://plaid.com/docs/api/

const HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};
const API_VERSION = '2020-09-14';
const TIMEOUT_MS = 30000;

class PlaidError extends Error {
  constructor(code, message, type) {
    super(message || code);
    this.code = code;
    this.type = type || null;
  }
}

function createPlaidClient({ env, clientId, secret }) {
  const base = HOSTS[env];
  if (!base) throw new Error(`Unknown Plaid environment: ${env}`);

  async function call(endpoint, body) {
    let res;
    try {
      res = await fetch(base + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Plaid-Version': API_VERSION },
        body: JSON.stringify({ client_id: clientId, secret, ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new PlaidError('NETWORK_ERROR', 'Could not reach Plaid. Check your internet connection.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new PlaidError(data.error_code || `HTTP_${res.status}`, data.display_message || data.error_message, data.error_type);
    }
    return data;
  }

  return {
    linkTokenCreate: (req) => call('/link/token/create', req),
    itemPublicTokenExchange: (req) => call('/item/public_token/exchange', req),
    accountsGet: (req) => call('/accounts/get', req),
    itemRemove: (req) => call('/item/remove', req),
    transactionsSync: (req) => call('/transactions/sync', req),
    investmentsHoldingsGet: (req) => call('/investments/holdings/get', req),
    liabilitiesGet: (req) => call('/liabilities/get', req),
    institutionsGetById: (req) => call('/institutions/get_by_id', req),
  };
}

module.exports = { createPlaidClient, PlaidError, PLAID_ENVS: Object.keys(HOSTS) };
