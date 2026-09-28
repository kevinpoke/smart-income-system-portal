import fs from "node:fs";
import path from "node:path";

// AWEBER-3DAY-NO-LOGIN-SYNC batch: the ONE AWeber API client for this
// whole app. No prior AWeber integration existed in this codebase
// (verified by a full repo-wide search before writing this file) --
// this is greenfield, built and LIVE-VERIFIED against the real AWeber
// API (account id, both list ids, and the create/find/update/delete
// subscriber operations below were each independently confirmed
// against the real API during development; see the batch's PR/commit
// notes) using OAuth2 credentials the user authorized interactively.
//
// AUTH: AWeber OAuth2 (authorization-code grant, already completed
// once out-of-band to mint the initial token pair). Access tokens
// expire in ~2 hours; this client automatically refreshes via the
// refresh_token grant and -- because AWeber ROTATES the refresh token
// on every single use (confirmed live: a used refresh_token cannot be
// reused) -- persists the freshly rotated access+refresh token pair to
// a DURABLE TOKEN-STATE FILE on every refresh, otherwise every second
// refresh would silently start failing.
//
// PRODUCTION-SAFETY AUDIT (source-inspection only, no production
// access): docker-compose.prod.yml passes
// /opt/smart-income-system/config/production.env to the container via
// Compose's `env_file:` directive -- this is read by Docker Compose ON
// THE HOST at container start and injected as plain environment
// variables. The CONTAINER PROCESS NEVER SEES THAT FILE ITSELF (it is
// not bind-mounted), so this application could never write rotated
// tokens back into it even if it wanted to. The ONLY volume actually
// mounted into the container is
// /opt/smart-income-system/data:/app/data (already used for
// data/auth.db, matching lib/db.js's own process.cwd()-relative path
// resolution) -- this is the correct, ALREADY-AVAILABLE durable
// location for a small rotating-token state file; no new volume needs
// to be added for this batch.
//
// TOKEN STATE FILE: a small, dedicated JSON file at
// AWEBER_TOKEN_STATE_PATH (defaults to
// path.join(process.cwd(), "data", "aweber-oauth.json"), i.e.
// /app/data/aweber-oauth.json in production, colocated with auth.db on
// the same already-durable bind mount) containing ONLY
// { accessToken, refreshToken, accessTokenExpiresAtMs, updatedAt } --
// NEVER client id/secret/account id/list ids, which remain static
// config in production.env per spec. Written atomically (write to a
// temp file in the SAME directory, then fs.renameSync -- rename is
// atomic on the same filesystem, so a crash mid-write can never leave
// a half-written/corrupt state file) with restrictive permissions
// (0600 -- owner read/write only). On first boot (no state file yet),
// this client BOOTSTRAPS from the env vars below (whatever initial
// token pair was minted by the one-time interactive OAuth exchange);
// every refresh AFTER that writes the state file first, so the file
// becomes authoritative for the rotating pair from that point forward,
// while the env vars remain a permanent fallback/bootstrap source that
// is never itself rewritten (env vars are typically not writable at
// all in a container).
//
// CONFIG (see .env.local for local dev, never committed -- see
// .gitignore's pre-existing `.env*` entry; production.env for prod):
//   AWEBER_CLIENT_ID, AWEBER_CLIENT_SECRET  -- OAuth2 app credentials
//   AWEBER_ACCESS_TOKEN, AWEBER_REFRESH_TOKEN -- BOOTSTRAP token pair
//     only, used solely when no token-state file exists yet
//   AWEBER_ACCOUNT_ID           -- this AWeber account's numeric id
//   AWEBER_LIST_ID_BUNBUN_MEDIA_CO -- source list (all customers land
//                                     here today)
//   AWEBER_LIST_ID_3DAY_NO_LOGIN   -- target/quarantine list
//   AWEBER_TOKEN_STATE_PATH     -- optional override for the durable
//                                   token-state file path
//
// Per spec section 15 ("do not rely on mutable list names at runtime
// if... stable list IDs" exist): both list IDs are configured once,
// here, as stable numeric ids -- never re-resolved by name on every
// call.

