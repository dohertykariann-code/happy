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
  it('rejects an untracked duplicate webhook without calling its terminator', () => {
    const claims = new Map([[101, session(101, 'session-1')]]);
    const terminate = vi.fn();

    expect(resolveWebhookSessionClaim(claims, 'session-1', 202, () => 'alive', terminate)).toEqual({
      type: 'rejected',
      claimantPids: [101],
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it.each([-1, 0, 12.5, '202'])('rejects invalid webhook hostPid %j explicitly without calling its terminator', (hostPid) => {
    const terminate = vi.fn();

    expect(resolveWebhookSessionClaim(new Map(), 'session-1', hostPid, () => 'alive', terminate)).toEqual({
      type: 'invalid-pid',
      hostPid,
    });
    expect(terminate).not.toHaveBeenCalled();
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
