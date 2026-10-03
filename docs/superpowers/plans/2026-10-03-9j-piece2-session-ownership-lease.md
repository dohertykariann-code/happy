# Session Ownership Lease (punch 9j, Piece 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second process that tries to run an already-owned Happy session refuses to start, so one phone message stops executing in several live sessions at once.

**Architecture:** A database lease on the `Session` row is the authority. A claimant presents a per-process `ownerToken` at `POST /v1/sessions`; a conditional (compare-and-swap) update either grants the lease or returns 409. The session-scoped socket handshake re-checks the lease and re-extends it on every admission, which is what covers network blips. Release happens only on explicit client disconnect, never on `transport close` or `ping timeout`.

**Tech Stack:** Fastify + Socket.IO + Prisma over PGlite (server, `happy-cos`); TypeScript CLI with socket.io-client (`happy`). No new libraries.

---

## THREE SPEC CORRECTIONS (read before Task 1)

The approved spec is sound on policy. Three of its implementation assumptions do
not match the code as it stands, each confirmed by direct read at the line cited.
The corrected mechanism is used throughout this plan.

### Correction 1: renewal cannot carry a "you lost it" response

Spec says the `session-alive` path's "response must be able to tell the caller it
no longer owns the session." Two blockers:

- `sources/app/api/socket/sessionUpdateHandler.ts:140` declares
  `socket.on('session-alive', async (data: {...}) => {...})` with **no callback
  parameter**, unlike its sibling handler above it which does use
  `callback({ result: 'error' })`.
- The CLI emits it with `socket.volatile.emit`
  (`happy/packages/happy-cli/src/api/apiSession.ts:912`). Volatile packets are
  dropped while disconnected and are not an acknowledgement channel.

**Corrected mechanism:** loss is delivered as a server push, not a renewal
response. On detecting foreign ownership the server emits
`socket.emit('session-owner-lost', { sessionId })`, a normal non-volatile
server-to-client emit that is reliable while connected, then disconnects that
socket. The CLI treats either signal as "stop executing and exit."

### Correction 2: lease renewal must not ride on the activity cache

`sessionUpdateHandler.ts` renews presence via `activityCache.queueSessionUpdate`.
In `sources/app/presence/sessionCache.ts` that method only queues a write when the
timestamp moved more than `UPDATE_THRESHOLD`, and increments
`databaseUpdatesSkippedCounter` otherwise. Constants read directly from that file:
`UPDATE_THRESHOLD = 30 * 1000` (line 28), `BATCH_INTERVAL = 5 * 1000` (line 31),
`CACHE_TTL = 30 * 1000` (line 25).

A 60-second lease renewed through a 30-second-threshold, 5-second-batched writer
can therefore sit up to roughly 35 seconds behind the real heartbeat before an
outage even begins, which spends more than half the window. **Lease expiry gets its
own direct conditional write**, throttled on its own terms (renew when the stored
expiry is less than half a lease away), and never depends on the coalescing path.

### Correction 3: the disconnect handler captures no reason

`sources/app/api/socket.ts:189` reads `socket.on('disconnect', () => {...})`. The
entire blip-safety property depends on distinguishing an explicit disconnect from
`transport close` and `ping timeout`, so the signature must widen to
`(reason: string) => {...}`. Task 6 carries the mandatory mutation proof for this.

---

## File structure

**Server (`~/code/happy-cos/packages/happy-server`)**

- Create `sources/app/presence/sessionLease.ts`: pure lease logic, claim verdicts,
  renewal predicate, release predicate. No database and no socket imports, so it is
  unit-testable without a server.
- Create `sources/app/presence/sessionLease.test.ts`: unit tests for the above.
- Create `sources/app/presence/sessionLeaseStore.ts`: the only module that writes
  lease columns; holds the compare-and-swap.
- Create `sources/app/presence/sessionLeaseStore.test.ts`.
- Modify `prisma/schema.prisma`: three nullable columns on `model Session`.
- Create `prisma/migrations/<timestamp>_add_session_ownership_lease/migration.sql`.
- Modify `sources/app/api/routes/sessionRoutes.ts:219`: claim at the acquisition door.
- Modify `sources/app/api/socket.ts`: admission inside the existing `io.use`
  middleware; release in the widened `disconnect` handler.
- Modify `sources/app/api/socket/sessionUpdateHandler.ts:140`: renewal plus the
  `session-owner-lost` push.
- Modify `sources/app/monitoring/metrics2.ts`: counters, alongside the existing
  `session_contention_events_total`.

**CLI (`~/code/happy`, `packages/happy-cli`)**

- Create `src/api/ownerToken.ts`: mint one token per process.
- Create `src/api/ownerToken.test.ts`.
- Modify `src/api/apiSession.ts:271-277`: add `ownerToken` to handshake auth; add a
  `session-owner-lost` listener.
- Modify the `POST /v1/sessions` call site: send `ownerToken`, handle 409.

---

