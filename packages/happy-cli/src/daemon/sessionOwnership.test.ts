import { describe, expect, it } from 'vitest';

import {
  isValidPersistedOwner,
  describeProcessOwner,
  readProcessStartTime,
  restorePersistedClaims,
  selectRestorableClaims,
  verifyOwner,
} from './sessionOwnership';
import { TrackedSession } from './types';

const OWNER = { pid: 4242, startedAt: 'Thu Oct  1 15:59:11 2026' };

describe('verifyOwner', () => {
  it('reports same when the start time still matches the recorded owner', () => {
    expect(verifyOwner(OWNER, () => OWNER.startedAt)).toBe('same');
  });

  // The whole reason a bare PID cannot be persisted. The OS may hand 4242 to an
  // unrelated process after a reboot; restoring that as a live claim would let a
  // stranger's process permanently block a resume of this session id.
  it('reports reused when the PID exists but started at a different time', () => {
    expect(verifyOwner(OWNER, () => 'Thu Oct  1 16:40:02 2026')).toBe('reused');
  });

  it('reports gone when no process holds the PID', () => {
    expect(verifyOwner(OWNER, () => undefined)).toBe('gone');
  });

  it('reports unknown when the start time cannot be read at all', () => {
    expect(verifyOwner(OWNER, () => { throw new Error('ps unavailable'); })).toBe('unknown');
  });
});

describe('isValidPersistedOwner', () => {
  it('accepts a well-formed owner', () => {
    expect(isValidPersistedOwner(OWNER)).toBe(true);
  });

  it.each([
    undefined,
    null,
    {},
    { pid: 0, startedAt: 'x' },
    { pid: -1, startedAt: 'x' },
    { pid: 12.5, startedAt: 'x' },
    { pid: '4242', startedAt: 'x' },
    { pid: 4242, startedAt: '' },
    { pid: 4242, startedAt: '   ' },
    { pid: 4242, startedAt: 123 },
  ])('rejects malformed owner %j', (owner) => {
    expect(isValidPersistedOwner(owner)).toBe(false);
  });
});

describe('selectRestorableClaims', () => {
  it('restores a session whose owner process is provably the same one', () => {
    const result = selectRestorableClaims(
      { 'session-1': OWNER },
      () => OWNER.startedAt,
    );

    expect(result.restore).toEqual([{ sessionId: 'session-1', pid: 4242 }]);
    expect(result.dropped).toEqual([]);
  });

  it('drops a reused PID instead of restoring it', () => {
    const result = selectRestorableClaims(
      { 'session-1': OWNER },
      () => 'Thu Oct  1 16:40:02 2026',
    );

    expect(result.restore).toEqual([]);
    expect(result.dropped).toEqual([{ sessionId: 'session-1', reason: 'reused' }]);
  });

  it('drops an exited owner so the session can be resumed', () => {
    const result = selectRestorableClaims({ 'session-1': OWNER }, () => undefined);

    expect(result.restore).toEqual([]);
    expect(result.dropped).toEqual([{ sessionId: 'session-1', reason: 'gone' }]);
  });

  // Degrade to the pre-persistence behaviour rather than inventing a claim we
  // cannot verify: an unverifiable restore would block resume across every
  // future restart, which is worse and harder to diagnose than a duplicate.
  it('restores nothing when ownership cannot be verified', () => {
    const result = selectRestorableClaims(
      { 'session-1': OWNER },
      () => { throw new Error('ps unavailable'); },
    );

    expect(result.restore).toEqual([]);
    expect(result.dropped).toEqual([{ sessionId: 'session-1', reason: 'unknown' }]);
  });

  it('ignores malformed owner records on disk', () => {
    const result = selectRestorableClaims(
      { 'session-1': { pid: -1, startedAt: '' } as unknown as typeof OWNER },
      () => OWNER.startedAt,
    );

    expect(result.restore).toEqual([]);
    expect(result.dropped).toEqual([{ sessionId: 'session-1', reason: 'malformed' }]);
  });

  // A corrupted store must not reproduce the very bug this fixes by mapping two
  // session ids onto one process.
  it('refuses to restore two sessions claiming the same PID', () => {
    const result = selectRestorableClaims(
      { 'session-1': OWNER, 'session-2': { ...OWNER } },
      () => OWNER.startedAt,
    );

    expect(result.restore).toEqual([]);
    expect(result.dropped).toEqual([
      { sessionId: 'session-1', reason: 'conflicting' },
      { sessionId: 'session-2', reason: 'conflicting' },
    ]);
  });
});

