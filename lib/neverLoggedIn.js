// ANALYTICS/SUPPORT/BRIDGE batch: durable Never-Logged-In-By-Day-3 admin
// list. See lib/db.js admin_never_logged_in_3day table comment for the
// full "permanent, append-only historical snapshot" rationale -- this
// file is the ONLY place that ever writes to that table, and it NEVER
// deletes/updates an existing row for any reason.
//
// QUALIFICATION RULE: a customer account qualifies once ALL of the
// following are true:
//   - role = 'customer' (admins are never eligible)
//   - account age >= 72h: now - created_at >= 72h
//   - EITHER first_login_at IS NULL (never logged in at all), OR
//     first_login_at is itself more than 72h after created_at (logged in
//     for the first time, but not until AFTER the Day-3 window had
//     already closed)
// A qualifying account is inserted exactly once (idempotency is
// double-guaranteed: the NOT EXISTS check below AND the table's own
// UNIQUE(account_id) constraint / INSERT OR IGNORE), and NEVER removed
// or updated afterward, even if the customer later logs in, sets up
// ISP, gets disabled/re-enabled, etc. -- this list is a historical fact
// ("this account missed its Day-3 login window"), not a live status.

const DAY3_MS = 72 * 60 * 60 * 1000;

// Callable both as a one-time BACKFILL (covers every existing account
// that already qualifies as of whenever this first runs) and as a
// recurring scan (see lib/backgroundScheduler.js runTick(), which calls
// this on every tick) -- both cases are the exact same idempotent
// query/insert logic, since re-running it after some accounts already
// have rows is always a safe no-op for those accounts (NOT EXISTS skips
// them) and correctly picks up any newly-qualifying account since the
// last run.
export function runNeverLoggedIn3DayScan(db, nowMs = Date.now()) {
  const cutoffIso = new Date(nowMs - DAY3_MS).toISOString();
  // BUG FIX (verification-report finding): first_login_at is stored as a
  // JS-generated ISO-8601 string ("...T...Z"), but SQLite's datetime()
  // function returns a space-separated string ("YYYY-MM-DD HH:MM:SS").
  // Comparing the raw ISO first_login_at directly against
  // datetime(created_at, '+72 hours') (as this query previously did) is
  // a STRING comparison where 'T' (0x54) sorts after ' ' (0x20) -- so
  // any first_login_at whose date component is >= the cutoff's date
  // incorrectly compared as "greater than" the cutoff regardless of the
  // actual clock time, causing accounts that logged in WELL WITHIN the
  // 72h window (e.g. at +24h, +71h) to be wrongly flagged as
  // never-logged-in-by-day-3. Wrapping first_login_at in datetime(...)
  // normalizes both sides to the same space-separated format so the
  // comparison is a correct chronological one.

  const candidates = db
    .prepare(
      `SELECT id, created_at, email FROM accounts a
       WHERE a.role = 'customer'
         AND a.created_at <= ?
         AND (
           a.first_login_at IS NULL
           OR datetime(a.first_login_at) > datetime(a.created_at, '+72 hours')
         )
         AND NOT EXISTS (
           SELECT 1 FROM admin_never_logged_in_3day n WHERE n.account_id = a.id
         )`
    )
    .all(cutoffIso);

  if (candidates.length === 0) return { scanned: 0, inserted: 0 };

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO admin_never_logged_in_3day
       (account_id, qualified_at, created_at_snapshot, email_snapshot)
     VALUES (?, ?, ?, ?)`
  );

  const nowIso = new Date(nowMs).toISOString();
  let insertedCount = 0;
  for (const row of candidates) {
    const result = insertStmt.run(row.id, nowIso, row.created_at, row.email);
    if (result.changes > 0) insertedCount += 1;
  }

  return { scanned: candidates.length, inserted: insertedCount };
}

// Admin read helper: joins the permanent snapshot table to the LIVE
// accounts table so an admin can see the account's CURRENT email and
// (if it eventually happened) a later first_login_at timestamp, WITHOUT
// that later activity ever removing the row from this permanent list --
// see the table comment in lib/db.js. Supports server-side search by
// email (matches either the live accounts.email or the frozen
// email_snapshot, in case the customer's email has since changed) and
// LIMIT/OFFSET pagination, default pageSize 50. Returns
// { rows, totalCount }.
export function listNeverLoggedIn3Day(db, { search = "", page = 1, pageSize = 50 } = {}) {
  const safePage = Number.isInteger(page) && page >= 1 ? page : 1;
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 50;

  const whereClauses = [];
  const params = [];
  const trimmedSearch = search.trim().toLowerCase();
  if (trimmedSearch) {
    whereClauses.push(`(LOWER(a.email) LIKE ? OR LOWER(n.email_snapshot) LIKE ?)`);
    const like = `%${trimmedSearch}%`;
    params.push(like, like);
  }
  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const totalCount = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM admin_never_logged_in_3day n
       JOIN accounts a ON a.id = n.account_id
       ${whereSql}`
    )
    .get(...params).c;

  const offset = (safePage - 1) * safePageSize;
  const rows = db
    .prepare(
      `SELECT
         n.account_id, n.qualified_at, n.created_at_snapshot, n.email_snapshot,
         a.email AS current_email, a.first_name, a.last_name, a.name,
         a.first_login_at AS current_first_login_at, a.account_status
       FROM admin_never_logged_in_3day n
       JOIN accounts a ON a.id = n.account_id
       ${whereSql}
       ORDER BY n.qualified_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, safePageSize, offset);

  return {
    rows: rows.map((r) => ({
      accountId: r.account_id,
      qualifiedAt: r.qualified_at,
      createdAtSnapshot: r.created_at_snapshot,
      emailSnapshot: r.email_snapshot,
      currentEmail: r.current_email,
      firstName: r.first_name,
      lastName: r.last_name,
      name: r.name,
      currentFirstLoginAt: r.current_first_login_at, // non-null means they DID eventually log in, later
      accountStatus: r.account_status,
    })),
    totalCount,
  };
}
