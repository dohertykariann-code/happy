import { describe, expect, it } from 'vitest';

import { findTrackedSessionById, resolveSessionClaim } from './sessionClaims';
import { TrackedSession } from './types';

function session(pid: number, happySessionId: string): TrackedSession {
  return { pid, happySessionId, startedBy: 'terminal' };
}

describe('session claim resolution', () => {
  it('rejects a second live PID claiming the same session ID', () => {
    const claims = new Map([[101, session(101, 'session-1')]]);

    expect(resolveSessionClaim(claims, 'session-1', 202, pid => pid === 101)).toEqual({
      type: 'rejected',
      claimantPids: [101],
    });
    expect(claims).toHaveLength(1);
  });

  it('releases a dead claim before accepting a replacement PID', () => {
    const claims = new Map([[101, session(101, 'session-1')]]);

    expect(resolveSessionClaim(claims, 'session-1', 202, () => false)).toEqual({ type: 'accepted' });
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

    expect(resolveSessionClaim(claims, 'session-1', 101, () => true)).toEqual({ type: 'accepted' });
    expect(claims).toHaveLength(1);
  });
});
