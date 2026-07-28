import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { rngFromKey, randomInt } from "./mockData";

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

  // Phase 5: WiFi on/off toggle. wifi_enabled only has meaning once
  // isp_status = 'active' (a Node is actually connected); it defaults to 1
  // so the moment /api/isp/authorize activates a Node, the customer is
  // shown as connected without requiring a separate first-time toggle.
  // wifi_state_since records the timestamp of the most recent on/off
  // transition and is the boundary used, together with wifi_events, to
  // compute exactly how much "on" time has elapsed for live earnings.
  ["wifi_enabled", "INTEGER NOT NULL DEFAULT 1"],
  ["wifi_state_since", "TEXT"],

  // Dashboard adjustment pass: marks an in-progress OFF->ON reconnection
  // (the 20-second "Establishing a Secure Connection..." flow). While this
  // is set, wifi_enabled remains 0 (still OFF) -- the account is only
  // actually marked connected once /api/wifi/reconnect/complete validates
  // (server-side) that at least 20 seconds have genuinely elapsed since
  // this timestamp. NULL means no reconnection is currently in progress.
  // This is what lets a page refresh/logout during the 20s window resume
  // correctly (the client re-derives remaining progress from this
  // timestamp) without ever granting earnings for the reconnecting period
  // (computeOnMsInRange still sees wifi_enabled=0 the whole time).
  ["wifi_reconnect_started_at", "TEXT"],

  // Phase 5: admin "Unlock All Modules" override. When set, gating logic
  // (Nodes page/API today) treats the account as unlocked regardless of
  // isp_status, without altering the underlying ISP workflow state.
  ["modules_unlocked", "INTEGER NOT NULL DEFAULT 0"],
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

  // Backfill wifi_state_since for accounts whose Node was already active
  // before this column existed, so earnings accrual has a valid boundary
  // immediately rather than treating every pre-existing active account as
  // "just turned on now". Idempotent: only touches rows still NULL.
  db.exec(
    `UPDATE accounts SET wifi_state_since = node_connected_at
     WHERE wifi_state_since IS NULL AND node_connected_at IS NOT NULL`
  );

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

  // Dashboard adjustment pass: per-Node earnings attribution.
  // ledger_entries.node_id identifies WHICH owned_nodes row a given
  // 'earning' row's amount is attributed to, so the Dashboard "Your
  // Nodes" table can show each Node's own cumulative "Total Earnings"
  // rather than dividing the account balance equally. NULL is
  // semantically meaningful and permanent for two categories of rows and
  // must never be backfilled to a guess:
  //   1. Non-'earning' rows (admin_credit/admin_debit/payout/correction)
  //      -- these are never attributed to a Node, per spec ("Administrative
  //      balance adjustments must not be falsely attributed to a Node").
  //   2. 'earning' rows written BEFORE this column existed (historical
  //      account-level earnings from Phase 5 / Phase 5 correction) -- we
  //      do not silently rewrite these with a guessed node_id, since we
  //      cannot know in retrospect which Node(s) existed at the time or
  //      how the account's Node inventory changed since. Per-Node totals
  //      for the "Your Nodes" table instead deterministically attribute
  //      this pre-existing NULL-node_id historical total by splitting it
  //      proportionally, at READ time (never rewritten in the DB), across
  //      the account's currently-owned Nodes by each Node's share of
  //      total estimated monthly earnings -- see
  //      lib/ownedNodes.js computeNodeEarningsTotals() for the exact
  //      read-time allocation and why it is safe/idempotent (it never
  //      writes anything, so it can be recomputed differently in the
  //      future without any migration).
  // New 'earning' rows going forward (see lib/earningsEngine.js
  // runEarningsCatchup) DO populate node_id directly and correctly,
  // proportionally splitting each cycle's total accrual across the
  // account's owned Nodes by their monthly-earnings share at write time
  // -- these are exact, not estimated, since the split happened at the
  // moment the money was "earned" in this demo model.
  ensureColumn(db, "ledger_entries", "node_id", "TEXT REFERENCES owned_nodes(id)");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ledger_node ON ledger_entries(node_id)`);

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
  // is the durable record of exactly what the customer submitted.
  //
  // SECURITY (Phase 3 correction): the WiFi password is NEVER persisted.
  // The portal does not need the real WiFi credential to simulate Node
  // activation, so the submit route discards it in memory after
  // validation and never writes it to any table or log. A prior version
  // of this schema had a `wifi_password` column -- the migration below
  // wipes any values that may have been written under that version and
  // drops the column entirely so the plaintext can't linger in the file
  // even in unused space.
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
      submitted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_isp_setups_account ON isp_setups(account_id);
  `);

  if (columnExists(db, "isp_setups", "wifi_password")) {
    // Overwrite before dropping so the plaintext isn't left recoverable in
    // the table's old row images any longer than necessary, then remove
    // the column so future schema introspection can't see it either.
    db.exec(`UPDATE isp_setups SET wifi_password = ''`);
    db.exec(`ALTER TABLE isp_setups DROP COLUMN wifi_password`);
    db.exec(`VACUUM`);
  }

  // Phase 5: WiFi on/off audit trail. audit_log.admin_account_id is
  // NOT NULL and semantically an ADMIN actor id (see
  // app/api/admin/isp/[id]/approve, its only other writer) -- reusing it
  // for a customer-initiated toggle would mislabel the audit trail. This
  // small dedicated table records every on/off transition instead.
  db.exec(`
    CREATE TABLE IF NOT EXISTS wifi_events (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      action TEXT NOT NULL, -- 'on' | 'off'
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wifi_events_account ON wifi_events(account_id, created_at);
  `);

  // Phase 5: customer-owned Node records (Dashboard "Your Nodes"). A row
  // is created here the moment a customer's Node is activated (see
  // app/api/isp/authorize). Location is intentionally NOT stored on this
  // table -- it is always read live from accounts.isp_city/isp_state at
  // query time, so it can never drift from the customer's actual ISP
  // Setup address. Capped defensively at 5 rows per account per the
  // "five Nodes per member" purchase limit.
  db.exec(`
    CREATE TABLE IF NOT EXISTS owned_nodes (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      node_number INTEGER NOT NULL,
      tier TEXT NOT NULL, -- 'Standard Node' | 'Super Node'
      est_monthly_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(account_id, node_number)
    );
    CREATE INDEX IF NOT EXISTS idx_owned_nodes_account ON owned_nodes(account_id);
  `);

  // Dashboard adjustment pass: customer-facing display Node ID, distinct
  // from `id` (internal PK, never shown) and `node_number` (internal
  // per-account ordinal used for the UNIQUE constraint / grant ordering,
  // also never shown directly). This is what actually renders in the UI
  // (e.g. "#8632563") and is fully independent of the internal identifier
  // scheme, so changing display formatting/values here can NEVER corrupt
  // the underlying PK or any ledger_entries.node_id foreign key (which
  // references owned_nodes.id, not this column).
  ensureColumn(db, "owned_nodes", "display_node_id", "TEXT");

  // Backfill: the customer's very first owned Node (node_number = 1) gets
  // the fixed demo display ID "8632563" per spec ("Use this exact visible
  // value for the current default owned Node"). Any additional Nodes
  // (node_number >= 2, for future multi-Node support) get a deterministic
  // 7-digit ID derived the same way the Nodes marketplace already
  // generates IDs (lib/nodesEngine.js), so every Node keeps its own
  // unique, stable display ID without ever colliding with "8632563" or
  // with each other. Idempotent: only ever touches rows still NULL, so
  // re-running this can never reassign/change an already-set display ID.
  db.exec(
    `UPDATE owned_nodes SET display_node_id = '8632563'
     WHERE display_node_id IS NULL AND node_number = 1`
  );

  // Any additional Nodes beyond the first (node_number >= 2) that still
  // lack a display ID get one deterministically derived from
  // account_id+node_number via the same FNV-1a/mulberry32 generator used
  // everywhere else in this codebase for stable "random-looking" demo
  // values (see lib/mockData.js rngFromKey) -- never Math.random(), so
  // re-running this migration can never reassign an ID even before the
  // NULL guard above would prevent it anyway.
  const missingDisplayIdRows = db
    .prepare(`SELECT id, account_id, node_number FROM owned_nodes WHERE display_node_id IS NULL`)
    .all();
  if (missingDisplayIdRows.length > 0) {
    const updateDisplayId = db.prepare(`UPDATE owned_nodes SET display_node_id = ? WHERE id = ?`);
    for (const row of missingDisplayIdRows) {
      const rand = rngFromKey(`ownednode:displayid:${row.account_id}:${row.node_number}`);
      const displayId = String(randomInt(rand, 1000000, 9999999));
      updateDisplayId.run(displayId, row.id);
    }
  }

  // Phase 5: bank information for withdrawals. Stored server-side only --
  // no API route ever serializes routing_number/account_number in full;
  // every client-facing read must go through a masking helper (see
  // lib/bank.js maskBankInfo) that returns only a last-4 representation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id),
      full_name TEXT NOT NULL,
      address TEXT NOT NULL,
      routing_number TEXT NOT NULL,
      account_number TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Phase 5: Support inbox. One conversation per customer account keeps
  // the admin inbox model simple (list of customers, not free-floating
  // threads) while still supporting the full read/unread/tag feature set.
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      created_at TEXT NOT NULL,
      last_message_at TEXT NOT NULL,
      -- unread_override: NULL = derive unread state from support_messages
      -- (any customer message with read_at IS NULL means unread); 1 =
      -- force-unread (admin used "Mark Unread"); 0 = force-read. Cleared
      -- back to NULL whenever a new customer message arrives or an admin
      -- opens the conversation, so the override never permanently masks
      -- real unread state.
      unread_override INTEGER,
      UNIQUE(account_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_account ON conversations(account_id);

    CREATE TABLE IF NOT EXISTS support_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      sender_role TEXT NOT NULL, -- 'customer' | 'admin'
      sender_account_id TEXT,   -- admin account id for admin-sent messages; NULL for customer messages
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read_at TEXT              -- set when an admin has viewed this (customer) message
    );
    CREATE INDEX IF NOT EXISTS idx_support_messages_conversation ON support_messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_support_messages_unread ON support_messages(conversation_id, sender_role, read_at);

    CREATE TABLE IF NOT EXISTS support_tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_tags (
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      tag_id TEXT NOT NULL REFERENCES support_tags(id),
      created_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_tags_tag ON conversation_tags(tag_id);
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
