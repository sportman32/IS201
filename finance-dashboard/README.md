# My Finance Dashboard

A personal app that runs **only on your own computer**. It brings all your money into one place:

- **Overview:** net worth with a history chart, cash, investments, credit card use, cash flow by month, spending by category, recent transactions and upcoming card payments.
- **Transactions:** instant search across every bank and card. Type a merchant, category, account or amount (`coffee`, `>100`, `<20`, `42.50`, `pending`), filter by date, account, category or direction, open any transaction for details, and export to CSV.
- **Accounts:** every bank, card, loan and investment account with balances, card limits and connection status, plus anything you add yourself (home, car, a personal loan).
- **Investments:** holdings across brokerages, IRAs and 401(k)s, combined by security, with gains, allocation and weights.
- **Rewards:** your airline, hotel and card points with estimated value. You enter these yourself, since airlines and hotels don't offer a safe way to sync them.
- Light and dark mode, keyboard shortcuts (`/` or `Ctrl+K` to search), and it works in a narrow window.

Bank connections go through [Plaid](https://plaid.com), the same service used by Venmo, Robinhood and most budgeting apps.

**It has zero third-party dependencies.** Every line of code that runs is in this folder or is part of Node.js itself.

## How it keeps your data safe

| Risk | Protection |
|---|---|
| Someone gets your bank password | This app never sees it. You type it into Plaid's secure window, and the app only receives a **read-only token** that can't move money. |
| Someone copies files off your computer | Your Plaid keys and bank tokens are stored only in `data/vault.json`, encrypted with **AES-256-GCM** using a key derived from your passphrase (**scrypt**). Without the passphrase the file is useless. The passphrase is never saved, and no secrets sit in plain files. |
| Malicious code sneaks in through a package ("supply-chain attack") | The app uses **no npm packages**, only Node's built-in modules, and the app page loads no outside code at all. Plaid's script runs in a **separate window on a separate site** (`127.0.0.1`) that can't see your data or session. |
| Someone on your Wi-Fi or the internet | The server only listens on `127.0.0.1`, so other devices can't connect to it at all. |
| You walk away from the computer | The app locks **immediately when you close or reload the tab**, **after 1 minute** with the tab in the background, and **after 15 minutes** idle. Locking wipes the key from memory. There's also a **Lock** button. |
| Someone guesses your passphrase | Passphrases must be **16+ characters** and not repetitive, with a strength meter. Each wrong guess makes the next attempt wait longer (up to 30 seconds), and scrypt makes every guess slow. |
| A malicious website tries to talk to the app | Requests from any other site, including other apps on `localhost`, are rejected. There's CSRF and DNS-rebinding protection, a strict Content-Security-Policy and no framing. |
| Malicious text in bank data | Always shown as plain text, so it can never run as code. CSV exports defuse spreadsheet formulas. |
| Another program or account on your computer | Can't do anything without your session. Wrong guesses can't log you out. Keep the folder in your user folder so other accounts can't change the app's files. |
| Removing an account | **Remove** tells Plaid to permanently revoke that token. |

The browser never receives Plaid tokens or your Plaid secret, and `data/` is git-ignored. See **[SECURITY.md](SECURITY.md)** for the full security review, including what no app can protect against.

## Setup (about 10 minutes)

1. **Install Node.js 20 or newer** (the **LTS** version) from <https://nodejs.org>.
2. **Create a free Plaid account** at <https://dashboard.plaid.com/signup>. Under **Developers → Keys**, you'll find your `client_id` and your **Sandbox** secret.
3. Start the app. There's nothing to install: the app has no dependencies.
   - **Windows:** double-click **`Start Finance Dashboard`** (`Start Finance Dashboard.bat`). Your browser opens automatically.
   - **Mac or Linux:** open a terminal in this folder, run `npm start`, then open <http://localhost:3000>.
4. Create a passphrase. Use 5–6 random words and save it in a password manager.
5. The **Settings** panel opens. Paste your Plaid client ID and secret and click **Save**. They are stored encrypted in your vault.
6. Click **Add** and choose **Bank or credit card** or **Investment account**.

### Try it with fake data first (Sandbox)
With **Sandbox** selected in Settings, pick any bank in the Plaid window and log in with username **`user_good`** and password **`pass_good`**. You'll see realistic fake checking, savings and credit card accounts.

### Switch to your real accounts (Production)
1. In the Plaid dashboard, request **Production** access. New US accounts get a free Trial plan with up to 10 connections (each bank, card issuer or brokerage login is one), including transactions, investments and card details. Check Plaid's current pricing page.
2. In the app, open **Settings**, choose **Production**, paste your **Production** secret, and save. Your sandbox test connections are revoked and removed automatically.
3. Connect your real banks and cards.

Some banks (for example Chase and Capital One) require Plaid to be approved for OAuth before you can connect them. The Plaid dashboard walks you through this.

## Everyday use
- **Windows:** double-click **`Start Finance Dashboard`** and unlock. Keep the black window open while you use the app, and close it to stop the app. Tip: right-click the file, choose **Show more options → Send to → Desktop (create shortcut)** to start it from your desktop.
- **Mac or Linux:** run `npm start` in this folder, open <http://localhost:3000>, then unlock. Press **Ctrl + C** in the terminal to stop the app.
- The app syncs automatically when you unlock it (if the last sync was more than 30 minutes ago). Click **Updated … ago** in the top bar to sync now. Only new transactions are downloaded.
- New bank connections pull up to 2 years of transaction history. It can take a few minutes for Plaid to have all of it ready, so click sync again later if older transactions are missing.
- If a bank shows **Reconnect**, its login expired (this is normal every few months). Click it and log in again.
- **Forgot your passphrase?** Delete `data/vault.json`, then re-enter your Plaid keys and reconnect your accounts. No money or bank data is lost.

Optional settings, as environment variables: `PORT` (default 3000) and `IDLE_LOCK_MINUTES` (default 15).

## Keep your computer secure too
The app can't protect you from a compromised computer, so:
- Turn on **disk encryption**: FileVault on Mac, BitLocker or Device Encryption on Windows.
- Keep this folder **in your user folder but outside OneDrive, iCloud or Dropbox**, for example `C:\Users\<you>\Apps`. Other Windows accounts can't change files there, and the vault never leaves your computer. The Windows start file warns you if the folder is somewhere else.
- Keep your system and browser **updated**, and set a short screen-lock timeout.
- Use a **separate browser profile with no extensions** for this app. Extensions can read pages you open.
- Allow pop-ups for `localhost` so Plaid's window can open when you connect an account.
- Delete CSV exports when you're done with them, since they're not encrypted.
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
lib/summary.js   Shapes Plaid data and computes totals and net worth
public/          Dashboard UI; link.html/link.js is the isolated Plaid window
test/            Tests, including the security rules
```

## Ideas for later
- Budgets per category with alerts
- Recurring subscriptions detection
- Investment transaction history (buys, sells, dividends)
