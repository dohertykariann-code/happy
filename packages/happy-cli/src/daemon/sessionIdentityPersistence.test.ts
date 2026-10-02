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