const TOKEN_URL = "https://auth.aweber.com/oauth2/token";
const API_BASE = "https://api.aweber.com/1.0";

const ENV_LOCAL_PATH = path.join(process.cwd(), ".env.local");

function tokenStatePath() {
  return process.env.AWEBER_TOKEN_STATE_PATH || path.join(process.cwd(), "data", "aweber-oauth.json");
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`AWeber integration misconfigured: missing ${name} in environment.`);
  }
  return value;
}

// In-process cache of the current access token + its expiry, so a burst
// of calls within the same scheduler tick doesn't refresh redundantly.
// Reset on process restart -- the very next call reloads from the
// durable token-state file (or bootstraps from env), never from a
// stale in-memory value.
let cachedAccessToken = null;
let cachedAccessTokenExpiresAtMs = 0;
let cachedRefreshToken = null;

// CONCURRENCY SAFETY: AWeber rotates (invalidates) the refresh_token on
// every use. If two callers in the SAME process both notice the access
// token has expired at nearly the same moment (e.g. two scheduler-batch
// candidates processed back-to-back, or a manual admin retry firing
// while the scheduler tick is mid-flight), and each independently
// calls refreshAccessToken(), the SECOND call would present the
// already-just-invalidated refresh_token to AWeber and fail with
// invalid_grant -- a genuine race, not a hypothetical one, given this
// app's batch-of-25 sequential-but-still-concurrent-with-manual-retry
// processing model. This single shared in-flight promise ensures only
// ONE real refresh_token POST is ever in flight at a time PER PROCESS:
// every concurrent caller that arrives while a refresh is already
// running awaits and receives the SAME resolved access token, rather
// than racing to spend the same rotating refresh_token twice.
let inFlightRefresh = null;

