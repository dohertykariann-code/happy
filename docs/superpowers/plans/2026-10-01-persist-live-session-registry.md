# Persist the Daemon Live Session Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daemon's live session registry survive a daemon restart, so a restart stops re-creating the duplicate-execution bug that punch row 9l describes.

**Architecture:** The daemon already persists session records to disk (`persistence.ts:434-465`, atomic tmp+rename, 14-day TTL) and already reads them at boot (`run.ts:182-199`), but it loads them into `sessionIdToFinishedSession` with `pid: 0`, so the LIVE map `pidToTrackedSession` (`run.ts:177`) starts empty on every restart. We add process identity (pid plus OS process start time) to the persisted record, and at boot we rehydrate into the LIVE map only those sessions whose pid is both alive AND the same process incarnation. Everything else keeps today's behavior. Two pure, injectable modules hold the logic; `run.ts` only wires them.

**Tech Stack:** TypeScript, Node, vitest. No new dependencies.

---

## Non-negotiable safety constraints

These are the two ways this change could be worse than the bug it fixes. Both get their own test.

1. **A rehydrated entry must never become killable.** `stopSession` (`run.ts:835-890`) signals only when `session.startedBy === 'daemon' && session.childProcess`. A `ChildProcess` handle cannot survive a restart, so rehydrated entries are structurally unkillable, but we also set `startedBy: 'rehydrated'` so the refusal is explicit rather than incidental. The control server has no caller authentication (punch 9h), so handing it a kill primitive on reconstructed pids would repeat the 9g failure.
2. **Pid reuse must not be trusted.** Pid alone is not identity. The OS reuses pids, and review round 2 blocked an earlier revision for exactly this. We compare the recorded process start time; a mismatch means a different process now holds that pid and we do NOT rehydrate.

**Known behavior consequence, verified in source, not a regression:** a rehydrated entry carries `startedBy: 'rehydrated'` and no `ChildProcess`, so `stopSession` refuses to signal it and returns "was not spawned by this daemon". Before this change the session was absent from the live map entirely after a restart, so stop already failed, with a less informative error. Confirmed by reading `resolveSessionClaim` (`sessionClaims.ts:60-80`), whose `claimedPid === reportingPid` skip means the surviving owner re-reporting its own session is still ACCEPTED, so resume and reconnect keep working. Task 5 Step 1 case three is the test that guards this.

**Fail-safe direction:** when identity cannot be established (liveness `unknown`, start time unreadable, or an old persisted record with no identity fields), do NOT rehydrate. Worst case is today's behavior, never worse.

## File Structure

- **Create** `packages/happy-cli/src/daemon/processIdentity.ts`: reads an OS process start time and compares incarnations. Only module that shells out.
- **Create** `packages/happy-cli/src/daemon/processIdentity.test.ts`
- **Create** `packages/happy-cli/src/daemon/rehydrateSessionClaims.ts`: pure. Decides which persisted sessions re-enter the live map. All I/O injected.
- **Create** `packages/happy-cli/src/daemon/rehydrateSessionClaims.test.ts`
- **Modify** `packages/happy-cli/src/persistence.ts:418-426`: add two optional identity fields to `PersistedSession`.
- **Modify** `packages/happy-cli/src/daemon/run.ts:182-199` (boot rehydration) and `run.ts:249-257` (write identity when persisting).

---

### Task 1: Process identity module

