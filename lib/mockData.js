// Static reference data + pure generator/formatter helpers.
// Everything here is deterministic-enough given a seed value so that
// re-renders don't reshuffle already-generated lists.

export const ISP_PROVIDERS = [
  "Spectrum",
  "Verizon",
  "AT&T",
  "Xfinity",
  "Cox",
  "Comcast Xfinity",
  "T-Mobile",
  "Frontier Communications",
  "Optimum",
  "Lumen Technologies",
  "Windstream (Kinetic)",
  "TDS Telecom",
  "Mediacom",
  "Ziply Fiber",
  "Starlink",
  "EarthLink",
  "Google Fiber",
  "Sonic",
  "altafiber",
  "Metronet",
  "C Spire",
  "Greenlight Networks",
  "Ezee Fiber",
  "Firefly Fiber Broadband",
  "Astound Broadband",
  "WOW! Internet",
  "Fidium Fiber",
  "Breezeline",
  "Sparklight",
  "Starry Internet",
  "Midco",
  "Bluepeak",
  "Armstrong",
  "Shentel",
  "Ting Internet",
  "Monkeybrains",
  "US Internet",
  "Pilot Fiber",
  "Stealth Communications",
  "Honest Networks",
  "Rise Broadband",
  "Viasat",
  "HughesNet",
  "GCI",
  "Open Fiber",
  "OEC Fiber",
  "Atlas Networks",
  "GigabitNow",
  "B2X Online",
  "Sail Internet",
  "Other",
];

export const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];

export const MODULES_META = [
  {
    id: 1,
    title: "How it Works (Nodes)",
    description:
      "An in-depth walkthrough of how StarAtlas Network nodes route and monetize idle bandwidth.",
    duration: "18:42",
  },
  {
    id: 2,
    title: "Program Goal",
    description:
      "Understand the mission behind the network and how your participation contributes.",
    duration: "22:15",
  },
  {
    id: 3,
    title: "How to Earn More (Upsell)",
    description:
      "Advanced strategies and node upgrades to multiply your monthly payout.",
    duration: "15:03",
  },
  {
    id: 4,
    title: "WiFi Setup Guide",
    description:
      "Step-by-step configuration guide to make sure your router is optimized for node uptime.",
    duration: "27:51",
  },
  {
    id: 5,
    title: "Payouts (4-Month Cycle)",
    description:
      "Everything you need to know about the 4-month payout cycle and withdrawal process.",
    duration: "19:37",
  },
];

export const HOURS_BETWEEN_MODULES = 12;
export const HOURS_UNTIL_AUTO_APPROVE_BUTTON = 60;
export const MONTHS_UNTIL_PAYOUT = 4.1;

export function rngFromSeed(seed) {
  // Simple deterministic PRNG (mulberry32) so generated lists stay stable
  // across renders once a seed (e.g. join date) is fixed.
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 32-bit string hash -- fast, deterministic, good-enough
// distribution for seeding rngFromSeed() from an arbitrary string key
// (account id + date, account id + row index, etc). Not used for anything
// security-sensitive, only for stable "random-looking" demo data.
export function hashStringToSeed(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// Convenience: build a seeded rand() function directly from a string key.
export function rngFromKey(key) {
  return rngFromSeed(hashStringToSeed(key));
}

export function randomInt(rand, min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

export function randomFloat(rand, min, max, decimals = 2) {
  const v = rand() * (max - min) + min;
  return Number(v.toFixed(decimals));
}

export function generateIP(rand) {
  return `192.168.${randomInt(rand, 0, 255)}.${randomInt(rand, 1, 254)}`;
}

export function formatCurrency(n) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Same as formatCurrency but with up to 5 decimal places, used for the
// Live Earnings ticker per the Phase 3 spec ("display up to five decimal
// places... animate smoothly without losing numeric accuracy").
export function formatCurrency5(n) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 5,
    maximumFractionDigits: 5,
  });
}

// Converts an integer cents amount (the canonical storage unit everywhere
// server-side) to a display dollar float. Only ever used for display --
// all storage/arithmetic on the server stays in integer cents.
export function centsToDollars(cents) {
  return (cents || 0) / 100;
}

