import { TrackedSession } from './types';

export type SessionLookup =
  | { type: 'found'; session: TrackedSession }
  | { type: 'not-found' }
  | { type: 'ambiguous'; pids: number[] };

export type SessionClaimResolution =
  | { type: 'accepted' }
  | { type: 'rejected'; claimantPids: number[] };

export type ProcessLiveness = 'alive' | 'dead' | 'unknown';

export type WebhookSessionClaimResolution = SessionClaimResolution | {
  type: 'invalid-pid';
  hostPid: unknown;
};

type SignalProbe = (pid: number, signal: 0) => void;

export function probeProcessLiveness(pid: number, signalProbe: SignalProbe): ProcessLiveness {
  try {
    signalProbe(pid, 0);
    return 'alive';
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

export function isValidHostPid(hostPid: unknown): hostPid is number {
  return typeof hostPid === 'number' && Number.isSafeInteger(hostPid) && hostPid > 0;
}

export function pruneDeadSessionClaims(
  pidToTrackedSession: Map<number, TrackedSession>,
  processLiveness: (pid: number) => ProcessLiveness,
): number[] {
  const deadPids: number[] = [];
  for (const pid of pidToTrackedSession.keys()) {
    if (processLiveness(pid) === 'dead') {
      pidToTrackedSession.delete(pid);
      deadPids.push(pid);
    }
  }
  return deadPids;
}

export function getResumeOwnerConflict(pid: number, liveness: ProcessLiveness): string | undefined {
  if (liveness === 'dead') return undefined;
  return `Session is still owned by ${liveness === 'alive' ? 'live' : 'unverified'} PID ${pid}`;
}

/**
 * Removes dead claims for a session and determines whether a reporting PID can
 * claim it. The caller owns the accepted/rejected process lifecycle.
 */
export function resolveSessionClaim(
  pidToTrackedSession: Map<number, TrackedSession>,
  sessionId: string,
  reportingPid: number,
  processLiveness: (pid: number) => ProcessLiveness,
): SessionClaimResolution {
  const claimantPids: number[] = [];

  for (const [claimedPid, claimedSession] of pidToTrackedSession.entries()) {
    if (claimedPid === reportingPid || claimedSession.happySessionId !== sessionId) continue;
    if (processLiveness(claimedPid) !== 'dead') {
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
 * Applies the webhook-specific ownership rule. A webhook can report a PID but
 * can never make the daemon terminate it: only an existing daemon-created
 * record may opt into the supplied terminator.
 */
export function resolveWebhookSessionClaim(
  pidToTrackedSession: Map<number, TrackedSession>,
  sessionId: string,
  hostPid: unknown,
  processLiveness: (pid: number) => ProcessLiveness,
  terminateDaemonTrackedSession: (pid: number) => void,
): WebhookSessionClaimResolution {
  if (!isValidHostPid(hostPid)) return { type: 'invalid-pid', hostPid };

  const resolution = resolveSessionClaim(pidToTrackedSession, sessionId, hostPid, processLiveness);
  if (resolution.type === 'rejected' && pidToTrackedSession.get(hostPid)?.startedBy === 'daemon') {
    terminateDaemonTrackedSession(hostPid);
  }
  return resolution;
}

export function formatAmbiguousSessionStopError(sessionId: string, pids: number[]): string {
  const pidStops = pids.map(pid => `PID-${pid}`).join(' or ');
  return `Session ${sessionId} has conflicting live claims from PIDs ${pids.join(', ')}. Stop one by ${pidStops}, then retry.`;
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