**Files:**
- Create: `packages/happy-cli/src/daemon/processIdentity.ts`
- Test: `packages/happy-cli/src/daemon/processIdentity.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { readProcessStartTime, isSameProcessIncarnation } from './processIdentity';

describe('readProcessStartTime', () => {
  it('returns the trimmed start time for a pid ps knows about', () => {
    const exec = (_cmd: string) => 'Wed Sep 30 07:16:31 2026    \n';
    expect(readProcessStartTime(94167, exec)).toBe('Wed Sep 30 07:16:31 2026');
  });

  it('returns undefined when ps exits non-zero', () => {
    const exec = (_cmd: string) => { throw new Error('ps: process id too large'); };
    expect(readProcessStartTime(999999, exec)).toBeUndefined();
  });

  it('returns undefined when ps prints nothing', () => {
    const exec = (_cmd: string) => '   \n';
    expect(readProcessStartTime(1234, exec)).toBeUndefined();
  });

  it('refuses a pid that is not a positive safe integer, without calling ps', () => {
    let called = false;
    const exec = (_cmd: string) => { called = true; return 'x'; };
    expect(readProcessStartTime(-1, exec)).toBeUndefined();
    expect(readProcessStartTime(0, exec)).toBeUndefined();
    expect(readProcessStartTime(1.5, exec)).toBeUndefined();
    expect(readProcessStartTime(Number.NaN, exec)).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe('isSameProcessIncarnation', () => {
  it('is true only when both start times are present and equal', () => {
    expect(isSameProcessIncarnation('Wed Sep 30 07:16:31 2026', 'Wed Sep 30 07:16:31 2026')).toBe(true);
  });

  it('is false when the start times differ, which is how pid reuse is caught', () => {
    expect(isSameProcessIncarnation('Wed Sep 30 07:16:31 2026', 'Thu Oct  1 09:02:11 2026')).toBe(false);
  });

  it('is false when either side is absent, so unverifiable identity never passes', () => {
    expect(isSameProcessIncarnation(undefined, 'Wed Sep 30 07:16:31 2026')).toBe(false);
    expect(isSameProcessIncarnation('Wed Sep 30 07:16:31 2026', undefined)).toBe(false);
    expect(isSameProcessIncarnation(undefined, undefined)).toBe(false);
    expect(isSameProcessIncarnation('', '')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/happy-cli && npx vitest run --project unit src/daemon/processIdentity.test.ts`
Expected: FAIL with `Failed to resolve import "./processIdentity"`

- [ ] **Step 3: Write minimal implementation**

```typescript
import { execSync } from 'child_process';

/** Runs a shell command and returns stdout. Injectable so tests never shell out. */
export type CommandRunner = (command: string) => string;

const defaultRunner: CommandRunner = (command: string) =>
  execSync(command, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * Reads the OS start time of a process as an opaque string.
 *
 * This exists because a pid is not an identity: the OS reuses pids, so a
 * recorded pid that is alive today may be a completely different process.
 * Pairing the pid with its start time makes the pair stable for the life of
 * that process and unforgeable by a later process that inherits the number.
 *
 * Returns undefined whenever identity cannot be established. Callers must
 * treat undefined as "not the same process", never as "probably fine".
 */
export function readProcessStartTime(
  pid: number,
  runCommand: CommandRunner = defaultRunner,
): string | undefined {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  try {
    const output = runCommand(`ps -o lstart= -p ${pid}`);
    const trimmed = typeof output === 'string' ? output.trim() : '';
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True only when both start times are present and identical. Any absent or
 * differing value means we are looking at a different process incarnation.
 */
export function isSameProcessIncarnation(
  recordedStartTime: string | undefined,
  observedStartTime: string | undefined,
): boolean {
  if (!recordedStartTime || !observedStartTime) return false;
  return recordedStartTime === observedStartTime;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/happy-cli && npx vitest run --project unit src/daemon/processIdentity.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/daemon/processIdentity.ts packages/happy-cli/src/daemon/processIdentity.test.ts
git commit -m "feat(daemon): add process identity probe for pid-reuse-safe session rehydration"
```

---

### Task 2: Pure rehydration decision