export function formatCompactDuration(ms) {
  if (ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (minutes || hours || days) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

// Formats a countdown as "3d 00h 00m 00s" (zero-padded hours/min/sec), the
// exact format specified for the ISP review timer, payout cycle, and
// waitlist countdown. Clamps to zero rather than going negative.
export function formatCountdown(ms) {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${days}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

// Decomposes a countdown into Months / Days / Hours / Minutes / Seconds
// for the "Next Payout" / "Next withdrawal available in..." displays,
// which the spec explicitly requires be shown in these five units. Months
// are derived from whole 30-day blocks purely for DISPLAY decomposition
// (the underlying target timestamp itself is computed exactly via
// addCalendarMonths() in lib/earningsEngine.js -- this function never
// recomputes the target, only formats an already-computed millisecond
// countdown into human units).
export function formatCountdownParts(ms) {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);
  const months = Math.floor(totalDays / 30);
  const days = totalDays % 30;
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;
  const seconds = totalSeconds % 60;
  return { months, days, hours, minutes, seconds };
}

export function formatLongDuration(ms) {
  if (ms <= 0) return "0 days";
  const totalDays = ms / 86400000;
  const months = Math.floor(totalDays / 30.44);
  const days = Math.floor(totalDays % 30.44);
  const parts = [];
  if (months) parts.push(`${months} month${months !== 1 ? "s" : ""}`);
  parts.push(`${days} day${days !== 1 ? "s" : ""}`);
  return parts.join(", ");
}

export function generatePayoutHistory(seedBase, joinDate) {
  const rand = rngFromSeed(seedBase);
  const rows = [];
  const join = new Date(joinDate);
  for (let i = 14; i >= 1; i--) {
    const d = new Date(join);
    d.setMonth(d.getMonth() - i);
    rows.push({
      id: i,
      month: d.toLocaleString("en-US", { month: "long", year: "numeric" }),
      amount: randomFloat(rand, 2200, 4500),
    });
  }
  return rows;
}

export function generateNodeLocation(rand) {
  const cities = [
    "Austin, TX", "Denver, CO", "Phoenix, AZ", "Columbus, OH", "Raleigh, NC",
    "Tampa, FL", "Portland, OR", "Nashville, TN", "Boise, ID", "Salt Lake City, UT",
  ];
  return cities[randomInt(rand, 0, cities.length - 1)];
}

export function generateNodes(seedBase, count = 24) {
  const rand = rngFromSeed(seedBase);
  const superIndices = new Set();
  while (superIndices.size < 3) {
    superIndices.add(randomInt(rand, 0, count - 1));
  }
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const isSuper = superIndices.has(i);
    nodes.push({
      id: `#${randomInt(rand, 10000, 99999)}`,
      type: isSuper ? "Super Node" : "Standard Node",
      ip: generateIP(rand),
      estMonthly: isSuper
        ? randomFloat(rand, 2400, 4000)
        : randomFloat(rand, 1500, 2800),
      cost: isSuper
        ? randomFloat(rand, 1500, 2000)
        : randomFloat(rand, 300, 900),
      status: "SOLD",
    });
  }
  return nodes;
}

export const GRAPH_RANGES = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "7 Days" },
  { key: "14d", label: "14 Days" },
  { key: "30d", label: "30 Days" },
  { key: "90d", label: "90 Days" },
  { key: "1y", label: "1 Year" },
  { key: "all", label: "All Time" },
];

// Generates a synthetic earnings series for a given range, anchored so the
// final point matches the "current" live total for continuity with the ticker.
export function generateEarningsSeries(rangeKey, dailyRate, joinDate, currentTotal) {
  const rand = rngFromSeed(
    Math.floor(new Date(joinDate).getTime() / 1000) + rangeKey.length
  );
  const now = Date.now();
  const join = new Date(joinDate).getTime();
  const daysSinceJoin = Math.max(1, Math.ceil((now - join) / 86400000));

  const rangeToDays = {
    today: 1,
    yesterday: 1,
    "7d": 7,
    "14d": 14,
    "30d": 30,
    "90d": 90,
    "1y": 365,
    all: daysSinceJoin,
  };
  let days = Math.min(rangeToDays[rangeKey] ?? 7, daysSinceJoin);
  days = Math.max(days, 1);

  const points = [];
  const isIntraday = rangeKey === "today" || rangeKey === "yesterday";
  const steps = isIntraday ? 24 : days;
  let cumulative = 0;
  const perStepBase = isIntraday ? dailyRate / 24 : dailyRate;

  for (let i = 0; i < steps; i++) {
    const variance = randomFloat(rand, 0.75, 1.25, 3);
    cumulative += perStepBase * variance;
    let label;
    if (isIntraday) {
      label = `${i}:00`;
    } else {
      const d = new Date(now - (steps - 1 - i) * 86400000);
      label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }
    points.push({ label, value: Number(cumulative.toFixed(2)) });
  }
  // Rescale so the last point lines up with the live total for continuity.
  const scale = currentTotal > 0 ? currentTotal / points[points.length - 1].value : 1;
  return points.map((p) => ({ ...p, value: Number((p.value * scale).toFixed(2)) }));
}
