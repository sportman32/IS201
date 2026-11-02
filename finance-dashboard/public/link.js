'use strict';

// The Plaid login window. It runs at http://127.0.0.1:PORT, a different site
// from the app (http://localhost:PORT), so Plaid's script can't reach your data
// or session. It hands only Plaid's one-time public token back to the app window.

const APP_ORIGIN = `http://localhost:${location.port}`;
const status = document.getElementById('status');

// The link token arrives in the URL fragment, which is never sent to any server.
// Remove it from the address bar right away.
const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);

function finish(message) {
  if (window.opener) window.opener.postMessage({ source: 'plaid-link', ...message }, APP_ORIGIN);
  window.close();
  // If the browser doesn't let the window close itself:
  status.textContent = 'Done. You can close this window and return to My Finances.';
}

if (!token || !window.opener) {
  status.textContent = 'Start from My Finances: click Add, then choose an account type.';
} else if (typeof Plaid === 'undefined') {
  finish({ type: 'exit', error: 'Could not load Plaid. Check your internet connection or ad blocker.' });
} else {
  Plaid.create({
    token,
    onSuccess: (publicToken, metadata) => {
      const institution = metadata.institution || {};
      finish({
        type: 'success',
        publicToken,
        institution: { name: institution.name || null, institution_id: institution.institution_id || null },
      });
    },
    onExit: (err) => finish({ type: 'exit', error: err ? err.display_message || err.error_message || 'Connection cancelled.' : null }),
  }).open();
}