**Files:**
- Create: `packages/happy-cli/src/daemon/rehydrateSessionClaims.ts`
- Test: `packages/happy-cli/src/daemon/rehydrateSessionClaims.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { rehydrateLiveSessionClaims, REHYDRATED_STARTED_BY } from './rehydrateSessionClaims';
import type { ProcessLiveness } from './sessionClaims';

const LIVE_START = 'Wed Sep 30 07:16:31 2026';

function record(overrides: Record<string, unknown> = {}) {
  return {
    encryptionKey: 'AAAA',
    encryptionVariant: 'dataKey' as const,
    seq: 1,
    metadataVersion: 2,
    agentStateVersion: 3,
    metadata: { hostPid: 4242 } as never,
    savedAt: Date.now(),
    hostPid: 4242,
    hostPidStartedAt: LIVE_START,
    ...overrides,
  };
}

const alive = (): ProcessLiveness => 'alive';
const dead = (): ProcessLiveness => 'dead';
const unknown = (): ProcessLiveness => 'unknown';
const sameStart = () => LIVE_START;

describe('rehydrateLiveSessionClaims', () => {
  it('rehydrates a session whose pid is alive and the same incarnation', () => {
    const result = rehydrateLiveSessionClaims({ 'sess-1': record() }, alive, sameStart);
    expect([...result.live.keys()]).toEqual([4242]);
    expect(result.live.get(4242)!.happySessionId).toBe('sess-1');
    expect(result.notRehydrated).toEqual([]);
  });

  it('does NOT rehydrate when the pid is alive but the start time differs, which is pid reuse', () => {
    const result = rehydrateLiveSessionClaims(
      { 'sess-1': record() },
      alive,
      () => 'Thu Oct  1 09:02:11 2026',
    );
    expect(result.live.size).toBe(0);
    expect(result.notRehydrated).toEqual([{ sessionId: 'sess-1', reason: 'pid-reused' }]);
  });

  it('does NOT rehydrate a dead pid', () => {
    const result = rehydrateLiveSessionClaims({ 'sess-1': record() }, dead, sameStart);
    expect(result.live.size).toBe(0);
    expect(result.notRehydrated).toEqual([{ sessionId: 'sess-1', reason: 'dead' }]);
  });

  it('does NOT rehydrate when liveness is unknown, failing safe to pre-change behavior', () => {
    const result = rehydrateLiveSessionClaims({ 'sess-1': record() }, unknown, sameStart);
    expect(result.live.size).toBe(0);
    expect(result.notRehydrated).toEqual([{ sessionId: 'sess-1', reason: 'liveness-unknown' }]);
  });

  it('does NOT rehydrate when the start time cannot be read', () => {
    const result = rehydrateLiveSessionClaims({ 'sess-1': record() }, alive, () => undefined);
    expect(result.live.size).toBe(0);
    expect(result.notRehydrated).toEqual([{ sessionId: 'sess-1', reason: 'pid-reused' }]);
  });

  it('does NOT rehydrate a legacy record written before identity fields existed', () => {
    const legacy = record({ hostPid: undefined, hostPidStartedAt: undefined });
    const result = rehydrateLiveSessionClaims({ 'sess-1': legacy }, alive, sameStart);
    expect(result.live.size).toBe(0);
    expect(result.notRehydrated).toEqual([{ sessionId: 'sess-1', reason: 'no-identity' }]);
  });

  it('rejects an invalid persisted hostPid without probing it', () => {
    let probed = false;
    const probe = () => { probed = true; return 'alive' as ProcessLiveness; };
    const result = rehydrateLiveSessionClaims(
      { 'sess-1': record({ hostPid: -1 }) },
      probe,
      sameStart,
    );
    expect(result.live.size).toBe(0);
    expect(result.notRehydrated).toEqual([{ sessionId: 'sess-1', reason: 'no-identity' }]);
    expect(probed).toBe(false);
  });

  it('marks rehydrated entries unkillable: no childProcess and startedBy is not daemon', () => {
    const result = rehydrateLiveSessionClaims({ 'sess-1': record() }, alive, sameStart);
    const entry = result.live.get(4242)!;
    expect(entry.childProcess).toBeUndefined();
    expect(entry.startedBy).toBe(REHYDRATED_STARTED_BY);
    expect(entry.startedBy).not.toBe('daemon');
  });

  it('keeps the last writer when two persisted sessions claim the same live pid', () => {
    const result = rehydrateLiveSessionClaims(
      { 'sess-1': record({ savedAt: 1 }), 'sess-2': record({ savedAt: 2 }) },
      alive,
      sameStart,
    );
    expect(result.live.size).toBe(1);
    expect(result.live.get(4242)!.happySessionId).toBe('sess-2');
  });

  it('returns an empty live map for no persisted sessions', () => {
    const result = rehydrateLiveSessionClaims({}, alive, sameStart);
    expect(result.live.size).toBe(0);
    expect(result.notRehydrated).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/happy-cli && npx vitest run --project unit src/daemon/rehydrateSessionClaims.test.ts`