## Workstream A: server (`happy-cos`)

### Task 1: Pure lease logic

**Files:**
- Create: `sources/app/presence/sessionLease.ts`
- Test: `sources/app/presence/sessionLease.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import {
    LEASE_DURATION_MS,
    RELEASING_DISCONNECT_REASONS,
    evaluateClaim,
    releasesOnDisconnect,
    shouldRenewExpiry,
} from './sessionLease';

const now = 1_700_000_000_000;

describe('evaluateClaim', () => {
    it('grants a lease on a row nobody owns', () => {
        expect(evaluateClaim({ ownerToken: null, ownerExpiresAt: null }, 'tok-a', now))
            .toEqual({ verdict: 'granted' });
    });

    it('refuses a different token while the incumbent lease is live', () => {
        expect(evaluateClaim(
            { ownerToken: 'tok-a', ownerExpiresAt: new Date(now + 30_000), ownerClient: 'cli/1.2.3' },
            'tok-b',
            now,
        )).toEqual({ verdict: 'refused', incumbentClient: 'cli/1.2.3', expiresAt: now + 30_000 });
    });

    it('grants a different token once the incumbent lease has expired', () => {
        expect(evaluateClaim(
            { ownerToken: 'tok-a', ownerExpiresAt: new Date(now - 1) },
            'tok-b',
            now,
        )).toEqual({ verdict: 'granted' });
    });

    // The rule that stops a long outage from killing a live session.
    it('lets the SAME token re-claim its own expired, uncontested lease', () => {
        expect(evaluateClaim(
            { ownerToken: 'tok-a', ownerExpiresAt: new Date(now - 120_000) },
            'tok-a',
            now,
        )).toEqual({ verdict: 'granted' });
    });

    it('renews rather than refuses when the live owner presents its own token', () => {
        expect(evaluateClaim(
            { ownerToken: 'tok-a', ownerExpiresAt: new Date(now + 10_000) },
            'tok-a',
            now,
        )).toEqual({ verdict: 'granted' });
    });
});

describe('releasesOnDisconnect', () => {
    it('releases on an explicit client disconnect', () => {
        expect(releasesOnDisconnect('client namespace disconnect')).toBe(true);
    });

    // The blip-safety property. These two reasons are network events, not intent.
    it('does NOT release on transport close', () => {
        expect(releasesOnDisconnect('transport close')).toBe(false);
    });

    it('does NOT release on ping timeout', () => {
        expect(releasesOnDisconnect('ping timeout')).toBe(false);
    });

    it('does NOT release on an unrecognised reason', () => {
        expect(releasesOnDisconnect('something new in socket.io')).toBe(false);
    });

    it('lists only explicit reasons as releasing', () => {
        expect([...RELEASING_DISCONNECT_REASONS].sort())
            .toEqual(['client namespace disconnect', 'server namespace disconnect']);
    });
});

describe('shouldRenewExpiry', () => {
    it('renews once the stored expiry is inside half a lease', () => {
        expect(shouldRenewExpiry(new Date(now + LEASE_DURATION_MS / 2 - 1), now)).toBe(true);
    });

    it('skips a renewal that would be a no-op write', () => {
        expect(shouldRenewExpiry(new Date(now + LEASE_DURATION_MS - 1), now)).toBe(false);
    });

    it('renews when there is no stored expiry at all', () => {
        expect(shouldRenewExpiry(null, now)).toBe(true);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/code/happy-cos/packages/happy-server && npx vitest run sources/app/presence/sessionLease.test.ts`
Expected: FAIL, cannot resolve `./sessionLease`.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Pure ownership-lease logic for a Happy session.
 *
 * WHAT THIS IS NOT: `ownerToken` is not a credential and this is not an
 * authorization check. Every racing process here is already authenticated with
 * the same account token, and any process running as the same user can read the
 * token. This answers only "are you the same PROCESS that claimed this session",
 * which the socket handshake cannot answer on its own, because token, clientType,
 * sessionId and happyClient are byte-identical across two processes serving one
 * session. The threat model is reliability, not security. See punch row 9j.
 *
 * No database and no socket imports live here on purpose, so every rule below is
 * testable without standing up a server.
 */

/** Lease window. Renewed by the existing 2s session-alive heartbeat. */
export const LEASE_DURATION_MS = 60_000;

/**
 * Socket.IO disconnect reasons that mean the client meant to leave.
 * Everything else, notably `transport close` and `ping timeout`, is a network
 * event: releasing on those would hand a live session away during a blip, which
 * is strictly worse than the duplicate-execution bug this lease exists to fix.
 */
export const RELEASING_DISCONNECT_REASONS: ReadonlySet<string> = new Set([
    'client namespace disconnect',
    'server namespace disconnect',
]);

export type LeaseRow = {
    ownerToken: string | null;
    ownerExpiresAt: Date | null;
    ownerClient?: string | null;
};

