import crypto from "node:crypto";

// Phase 7: dedicated high-entropy temporary password generator for
// automatic JVZoo onboarding. Deliberately separate from
// lib/auth-crypto.js generateTempPassword() (the existing "bright-otter-4821"
// human-typeable generator used by the manual admin/simulate-purchase
// flow) -- that generator draws from a small fixed wordlist and is not
// intended to meet a >=16-character, high-entropy bar. This one is used
// ONLY for real automatic JVZoo-provisioned accounts.
//
// Uses crypto.randomBytes (CSPRNG, not Math.random) mapped into an
// unambiguous base62 alphabet (no 0/O/1/l confusion) so a customer typing
// it in manually from an email is not tripped up by lookalike characters.
// 20 characters from a 62-symbol alphabet is ~119 bits of entropy, well
// above the >=16-character / "cryptographically secure" / "difficult to
// guess" requirement.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const LENGTH = 20;

export function generateSecureTempPassword() {
  // Rejection sampling avoids the small modulo bias that `byte %
  // ALPHABET.length` would introduce (256 is not an exact multiple of 62)
  // -- every accepted byte maps to a uniformly random alphabet index.
  const maxValid = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < LENGTH) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < maxValid) {
      out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return out;
}
