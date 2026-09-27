import { describe, expect, it } from 'vitest';
import {
    buildSessionChildEnvironment,
    sanitizeSessionEnvironment,
    SESSION_SCOPED_ENV_KEYS,
    sessionEnvironmentKeysToUnset,
    wrapTmuxCommandWithSessionEnvironmentSanitizer,
} from './sessionEnvironment';

function contaminatedEnvironment(): NodeJS.ProcessEnv {
    return {
        KEEP_ME: 'safe',
        ...Object.fromEntries(SESSION_SCOPED_ENV_KEYS.map((key) => [key, `stale-${key}`])),
    };
}

describe('sessionEnvironment', () => {
    it('removes all inherited session-scoped values without mutating the source', () => {
        const source = contaminatedEnvironment();

        const sanitized = sanitizeSessionEnvironment(source);

        expect(sanitized).toMatchObject({ KEEP_ME: 'safe' });
        for (const key of SESSION_SCOPED_ENV_KEYS) {
            expect(sanitized).not.toHaveProperty(key);
            expect(source[key]).toBe(`stale-${key}`);
        }
    });

    it('keeps explicit fork values after removing stale ambient values', () => {
        const childEnv = buildSessionChildEnvironment(contaminatedEnvironment(), {
            HAPPY_FORKED_FROM_SESSION_ID: 'new-parent-session',
            HAPPY_FORKED_FROM_MESSAGE_ID: 'new-parent-message',
            HAPPY_FORK_CODEX_THREAD_ID: 'new-codex-thread',
            HAPPY_SIDE_CHAT: '1',
        });

        expect(childEnv).toMatchObject({
            KEEP_ME: 'safe',
            HAPPY_FORKED_FROM_SESSION_ID: 'new-parent-session',
            HAPPY_FORKED_FROM_MESSAGE_ID: 'new-parent-message',
            HAPPY_FORK_CODEX_THREAD_ID: 'new-codex-thread',
            HAPPY_SIDE_CHAT: '1',
        });
        expect(childEnv).not.toHaveProperty('CODEX_THREAD_ID');
        expect(childEnv).not.toHaveProperty('HAPPY_RECONNECT_SESSION_ID');
    });

    it('replaces stale reconnect state with the values for the resumed session', () => {
        const childEnv = buildSessionChildEnvironment(contaminatedEnvironment(), {
            HAPPY_RECONNECT_SESSION_ID: 'new-session',
            HAPPY_RECONNECT_ENCRYPTION_KEY: 'new-key',
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'dataKey',
            HAPPY_RECONNECT_SEQ: '12',
            HAPPY_RECONNECT_METADATA_VERSION: '13',
            HAPPY_RECONNECT_AGENT_STATE_VERSION: '14',
        });

        expect(childEnv).toMatchObject({
            HAPPY_RECONNECT_SESSION_ID: 'new-session',
            HAPPY_RECONNECT_ENCRYPTION_KEY: 'new-key',
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'dataKey',
            HAPPY_RECONNECT_SEQ: '12',
            HAPPY_RECONNECT_METADATA_VERSION: '13',
            HAPPY_RECONNECT_AGENT_STATE_VERSION: '14',
        });
        expect(childEnv).not.toHaveProperty('HAPPY_FORK_CODEX_THREAD_ID');
        expect(childEnv).not.toHaveProperty('CODEX_THREAD_ID');
    });

    it('unsets inherited tmux values without removing an explicit fork value', () => {
        const explicitEnv = { HAPPY_FORK_CODEX_THREAD_ID: 'new-codex-thread' };
        const keysToUnset = sessionEnvironmentKeysToUnset(explicitEnv);
        const command = wrapTmuxCommandWithSessionEnvironmentSanitizer('node happy.mjs codex', explicitEnv);

        expect(keysToUnset).not.toContain('HAPPY_FORK_CODEX_THREAD_ID');
        expect(keysToUnset).toContain('CODEX_THREAD_ID');
        expect(command).toMatch(/^unset /);
        expect(command).toContain('CODEX_THREAD_ID');
        expect(command).not.toContain('unset HAPPY_FORK_CODEX_THREAD_ID');
        expect(command).toMatch(/node happy\.mjs codex$/);
    });

    it('unsets an OpenHands-launch host secret a tmux server may already carry', () => {
        // Simulates a tmux server whose default environment predates this
        // launch and still has the daemon's host-only DeepInfra key, which
        // `new-window -e` cannot remove because it only sets/overrides keys,
        // it never unsets ones the launch omits.
        const explicitEnv = { LLM_API_KEY: 'scoped-child-key' };
        const keysToUnset = sessionEnvironmentKeysToUnset(explicitEnv, ['DEEPINFRA_API_KEY']);
        const command = wrapTmuxCommandWithSessionEnvironmentSanitizer(
            'node happy.mjs acp openhands',
            explicitEnv,
            ['DEEPINFRA_API_KEY'],
        );

        expect(keysToUnset).toContain('DEEPINFRA_API_KEY');
        expect(command).toContain('unset ');
        expect(command).toContain('DEEPINFRA_API_KEY');
        expect(command).toMatch(/node happy\.mjs acp openhands$/);
    });

    it('keeps a launch-supplied DEEPINFRA_API_KEY instead of unsetting it', () => {
        const explicitEnv = { DEEPINFRA_API_KEY: 'explicit-value' };
        const keysToUnset = sessionEnvironmentKeysToUnset(explicitEnv, ['DEEPINFRA_API_KEY']);

        expect(keysToUnset).not.toContain('DEEPINFRA_API_KEY');
    });
});
