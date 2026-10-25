# My Finance Dashboard

A personal app that runs **only on your own computer**. It shows the current balances of all your bank accounts and credit cards on one screen: cash, card balances, credit utilization and net worth.

Bank connections go through [Plaid](https://plaid.com), the same service used by Venmo, Robinhood and most budgeting apps.

## How it keeps your data safe

| Risk | Protection |
|---|---|
| Someone gets your bank password | This app never sees it. You type it into Plaid's secure window, and the app only receives a **read-only token** that can't move money. |
| Someone copies files off your computer | Tokens are stored in `data/vault.json`, encrypted with **AES-256-GCM** using a key derived from your passphrase (**scrypt**). Without the passphrase the file is useless. The passphrase is never saved. |
| Someone on your Wi-Fi or the internet | The server only listens on `127.0.0.1`, so other devices can't connect to it at all. |
| You walk away from the computer | The app **auto-locks after 15 minutes** of inactivity and wipes the key from memory. There's also a **Lock** button. |
| Someone guesses your passphrase | Each wrong guess makes the next attempt wait longer (up to 30 seconds), and scrypt makes every guess slow. |
| A malicious website tries to talk to the app | Requests from other origins are blocked (CSRF and DNS-rebinding protection), with a strict Content-Security-Policy and no framing. |
| Removing an account | **Remove** tells Plaid to permanently revoke that token. |

The browser never receives Plaid tokens or your Plaid secret. Your secrets live in `.env`, and `.env`, `data/` and `node_modules/` are all git-ignored.

## Setup (about 15 minutes)

1. **Install Node.js 20 or newer** from <https://nodejs.org>.
2. **Create a free Plaid account** at <https://dashboard.plaid.com/signup>. Under **Developers → Keys**, copy your `client_id` and your **Sandbox** secret.
3. In this folder:
   ```bash
   cp .env.example .env      # then paste your client_id and secret into .env
   npm install
   npm start
   ```
4. Open <http://localhost:3000>, create a passphrase, and click **+ Connect account**.

### Try it with fake data first (Sandbox)
With `PLAID_ENV=sandbox`, pick any bank in the Plaid window and log in with username **`user_good`** and password **`pass_good`**. You'll see realistic fake checking, savings and credit card accounts.

### Switch to your real accounts (Production)
1. In the Plaid dashboard, request **Production** access. For personal, low-volume use this is typically free or a few dollars a month. Check Plaid's current pricing page.
2. In `.env`, set `PLAID_ENV=production` and replace `PLAID_SECRET` with your **Production** secret.
3. Delete `data/vault.json`, since sandbox connections don't work in production. Restart and connect your real banks and cards.

Some banks (for example Chase and Capital One) require Plaid to be approved for OAuth before you can connect them. The Plaid dashboard walks you through this.

## Everyday use
- `npm start`, open <http://localhost:3000>, then unlock.
- **Refresh** gets the latest balances.
- If a bank shows **Reconnect**, its login expired (this is normal every few months). Click it and log in again.
- **Forgot your passphrase?** Delete `data/vault.json` and reconnect your accounts. No money or bank data is lost.

## Tests
```bash
npm test
```

## Project layout
```
server.js        Local web server, Plaid calls, session and auto-lock
lib/vault.js     Encrypted storage for Plaid tokens
lib/summary.js   Totals: cash, card balances, utilization, net worth
public/          Dashboard UI (HTML, CSS, JS)
test/            Unit tests
```

## Ideas for later
- Loyalty points (airline and hotel) via manual entry or statement-email parsing
- Balance history chart (save a daily snapshot inside the vault)
- Recent transactions and spending by category
