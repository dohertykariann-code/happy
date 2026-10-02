import { decodeBase64 } from '@/api/encryption';
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
