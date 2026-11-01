import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClaudeRemote, mockReadClaudeSessionRecap } = vi.hoisted(() => ({
    mockClaudeRemote: vi.fn(),
    mockReadClaudeSessionRecap: vi.fn(),
}));

vi.mock('./claudeRemote', () => ({ claudeRemote: mockClaudeRemote }));
vi.mock('./utils/usageCapFailover', async (importOriginal) => ({
    ...await importOriginal<typeof import('./utils/usageCapFailover')>(),
    readClaudeSessionRecap: mockReadClaudeSessionRecap,
}));
vi.mock('ink', () => ({ render: vi.fn() }));
vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('@/ui/messageFormatterInk', () => ({ formatClaudeMessageForInk: vi.fn() }));
vi.mock('@/utils/terminalStdinCleanup', () => ({ cleanupStdinAfterInk: vi.fn() }));
vi.mock('node:child_process', () => ({ execSync: () => 'fixture-branch', execFile: vi.fn() }));
vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class {
        reset = vi.fn();
        setOnPermissionRequest = vi.fn();
        getResponseLookup = () => new Map();
        handleToolCall = vi.fn();
        handleModeChange = vi.fn();
    },
}));

import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import { closeClaudeTurnWithStatus, mapClaudeLogMessageToSessionEnvelopes, type ClaudeSessionProtocolState } from './utils/sessionProtocolMapper';
import { CLAUDE_LOGIN_EXPIRED_MESSAGE } from './utils/providerAuth';
import type { SessionEnvelope } from '@slopus/happy-wire';

// Exercise the real outgoing queue, SDK converter and protocol mapper without
// a terminal, credential store, provider process, relay or push service.
function fixture() {
    const handlers = new Map<string, () => Promise<void>>();
    const state: ClaudeSessionProtocolState = { currentTurnId: null };
    const envelopes: SessionEnvelope[] = [];
    const session = {
        sessionId: 'fixture-session', path: '/fixture/project', hookSettingsPath: '/fixture/settings.json',
        queue: { size: () => 0 },
        consumeOneTimeFlags: vi.fn(),
        api: { push: () => ({ sendSessionNotification: notification }) },
        client: {
            sessionId: 'fixture-happy-session',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<void>) => handlers.set(name, handler) },
            getMetadata: () => ({}),
            sendSessionEvent: vi.fn(),
            sendClaudeSessionMessage: vi.fn((message) => {
                const mapped = mapClaudeLogMessageToSessionEnvelopes(message, state);
                state.currentTurnId = mapped.currentTurnId;
                envelopes.push(...mapped.envelopes);
            }),
            closeClaudeSessionTurn: vi.fn((status) => {
                const mapped = closeClaudeTurnWithStatus(state, status);
                state.currentTurnId = mapped.currentTurnId;
                envelopes.push(...mapped.envelopes);
            }),
        },
    };
    const notification = vi.fn();
    const stop = () => { void handlers.get('switch')!(); };
    return { session, state, envelopes, notification, stop };
}

describe('claudeRemoteLauncher provider auth', () => {
    beforeEach(() => { mockClaudeRemote.mockReset(); });

    it('flushes back-to-back auth output before closing the failed wire turn, without a done push', async () => {
        const { session, state, envelopes, notification, stop } = fixture();
        let eventsAtReady: string[] = [];
        let turnAtReady: string | null | undefined;
        mockClaudeRemote.mockImplementation(async (opts: any) => {
            opts.onCompletionEvent?.(CLAUDE_LOGIN_EXPIRED_MESSAGE);
            opts.onMessage({
                type: 'assistant', error: 'authentication_failed', parent_tool_use_id: null,
                message: { role: 'assistant', content: [{ type: 'text', text: 'Provider login failed' }] },
            } as any);
            await opts.onReady('failed');
            // Verify before cleanup's final flush can hide incorrect ordering.
            eventsAtReady = envelopes.map(envelope => envelope.ev.t);
            turnAtReady = state.currentTurnId;
            stop();
        });
        await claudeRemoteLauncher(session as any);
        expect(eventsAtReady).toEqual(['turn-start', 'text', 'turn-end']);
        expect(envelopes.at(-1)?.ev).toEqual({ t: 'turn-end', status: 'failed' });
        expect(turnAtReady).toBeNull();
        expect(notification).not.toHaveBeenCalled();
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: CLAUDE_LOGIN_EXPIRED_MESSAGE });
        expect(envelopes.filter(envelope => envelope.ev.t === 'turn-end')).toHaveLength(1);
    });

    it('shows untruncated host-login guidance for a thrown OAuth error and accepts a later invocation', async () => {
        const { session, notification, stop } = fixture();
        mockClaudeRemote
            .mockRejectedValueOnce(new Error('Failed to authenticate: OAuth session expired and could not be refreshed\nhttps://fixture-secret@example.invalid'))
            .mockImplementationOnce(async () => { stop(); });
        await claudeRemoteLauncher(session as any);
        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('failed');
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: CLAUDE_LOGIN_EXPIRED_MESSAGE });
        expect(JSON.stringify(session.client.sendSessionEvent.mock.calls)).not.toContain('fixture-secret');
        expect(notification).not.toHaveBeenCalled();
        expect(mockClaudeRemote).toHaveBeenCalledTimes(2);
    });
});

