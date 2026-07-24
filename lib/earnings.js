// Pure helpers for computing simulated earnings figures from a user's
// dailyRate and participationApprovedAt timestamp. Kept separate from the
// store so components (and the admin table) can share the exact same math.

export function ratePerMs(dailyRate) {
  return dailyRate / 86400000;
}

export function isEarningActive(user) {
  return Boolean(user?.status === "active" && user?.participationApprovedAt);
}

export function totalEarnings(user, now = Date.now()) {
  if (!isEarningActive(user)) return 0;
  const start = new Date(user.participationApprovedAt).getTime();
  const elapsed = Math.max(0, now - start);
  return elapsed * ratePerMs(user.dailyRate);
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function todayEarnings(user, now = Date.now()) {
  if (!isEarningActive(user)) return 0;
  const start = Math.max(
    new Date(user.participationApprovedAt).getTime(),
    startOfDay(now)
  );
  const elapsed = Math.max(0, now - start);
  return elapsed * ratePerMs(user.dailyRate);
}

export function weekEarnings(user, now = Date.now()) {
  if (!isEarningActive(user)) return 0;
  const start = Math.max(
    new Date(user.participationApprovedAt).getTime(),
    now - 7 * 86400000
  );
  const elapsed = Math.max(0, now - start);
  return elapsed * ratePerMs(user.dailyRate);
}

export function monthEarnings(user, now = Date.now()) {
  if (!isEarningActive(user)) return 0;
  const start = Math.max(
    new Date(user.participationApprovedAt).getTime(),
    now - 30 * 86400000
  );
  const elapsed = Math.max(0, now - start);
  return elapsed * ratePerMs(user.dailyRate);
}

export function nextPayoutTarget(user) {
  if (!user?.participationApprovedAt) return null;
  const start = new Date(user.participationApprovedAt).getTime();
  const MONTH_MS = 30.44 * 24 * 60 * 60 * 1000;
  return start + 4.1 * MONTH_MS;
}

export function msUntilNextPayout(user, now = Date.now()) {
  const target = nextPayoutTarget(user);
  if (!target) return null;
  return Math.max(0, target - now);
}
