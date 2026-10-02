import { describe, expect, it, vi } from 'vitest';

import {
  findTrackedSessionById,
  formatAmbiguousSessionStopError,
  getResumeOwnerConflict,
  pruneDeadSessionClaims,
  probeProcessLiveness,
  resolveSessionClaim,
  resolveWebhookSessionClaim,
} from './sessionClaims';
import { TrackedSession } from './types';

function session(pid: number, happySessionId: string): TrackedSession {
  return { pid, happySessionId, startedBy: 'terminal' };
}

describe('session claim resolution', () => {
  it('rejects an untracked duplicate webhook and leaves the registry untouched', () => {
    const claims = new Map([[101, session(101, 'session-1')]]);

    expect(resolveWebhookSessionClaim(claims, 'session-1', 202, () => 'alive')).toEqual({
      type: 'rejected',
      claimantPids: [101],
    });
    expect([...claims.keys()]).toEqual([101]);
  });

  it.each([-1, 0, 12.5, '202'])('rejects invalid webhook hostPid %j explicitly', (hostPid) => {
    expect(resolveWebhookSessionClaim(new Map(), 'session-1', hostPid, () => 'alive')).toEqual({
      type: 'invalid-pid',
      hostPid,
    });
  });

  // The webhook resolver must never be able to cause a signal. Refusing to
  // register the duplicate is what stops the fanout; killing the reporter was
  // the source of two review findings (untrusted PID from an unauthenticated
  // control server, and PID reuse aiming the signal at an unrelated process).
  // This case is the one a regression would most plausibly re-open, because a
  // daemon-owned record is the only kind the old code was willing to kill.
  it('classifies a DAEMON-OWNED duplicate without terminating or evicting it', () => {
    const owner = { pid: 101, happySessionId: 'session-1', startedBy: 'daemon' } as TrackedSession;
    const duplicate = { pid: 202, happySessionId: 'session-1', startedBy: 'daemon' } as TrackedSession;
    const claims = new Map([[101, owner], [202, duplicate]]);

    const resolution = resolveWebhookSessionClaim(claims, 'session-1', 202, () => 'alive');

    expect(resolution).toEqual({ type: 'rejected', claimantPids: [101] });
    // The removed terminator deleted the reporter's map entry as its final act,
    // so an intact record is the observable proof it was not invoked. Asserting
    // on a kill spy would be vacuous here: the resolver takes no such argument.
    expect(claims.get(202)).toBe(duplicate);
    expect([...claims.keys()]).toEqual([101, 202]);
  });

  it('treats EPERM as alive and ESRCH as dead', () => {
    expect(probeProcessLiveness(101, () => {
      const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      throw error;
    })).toBe('alive');
    expect(probeProcessLiveness(101, () => {
      const error = Object.assign(new Error('no such process'), { code: 'ESRCH' });
      throw error;
    })).toBe('dead');
  });

  it('keeps an indeterminate claimant rather than pruning it', () => {
    const claims = new Map([[101, session(101, 'session-1')]]);

    expect(resolveSessionClaim(claims, 'session-1', 202, () => 'unknown')).toEqual({
      type: 'rejected',
      claimantPids: [101],
    });
    expect(claims).toHaveLength(1);
  });

  it('keeps EPERM claimants during the stale-session prune', () => {
    const claims = new Map([[101, session(101, 'session-1')]]);

    expect(pruneDeadSessionClaims(claims, () => 'alive')).toEqual([]);
    expect(claims).toHaveLength(1);
  });

  it('refuses a resume while the prior owner is live, before a replacement can be spawned', () => {
    const spawnReplacement = vi.fn();
    const conflict = getResumeOwnerConflict(101, 'alive');
    if (!conflict) spawnReplacement();

    expect(conflict).toBe('Session is still owned by live PID 101');
    expect(spawnReplacement).not.toHaveBeenCalled();
  });

  it('makes an ambiguous session stop actionable by naming every conflicting PID', () => {
    expect(formatAmbiguousSessionStopError('session-1', [101, 202])).toBe(
      'Session session-1 has conflicting live claims from PIDs 101, 202. Stop one by PID-101 or PID-202, then retry.',
    );
  });

  it('rejects a second live PID claiming the same session ID', () => {
    const claims = new Map([[101, session(101, 'session-1')]]);

    expect(resolveSessionClaim(claims, 'session-1', 202, pid => pid === 101 ? 'alive' : 'dead')).toEqual({
      type: 'rejected',
      claimantPids: [101],
    });
    expect(claims).toHaveLength(1);
  });

  it('releases a dead claim before accepting a replacement PID', () => {
    const claims = new Map([[101, session(101, 'session-1')]]);

    expect(resolveSessionClaim(claims, 'session-1', 202, () => 'dead')).toEqual({ type: 'accepted' });
    claims.set(202, session(202, 'session-1'));
    expect(Array.from(claims.values())).toEqual([session(202, 'session-1')]);
  });

  it('reports duplicate session IDs as ambiguous instead of returning the first claimant', () => {
    const claims = new Map([
      [101, session(101, 'session-1')],
      [202, session(202, 'session-1')],
    ]);

    expect(findTrackedSessionById(claims, new Map(), 'session-1')).toEqual({
      type: 'ambiguous',
      pids: [101, 202],
    });
  });

  it('accepts a re-report from the PID that already owns the session', () => {
    const claims = new Map([[101, session(101, 'session-1')]]);

    expect(resolveSessionClaim(claims, 'session-1', 101, () => 'alive')).toEqual({ type: 'accepted' });
    expect(claims).toHaveLength(1);
  });
});

// F2: resolveSessionClaim skipped any entry sharing the reporting PID without
// checking its session id, so a webhook reporting a DIFFERENT session id for a
// PID that already owned one was accepted, and the webhook handler then
// overwrote the live claim's id/metadata/encryption. The original session lost
// its live claimant and became duplicate-resumable while still running.
// hostPid is untrusted input from an unauthenticated control server.
describe('same-PID re-reports must prove the session id too', () => {
  it('rejects a same-PID webhook that reports a different session id', () => {
    const claims = new Map([[101, session(101, 'session-A')]]);

    expect(resolveWebhookSessionClaim(claims, 'session-B', 101, () => 'alive')).toEqual({
      type: 'rejected',
      claimantPids: [101],
    });
    // The real session A must still own the claim, untouched.
    expect(claims.get(101)?.happySessionId).toBe('session-A');
  });

  it('still accepts a same-PID re-report of the same session id as handoff', () => {
    const claims = new Map([[101, session(101, 'session-A')]]);

    expect(resolveWebhookSessionClaim(claims, 'session-A', 101, () => 'alive'))
      .toEqual({ type: 'accepted' });
  });

  // The daemon sets a placeholder with no happySessionId at spawn time and the
  // webhook fills it in. That flow must keep working.
  it('accepts a webhook for a daemon placeholder that has no session id yet', () => {
    const claims = new Map<number, TrackedSession>([
      [101, { pid: 101, startedBy: 'daemon' }],
    ]);

    expect(resolveWebhookSessionClaim(claims, 'session-A', 101, () => 'alive'))
      .toEqual({ type: 'accepted' });
  });
});