function createSession(configDir: string) {
    const handlers = new Map<string, () => Promise<void>>();
    return {
        sessionId: 'primary-session', path: '/tmp/project', logPath: '/tmp/happy.log',
        claudeEnvVars: { CLAUDE_CONFIG_DIR: configDir }, claudeArgs: ['--resume', 'primary-session', '--verbose'],
        allowedTools: [], mcpServers: {}, hookSettingsPath: '/tmp/hook-settings.json', jsRuntime: 'node',
        client: { closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(), sendClaudeSessionMessage: vi.fn(), getMetadata: vi.fn(() => ({})), updateMetadata: vi.fn(), updateAgentState: vi.fn(), rpcHandlerManager: { registerHandler: vi.fn((name: string, handler: () => Promise<void>) => handlers.set(name, handler)) } },
        api: { push: vi.fn(() => ({ sendSessionNotification: vi.fn() })) }, queue: { size: vi.fn(() => 0), waitForMessagesAndGetAsString: vi.fn() },
        onAbort: vi.fn(), onSessionFound: vi.fn(), onThinkingChange: vi.fn(), clearSessionId: vi.fn(function (this: { sessionId: string | null }) { this.sessionId = null; }), consumeOneTimeFlags: vi.fn(), switch: () => handlers.get('switch')!(),
    };
}

describe('claudeRemoteLauncher usage-cap failover', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('HAPPY_FAILOVER_FROM_CONFIG_DIR', '/configs/primary');
        vi.stubEnv('HAPPY_FAILOVER_TO_CONFIG_DIR', '/configs/fallback');
        mockReadClaudeSessionRecap.mockResolvedValue('Primary recap');
    });
    afterEach(() => vi.unstubAllEnvs());

    it('starts a fresh fallback session with the recap after a matching usage cap', async () => {
        const session = createSession('/configs/primary');
        let fallbackOptions: any;
        mockClaudeRemote.mockRejectedValueOnce(new Error('Claude usage limit reached')).mockImplementationOnce(async (options) => {
            fallbackOptions = options;
            const initial = await options.nextMessage();
            expect(initial.message).toContain('Primary recap');
            options.onSessionFound('fallback-session');
            void session.switch();
        });
        await expect(claudeRemoteLauncher(session as any)).resolves.toBe('switch');
        expect(mockReadClaudeSessionRecap).toHaveBeenCalledWith('/configs/primary', 'primary-session');
        expect(fallbackOptions.sessionId).toBeNull();
        expect(fallbackOptions.claudeEnvVars).toEqual({ CLAUDE_CONFIG_DIR: '/configs/fallback' });
        expect(fallbackOptions.claudeArgs).toEqual(['--verbose']);
        expect(session.clearSessionId).toHaveBeenCalledOnce();
    });

    it('does not fail over for an unrelated launcher error', async () => {
        const session = createSession('/configs/primary');
        mockClaudeRemote.mockImplementationOnce(async () => { void session.switch(); throw new Error('socket hang up'); });
        await expect(claudeRemoteLauncher(session as any)).resolves.toBe('switch');
        expect(mockReadClaudeSessionRecap).not.toHaveBeenCalled();
        expect(session.clearSessionId).not.toHaveBeenCalled();
    });

    it('restores process.env.CLAUDE_CONFIG_DIR to its prior state once the launcher returns, instead of leaking it daemon-wide', async () => {
        const session = createSession('/configs/primary');
        const hadOriginal = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CONFIG_DIR');
        const originalValue = process.env.CLAUDE_CONFIG_DIR;
        delete process.env.CLAUDE_CONFIG_DIR;
        mockClaudeRemote.mockRejectedValueOnce(new Error('Claude usage limit reached')).mockImplementationOnce(async (options) => {
            await options.nextMessage();
            options.onSessionFound('fallback-session');
            void session.switch();
        });
        try {
            await expect(claudeRemoteLauncher(session as any)).resolves.toBe('switch');
            expect(Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CONFIG_DIR')).toBe(false);
        } finally {
            if (hadOriginal) process.env.CLAUDE_CONFIG_DIR = originalValue!;
        }
    });
});
