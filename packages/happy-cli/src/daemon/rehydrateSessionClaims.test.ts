import { describe, it, expect } from 'vitest';
import { rehydrateLiveSessionClaims, REHYDRATED_STARTED_BY } from './rehydrateSessionClaims';
import { resolveWebhookSessionClaim, type ProcessLiveness } from './sessionClaims';

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
