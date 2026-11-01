import { describe, expect, it } from 'vitest';
import { redactDaemonStateForDisplay } from './doctor';

describe('redactDaemonStateForDisplay', () => {
    it('replaces a present control token with a placeholder, not the real value', () => {
        const state = {
            pid: 123,
            httpPort: 4567,
            startTime: '2026-11-01T12:00:00.000Z',
            startedWithCliVersion: '1.2.6',
            controlToken: 'super-secret-value',
        };

        const redacted = redactDaemonStateForDisplay(state);

        expect(redacted.controlToken).toBe('<redacted>');
        expect(JSON.stringify(redacted)).not.toContain('super-secret-value');
    });

    it('leaves every other field untouched', () => {
        const state = {
            pid: 123,
            httpPort: 4567,
            startTime: '2026-11-01T12:00:00.000Z',
            startedWithCliVersion: '1.2.6',
            lastHeartbeat: '2026-11-01T12:01:00.000Z',
            daemonLogPath: '/tmp/daemon.log',
            controlToken: 'super-secret-value',
        };

        const redacted = redactDaemonStateForDisplay(state);

        expect(redacted).toEqual({ ...state, controlToken: '<redacted>' });
    });

    it('does not invent a token when none is present', () => {
        const state = {
            pid: 123,
            httpPort: 4567,
            startTime: '2026-11-01T12:00:00.000Z',
            startedWithCliVersion: '1.2.6',
        };

        expect(redactDaemonStateForDisplay(state).controlToken).toBeUndefined();
    });
});
