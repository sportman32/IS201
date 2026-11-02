# Security review

What this app protects, how, and what it can't protect against. Every protection marked **Tested** has an automated test in `test/` that tries the attack and checks that it fails. Run `npm test` to check them yourself.

## What's at stake

| Asset | Where it lives | If stolen |
|---|---|---|
| Plaid client ID and secret | Encrypted vault (`data/vault.json`) | With a bank token, someone could read your balances and transactions |
| Plaid access tokens (one per bank) | Encrypted vault | Same as above. They are read-only: **they cannot move money** |
| Balances, transactions, holdings, points | Encrypted vault; in the browser tab only while unlocked | Privacy loss |
| Your passphrase | Nowhere. Only in your head and password manager | Opens the vault |

Bank passwords are never seen, sent or stored by this app. You type them only into Plaid's window.

## Who might attack, and what stops them

### 1. Anyone on the internet or your Wi-Fi: no access
- The server listens only on `127.0.0.1` (loopback), so no other device can connect. Verified: the only listening socket is `127.0.0.1:PORT`. Connections to the machine's network address and to IPv6 are refused.
- It accepts no incoming connections from Plaid or anyone else (no webhooks). It only makes outgoing HTTPS calls to `sandbox.plaid.com` or `production.plaid.com`.
- It refuses to start if certificate checking has been turned off (`NODE_TLS_REJECT_UNAUTHORIZED=0`), so an impostor can't pose as Plaid. **Tested**

### 2. Websites you visit in the same browser: no access
- **Reading your data:** blocked three ways.
  - The session cookie is `SameSite=Strict` and `HttpOnly`.
  - The browser blocks other sites from reading responses.
  - The server rejects any API request that the browser labels as coming from another site, including other apps on `localhost`. **Tested, plus a live run with a hostile page**
- **Triggering actions (CSRF):** every change must come from the app's own origin. **Tested**
- **DNS rebinding** (a site pointing its own domain at your computer): any request not addressed to `localhost:PORT` is refused. **Tested**
- **Clickjacking** (hiding the app in an invisible frame): framing is forbidden. **Tested**
- **Forged messages** pretending to be Plaid: the app accepts results only from the exact window it opened, on the exact Plaid-window site. **Tested live**

### 3. Malicious content in bank data: can't run
- Merchant names, descriptions and institution names are always displayed as plain text, never as HTML. Even if they could become code, the Content-Security-Policy forbids running any script not shipped with the app. **Tested live:** a transaction named `<script>…</script>` displays as text and never runs.
- Logos and colors from Plaid are validated before use. **Tested**
- CSV exports defuse spreadsheet formulas (`=`, `+`, `-`, `@`), so a malicious description can't run when you open the file in Excel. **Tested live**

### 4. Third-party code: kept away from your data
- The app uses **no npm packages**, only Node.js itself.
- The app page loads **no outside code** (`script-src 'self'`).
- Plaid's script is the only outside code. It runs in a separate window on a separate site (`http://127.0.0.1:PORT`, while the app is `http://localhost:PORT`). That site:
  - never receives the session cookie
  - can't read the app's page
  - can't call the API

  It only hands back Plaid's one-time public token, which is useless without your Plaid secret. **Tested live**

### 5. Someone who copies your files: can't read them
- The vault is encrypted with **AES-256-GCM**. The key is derived from your passphrase with **scrypt** (N=2¹⁷, r=8), which makes each guess slow and memory-heavy.
- Passphrases must be 16+ characters and not repetitive.
- Any change to the file is detected.
- A file tampered to demand extreme settings is refused.
- Older, weaker settings are upgraded automatically when you unlock. **Tested**
- Nothing sensitive is written anywhere else:
  - no plaintext secrets or `.env` file
  - no browser caching (`Cache-Control: no-store`)
  - nothing in browser storage except your theme choice
  - logs show only error codes

### 6. Other programs or accounts on your computer: limited
- Another program can connect to `localhost`, but it can't do anything without your session, a random 256-bit value held only by your browser. **Tested**
- A wrong passphrase sent by another program no longer logs you out, and another program can no longer lock you out. Both were possible before this review and are now fixed. **Tested**
- Passphrase guessing is slowed: each wrong guess doubles the wait, up to 30 seconds.
- The Windows start file clears settings (`NODE_OPTIONS` and certificate overrides) that could make Node.js load extra code.
- **Keep the app in your own user folder** (`C:\Users\<you>\Apps`), not directly under `C:\`. On Windows, folders created directly under `C:\` can be modified by other accounts on the PC, which could tamper with the app's code. The start file warns you if the folder is outside your user folder or inside OneDrive.

### 7. Someone at your keyboard: limited window
- The app locks:
  - immediately when the tab is closed or reloaded
  - after 1 minute in the background
  - after 15 minutes idle
- Locking erases the key from memory.

## What no app can fully protect against

1. **Malware already running as your Windows user.** It could record your keystrokes (including the passphrase), read the browser's memory while unlocked, or alter the app's files. It could also pretend to be the app on port 3000 while the real app isn't running. This is true of every program on a compromised computer, including your bank's own app. The defenses are on the computer itself:
   - keep Windows and your browser updated
   - keep Microsoft Defender on
   - don't run unknown software
   - use a standard (non-admin) account day to day
2. **Browser extensions** can read pages you open. Use a browser profile with no extensions for this app.
3. **Data in memory and the page file** while unlocked. Turn on **BitLocker** or Device Encryption so the disk, including the page file, is encrypted.
4. **CSV exports** are ordinary unencrypted files. Delete them when you're done.
5. **Plaid and your banks** hold your data on their side. Removing a connection in the app revokes its token at Plaid.
6. **Nuisance from local programs:** another program on your computer could slow down unlock attempts by sending wrong guesses, but it can't get in.

## Check it yourself (Windows)

With the app running, open Command Prompt and run:

```
netstat -ano | findstr :3000
```

You should see `127.0.0.1:3000 ... LISTENING` and nothing like `0.0.0.0:3000`. That shows only your own computer can connect.
