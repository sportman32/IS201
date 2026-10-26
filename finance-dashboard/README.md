# My Finance Dashboard

A personal app that runs **only on your own computer**. It shows the current balances of all your bank accounts and credit cards on one screen: cash, card balances, credit utilization and net worth.

Bank connections go through [Plaid](https://plaid.com), the same service used by Venmo, Robinhood and most budgeting apps.

**It has zero third-party dependencies.** Every line of code that runs is in this folder or is part of Node.js itself.

## How it keeps your data safe

| Risk | Protection |
|---|---|
| Someone gets your bank password | This app never sees it. You type it into Plaid's secure window, and the app only receives a **read-only token** that can't move money. |
| Someone copies files off your computer | Your Plaid keys and bank tokens are stored only in `data/vault.json`, encrypted with **AES-256-GCM** using a key derived from your passphrase (**scrypt**). Without the passphrase the file is useless. The passphrase is never saved, and no secrets sit in plain files. |
| Malicious code sneaks in through a package ("supply-chain attack") | The app uses **no npm packages**, only Node's built-in modules. The only outside code is Plaid's official Link script, loaded from Plaid's CDN. Your bank login form runs inside Plaid's own isolated frame. |
| Someone on your Wi-Fi or the internet | The server only listens on `127.0.0.1`, so other devices can't connect to it at all. |
| You walk away from the computer | The app locks **immediately when you close or reload the tab**, **after 1 minute** with the tab in the background, and **after 15 minutes** idle. Locking wipes the key from memory. There's also a **Lock** button. |
| Someone guesses your passphrase | Passphrases must be **16+ characters** and not repetitive, with a strength meter. Each wrong guess makes the next attempt wait longer (up to 30 seconds), and scrypt makes every guess slow. |
| A malicious website tries to talk to the app | Requests from other origins are blocked (CSRF and DNS-rebinding protection), with a strict Content-Security-Policy and no framing. |
| Removing an account | **Remove** tells Plaid to permanently revoke that token. |

The browser never receives Plaid tokens or your Plaid secret, and `data/` is git-ignored.

## Setup (about 10 minutes)

1. **Install Node.js 20 or newer** (the **LTS** version) from <https://nodejs.org>.
2. **Create a free Plaid account** at <https://dashboard.plaid.com/signup>. Under **Developers → Keys**, you'll find your `client_id` and your **Sandbox** secret.
3. Open a terminal in this folder and run:
   ```bash
   npm start
   ```
   There's nothing to install: the app has no dependencies.
4. Open <http://localhost:3000> and create a passphrase. Use 5–6 random words and save it in a password manager.
5. The **Settings** panel opens. Paste your Plaid client ID and secret and click **Save**. They are stored encrypted in your vault.
6. Click **+ Connect account**.

### Try it with fake data first (Sandbox)
With **Sandbox** selected in Settings, pick any bank in the Plaid window and log in with username **`user_good`** and password **`pass_good`**. You'll see realistic fake checking, savings and credit card accounts.

### Switch to your real accounts (Production)
1. In the Plaid dashboard, request **Production** access. New US accounts get a free Trial plan with up to 10 bank logins. Check Plaid's current pricing page.
2. In the app, open **Settings**, choose **Production**, paste your **Production** secret, and save. Your sandbox test connections are revoked and removed automatically.
3. Connect your real banks and cards.

Some banks (for example Chase and Capital One) require Plaid to be approved for OAuth before you can connect them. The Plaid dashboard walks you through this.

## Everyday use
- Run `npm start` in this folder, open <http://localhost:3000>, then unlock. Press **Ctrl + C** in the terminal to stop the app.
- **Refresh** gets the latest balances.
- If a bank shows **Reconnect**, its login expired (this is normal every few months). Click it and log in again.
- **Forgot your passphrase?** Delete `data/vault.json`, then re-enter your Plaid keys and reconnect your accounts. No money or bank data is lost.

Optional settings, as environment variables: `PORT` (default 3000) and `IDLE_LOCK_MINUTES` (default 15).

## Keep your computer secure too
The app can't protect you from a compromised computer, so:
- Turn on **disk encryption**: FileVault on Mac, BitLocker or Device Encryption on Windows.
- Keep your system and browser **updated**, and set a short screen-lock timeout.
- Use a **separate browser profile with no extensions** for this app. Extensions can read pages you open.
- Turn on **two-factor authentication** for your Plaid dashboard, email and GitHub.
- Turn on **balance and transaction alerts** at your banks.

## Tests
```bash
npm test
```

## Project layout
```
server.js        Local web server, routes, session and auto-lock
lib/plaid.js     Minimal Plaid API client (built-in fetch, no SDK)
lib/vault.js     Encrypted storage for Plaid keys and tokens
lib/summary.js   Totals: cash, card balances, utilization, net worth
public/          Dashboard UI (HTML, CSS, JS)
test/            Tests, including the security rules
```

## Ideas for later
- Loyalty points (airline and hotel) via manual entry or statement-email parsing
- Balance history chart (save a daily snapshot inside the vault)
- Recent transactions and spending by category
