import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireDaemonLock, releaseDaemonLock, SandboxConfigSchema, writeDaemonState } from './persistence';

const mockConfiguration = vi.hoisted(() => ({
    daemonLockFile: '',
    daemonStateFile: '',
    isDaemonProcess: false,
    logsDir: '/tmp',
    sessionsFile: '',
}));

vi.mock('@/configuration', () => ({
    configuration: mockConfiguration,
}));

describe('SandboxConfigSchema', () => {
    it('applies defaults when values are omitted', () => {
        const parsed = SandboxConfigSchema.parse({});

        expect(parsed).toEqual({
            enabled: false,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: ['~/.ssh', '~/.aws', '~/.gnupg'],
            extraWritePaths: ['/tmp'],
            denyWritePaths: ['.env'],
            networkMode: 'allowed',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: true,
        });
    });

    it('accepts a fully custom valid sandbox config', () => {
        const parsed = SandboxConfigSchema.parse({
            enabled: true,
            workspaceRoot: '~/projects',
            sessionIsolation: 'custom',
            customWritePaths: ['~/projects/foo', '/var/tmp'],
            denyReadPaths: ['~/.ssh'],
            extraWritePaths: ['/tmp', '/private/tmp'],
            denyWritePaths: ['.env', '.secrets'],
            networkMode: 'custom',
            allowedDomains: ['api.openai.com', '*.github.com'],
            deniedDomains: ['tracking.example.com'],
            allowLocalBinding: false,
        });

        expect(parsed.enabled).toBe(true);
        expect(parsed.workspaceRoot).toBe('~/projects');
        expect(parsed.sessionIsolation).toBe('custom');
        expect(parsed.networkMode).toBe('custom');
        expect(parsed.allowedDomains).toEqual(['api.openai.com', '*.github.com']);
        expect(parsed.allowLocalBinding).toBe(false);
    });

    it('rejects invalid enum values', () => {
        expect(() =>
            SandboxConfigSchema.parse({
                sessionIsolation: 'invalid',
            }),
        ).toThrow();

        expect(() =>
            SandboxConfigSchema.parse({
                networkMode: 'invalid',
            }),
        ).toThrow();
    });

    it('rejects invalid field types', () => {
        expect(() =>
            SandboxConfigSchema.parse({
                allowLocalBinding: 'yes',
            }),
        ).toThrow();

        expect(() =>
            SandboxConfigSchema.parse({
                denyReadPaths: [123],
            }),
        ).toThrow();
    });
});

describe('acquireDaemonLock', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'happy-daemon-lock-'));
        mockConfiguration.daemonLockFile = join(testDir, 'daemon.state.json.lock');
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it.each([
        ['empty', ''],
        ['non-numeric', 'not-a-pid'],
        ['zero-pid', '0'],
    ])('treats a %s lock file as stale and acquires a fresh lock', async (_label, lockContent) => {
        writeFileSync(mockConfiguration.daemonLockFile, lockContent, 'utf-8');

        // Lock creation is atomic including the PID payload (temp file +
        // hard link), so a payload-less lock can never belong to a live
        // acquirer and is reclaimed on first sight.
        const lockHandle = await acquireDaemonLock(2, 0);

        expect(lockHandle).not.toBeNull();
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(process.pid));
        await releaseDaemonLock(lockHandle!);
        expect(existsSync(mockConfiguration.daemonLockFile)).toBe(false);
    });

    it('creates the lock with its PID payload atomically (no temp file left behind)', async () => {
        const lockHandle = await acquireDaemonLock(1, 0);

        expect(lockHandle).not.toBeNull();
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(process.pid));
        expect(existsSync(`${mockConfiguration.daemonLockFile}.${process.pid}.tmp`)).toBe(false);
        await releaseDaemonLock(lockHandle!);
    });

    it('does not clear a lock held by a live process', async () => {
        writeFileSync(mockConfiguration.daemonLockFile, String(process.pid), 'utf-8');

        const lockHandle = await acquireDaemonLock(1, 0);

        expect(lockHandle).toBeNull();
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(process.pid));
    });
});

describe('writeDaemonState', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'happy-daemon-state-'));
        mockConfiguration.daemonStateFile = join(testDir, 'daemon.state.json');
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    const daemonState = {
        pid: process.pid,
        httpPort: 12345,
        startTime: 'now',
        startedWithCliVersion: 'test',
        controlToken: 'token',
    };

    it('writes a freshly created daemon state file as 0600', () => {
        writeDaemonState(daemonState);

        expect(statSync(mockConfiguration.daemonStateFile).mode & 0o777).toBe(0o600);
    });

    it('tightens a pre-existing daemon state file to 0600', () => {
        writeFileSync(mockConfiguration.daemonStateFile, '{}', { mode: 0o644 });
        expect(statSync(mockConfiguration.daemonStateFile).mode & 0o777).toBe(0o644);

        writeDaemonState(daemonState);

        expect(statSync(mockConfiguration.daemonStateFile).mode & 0o777).toBe(0o600);
    });
});
