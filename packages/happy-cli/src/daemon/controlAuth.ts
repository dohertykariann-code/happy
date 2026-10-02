/**
 * Authentication for the daemon's local control server.
 *
 * The control server listens on 127.0.0.1 and exposes /spawn-session (arbitrary
 * directory and arbitrary environment variables, spawned with the daemon's own
 * permission mode), /stop-session, /stop, /list and /session-started. Until this
 * was added it required no credential at all, and the port it listens on is
 * published in the daemon state file, which was written world-readable (0644).
 * Any other local process, and via DNS rebinding any web page the user visited,
 * could therefore drive it. This was a known TODO: see the "Improvements"
 * section of src/daemon/CLAUDE.md.
 *
 * The daemon now mints a random token per run, stores it in the daemon state
 * file (tightened to 0600 by writeDaemonState), and requires it on every
 * request via a single global onRequest hook, so a route cannot later be added
 * without auth. A non-owner process cannot read the token, and a browser cannot
 * read a local file, so both of those paths close.
 *
 * Honest limit: this does NOT defend against code already running as the same
 * user. Such code can read the token file directly, exactly as it could read
 * ~/.ssh. That threat needs OS-level sandboxing, not a bearer token.
 *
 * Note on design: src/daemon/CLAUDE.md proposed signing payloads with the
 * existing TweetNaCl keypair instead. That reduces to the same trust boundary
 * (possession of a protected local file) while adding replay-protection
 * complexity, so a per-run bearer token was chosen here.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Mints a fresh control token. One per daemon run; never logged. */
export function generateControlToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Constant-time token comparison. Both sides are hashed to a fixed width first
 * so timingSafeEqual never sees mismatched lengths (it throws on those) and so
 * the comparison cannot leak the expected token's length. A missing or empty
 * token on either side is never a match.
 */
export function controlTokensMatch(expected: string | undefined, provided: string | undefined): boolean {
  if (!expected || !provided) {
    return false;
  }

  const expectedHash = createHash('sha256').update(expected).digest();
  const providedHash = createHash('sha256').update(provided).digest();
  return timingSafeEqual(expectedHash, providedHash);
}

/**
 * Pulls the token out of an `Authorization: Bearer <token>` header value.
 * Returns undefined for any other shape, including a bare token with no scheme.
 */
export function extractBearerToken(headerValue: string | string[] | undefined): string | undefined {
  if (typeof headerValue !== 'string') {
    return undefined;
  }

  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(headerValue);
  const token = match?.[1].trim();
  return token || undefined;
}
