import crypto from "node:crypto";

// scrypt-based password hashing (built into Node, no extra dependency).

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Generates a human-typeable temporary password, e.g. "bright-otter-4821".
const WORDS_A = [
  "bright", "quiet", "swift", "lucky", "cosmic", "silver", "amber", "bold",
  "rapid", "gentle", "vivid", "solar", "lunar", "brave", "calm",
];
const WORDS_B = [
  "otter", "falcon", "comet", "harbor", "meadow", "signal", "ember", "atlas",
  "voyager", "beacon", "summit", "current", "nebula", "orbit", "drift",
];

export function generateTempPassword() {
  const a = WORDS_A[crypto.randomInt(WORDS_A.length)];
  const b = WORDS_B[crypto.randomInt(WORDS_B.length)];
  const n = crypto.randomInt(1000, 9999);
  return `${a}-${b}-${n}`;
}

export function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
}