describe('readProcessStartTime', () => {
  it('reads a start time for a process that exists', () => {
    const startedAt = readProcessStartTime(process.pid);

    expect(typeof startedAt).toBe('string');
    expect(startedAt!.trim().length).toBeGreaterThan(0);
  });

  it('returns the same value on repeated reads, so it works as an identity', () => {
    expect(readProcessStartTime(process.pid)).toBe(readProcessStartTime(process.pid));
  });

  it('distinguishes two different live processes', () => {
    expect(readProcessStartTime(process.pid)).not.toBe(readProcessStartTime(1));
  });

  it('returns undefined for a PID no process holds', () => {
    expect(readProcessStartTime(999_999)).toBeUndefined();
  });

  it('round-trips through verifyOwner against a real live process', () => {
    const owner = { pid: process.pid, startedAt: readProcessStartTime(process.pid)! };

    expect(verifyOwner(owner, readProcessStartTime)).toBe('same');
    expect(verifyOwner({ ...owner, startedAt: 'not when it started' }, readProcessStartTime))
      .toBe('reused');
    expect(verifyOwner({ ...owner, pid: 999_999 }, readProcessStartTime)).toBe('gone');
  });
});

describe('describeProcessOwner', () => {
  it('describes a live process as a persistable owner', () => {
    expect(describeProcessOwner(process.pid)).toEqual({
      pid: process.pid,
      startedAt: readProcessStartTime(process.pid),
    });
  });

  it('returns undefined for a PID no process holds', () => {
    expect(describeProcessOwner(999_999)).toBeUndefined();
  });

  // Persisting nothing degrades to the old behaviour for that one session.
  // Persisting a PID with an unreadable start time would create exactly the
  // unfalsifiable record this module exists to avoid.
  it('returns undefined rather than a PID-only owner when the probe is broken', () => {
    expect(describeProcessOwner(process.pid, () => { throw new Error('ps unavailable'); }))
      .toBeUndefined();
  });
});

describe('restorePersistedClaims (the boot path itself)', () => {
  const startedAt = 'Thu Oct  1 15:59:11 2026';

  function persistedRecord(pid: number) {
    return {
      owner: { pid, startedAt },
      encryptionKey: 'a2V5',
      encryptionVariant: 'dataKey' as const,
      seq: 7,
      metadataVersion: 2,
      agentStateVersion: 3,
      metadata: { flavor: 'claude' } as never,
      savedAt: Date.now(),
    };
  }

  function finished(sessionId: string): TrackedSession {
    return {
      startedBy: 'persisted',
      happySessionId: sessionId,
      happySessionMetadataFromLocalWebhook: { flavor: 'claude' } as never,
      pid: 0,
    };
  }

  it('puts a still-running session back into the live claim registry', () => {
    const live = new Map<number, TrackedSession>();
    const finishedSessions = new Map([['session-1', finished('session-1')]]);

    const dropped = restorePersistedClaims({
      persisted: { 'session-1': persistedRecord(4242) },
      sessionIdToFinishedSession: finishedSessions,
      pidToTrackedSession: live,
      readStartTime: () => startedAt,
    });

    expect(dropped).toEqual([]);
    expect(live.get(4242)?.happySessionId).toBe('session-1');
    expect(live.get(4242)?.pid).toBe(4242);
  });

  // The trap: resumeSession deletes the claim when the owner has exited and then
  // resumes from THIS object, so a bare {pid, happySessionId} would turn a
  // working resume into "has no metadata. Cannot resume."
  it('carries the persisted metadata onto the restored claim', () => {
    const live = new Map<number, TrackedSession>();

    restorePersistedClaims({
      persisted: { 'session-1': persistedRecord(4242) },
      sessionIdToFinishedSession: new Map([['session-1', finished('session-1')]]),
      pidToTrackedSession: live,
      readStartTime: () => startedAt,
    });

    expect(live.get(4242)?.happySessionMetadataFromLocalWebhook).toBeDefined();
  });

  it('leaves the registry empty when the PID was reused by another process', () => {
    const live = new Map<number, TrackedSession>();

    const dropped = restorePersistedClaims({
      persisted: { 'session-1': persistedRecord(4242) },
      sessionIdToFinishedSession: new Map([['session-1', finished('session-1')]]),
      pidToTrackedSession: live,
      readStartTime: () => 'a completely different start time',
    });

    expect(live.size).toBe(0);
    expect(dropped).toEqual([{ sessionId: 'session-1', reason: 'reused' }]);
  });

  it('skips a claim with no matching persisted session record', () => {
    const live = new Map<number, TrackedSession>();

    restorePersistedClaims({
      persisted: { 'session-1': persistedRecord(4242) },
      sessionIdToFinishedSession: new Map(),
      pidToTrackedSession: live,
      readStartTime: () => startedAt,
    });

    expect(live.size).toBe(0);
  });

  it('restores nothing when a session was persisted without an owner', () => {
    const live = new Map<number, TrackedSession>();
    const { owner, ...withoutOwner } = persistedRecord(4242);

    const dropped = restorePersistedClaims({
      persisted: { 'session-1': withoutOwner },
      sessionIdToFinishedSession: new Map([['session-1', finished('session-1')]]),
      pidToTrackedSession: live,
      readStartTime: () => startedAt,
    });

    expect(live.size).toBe(0);
    expect(dropped).toEqual([{ sessionId: 'session-1', reason: 'malformed' }]);
  });
});