Expected: FAIL with `Failed to resolve import "./rehydrateSessionClaims"`

- [ ] **Step 3: Confirm the base64 import specifier before writing**

Run: `cd packages/happy-cli && grep -n "decodeBase64" src/daemon/run.ts`

Use that exact import specifier in the implementation below rather than the one written here, if they differ.

- [ ] **Step 4: Write minimal implementation**

```typescript
import { decodeBase64 } from '@/encryption/base64';
import type { PersistedSession } from '@/persistence';
import { isSameProcessIncarnation } from './processIdentity';
import type { ProcessLiveness } from './sessionClaims';
import type { TrackedSession } from './types';

/**
 * Provenance marker for an entry reconstructed from disk. Deliberately not
 * 'daemon': stopSession only signals sessions whose startedBy is 'daemon' AND
 * that carry a live ChildProcess handle. A handle cannot survive a restart, so
 * rehydrated entries are already unkillable; this value makes that explicit
 * rather than incidental. The control server has no caller authentication, so
 * a reconstructed pid must never reach a kill path.
 */
export const REHYDRATED_STARTED_BY = 'rehydrated';

export type NotRehydratedReason = 'no-identity' | 'dead' | 'liveness-unknown' | 'pid-reused';

export type RehydrationResult = {
  live: Map<number, TrackedSession>;
  notRehydrated: { sessionId: string; reason: NotRehydratedReason }[];
};

/**
 * Rebuilds the live session registry from persisted records.
 *
 * A restart empties the in-memory registry, which is what lets a phone-initiated
 * resume spawn a second process for a session id that is still running: the
 * surviving original is not in the map to conflict with. Rehydrating the live
 * map restores that conflict.
 *
 * Only sessions whose recorded pid is BOTH alive AND the same process
 * incarnation are rehydrated. Every other case is skipped, which reproduces
 * pre-change behavior exactly; no path here is allowed to be worse than that.
 */
export function rehydrateLiveSessionClaims(
  persisted: Record<string, PersistedSession>,
  probeLiveness: (pid: number) => ProcessLiveness,
  readStartTime: (pid: number) => string | undefined,
): RehydrationResult {
  const live = new Map<number, TrackedSession>();
  const notRehydrated: { sessionId: string; reason: NotRehydratedReason }[] = [];

  const entries = Object.entries(persisted).sort(
    ([, a], [, b]) => (a.savedAt ?? 0) - (b.savedAt ?? 0),
  );

  for (const [sessionId, session] of entries) {
    const pid = session.hostPid;
    const recordedStartTime = session.hostPidStartedAt;

    // A record written before identity fields existed, or with a nonsense pid,
    // carries no identity we can verify. Skip before probing anything.
    if (
      typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 ||
      typeof recordedStartTime !== 'string' || recordedStartTime.length === 0
    ) {
      notRehydrated.push({ sessionId, reason: 'no-identity' });
      continue;
    }

    const liveness = probeLiveness(pid);
    if (liveness === 'dead') {
      notRehydrated.push({ sessionId, reason: 'dead' });
      continue;
    }
    if (liveness === 'unknown') {
      notRehydrated.push({ sessionId, reason: 'liveness-unknown' });
      continue;
    }

    if (!isSameProcessIncarnation(recordedStartTime, readStartTime(pid))) {
      notRehydrated.push({ sessionId, reason: 'pid-reused' });
      continue;
    }

    live.set(pid, {
      startedBy: REHYDRATED_STARTED_BY,
      happySessionId: sessionId,
      happySessionMetadataFromLocalWebhook: session.metadata,
      encryption: {
        encryptionKey: decodeBase64(session.encryptionKey),
        encryptionVariant: session.encryptionVariant,
        seq: session.seq,
        metadataVersion: session.metadataVersion,
        agentStateVersion: session.agentStateVersion,
      },
      pid,
    });
  }

  return { live, notRehydrated };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/happy-cli && npx vitest run --project unit src/daemon/rehydrateSessionClaims.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 6: Commit**

```bash
git add packages/happy-cli/src/daemon/rehydrateSessionClaims.ts packages/happy-cli/src/daemon/rehydrateSessionClaims.test.ts
git commit -m "feat(daemon): decide which persisted sessions re-enter the live registry"
```

---

### Task 3: Record process identity when persisting a session

**Files:**
- Modify: `packages/happy-cli/src/persistence.ts:418-426`
- Modify: `packages/happy-cli/src/daemon/run.ts:249-257`
- Test: `packages/happy-cli/src/daemon/sessionIdentityPersistence.test.ts`

- [ ] **Step 1: Add the identity fields to the persisted record type**

In `packages/happy-cli/src/persistence.ts`, replace the `PersistedSession` type:

```typescript
export type PersistedSession = {
  encryptionKey: string;
  encryptionVariant: 'legacy' | 'dataKey';
  seq: number;
  metadataVersion: number;
  agentStateVersion: number;
  metadata: Metadata;
  savedAt: number;
  /**
   * OS pid that owned this session when it was persisted. Optional because
   * records written before this field existed must still load.
   */
  hostPid?: number;
  /**
   * OS start time of hostPid, as an opaque string. Pairing pid with start time
   * is what makes the owner identifiable after a restart: a pid alone can be
   * reused by an unrelated process.
   */
  hostPidStartedAt?: string;
};
```

- [ ] **Step 2: Write the failing test for the write site**

Create `packages/happy-cli/src/daemon/sessionIdentityPersistence.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildPersistedSessionIdentity } from './rehydrateSessionClaims';