// Reads the durable token-state file if present. Returns null if it
// doesn't exist yet (first-ever boot) or is unreadable/corrupt (falls
// back to env-var bootstrap in that case too, rather than crashing).
function readTokenState() {
  const statePath = tokenStatePath();
  if (!fs.existsSync(statePath)) return null;
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Atomically persists the current token pair to the durable state
// file: write to a temp file in the SAME directory (guarantees the
// rename below is on the same filesystem, making it atomic), then
// fs.renameSync over the real path. This means the OLD token-state
// file (or none, on first write) remains intact and readable right up
// until the instant the new one is fully written -- a crash or power
// loss mid-write can never leave a truncated/corrupt state file for
// the next process to load. Sets file mode 0600 (owner read/write
// only) before the rename so the final file is never briefly
// world-readable. Never logs the token values.
function writeTokenState({ accessToken, refreshToken, accessTokenExpiresAtMs }) {
  const statePath = tokenStatePath();
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path.join(dir, `.aweber-oauth.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(
    {
      accessToken,
      refreshToken,
      accessTokenExpiresAtMs,
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  );
  fs.writeFileSync(tmpPath, payload, { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, statePath);
}

// Persists a freshly rotated access+refresh token pair: the DURABLE
// token-state file first (this is what survives restart/recreate/
// reboot), then the in-process cache, then -- for local dev
// convenience only, when a .env.local file exists (never present in
// production, see the audit above) -- a best-effort mirror into
// .env.local so a developer inspecting that file sees the latest
// values too. The .env.local mirror is NOT relied upon for
// correctness anywhere; the token-state file is the sole source of
// truth for what the NEXT process loads.
function persistRotatedTokens({ accessToken, refreshToken, accessTokenExpiresAtMs }) {
  writeTokenState({ accessToken, refreshToken, accessTokenExpiresAtMs });

  cachedAccessToken = accessToken;
  cachedRefreshToken = refreshToken;
  cachedAccessTokenExpiresAtMs = accessTokenExpiresAtMs;

  if (!fs.existsSync(ENV_LOCAL_PATH)) {
    // No .env.local on this deployment (production, or a dev checkout
    // that hasn't created one) -- the durable token-state file above
    // is already the authoritative persistence; nothing more to do.
    return;
  }

  const original = fs.readFileSync(ENV_LOCAL_PATH, "utf8");
  const lines = original.split("\n");
  let sawAccess = false;
  let sawRefresh = false;
  const updated = lines.map((line) => {
    if (line.startsWith("AWEBER_ACCESS_TOKEN=")) {
      sawAccess = true;
      return `AWEBER_ACCESS_TOKEN=${accessToken}`;
    }
    if (line.startsWith("AWEBER_REFRESH_TOKEN=")) {
      sawRefresh = true;
      return `AWEBER_REFRESH_TOKEN=${refreshToken}`;
    }
    return line;
  });
  if (!sawAccess) updated.push(`AWEBER_ACCESS_TOKEN=${accessToken}`);
  if (!sawRefresh) updated.push(`AWEBER_REFRESH_TOKEN=${refreshToken}`);
  fs.writeFileSync(ENV_LOCAL_PATH, updated.join("\n"));
}

// Resolves the refresh_token to use for the NEXT refresh call: the
// durable token-state file's value if one exists (it is authoritative
// once bootstrapped, since it always holds the MOST RECENTLY rotated
// pair), otherwise the bootstrap value from AWEBER_REFRESH_TOKEN (only
// ever used on a genuine first-ever boot with no state file yet).
function currentRefreshToken() {
  if (cachedRefreshToken) return cachedRefreshToken;
  const state = readTokenState();
  if (state?.refreshToken) {
    cachedRefreshToken = state.refreshToken;
    return cachedRefreshToken;
  }
  return requiredEnv("AWEBER_REFRESH_TOKEN");
}

// Exchanges the current refresh_token for a fresh access_token (and a
// ROTATED refresh_token -- AWeber invalidates the old one on use,
// confirmed live). The new pair is persisted to the durable
// token-state file BEFORE it becomes the only valid token this process
// relies on for its next call -- i.e. writeTokenState() (inside
// persistRotatedTokens) completes before this function returns the new
// access token to any caller. Never logs/throws the token values
// themselves.
//
// CONCURRENCY: this is the single entry point every caller (getAccessToken's
// expiry path AND aweberRequest's 401-retry path) goes through, and it
// is wrapped by a shared in-flight promise (see inFlightRefresh above)
// so at most one real HTTP refresh_token exchange is ever in flight at
// once per process -- see refreshAccessToken() below, which is the
// public-facing function name every caller actually calls.
async function doRefreshAccessToken() {
  const clientId = requiredEnv("AWEBER_CLIENT_ID");
  const clientSecret = requiredEnv("AWEBER_CLIENT_SECRET");
  const refreshToken = currentRefreshToken();

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`AWeber token refresh failed: HTTP ${res.status} ${bodyText.slice(0, 300)}`);
  }

  const data = await res.json();
  // Refresh a little early (60s buffer) rather than cutting it exactly
  // at the provider's own expiry.
  const expiresAtMs = Date.now() + (data.expires_in - 60) * 1000;
  persistRotatedTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessTokenExpiresAtMs: expiresAtMs,
  });
  return cachedAccessToken;
}

// Public refresh entry point -- ALL callers (getAccessToken, and
// aweberRequest's bounded 401-retry) call THIS function, never
// doRefreshAccessToken() directly. If a refresh is already in flight
// (inFlightRefresh non-null), every concurrent caller awaits and
// receives that SAME promise's result instead of starting a second,
// independent refresh_token exchange -- this is what prevents two
// concurrent callers from each trying to spend the same
// about-to-be-rotated-and-invalidated refresh_token. The in-flight
// promise is cleared in a `finally` so the NEXT genuinely-needed
// refresh (well after this one settles) always starts a fresh attempt,
// whether the previous one succeeded or failed.
async function refreshAccessToken() {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }
  inFlightRefresh = doRefreshAccessToken().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAtMs) {
    return cachedAccessToken;
  }

  // No valid in-memory token yet this process (fresh boot, or expired)
  // -- BOOTSTRAP/RELOAD order of precedence:
  //   1. The durable token-state file, if one exists -- it always
  //      holds the MOST RECENTLY rotated pair from any prior process,
  //      so this is what makes a container restart/recreate correctly
  //      pick up the newest tokens rather than an env var that may now
  //      be stale (AWeber invalidates a used refresh_token, so a stale
  //      env-var refresh_token would fail the very next refresh
  //      attempt if the state file were ignored here).
  //   2. AWEBER_ACCESS_TOKEN from env -- ONLY on a genuine first-ever
  //      boot with no state file yet (the initial interactive OAuth
  //      exchange's token pair).
  const state = readTokenState();
  if (state?.accessToken) {
    cachedAccessToken = state.accessToken;
    cachedRefreshToken = state.refreshToken;
    // accessTokenExpiresAtMs may be absent on an older/foreign state
    // file shape -- treat as unknown-but-recent (conservative 5
    // minutes) rather than crashing or forcing an immediate refresh.
    cachedAccessTokenExpiresAtMs =
      typeof state.accessTokenExpiresAtMs === "number"
        ? state.accessTokenExpiresAtMs
        : Date.now() + 5 * 60 * 1000;
    if (Date.now() < cachedAccessTokenExpiresAtMs) {
      return cachedAccessToken;
    }
    // State file's access token has expired -- fall through to a real
    // refresh, which will use this same state file's refresh_token
    // (already cached above) as the current one.
    return refreshAccessToken();
  }

  const envToken = process.env.AWEBER_ACCESS_TOKEN;
  if (envToken) {
    // First-ever boot, no state file yet -- bootstrap from env,
    // treated as valid for a conservative 5 minutes so this cold start
    // doesn't force an unnecessary refresh, but a call soon after will
    // naturally refresh once truly needed (and that refresh will
    // create the state file for every subsequent boot).
    cachedAccessToken = envToken;
    cachedAccessTokenExpiresAtMs = Date.now() + 5 * 60 * 1000;
    return cachedAccessToken;
  }
  return refreshAccessToken();
}

// Low-level authenticated request helper. On a 401 (expired/invalid
// token), refreshes ONCE and retries the exact same request exactly
// once -- never an unbounded retry loop. Every other HTTP status is
// returned as-is (including 4xx/5xx) for the caller to interpret,
// EXCEPT network-level failures which throw.
async function aweberRequest(pathSuffix, { method = "GET", body } = {}) {
  const doRequest = async (token) => {
    const res = await fetch(`${API_BASE}${pathSuffix}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  };

  let token = await getAccessToken();
  let res = await doRequest(token);

  if (res.status === 401) {
    // Token expired/invalid mid-cache-window (e.g. revoked externally,
    // or our expiry estimate was optimistic) -- refresh exactly once
    // and retry exactly once. A second 401 after a fresh refresh is a
    // genuine auth failure, surfaced to the caller as-is.
    token = await refreshAccessToken();
    res = await doRequest(token);
  }

  let json = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return { status: res.status, ok: res.ok, json, rawText: text };
}

// ---- List/subscriber operations -----------------------------------------

export function getBunbunListId() {
  return requiredEnv("AWEBER_LIST_ID_BUNBUN_MEDIA_CO");
}

export function get3DayNoLoginListId() {
  return requiredEnv("AWEBER_LIST_ID_3DAY_NO_LOGIN");
}

function accountId() {
  return requiredEnv("AWEBER_ACCOUNT_ID");
}

// Finds a subscriber by exact email within one list. Returns the full
// subscriber entry (including its numeric `id` and `self_link`) or
// null if not present in that list. Uses AWeber's documented
// ws.op=find query operation (live-verified against the real API
// during development) rather than paging the entire list client-side.
export async function findSubscriberByEmail(listId, email) {
  const qs = new URLSearchParams({ "ws.op": "find", email });
  const result = await aweberRequest(
    `/accounts/${accountId()}/lists/${listId}/subscribers?${qs.toString()}`
  );
  if (!result.ok) {
    return { found: false, error: describeError(result) };
  }
  const entries = result.json?.entries || [];
  if (entries.length === 0) {
    return { found: false };
  }
  return { found: true, subscriber: entries[0] };
}

// Unsubscribes (never deletes) a subscriber from a list by their
// numeric subscriber id. AWeber's PATCH .../subscribers/<id> with
// {status: "unsubscribed"} is the documented, live-verified mechanism
// -- idempotent by construction: re-PATCHing an already-unsubscribed
// subscriber to the same status is a safe no-op (AWeber returns 2xx
// either way; unsubscribed_at is not re-stamped on a repeat call per
// AWeber's own semantics).
export async function unsubscribeFromList(listId, subscriberId) {
  const result = await aweberRequest(
    `/accounts/${accountId()}/lists/${listId}/subscribers/${subscriberId}`,
    { method: "PATCH", body: { status: "unsubscribed" } }
  );
  if (!result.ok) {
    return { ok: false, error: describeError(result) };
  }
  return { ok: true };
}

// Ensures a subscriber exists (with status "subscribed") in a target
// list, preserving email/name where supported. Idempotent:
//   - If the email already exists in the target list as
//     "subscribed" -- safe no-op, returns { created: false,
//     alreadySubscribed: true }.
//   - If the email exists in the target list but is "unsubscribed"
//     (e.g. a prior manual unsubscribe, or a retried sync after a
//     partial failure) -- re-activates it via the SAME PATCH mechanism
//     unsubscribeFromList uses, in reverse (status: "subscribed"),
//     rather than attempting a duplicate POST (which AWeber would
//     reject as a conflict for an existing email in that list) or
//     silently leaving it unsubscribed.
//   - Otherwise, creates a new subscriber via POST.
// firstName/lastName are combined into AWeber's single free-text
// `name` field (AWeber has no separate first/last name fields on the
// core subscriber resource) -- whichever of the two is present is
// used; both empty means no name is sent at all (AWeber allows a
// nameless subscriber).
export async function ensureSubscribedToList(listId, { email, firstName, lastName }) {
  const existing = await findSubscriberByEmail(listId, email);
  if (existing.error) {
    return { ok: false, error: existing.error };
  }

  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || undefined;

  if (existing.found) {
    if (existing.subscriber.status === "subscribed") {
      return { ok: true, alreadySubscribed: true, subscriberId: existing.subscriber.id };
    }
    // Re-activate a previously unsubscribed/other-status row rather
    // than creating a duplicate.
    const reactivate = await aweberRequest(
      `/accounts/${accountId()}/lists/${listId}/subscribers/${existing.subscriber.id}`,
      { method: "PATCH", body: { status: "subscribed" } }
    );
    if (!reactivate.ok) {
      return { ok: false, error: describeError(reactivate) };
    }
    return { ok: true, reactivated: true, subscriberId: existing.subscriber.id };
  }

  const created = await aweberRequest(`/accounts/${accountId()}/lists/${listId}/subscribers`, {
    method: "POST",
    body: { email, ...(fullName ? { name: fullName } : {}) },
  });
  if (created.status === 201) {
    // AWeber returns the new subscriber's id only via the Location
    // header on a bare 201 (no body) for this endpoint in some API
    // versions, but our thin wrapper only surfaces status/json/rawText
    // -- a subsequent findSubscriberByEmail() call is the safe,
    // portable way to obtain the id either way, and the caller
    // (syncThreeDayNoLoginToAweber) already does exactly that as part
    // of recording durable sync state.
    return { ok: true, created: true };
  }
  if (created.status === 400 && /already exists|duplicate/i.test(created.rawText || "")) {
    // Race: another concurrent scheduler tick created it between our
    // find and our create. Safe to treat as success.
    return { ok: true, alreadySubscribed: true };
  }
  return { ok: false, error: describeError(created) };
}

function describeError(result) {
  const message = result.json?.error?.message || result.rawText || `HTTP ${result.status}`;
  return {
    status: result.status,
    message,
    // Classify a few well-known AWeber failure modes the caller's
    // retry logic cares about (spec section 25).
    rateLimited: result.status === 429,
    authFailure: result.status === 401,
    notFound: result.status === 404,
    conflict: result.status === 409,
  };
}
