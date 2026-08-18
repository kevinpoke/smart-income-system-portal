// Stable 4-hour "display bucket" helper shared by the customer-facing
// Dashboard's earnings-freeze feature (see app/(portal)/page.js).
//
// WHY: customer-facing dashboard stats/earnings previously appeared to
// update continuously (a client-side interpolation ticked the Live/
// Today numbers upward every ~100ms, plus a few purely-cosmetic +/-5%
// "wobble" re-rolls every 5-10s). Per spec, the DISPLAYED numbers must
// now only change once every real 4-hour wall-clock window -- a
// customer checking multiple times within the same 4-hour window must
// see identical figures; the next window may show fresh numbers. This
// is a pure DISPLAY freeze: the underlying ledger/accrual accounting in
// lib/earningsEngine.js (runEarningsCatchup, midnight-Pacific cycle
// boundaries, WiFi-gating, per-Node eligibility) is completely
// untouched -- computeEarningsSummary() keeps computing 100%-accurate,
// live numbers server-side on every call; only what the CUSTOMER
// dashboard chooses to RENDER is snapshotted. The admin portal
// continues to render summary/live values directly (no freeze).
//
// Approach chosen: (A) client-side bucket-key snapshot, not (B) a
// server-computed frozen figure -- simpler, lower-risk, and requires
// zero changes to the earnings-accuracy-critical server engine.
//
// Bucket boundary formula: floor(nowMs / FOUR_HOURS_MS) * FOUR_HOURS_MS,
// i.e. UTC-epoch-aligned 4-hour buckets (00:00, 04:00, 08:00, ... UTC
// each day). The bucket KEY (an integer, not a timestamp) is what
// consumers actually compare across renders/effects to detect "a new
// 4-hour window has begun".
export const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// Returns an integer bucket id for `nowMs` -- two timestamps in the same
// 4-hour UTC window always return the same integer; crossing a 4-hour
// boundary always returns a different (larger) integer.
export function getFourHourBucketKey(nowMs) {
  return Math.floor(nowMs / FOUR_HOURS_MS);
}
