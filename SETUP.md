# Running this locally

## 1. Install dependencies

```bash
npm install
```

Requires Node.js 22+ (uses the built-in `node:sqlite` module, which is
experimental — you'll see a one-time `ExperimentalWarning` in the console,
that's expected and harmless).

## 2. Start the dev server

```bash
npm run dev
```

Open http://localhost:3000 — you'll be redirected to `/login` since every
route except `/login`, the auth API, and the purchase webhook requires a
session cookie.

## 3. Create your first (admin) account

There's no signup form — accounts are created either by the purchase
webhook or manually. Easiest path: run this once from the project root to
seed an admin login (uses the same scrypt hashing as the real app):

```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'auth.db'));
db.exec(\`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT,
    password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    role TEXT NOT NULL DEFAULT 'customer', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, account_id TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY, to_email TEXT NOT NULL, subject TEXT NOT NULL,
    body TEXT NOT NULL, sent_via TEXT NOT NULL, created_at TEXT NOT NULL
  );
\`);
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
const { hash, salt } = hashPassword('AdminPass123');
const id = 'acct_admin_' + crypto.randomBytes(6).toString('hex');
db.prepare('INSERT OR IGNORE INTO accounts (id, email, name, password_hash, password_salt, must_change_password, role, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
  .run(id, 'admin@staratlas.local', 'Admin', hash, salt, 'admin', new Date().toISOString());
console.log('admin account ready: admin@staratlas.local / AdminPass123');
"
```

Then log in at http://localhost:3000/login with:
- **Email:** `admin@staratlas.local`
- **Password:** `AdminPass123`

## 4. Test the purchase webhook flow

Go to **http://localhost:3000/admin** and click **"Simulate JVZoo Purchase"**.
This POSTs `{email: "test@example.com", name: "Test User", password: "Password123"}`
to `/api/webhooks/purchase`, which:
- Creates a real account in `data/auth.db` (SQLite, gitignored, created on first run)
- Logs `[Email Sent] ...` to your terminal (real email delivery needs
  `SENDGRID_API_KEY` + `EMAIL_FROM` env vars — until then it falls back to
  a local "outbox" table, visible right on the admin page)

You can then log in as `test@example.com` / `Password123` at `/login`.

## What's real vs. simulated

- **Real**: accounts, password hashing (scrypt), sessions (httpOnly cookie),
  the `/api/webhooks/purchase` endpoint, SQLite storage in `data/auth.db`.
- **Simulated / demo data**: the Dashboard/Modules/Payouts/Nodes/Withdrawals
  pages and the "User Management" table on `/admin` still run off a
  client-side Zustand store (`lib/store.js`, persisted to browser
  localStorage) seeded with 4 fake demo users — this is separate from the
  real SQLite accounts table. They're not wired together yet (a real
  customer logging in won't see personalized dashboard data reflecting
  their own webhook signup) — flag if you want that connected next.
- **Not yet configured**: SendGrid (needs `SENDGRID_API_KEY` + `EMAIL_FROM`
  in a `.env.local` file) — until then all emails land in the local outbox
  table shown on the admin page instead of actually sending.
