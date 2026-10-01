import { TrackedSession } from './types';

export type SessionLookup =
  | { type: 'found'; session: TrackedSession }
  | { type: 'not-found' }
  | { type: 'ambiguous'; pids: number[] };

export type SessionClaimResolution =
  | { type: 'accepted' }
  | { type: 'rejected'; claimantPids: number[] };

/**
 * Removes dead claims for a session and determines whether a reporting PID can
 * claim it. The caller owns the accepted/rejected process lifecycle.
 */
export function resolveSessionClaim(
  pidToTrackedSession: Map<number, TrackedSession>,
  sessionId: string,
  reportingPid: number,
  isProcessAlive: (pid: number) => boolean,
): SessionClaimResolution {
  const claimantPids: number[] = [];

  for (const [claimedPid, claimedSession] of pidToTrackedSession.entries()) {
    if (claimedPid === reportingPid || claimedSession.happySessionId !== sessionId) continue;
    if (isProcessAlive(claimedPid)) {
      claimantPids.push(claimedPid);
    } else {
      pidToTrackedSession.delete(claimedPid);
    }
  }

  return claimantPids.length > 0
    ? { type: 'rejected', claimantPids }
    : { type: 'accepted' };
}

/**
 * Looks up a session without allowing a corrupted duplicate registry to pick
 * an arbitrary process. Finished-session state is only considered when there
 * is no live claimant.
 */
export function findTrackedSessionById(
  pidToTrackedSession: Map<number, TrackedSession>,
  sessionIdToFinishedSession: Map<string, TrackedSession>,
  happySessionId: string,
): SessionLookup {
  const matches = Array.from(pidToTrackedSession.values())
    .filter(session => session.happySessionId === happySessionId);

  if (matches.length > 1) {
    return { type: 'ambiguous', pids: matches.map(session => session.pid) };
  }
  if (matches.length === 1) return { type: 'found', session: matches[0] };

  const finishedSession = sessionIdToFinishedSession.get(happySessionId);
  return finishedSession ? { type: 'found', session: finishedSession } : { type: 'not-found' };
}
