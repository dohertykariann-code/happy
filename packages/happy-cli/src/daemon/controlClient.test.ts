import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearDaemonState: vi.fn(),
  readDaemonState: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  clearDaemonState: mocks.clearDaemonState,
  readDaemonState: mocks.readDaemonState,
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: mocks.loggerDebug },
}));

vi.mock('@/configuration', () => ({
  configuration: { currentCliVersion: 'test' },
}));

import { checkIfDaemonRunningAndCleanupStaleState } from './controlClient';

describe('daemon control client health checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readDaemonState.mockResolvedValue({
      pid: process.pid,
      httpPort: 12345,
      startTime: 'now',
      startedWithCliVersion: 'test',
      controlToken: 'control-token',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('treats a 401 as proof that the control server is the daemon and includes its token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/list',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer control-token' }),
      }),
    );
    expect(mocks.clearDaemonState).not.toHaveBeenCalled();
  });
});
