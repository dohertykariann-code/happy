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
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

import { claudeRemoteLauncher } from './claudeRemoteLauncher';

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
        expect(mockReadClaudeSessionRecap).toHaveBeenCalledWith('/configs/primary');
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
});