export type ClaimVerdict =
    | { verdict: 'granted' }
    | { verdict: 'refused'; incumbentClient: string | null; expiresAt: number };

export function evaluateClaim(row: LeaseRow, presentedToken: string, nowMs: number): ClaimVerdict {
    const expiresAtMs = row.ownerExpiresAt?.getTime() ?? null;
    const leaseIsLive = expiresAtMs !== null && expiresAtMs > nowMs;
    const sameProcess = row.ownerToken !== null && row.ownerToken === presentedToken;

    if (leaseIsLive && !sameProcess && row.ownerToken !== null) {
        return {
            verdict: 'refused',
            incumbentClient: row.ownerClient ?? null,
            expiresAt: expiresAtMs,
        };
    }
    return { verdict: 'granted' };
}

export function releasesOnDisconnect(reason: string): boolean {
    return RELEASING_DISCONNECT_REASONS.has(reason);
}

export function shouldRenewExpiry(storedExpiry: Date | null, nowMs: number): boolean {
    if (!storedExpiry) {
        return true;
    }
    return storedExpiry.getTime() - nowMs < LEASE_DURATION_MS / 2;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run sources/app/presence/sessionLease.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add sources/app/presence/sessionLease.ts sources/app/presence/sessionLease.test.ts
git commit -m "feat(server): pure session ownership lease rules"
```

### Task 2: Schema + migration

**Files:**
- Modify: `prisma/schema.prisma` (`model Session`)
- Create: `prisma/migrations/<timestamp>_add_session_ownership_lease/migration.sql`

- [ ] **Step 1: Add the columns**

In `model Session`, after the `lastActiveAt` line, add:

```prisma
    ownerToken        String?
    ownerExpiresAt    DateTime?
    ownerClient       String?
```

All three are nullable, so the migration is additive and a pre-change CLI that
writes none of them still works.

- [ ] **Step 2: Generate the migration**

Run: `cd ~/code/happy-cos/packages/happy-server && npx prisma migrate dev --name add_session_ownership_lease --create-only`
Expected: a new directory under `prisma/migrations/` whose `migration.sql` contains three `ADD COLUMN` statements and no `DROP`.

- [ ] **Step 3: Verify the SQL is additive only**

Run: `grep -c "ADD COLUMN" prisma/migrations/*add_session_ownership_lease/migration.sql && grep -ci "drop" prisma/migrations/*add_session_ownership_lease/migration.sql`
Expected: `3` then `0`. If any `DROP` appears, stop and hand back.

- [ ] **Step 4: Apply and confirm against the real database**

Run: `npx prisma migrate deploy && npx prisma generate`
Expected: migration applied, client regenerated.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(server): add nullable session ownership lease columns"
```

### Task 3: The compare-and-swap store

**Files:**
- Create: `sources/app/presence/sessionLeaseStore.ts`
- Test: `sources/app/presence/sessionLeaseStore.test.ts`

The conditional-update idiom is ported from `sources/app/presence/timeout.ts:19-26`,
which does `db.session.updateManyAndReturn({ where: { id, active: true }, ... })` and
treats `updated.length === 0` as having lost the race. Do not write a read-then-write.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { LEASE_DURATION_MS } from './sessionLease';
import { claimLease, releaseLease, renewLease } from './sessionLeaseStore';

const now = 1_700_000_000_000;

function fakeDb(row: any, updateResult: any[]) {
    return {
        session: {
            findFirst: vi.fn().mockResolvedValue(row),
            updateManyAndReturn: vi.fn().mockResolvedValue(updateResult),
        },
    } as any;
}

describe('claimLease', () => {
    it('writes the presented token and a fresh expiry when granted', async () => {
        const db = fakeDb({ id: 's1', ownerToken: null, ownerExpiresAt: null }, [{ id: 's1' }]);
        const result = await claimLease(db, 's1', 'tok-a', 'cli/1.2.3', now);

        expect(result).toEqual({ verdict: 'granted' });
        const args = db.session.updateManyAndReturn.mock.calls[0][0];
        expect(args.data.ownerToken).toBe('tok-a');
        expect(args.data.ownerExpiresAt.getTime()).toBe(now + LEASE_DURATION_MS);
    });

    it('refuses without writing when a live foreign owner holds it', async () => {
        const db = fakeDb(
            { id: 's1', ownerToken: 'tok-a', ownerExpiresAt: new Date(now + 30_000), ownerClient: 'cli/1.0.0' },
            [],
        );
        const result = await claimLease(db, 's1', 'tok-b', 'cli/1.2.3', now);

        expect(result.verdict).toBe('refused');
        expect(db.session.updateManyAndReturn).not.toHaveBeenCalled();
    });

    // The race the CAS exists for: the row changed between read and write.
    it('refuses when the conditional write matches zero rows', async () => {
        const db = fakeDb({ id: 's1', ownerToken: null, ownerExpiresAt: null }, []);
        const result = await claimLease(db, 's1', 'tok-a', 'cli/1.2.3', now);

        expect(result.verdict).toBe('refused');
    });

    it('re-asserts the observed owner in the where clause, not just the id', async () => {
        const db = fakeDb({ id: 's1', ownerToken: null, ownerExpiresAt: null }, [{ id: 's1' }]);
        await claimLease(db, 's1', 'tok-a', 'cli/1.2.3', now);

        expect(db.session.updateManyAndReturn.mock.calls[0][0].where)
            .toEqual({ id: 's1', ownerToken: null });
    });
});

describe('renewLease', () => {
    it('extends the expiry only for the holding token', async () => {
        const db = fakeDb(null, [{ id: 's1' }]);
        const result = await renewLease(db, 's1', 'tok-a', now);

        expect(result).toBe('renewed');
        expect(db.session.updateManyAndReturn.mock.calls[0][0].where)
            .toEqual({ id: 's1', ownerToken: 'tok-a' });
    });

    it('reports loss when no row matches the presented token', async () => {
        const db = fakeDb(null, []);
        expect(await renewLease(db, 's1', 'tok-a', now)).toBe('lost');
    });
});

describe('releaseLease', () => {
    it('clears owner columns only for the holding token', async () => {
        const db = fakeDb(null, [{ id: 's1' }]);
        await releaseLease(db, 's1', 'tok-a');

        const args = db.session.updateManyAndReturn.mock.calls[0][0];
        expect(args.where).toEqual({ id: 's1', ownerToken: 'tok-a' });
        expect(args.data).toEqual({ ownerToken: null, ownerExpiresAt: null, ownerClient: null });
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run sources/app/presence/sessionLeaseStore.test.ts`
Expected: FAIL, cannot resolve `./sessionLeaseStore`.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * The only module that writes session ownership lease columns.
 *
 * Every write is a compare-and-swap: the condition observed during the read is
 * re-asserted in the `where` clause, and an empty result means another process
 * won the race. This is the idiom already used by sources/app/presence/timeout.ts:19-26.
 */

import { ClaimVerdict, LEASE_DURATION_MS, evaluateClaim } from './sessionLease';

export async function claimLease(
    db: any,
    sessionId: string,
    presentedToken: string,
    presentedClient: string | null,
    nowMs: number = Date.now(),
): Promise<ClaimVerdict> {
    const row = await db.session.findFirst({
        where: { id: sessionId },
        select: { id: true, ownerToken: true, ownerExpiresAt: true, ownerClient: true },
    });
    if (!row) {
        return { verdict: 'refused', incumbentClient: null, expiresAt: 0 };
    }

    const verdict = evaluateClaim(row, presentedToken, nowMs);
    if (verdict.verdict === 'refused') {
        return verdict;
    }

    // Re-assert the owner we observed. If it changed underneath us, zero rows match.
    const updated = await db.session.updateManyAndReturn({
        where: { id: sessionId, ownerToken: row.ownerToken },
        data: {
            ownerToken: presentedToken,
            ownerExpiresAt: new Date(nowMs + LEASE_DURATION_MS),
            ownerClient: presentedClient,
        },
    });
    if (updated.length === 0) {
        return { verdict: 'refused', incumbentClient: null, expiresAt: 0 };
    }
    return { verdict: 'granted' };
}

export async function renewLease(
    db: any,
    sessionId: string,
    presentedToken: string,
    nowMs: number = Date.now(),
): Promise<'renewed' | 'lost'> {
    const updated = await db.session.updateManyAndReturn({
        where: { id: sessionId, ownerToken: presentedToken },
        data: { ownerExpiresAt: new Date(nowMs + LEASE_DURATION_MS) },
    });
    return updated.length === 0 ? 'lost' : 'renewed';
}

export async function releaseLease(db: any, sessionId: string, presentedToken: string): Promise<void> {
    await db.session.updateManyAndReturn({
        where: { id: sessionId, ownerToken: presentedToken },
        data: { ownerToken: null, ownerExpiresAt: null, ownerClient: null },
    });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run sources/app/presence/sessionLeaseStore.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add sources/app/presence/sessionLeaseStore.ts sources/app/presence/sessionLeaseStore.test.ts
git commit -m "feat(server): compare-and-swap store for the ownership lease"
```

### Task 4: Claim at the acquisition door (`POST /v1/sessions`)

**Files:**
- Modify: `sources/app/api/routes/sessionRoutes.ts:219`

Note the route is `findFirst` then `create` today, not an atomic upsert. The claim
therefore attaches to the existing-session branch; a freshly created row has no
owner, so its claim is unconditional.

- [ ] **Step 1: Widen the request body schema**

Add to the `z.object({...})` body at `sessionRoutes.ts:221`:

```typescript
                ownerToken: z.string().min(1).nullish(),
                ownerClient: z.string().nullish()
```

- [ ] **Step 2: Claim on the existing-session branch**

Inside `if (session) {`, before the existing `log(...)` call, insert:

```typescript
            const { ownerToken, ownerClient } = request.body;
            if (ownerToken) {
                const claim = await claimLease(db, session.id, ownerToken, ownerClient ?? null);
                if (claim.verdict === 'refused') {
                    sessionClaimRefusedCounter.inc();
                    log({ module: 'session-lease', sessionId: session.id, userId, tag },
                        `Refused claim: session already owned by ${claim.incumbentClient ?? 'another process'}`);
                    return reply.code(409).send({
                        error: 'session_already_owned',
                        incumbentClient: claim.incumbentClient,
                        expiresAt: claim.expiresAt
                    });
                }
            } else {
                // Tolerate-and-log, Kari's decision 2026-10-03. A pre-change CLI
                // presents no token; it is admitted and logged, and cannot claim.
                sessionTokenlessClaimCounter.inc();
                log({ module: 'session-lease', sessionId: session.id, userId, tag },
                    `Token-less session claim admitted (pre-lease CLI build)`);
            }
```

- [ ] **Step 3: Claim on the create branch**

After `const session = await db.session.create({...})` in the `else` branch, insert:

```typescript
            if (request.body.ownerToken) {
                await claimLease(db, session.id, request.body.ownerToken, request.body.ownerClient ?? null);
            }
```

- [ ] **Step 4: Add the imports**

```typescript
import { claimLease } from '@/app/presence/sessionLeaseStore';
import { sessionClaimRefusedCounter, sessionTokenlessClaimCounter } from '@/app/monitoring/metrics2';
```

Match the path-alias style already used by the other imports in this file; if it
uses relative imports, use `../../presence/sessionLeaseStore` instead.

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add sources/app/api/routes/sessionRoutes.ts
git commit -m "feat(server): claim the ownership lease at POST /v1/sessions"
```

### Task 5: Socket admission that also renews

**Files:**
- Modify: `sources/app/api/socket.ts` (inside the existing `io.use` middleware)

Admission goes in `io.use`, not in the `connection` callback. That middleware
already awaits `auth.verifyToken` before handlers attach, and its own comment
explains that async work in the connection callback creates a window where client
events are silently dropped.

- [ ] **Step 1: Read the owner token off the handshake and gate on it**

After the existing `socket.data.happyClient = ...` assignment and before `next()`:

```typescript
        const ownerToken = socket.handshake.auth.ownerToken as string | undefined;
        socket.data.ownerToken = ownerToken;

        if (clientType === 'session-scoped' && sessionId) {
            if (!ownerToken) {
                // Tolerate-and-log (Kari, 2026-10-03). Flip with LEASE_STRICT_MODE=1.
                sessionTokenlessAdmissionCounter.inc();
                log({ module: 'session-lease' }, `Token-less session-scoped admission for ${sessionId}`);
                if (strictModeEnabled()) {
                    next(new Error('SESSION_OWNER_TOKEN_REQUIRED'));
                    return;
                }
            } else {
                // Admission itself renews. session-alive is a volatile emit
                // (happy/packages/happy-cli/src/api/apiSession.ts:912) and is dropped
                // while disconnected, so a reconnect is the only reliable renewal point.
                const claim = await claimLease(db, sessionId, ownerToken, socket.data.happyClient ?? null);
                if (claim.verdict === 'refused') {
                    sessionAdmissionRefusedCounter.inc();
                    log({ module: 'session-lease' }, `Refused session-scoped admission for ${sessionId}`);
                    next(new Error('SESSION_ALREADY_OWNED'));
                    return;
                }
            }
        }
```

- [ ] **Step 2: Add the imports**

```typescript
import { claimLease, releaseLease } from '@/app/presence/sessionLeaseStore';
import { releasesOnDisconnect, strictModeEnabled } from '@/app/presence/sessionLease';
import { sessionAdmissionRefusedCounter, sessionTokenlessAdmissionCounter } from '@/app/monitoring/metrics2';
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add sources/app/api/socket.ts
git commit -m "feat(server): gate and renew the lease at socket admission"
```

### Task 6: Release on explicit disconnect only, with mutation proof

**Files:**
- Modify: `sources/app/api/socket.ts:189`
- Test: `sources/app/presence/sessionLease.test.ts` (already covers the predicate)

This is the highest-risk change in the build. Releasing on the wrong reason hands a
live session away on every network hiccup.

- [ ] **Step 1: Widen the handler signature and release conditionally**

Change `socket.on('disconnect', () => {` to `socket.on('disconnect', (reason: string) => {`,
then inside the handler, after the existing `eventRouter.removeConnection(...)` call:

```typescript
            const leaseSessionId = socket.data.sessionId as string | undefined;
            const leaseToken = socket.data.ownerToken as string | undefined;
            if (leaseSessionId && leaseToken && releasesOnDisconnect(reason)) {
                void releaseLease(db, leaseSessionId, leaseToken).catch((error) => {
                    log({ module: 'session-lease', level: 'error' }, `Lease release failed: ${error}`);
                });
            }
```

- [ ] **Step 2: Confirm the predicate tests pass**

Run: `npx vitest run sources/app/presence/sessionLease.test.ts`
Expected: PASS, including the three non-releasing reasons.

- [ ] **Step 3: MUTATION PROOF 1 (mandatory)**

Invert the predicate in `sessionLease.ts`:

```typescript
export function releasesOnDisconnect(reason: string): boolean {
    return !RELEASING_DISCONNECT_REASONS.has(reason);
}
```

Run: `npx vitest run sources/app/presence/sessionLease.test.ts`
Expected: FAIL. At minimum the `transport close`, `ping timeout`, unrecognised-reason
and explicit-disconnect tests must redden. If the suite stays green, the blip-safety
property is untested and this task is not done.

- [ ] **Step 4: Restore and prove the restore is byte-identical**

```bash
git checkout sources/app/presence/sessionLease.ts
npx vitest run sources/app/presence/sessionLease.test.ts
git diff --quiet sources/app/presence/sessionLease.ts && echo "RESTORED CLEAN"
```
Expected: PASS, then `RESTORED CLEAN`.

- [ ] **Step 5: Commit**

```bash
git add sources/app/api/socket.ts
git commit -m "fix(server): release the lease only on an explicit disconnect reason"
```

### Task 7: Renewal plus the lost-ownership push

**Files:**
- Modify: `sources/app/api/socket/sessionUpdateHandler.ts:140`

- [ ] **Step 1: Renew inside the existing session-alive handler**

Inside `socket.on('session-alive', ...)`, after the existing
`activityCache.queueSessionUpdate(sid, t)` call:

```typescript
            const leaseToken = socket.data.ownerToken as string | undefined;
            if (leaseToken) {
                // Deliberately NOT routed through activityCache: its
                // UPDATE_THRESHOLD is 30s and BATCH_INTERVAL is 5s
                // (sources/app/presence/sessionCache.ts lines 28 and 31), which can
                // leave a 60s lease roughly 35s behind the real heartbeat.
                const outcome = await renewLease(db, sid, leaseToken);
                if (outcome === 'lost') {
                    sessionLeaseLostCounter.inc();
                    log({ module: 'session-lease' }, `Session ${sid} lease lost by its holder`);
                    // A normal emit, not volatile: this must actually arrive.
                    socket.emit('session-owner-lost', { sessionId: sid });
                    socket.disconnect(true);
                }
            }
```

- [ ] **Step 2: Add the imports**

```typescript
import { renewLease } from '@/app/presence/sessionLeaseStore';
import { sessionLeaseLostCounter } from '@/app/monitoring/metrics2';
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: MUTATION PROOF 2 (mandatory)**

In `sessionLease.ts`, force the claim predicate to always grant:

```typescript
export function evaluateClaim(row: LeaseRow, presentedToken: string, nowMs: number): ClaimVerdict {
    return { verdict: 'granted' };
}
```

Run: `npx vitest run sources/app/presence/sessionLease.test.ts sources/app/presence/sessionLeaseStore.test.ts`
Expected: FAIL. The refuse-a-different-token test and the store's refuse-without-writing
test must both redden.

- [ ] **Step 5: Restore and verify**

```bash
git checkout sources/app/presence/sessionLease.ts
npx vitest run sources/app/presence/sessionLease.test.ts sources/app/presence/sessionLeaseStore.test.ts
git diff --quiet sources/app/presence/sessionLease.ts && echo "RESTORED CLEAN"
```
Expected: PASS, then `RESTORED CLEAN`.

- [ ] **Step 6: Commit**

```bash
git add sources/app/api/socket/sessionUpdateHandler.ts
git commit -m "feat(server): renew the lease on heartbeat and push loss of ownership"
```

### Task 8: Counters (wiring task, L12 audit obligation)

**Files:**
- Modify: `sources/app/monitoring/metrics2.ts`

The five counters referenced by Tasks 4 through 7 must exist and be registered next
to the existing `session_contention_events_total` at `metrics2.ts:69`.

- [ ] **Step 1: Register the counters**

```typescript
export const sessionClaimRefusedCounter = new Counter({
    name: 'session_claim_refused_total',
    help: 'Session claims refused because a live foreign owner held the lease',
    registers: [register],
});
export const sessionAdmissionRefusedCounter = new Counter({
    name: 'session_admission_refused_total',
    help: 'Session-scoped socket admissions refused by the ownership lease',
    registers: [register],
});
export const sessionLeaseLostCounter = new Counter({
    name: 'session_lease_lost_total',
    help: 'Heartbeats whose holder no longer owned the session',
    registers: [register],
});
export const sessionTokenlessClaimCounter = new Counter({
    name: 'session_tokenless_claim_total',
    help: 'Claims admitted from a CLI presenting no owner token',
    registers: [register],
});
export const sessionTokenlessAdmissionCounter = new Counter({
    name: 'session_tokenless_admission_total',
    help: 'Session-scoped admissions from a CLI presenting no owner token',
    registers: [register],
});
```

Copy the exact `Counter` construction and `registers` argument shape already used at
`metrics2.ts:69` rather than the above if the two differ.

- [ ] **Step 2: Prove each counter has a real caller**

Run: `for c in sessionClaimRefusedCounter sessionAdmissionRefusedCounter sessionLeaseLostCounter sessionTokenlessClaimCounter sessionTokenlessAdmissionCounter; do echo "== $c"; grep -rn "$c.inc()" sources --include='*.ts'; done`
Expected: every one of the five prints at least one `file:line`. A counter with no
`.inc()` call site fails the `/gate` D1 wiring check and must be wired or deleted
here, not later.

- [ ] **Step 3: Full server suite plus typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: exit 0, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add sources/app/monitoring/metrics2.ts sources/app/api sources/app/presence
git commit -m "feat(server): register and wire ownership lease counters"
```

### Task 9: Strict-mode path test

**Files:**
- Test: `sources/app/presence/sessionLease.test.ts`
- Modify: `sources/app/presence/sessionLease.ts`

The default is tolerant, so without this the strict branch would first execute on
the day someone flips the setting.

- [ ] **Step 1: Add the test**

```typescript
import { strictModeEnabled } from './sessionLease';

describe('strictModeEnabled', () => {
    it('is off by default', () => {
        expect(strictModeEnabled({})).toBe(false);
    });

    it('is on only for the exact value 1', () => {
        expect(strictModeEnabled({ LEASE_STRICT_MODE: '1' })).toBe(true);
        expect(strictModeEnabled({ LEASE_STRICT_MODE: 'true' })).toBe(false);
        expect(strictModeEnabled({ LEASE_STRICT_MODE: '0' })).toBe(false);
    });
});
```

- [ ] **Step 2: Implement it**

```typescript
/** Flip to strict refusal of token-less session-scoped connections. Default off. */
export function strictModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.LEASE_STRICT_MODE === '1';
}
```

- [ ] **Step 3: Run and commit**

Run: `npx vitest run sources/app/presence/sessionLease.test.ts && npx tsc --noEmit`
Expected: PASS, exit 0.

```bash
git add sources/app/presence/sessionLease.ts sources/app/presence/sessionLease.test.ts
git commit -m "feat(server): gate strict lease mode behind a tested setting"
```

---

## Workstream B: CLI (`happy`)

Start this only after Workstream A is merged, so the contract is real rather than
assumed.

### Task 10: Mint one owner token per process

**Files:**
- Create: `packages/happy-cli/src/api/ownerToken.ts`
- Test: `packages/happy-cli/src/api/ownerToken.test.ts`

Ported from `src/daemon/controlAuth.ts`, which uses `randomBytes` for the same shape
of per-run identifier.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import { getOwnerToken } from './ownerToken';

describe('getOwnerToken', () => {
    it('returns a 64-char hex token', () => {
        expect(getOwnerToken()).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is stable within a process, so a reconnect presents the same identity', () => {
        expect(getOwnerToken()).toBe(getOwnerToken());
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/code/happy/packages/happy-cli && npx vitest run --project unit src/api/ownerToken.test.ts`
Expected: FAIL, cannot resolve `./ownerToken`.

- [ ] **Step 3: Implement**

```typescript
/**
 * One ownership token per CLI process.
 *
 * This is NOT a credential. Any process running as this user can read it, and the
 * server already authenticates every connection with the account token. Its only
 * job is to answer "am I the same process that claimed this session", which the
 * handshake fields cannot answer: token, clientType, sessionId and happyClient are
 * identical across two processes serving one session. See punch row 9j.
 */

import { randomBytes } from 'node:crypto';

let cached: string | undefined;

export function getOwnerToken(): string {
    if (!cached) {
        cached = randomBytes(32).toString('hex');
    }
    return cached;
}
```

- [ ] **Step 4: Run to verify pass, then commit**

Run: `npx vitest run --project unit src/api/ownerToken.test.ts`
Expected: PASS, 2 tests.

```bash
git add src/api/ownerToken.ts src/api/ownerToken.test.ts
git commit -m "feat(cli): mint one session ownership token per process"
```

### Task 11: Present the token and handle both loss signals

**Files:**
- Modify: `packages/happy-cli/src/api/apiSession.ts:271-277` (handshake auth)
- Modify: the `POST /v1/sessions` call site in the same package

- [ ] **Step 1: Add the token to the handshake auth object**

In the `io(configuration.serverUrl, { auth: {...} })` call, add to `auth`:

```typescript
                ownerToken: getOwnerToken(),
```

- [ ] **Step 2: Listen for the server's loss push**

Where the other `this.socket.on(...)` handlers are registered, add:

```typescript
        this.socket.on('session-owner-lost', (data: { sessionId: string }) => {
            logger.debug(`[LEASE] Session ${data.sessionId} is owned by another process; exiting`);
            console.error(
                `This session is now owned by another Happy process. Exiting so the two do not both run.`
            );
            process.exit(1);
        });
```

- [ ] **Step 3: Send the token at claim time and handle 409**

At the `POST /v1/sessions` call site, add to the request body:

```typescript
            ownerToken: getOwnerToken(),
            ownerClient: `cli-coding-session/${configuration.currentCliVersion}`,
```

Then handle the refusal:

```typescript
        if (response.status === 409) {
            const body = await response.json().catch(() => ({} as any));
            console.error(
                `This session is already running in another Happy process` +
                (body.incumbentClient ? ` (${body.incumbentClient})` : '') +
                `. Stop that one first, or wait for it to exit.`
            );
            process.exit(1);
        }
```

- [ ] **Step 4: Add the import**

```typescript
import { getOwnerToken } from '@/api/ownerToken';
```

- [ ] **Step 5: Prove the token actually reaches both call sites**

Run: `grep -rn "getOwnerToken()" src --include='*.ts' | grep -v ownerToken`
Expected: at least two `file:line` results, one in the handshake auth object and one
in the claim body. Fewer than two means the token is minted and never presented,
which fails the `/gate` D1 wiring check.

- [ ] **Step 6: Typecheck and full unit suite**

Run: `npx tsc --noEmit && npx vitest run --project unit`
Expected: exit 0; test count at or above the 101 files / 993 tests baseline measured
on `origin/main` 19162018.

- [ ] **Step 7: Commit**

```bash
git add src/api/apiSession.ts
git commit -m "feat(cli): present the ownership token and exit when the lease is refused or lost"
```

---

## Task 12: Deployment (do not fold into any earlier task)

- [ ] **Step 1: Read the launcher rather than assuming the restart command**

Run: `grep -n "terminate_relay_pid\|restart\|SUPERVISOR_SOURCED_ONLY" ~/code/happy-cos/scripts/launcher/engine-supervisor.sh | head -20`
Expected: the real function names. Use them. Do not kill the node pid directly.

- [ ] **Step 2: Restart the relay through the sanctioned path**

Follow the procedure recorded in punch row 9j: source `engine-supervisor.sh` with
`SUPERVISOR_SOURCED_ONLY=1`, call the real terminate function with the tracked
pid/start/pgid, and let the running supervisor loop restart it. Confirm the port
returns under a NEW pid rather than assuming the restart completed.

- [ ] **Step 3: Verify server identity, not just a 200**

Run: `curl -s localhost:3010 | head -c 80`
Expected: `Welcome to Happy Server!`. Then confirm the three new columns exist by
reading the live schema, not the migration file.

- [ ] **Step 4: CLI rebuild and daemon restart**

Build in `~/code/happy-wt-main` (the worktree punch row 13 prepared), never in the
live daemon's own tree, per the row 9q containment rule. Batch with the row 13 and
9l cutover. Verify by symbol in the compiled bundle that `getOwnerToken` appears at
both call sites, as row 9h did, rather than trusting the source.

- [ ] **Step 5: Confirm the lease is live, with the distribution check**

After roughly an hour of real use, read the actual values: count sessions grouped by
whether `ownerToken` is null.
Expected: a MIX. If every row is null, the CLI is not presenting the token and the
feature is wired but not running, which the `/gate` D2 check treats as a failure to
investigate rather than as data.

---

## Self-review

**Spec coverage.** Schema (Task 2), claim with 409 (Task 4), socket admission
(Task 5), admission-also-renews (Task 5 Step 1), renewal (Task 7),
expired-but-uncontested re-claim (Task 1, fourth test), release on explicit reasons
only (Task 6), lease duration 60s (Task 1), tolerate-and-log plus the strict setting
(Tasks 4, 5, 9), CLI token/handshake/409/lost-lease (Tasks 10, 11), deployment
(Task 12). The spec's required unit list maps onto Tasks 1, 3 and 9; both mandatory
mutation proofs are Tasks 6 and 7. Integration tests remain excluded per punch rows
9m, 9o and 12.

**Placeholders.** None: every code step carries the code, every run step carries the
command and its expected output.

**Type consistency.** `evaluateClaim` returns `ClaimVerdict` and is consumed as
`claim.verdict` in Tasks 4 and 5. `renewLease` returns the string union
`'renewed' | 'lost'` and is compared against `'lost'` in Task 7.
`releasesOnDisconnect` and `strictModeEnabled` keep the same names in Tasks 6 and 9.
`getOwnerToken` keeps one name across Tasks 10 and 11. The five counter names in
Task 8 match their `.inc()` call sites in Tasks 4, 5 and 7 exactly.

**Wiring coverage.** Task 8 is a wiring-only task whose grep fails when a counter has
no `.inc()` caller. Task 11 Step 5 greps that the minted token reaches both
presentation sites. Task 12 Step 5 checks the real value distribution rather than
only that the column writes.