describe('buildPersistedSessionIdentity', () => {
  it('records the pid and its start time', () => {
    expect(buildPersistedSessionIdentity(4242, () => 'Wed Sep 30 07:16:31 2026')).toEqual({
      hostPid: 4242,
      hostPidStartedAt: 'Wed Sep 30 07:16:31 2026',
    });
  });

  it('records no identity at all when the start time cannot be read, rather than a bare pid', () => {
    expect(buildPersistedSessionIdentity(4242, () => undefined)).toEqual({});
  });

  it('records no identity for an invalid pid', () => {
    expect(buildPersistedSessionIdentity(-1, () => 'Wed Sep 30 07:16:31 2026')).toEqual({});
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/happy-cli && npx vitest run --project unit src/daemon/sessionIdentityPersistence.test.ts`
Expected: FAIL with `buildPersistedSessionIdentity is not a function`

- [ ] **Step 4: Implement the helper**

Append to `packages/happy-cli/src/daemon/rehydrateSessionClaims.ts`:

```typescript
/**
 * Builds the identity half of a persisted session record.
 *
 * Returns an empty object rather than a bare pid when the start time is
 * unreadable. A pid with no start time is not an identity, and persisting one
 * would invite a future reader to trust it.
 */
export function buildPersistedSessionIdentity(
  pid: number,
  readStartTime: (pid: number) => string | undefined,
): { hostPid?: number; hostPidStartedAt?: string } {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return {};
  const startedAt = readStartTime(pid);
  if (!startedAt) return {};
  return { hostPid: pid, hostPidStartedAt: startedAt };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/happy-cli && npx vitest run --project unit src/daemon/sessionIdentityPersistence.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 6: Wire it into the webhook persist call**

In `packages/happy-cli/src/daemon/run.ts`, add to the imports near line 38:

```typescript
import { rehydrateLiveSessionClaims, buildPersistedSessionIdentity } from './rehydrateSessionClaims';
import { readProcessStartTime } from './processIdentity';
```

Then in `onHappySessionWebhook`, change the `persistSession` call (currently `run.ts:249-257`) to:

```typescript
      if (encryption) {
        persistSession(sessionId, {
          encryptionKey: encodeBase64(encryption.encryptionKey),
          encryptionVariant: encryption.encryptionVariant,
          seq: encryption.seq,
          metadataVersion: encryption.metadataVersion,
          agentStateVersion: encryption.agentStateVersion,
          metadata: sessionMetadata,
          savedAt: Date.now(),
          ...buildPersistedSessionIdentity(pid, (p) => readProcessStartTime(p)),
        });
      }
```

- [ ] **Step 7: Typecheck and commit**

Run: `cd packages/happy-cli && npx tsc --noEmit`
Expected: exit 0, no output.

```bash
git add packages/happy-cli/src/persistence.ts packages/happy-cli/src/daemon/run.ts packages/happy-cli/src/daemon/rehydrateSessionClaims.ts packages/happy-cli/src/daemon/sessionIdentityPersistence.test.ts
git commit -m "feat(daemon): record owning pid and its start time when persisting a session"
```

---

### Task 4: Rehydrate the live map at daemon boot

**Files:**
- Modify: `packages/happy-cli/src/daemon/run.ts:177-199`

- [ ] **Step 1: Read the current boot block**

Run: `cd packages/happy-cli && sed -n '176,200p' src/daemon/run.ts`

Confirm it matches what this task replaces before editing. If it has drifted, stop and report rather than editing blind.

- [ ] **Step 2: Replace the boot block**

Replace lines 177-199 of `packages/happy-cli/src/daemon/run.ts` with:

```typescript
    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Retain session data after process exits so resume can still find it.
    // Pre-populate from disk so sessions survive daemon restarts.
    const sessionIdToFinishedSession = new Map<string, TrackedSession>();
    const persisted = readPersistedSessions();

    // A restart used to empty the LIVE registry, so a session that was still
    // running became invisible and a phone-initiated resume could spawn a
    // second process for the same session id with nothing to conflict with
    // (punch 9l). Rehydrate the live map first; only owners that are alive AND
    // the same process incarnation qualify.
    const rehydration = rehydrateLiveSessionClaims(
      persisted,
      (pid) => probeProcessLiveness(pid, process.kill),
      (pid) => readProcessStartTime(pid),
    );
    for (const [pid, session] of rehydration.live) {
      pidToTrackedSession.set(pid, session);
    }
    if (rehydration.live.size > 0) {
      logger.debug(`[DAEMON RUN] Rehydrated ${rehydration.live.size} live session claim(s) from disk: PIDs ${[...rehydration.live.keys()].join(', ')}`);
    }
    for (const skipped of rehydration.notRehydrated) {
      logger.debug(`[DAEMON RUN] Did not rehydrate session ${skipped.sessionId} as live: ${skipped.reason}`);
    }

    const rehydratedSessionIds = new Set(
      [...rehydration.live.values()].map((s) => s.happySessionId),
    );
    for (const [id, s] of Object.entries(persisted)) {
      // A session rehydrated as LIVE must not also appear as finished.
      if (rehydratedSessionIds.has(id)) continue;
      sessionIdToFinishedSession.set(id, {
        startedBy: 'persisted',
        happySessionId: id,
        happySessionMetadataFromLocalWebhook: s.metadata,
        encryption: {
          encryptionKey: decodeBase64(s.encryptionKey),
          encryptionVariant: s.encryptionVariant,
          seq: s.seq,
          metadataVersion: s.metadataVersion,
          agentStateVersion: s.agentStateVersion,
        },
        pid: 0,
      });
    }
    if (Object.keys(persisted).length > 0) {
      logger.debug(`[DAEMON RUN] Loaded ${Object.keys(persisted).length} persisted sessions from disk`);
    }
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/happy-cli && npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 4: Confirm the wiring with a grep, not an assumption**

Run: `cd packages/happy-cli && grep -n "rehydrateLiveSessionClaims\|readProcessStartTime\|buildPersistedSessionIdentity" src/daemon/run.ts`

Expected: at least 4 hits, being two imports, one rehydration call at boot, and one identity call in the persist path. Zero hits would mean the capability exists and never runs.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/daemon/run.ts
git commit -m "feat(daemon): rehydrate the live session registry at boot so restarts stop re-creating duplicate execution"
```

---

### Task 5: Regression test, a rehydrated claim blocks a duplicate claim

This is the test that fails if the whole change is pointless. It asserts the end behavior punch 9l describes, not the plumbing.

**Files:**
- Modify: `packages/happy-cli/src/daemon/rehydrateSessionClaims.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/happy-cli/src/daemon/rehydrateSessionClaims.test.ts`:

```typescript
import { resolveWebhookSessionClaim } from './sessionClaims';

describe('rehydration closes the restart hole in punch 9l', () => {
  const LIVE_START_2 = 'Wed Sep 30 07:16:31 2026';

  function persistedRecord(pid: number) {
    return {
      encryptionKey: 'AAAA',
      encryptionVariant: 'dataKey' as const,
      seq: 1,
      metadataVersion: 2,
      agentStateVersion: 3,
      metadata: { hostPid: pid } as never,
      savedAt: Date.now(),
      hostPid: pid,
      hostPidStartedAt: LIVE_START_2,
    };
  }

  it('rejects a second process claiming a session whose original owner survived the restart', () => {
    const map = rehydrateLiveSessionClaims(
      { 'sess-survivor': persistedRecord(4242) },
      () => 'alive',
      () => LIVE_START_2,
    ).live;

    // A phone-initiated resume spawns a NEW process for the same session id.
    const resolution = resolveWebhookSessionClaim(map, 'sess-survivor', 5555, () => 'alive');

    expect(resolution.type).toBe('rejected');
    expect(resolution).toMatchObject({ claimantPids: [4242] });
  });

  it('without rehydration the same second claim is accepted, which is the bug', () => {
    const emptyMap = new Map();
    const resolution = resolveWebhookSessionClaim(emptyMap, 'sess-survivor', 5555, () => 'alive');
    expect(resolution.type).toBe('accepted');
  });

  it('still lets the surviving owner re-report its own session after a restart', () => {
    const map = rehydrateLiveSessionClaims(
      { 'sess-survivor': persistedRecord(4242) },
      () => 'alive',
      () => LIVE_START_2,
    ).live;

    const resolution = resolveWebhookSessionClaim(map, 'sess-survivor', 4242, () => 'alive');
    expect(resolution.type).toBe('accepted');
  });

  it('accepts a resume once the original owner has exited', () => {
    const map = rehydrateLiveSessionClaims(
      { 'sess-survivor': persistedRecord(4242) },
      () => 'dead',
      () => LIVE_START_2,
    ).live;

    const resolution = resolveWebhookSessionClaim(map, 'sess-survivor', 5555, () => 'dead');
    expect(resolution.type).toBe('accepted');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd packages/happy-cli && npx vitest run --project unit src/daemon/rehydrateSessionClaims.test.ts`
Expected: PASS, 14 tests total in this file.

If the third case ("still lets the surviving owner re-report") fails, the rehydrated entry is blocking the legitimate owner, which is a real regression that would break resume. Stop and report; do not loosen the test.

- [ ] **Step 3: Commit**

```bash
git add packages/happy-cli/src/daemon/rehydrateSessionClaims.test.ts
git commit -m "test(daemon): prove rehydration blocks a duplicate claim and still allows legitimate resume"
```

---

### Task 6: Mutation proofs

Each mutation must redden exactly the named test, then be reverted. A mutation that reddens nothing means the test does not guard the thing it claims to.

**Files:** no permanent changes.

- [ ] **Step 1: Mutation A, trust pid alone**

In `rehydrateSessionClaims.ts`, change the `if (!isSameProcessIncarnation(...))` guard to `if (false)`.
Run: `cd packages/happy-cli && npx vitest run --project unit src/daemon/rehydrateSessionClaims.test.ts`
Expected: FAIL on "does NOT rehydrate when the pid is alive but the start time differs, which is pid reuse" and on "does NOT rehydrate when the start time cannot be read".
Revert the mutation. Re-run. Expected: PASS.

- [ ] **Step 2: Mutation B, treat unknown liveness as alive**

In `rehydrateSessionClaims.ts`, delete the `if (liveness === 'unknown')` block.
Run the same command.
Expected: FAIL on "does NOT rehydrate when liveness is unknown, failing safe to pre-change behavior".
Revert. Re-run. Expected: PASS.

- [ ] **Step 3: Mutation C, mark rehydrated entries as daemon-started**

In `rehydrateSessionClaims.ts`, change `REHYDRATED_STARTED_BY` to `'daemon'`.
Run the same command.
Expected: FAIL on "marks rehydrated entries unkillable: no childProcess and startedBy is not daemon".
Revert. Re-run. Expected: PASS.

- [ ] **Step 4: Mutation D, skip the boot wiring**

In `run.ts`, comment out the body of the `for (const [pid, session] of rehydration.live)` loop.
Run: `cd packages/happy-cli && npx tsc --noEmit`
Expected: exit 0. This mutation is type-safe and reddens no unit test, which is exactly why the grep in Task 4 Step 4 matters.
Revert.

- [ ] **Step 5: Record the proofs**

```bash
git commit --allow-empty -m "test(daemon): record mutation proofs for session rehydration

Mutation A (trust pid alone) reddens the two pid-reuse cases.
Mutation B (unknown liveness treated as alive) reddens the fail-safe case.
Mutation C (rehydrated marked daemon-started) reddens the unkillable case.
Mutation D (skip boot wiring) is type-safe and reddens no unit test; boot
wiring is guarded by the Task 4 Step 4 grep instead."
```

---

### Task 7: Full verification

**Files:** none.

- [ ] **Step 1: Full unit suite**

Run: `cd packages/happy-cli && npx vitest run --project unit`
Expected: all files pass. Baseline at `83c1ce56` is 93 files and 886 tests; this change adds 3 files and 17 tests, so expect 96 files and 903 tests. Record the ACTUAL numbers. If the file or test count differs from that, say so rather than rounding to "passing".

- [ ] **Step 2: Typecheck**

Run: `cd packages/happy-cli && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Re-run the tests of every modified file**

Run: `cd packages/happy-cli && npx vitest run --project unit src/daemon/sessionClaims.test.ts src/daemon/rehydrateSessionClaims.test.ts src/daemon/processIdentity.test.ts src/daemon/sessionIdentityPersistence.test.ts`
Expected: PASS.

- [ ] **Step 4: Report what is NOT covered**

State plainly in the final report:
- `daemon.integration.test.ts` is excluded from the `unit` project by `vitest.config.ts:15` and is not safely runnable on this machine (punch 9m), so the boot wiring has no automated end-to-end coverage here.
- The change is not proven against a real daemon restart until the daemon is rebuilt and restarted, which is a separate authorized step and NOT part of this plan.

- [ ] **Step 5: Do not declare done**

Hand back for the mandatory independent Codex review before any merge. This touches session ownership and sits next to an unauthenticated control server, which is high-stakes under the standing review rule.
