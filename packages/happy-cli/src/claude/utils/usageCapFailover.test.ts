import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
    CLAUDE_SESSION_RECAP_SCRIPT,
    buildUsageCapFailoverPrompt,
    getUsageCapFailoverConfig,
    isClaudeUsageCapExhausted,
    readClaudeSessionRecap,
    withoutClaudeResumeArgs,
} from './usageCapFailover';

describe('usage-cap failover', () => {
    const env = {
        HAPPY_FAILOVER_FROM_CONFIG_DIR: '/configs/primary',
        HAPPY_FAILOVER_TO_CONFIG_DIR: '/configs/fallback',
    };

    it('is disabled when either failover environment variable is unset', () => {
        expect(getUsageCapFailoverConfig('/configs/primary', {})).toBeNull();
        expect(getUsageCapFailoverConfig('/configs/primary', {
            HAPPY_FAILOVER_FROM_CONFIG_DIR: '/configs/primary',
        })).toBeNull();
    });

    it('is disabled unless the resolved session config directory exactly matches FROM', () => {
        expect(getUsageCapFailoverConfig('/configs/other', env)).toBeNull();
        expect(getUsageCapFailoverConfig('/configs/primary/', env)).toBeNull();
    });

    it('recognizes only clear usage-cap exhaustion messages', () => {
        expect(isClaudeUsageCapExhausted(new Error(USAGE_LIMIT_ERROR_PREFIXES[0] + ' 5-hour limit. Upgrade for more usage.'))).toBe(true);
        expect(isClaudeUsageCapExhausted(new Error(USAGE_LIMIT_ERROR_PREFIXES[1] + ' weekly limit. Resets Monday.'))).toBe(true);
        expect(isClaudeUsageCapExhausted({ message: "You're out of usage credits for this billing period." })).toBe(true);
        expect(isClaudeUsageCapExhausted(new Error('socket hang up'))).toBe(false);
        expect(isClaudeUsageCapExhausted({ status: 429, message: 'temporarily rate limited' })).toBe(false);
        expect(isClaudeUsageCapExhausted(new Error(''))).toBe(false);
        expect(isClaudeUsageCapExhausted(undefined)).toBe(false);
    });

    it('runs the established recap script scoped to the failed session, not the newest transcript', async () => {
        const run = vi.fn().mockResolvedValue({ stdout: 'Latest work\n' });

        await expect(readClaudeSessionRecap('/configs/primary', 'claude-session-id', run)).resolves.toBe('Latest work');
        expect(run).toHaveBeenCalledWith(process.execPath, [
            CLAUDE_SESSION_RECAP_SCRIPT,
            '--config-dir',
            '/configs/primary',
            '--n',
            '10',
            '--session',
            'claude-session-id',
        ], { maxBuffer: 1024 * 1024 });
    });

    it('skips the recap entirely without a session id, rather than risk reading an unrelated session', async () => {
        const run = vi.fn();

        await expect(readClaudeSessionRecap('/configs/primary', null, run)).resolves.toBe('');
        expect(run).not.toHaveBeenCalled();
    });

    it('builds a fresh-session prompt and removes resume-only arguments', () => {
        expect(buildUsageCapFailoverPrompt('The last turn')).toContain('The primary account hit its usage cap.');
        expect(withoutClaudeResumeArgs(['--resume', 'session-id', '--verbose', '--continue'])).toEqual(['--verbose']);
    });
});
