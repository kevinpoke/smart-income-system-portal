#!/usr/bin/env node
// One-time DB backfill: normalize existing owned_nodes rows whose stored
// est_monthly_cents/earning_rate_cents exceed their OWN tier's CURRENT
// maxCents (lib/nodeTiers.js). This exists because tier ranges have
// been tightened over time (most recently: nova/XI Bridge's max dropped
// from $2,000 to $1,700 in the production feature/fix batch), and a
// range change alone never retroactively touches rows persisted under
// an earlier, wider range -- lib/nodeTiers.js#pickRateForTier() only
// applies at the moment a NEW rate is assigned (Node creation, or an
// admin explicitly changing a Node's tier).
//
// Companion runtime guard: lib/nodeTiers.js#clampCentsToTierMax(), wired
// into lib/earningsEngine.js#computeNodeCycleCents(), means production
// was ALREADY safe from over-cap rows inflating live/future earnings
// even before this script runs. This script's only job is to make the
// STORED values themselves honest again (so admin UI/API responses that
// read est_monthly_cents directly, e.g. User Management's Node list,
// stop displaying a stale over-cap number) -- it changes no earnings
// math on its own.
//
// SAFE BY DEFAULT: dry-run unless --apply is passed. Prints exactly
// which rows would change / did change (owned_nodes.id, account_id,
// tier, old cents, new cents) -- no other columns, no PII beyond the
// existing account_id/node id already used everywhere else in this
// app's admin tooling.
//
// Usage:
//   node scripts/normalize-xi-cap.mjs [--db /path/to/auth.db] [--apply]
//
// Defaults --db to $SIS_DB_PATH, then ./data/auth.db, matching this
// app's own lib/db.js resolution order (see getDb()).

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const NODE_TIERS = {
  standard: { maxCents: 250000 },
  super: { maxCents: 400000 },
  nova: { maxCents: 170000 },
};

const DISPLAY_TO_KEY = {
  "Standard Node": "standard",
  "Super Node": "super",
  "Nova Node": "nova",
};

function tierMaxCentsForDisplayName(displayName) {
  const key = DISPLAY_TO_KEY[displayName] || "standard";
  return NODE_TIERS[key].maxCents;
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dbFlagIdx = args.indexOf("--db");
const dbPath =
  dbFlagIdx !== -1 && args[dbFlagIdx + 1]
    ? args[dbFlagIdx + 1]
    : process.env.SIS_DB_PATH || path.join(process.cwd(), "data", "auth.db");

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}. Pass --db /path/to/auth.db or set SIS_DB_PATH.`);
  process.exit(1);
}

console.log(`normalize-xi-cap: ${apply ? "APPLY" : "DRY-RUN"} against ${dbPath}`);

const db = new DatabaseSync(dbPath);

const rows = db
  .prepare(
    `SELECT id, account_id, tier, est_monthly_cents, earning_rate_cents
     FROM owned_nodes
     WHERE removed_at IS NULL`
  )
  .all();

const overCap = rows
  .map((r) => ({ ...r, maxCents: tierMaxCentsForDisplayName(r.tier) }))
  .filter((r) => r.est_monthly_cents > r.maxCents);

if (overCap.length === 0) {
  console.log("No owned_nodes rows exceed their tier's current cap. Nothing to do.");
  db.close();
  process.exit(0);
}

console.log(`Found ${overCap.length} row(s) exceeding their tier cap:`);
for (const r of overCap) {
  console.log(
    `  node=${r.id} account=${r.account_id} tier=${r.tier} ` +
      `est_monthly_cents=${r.est_monthly_cents} -> ${r.maxCents} ` +
      `(earning_rate_cents=${r.earning_rate_cents ?? "null"} -> ${r.maxCents})`
  );
}

if (!apply) {
  console.log("\nDry-run only -- no changes made. Re-run with --apply to write these updates.");
  db.close();
  process.exit(0);
}

const update = db.prepare(
  `UPDATE owned_nodes SET est_monthly_cents = ?, earning_rate_cents = ? WHERE id = ?`
);

db.exec("BEGIN");
try {
  for (const r of overCap) {
    update.run(r.maxCents, r.maxCents, r.id);
  }
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  throw err;
}

console.log(`\nApplied: clamped ${overCap.length} row(s) to their tier's cap.`);
db.close();
