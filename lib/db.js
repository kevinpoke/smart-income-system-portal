import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

// Server-only SQLite store for real auth + business data (accounts, sessions,
// outbox, earnings ledger, admin audit log). Kept separate from the
// client-side Zustand demo store, which only drives cosmetic/local UI state
// that must never be treated as the source of truth for money or status.
//
// Migration strategy: every column/table addition below is guarded by an
// existence check first (see ensureColumn / CREATE TABLE IF NOT EXISTS), so
// this file can be run repeatedly against an existing data/auth.db without
// clobbering real rows. Table/column identifiers interpolated into DDL below
// are fixed developer-authored constants (never request input), so they are
// not a SQL-injection surface; all *data* reads/writes elsewhere in the app
// use parameterized `?` placeholders.

const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "auth.db");

let _db = null;

function tableExists(db, table) {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(table);
  return Boolean(row);
}

function columnExists(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

function ensureColumn(db, table, column, definition) {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Columns added to `accounts` beyond the original auth-only set
// (id, email, name, password_hash, password_salt, must_change_password,
// role, created_at). Grouped by feature area for readability.
const ACCOUNT_COLUMNS = [
  // Identity
  ["first_name", "TEXT"],
  ["last_name", "TEXT"],

  // Status / lifecycle (allowed account_status: active | disabled)
  ["account_status", "TEXT NOT NULL DEFAULT 'active'"],
  ["first_login_at", "TEXT"],
  ["last_login_at", "TEXT"],

  // Package / earnings configuration (admin-controlled only)
  ["package_tier", "TEXT"],
  ["earnings_multiplier", "REAL NOT NULL DEFAULT 1.0"],
  ["current_balance_cents", "INTEGER NOT NULL DEFAULT 0"],
  ["lifetime_earnings_cents", "INTEGER NOT NULL DEFAULT 0"],

  // ISP setup / node activation workflow
  // Allowed isp_status: not_started | pending_review | approved_awaiting_user | active
  ["isp_status", "TEXT NOT NULL DEFAULT 'not_started'"],
  ["isp_submitted_at", "TEXT"],
  ["isp_approved_at", "TEXT"],
  ["user_authorized_at", "TEXT"],
  ["node_connected_at", "TEXT"],
  ["isp_street", "TEXT"],
  ["isp_city", "TEXT"],
  ["isp_state", "TEXT"],
  ["isp_zip", "TEXT"],
  ["isp_provider", "TEXT"],

  // Waitlist (Nodes page)
  ["waitlist_started_at", "TEXT"],
  ["waitlist_joined_at", "TEXT"],

  // External purchase reference (future JVZoo / Explodely integration)
  ["purchase_network", "TEXT"],
  ["external_order_id", "TEXT"],
  ["product_id", "TEXT"],
  ["purchased_at", "TEXT"],
];

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL DEFAULT 'customer',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      sent_via TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  for (const [column, definition] of ACCOUNT_COLUMNS) {
    ensureColumn(db, "accounts", column, definition);
  }

  // Earnings ledger: every credit/debit to a customer's balance is an
  // immutable row here. current_balance_cents / lifetime_earnings_cents on
  // `accounts` are denormalized caches recomputed from this table -- never
  // trust a client-submitted balance.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      event_type TEXT NOT NULL, -- earning | admin_credit | admin_debit | payout | correction
      base_amount_cents INTEGER NOT NULL,
      multiplier REAL NOT NULL DEFAULT 1.0,
      final_amount_cents INTEGER NOT NULL,
      effective_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source_reference TEXT,
      metadata_json TEXT,
      UNIQUE(account_id, source_reference)
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id);
  `);

  // Admin audit log: every sensitive admin write is recorded here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      admin_account_id TEXT NOT NULL,
      target_account_id TEXT,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_account_id);
  `);

  // Full ISP setup submission record (Phase 2). accounts.isp_city/isp_state/
  // isp_street/isp_zip/isp_provider are kept as a denormalized mirror for
  // quick reads elsewhere (payouts location, admin table), but this table
  // is the durable record of exactly what the customer submitted,
  // including fields not promoted to accounts (ssid / wifi password).
  db.exec(`
    CREATE TABLE IF NOT EXISTS isp_setups (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      provider TEXT NOT NULL,
      street TEXT NOT NULL,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      zip TEXT NOT NULL,
      ssid TEXT NOT NULL,
      wifi_password TEXT NOT NULL,
      submitted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_isp_setups_account ON isp_setups(account_id);
  `);
}

export function getDb() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(_db);
  return _db;
}

export { tableExists, columnExists };
