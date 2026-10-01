/**
 * Durable ownership identity for a happySessionId.
 *
 * The in-memory claim registry in `run.ts` is emptied by a daemon restart, so
 * every session alive at that moment becomes untracked and a later resume can
 * spawn a second process for the same session id with nothing left to conflict
 * with. Persisting the claim fixes that, but a bare PID is NOT a safe identity
 * across a restart: the OS may have handed that number to an unrelated process,
 * and restoring it would permanently block a legitimate resume. Pairing the PID
 * with the process start time makes the record falsifiable, which is what lets
 * it be trusted at boot.
 */

import { execFileSync } from 'node:child_process';

import { TrackedSession } from './types';

export type ProcessOwner = { pid: number; startedAt: string };

export type OwnerVerdict = 'same' | 'reused' | 'gone' | 'unknown';

export type DropReason = 'reused' | 'gone' | 'unknown' | 'malformed' | 'conflicting';

/** Returns the process start time for a PID, or undefined if no such process. */
export type StartTimeReader = (pid: number) => string | undefined;

export type RestorableClaims = {
  restore: Array<{ sessionId: string; pid: number }>;
  dropped: Array<{ sessionId: string; reason: DropReason }>;
};

export function isValidPersistedOwner(owner: unknown): owner is ProcessOwner {
  if (!owner || typeof owner !== 'object') return false;
  const { pid, startedAt } = owner as Partial<ProcessOwner>;
  return typeof pid === 'number'
    && Number.isSafeInteger(pid)
    && pid > 0
    && typeof startedAt === 'string'
    && startedAt.trim().length > 0;
}

export function verifyOwner(owner: ProcessOwner, readStartTime: StartTimeReader): OwnerVerdict {
  let observed: string | undefined;
  try {
    observed = readStartTime(owner.pid);
  } catch {
    return 'unknown';
  }
  if (observed === undefined) return 'gone';
  return observed === owner.startedAt ? 'same' : 'reused';
}

export function selectRestorableClaims(
  persistedOwners: Record<string, unknown>,
  readStartTime: StartTimeReader,
): RestorableClaims {
  const reasons = new Map<string, DropReason>();
  const verifiedPid = new Map<string, number>();
  const sessionIdsByPid = new Map<number, string[]>();

  for (const [sessionId, owner] of Object.entries(persistedOwners)) {
    if (!isValidPersistedOwner(owner)) {
      reasons.set(sessionId, 'malformed');
      continue;
    }
    const verdict = verifyOwner(owner, readStartTime);
    if (verdict !== 'same') {
      reasons.set(sessionId, verdict);
      continue;
    }
    verifiedPid.set(sessionId, owner.pid);
    sessionIdsByPid.set(owner.pid, [...(sessionIdsByPid.get(owner.pid) ?? []), sessionId]);
  }

  // One process cannot own two session ids. A store that says otherwise is
  // corrupt, and trusting it would recreate the duplicate-claim bug at boot.
  for (const [, sessionIds] of sessionIdsByPid) {
    if (sessionIds.length > 1) {
      for (const sessionId of sessionIds) reasons.set(sessionId, 'conflicting');
    }
  }

  const restore: RestorableClaims['restore'] = [];
  const dropped: RestorableClaims['dropped'] = [];
  for (const sessionId of Object.keys(persistedOwners)) {
    const reason = reasons.get(sessionId);
    if (reason) {
      dropped.push({ sessionId, reason });
      continue;
    }
    restore.push({ sessionId, pid: verifiedPid.get(sessionId)! });
  }

  return { restore, dropped };
}

/**
 * Reads a process's start time from the OS. Paired with the PID this is a
 * durable identity: the pair cannot be reproduced by a later process that
 * happens to be handed the same PID number.
 *
 * Returns undefined when no process holds the PID (`ps` exits 1 with no rows).
 * Rethrows anything else, so "the probe itself is broken" stays distinguishable
 * from "the process is gone" and callers can refuse to guess.
 */
export function readProcessStartTime(pid: number): string | undefined {
  try {
    const stdout = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const startedAt = stdout.trim();
    return startedAt.length > 0 ? startedAt : undefined;
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined;
    if (status === 1) return undefined;
    throw error;
  }
}

/**
 * Builds the owner record to persist alongside a session, or undefined if the
 * process's identity cannot be established. Never returns a PID without a
 * start time: an unfalsifiable record is worse than no record, because it would
 * be restored as a live claim and could block resume forever.
 */
export function describeProcessOwner(
  pid: number,
  readStartTime: StartTimeReader = readProcessStartTime,
): ProcessOwner | undefined {
  let startedAt: string | undefined;
  try {
    startedAt = readStartTime(pid);
  } catch {
    return undefined;
  }
  if (startedAt === undefined) return undefined;
  const owner = { pid, startedAt };
  return isValidPersistedOwner(owner) ? owner : undefined;
}

/**
 * The daemon boot path, as a function the tests can actually execute.
 *
 * Mutates `pidToTrackedSession` in place, restoring every persisted claim whose
 * owner is provably the same process, and returns the claims it refused to
 * restore so the caller can log them.
 */
export function restorePersistedClaims(args: {
  persisted: Record<string, { owner?: ProcessOwner; [extra: string]: unknown }>;
  sessionIdToFinishedSession: Map<string, TrackedSession>;
  pidToTrackedSession: Map<number, TrackedSession>;
  readStartTime?: StartTimeReader;
}): RestorableClaims['dropped'] {
  const { persisted, sessionIdToFinishedSession, pidToTrackedSession } = args;
  const readStartTime = args.readStartTime ?? readProcessStartTime;

  const owners = Object.fromEntries(
    Object.entries(persisted).map(([sessionId, session]) => [sessionId, session.owner]),
  );
  const { restore, dropped } = selectRestorableClaims(owners, readStartTime);

  for (const { sessionId, pid } of restore) {
    const persistedSession = sessionIdToFinishedSession.get(sessionId);
    if (!persistedSession) continue;
    // Carry metadata and encryption onto the live claim: if the owner later
    // exits, resumeSession drops the claim and resumes from THIS object.
    pidToTrackedSession.set(pid, { ...persistedSession, pid });
  }

  return dropped;
}
