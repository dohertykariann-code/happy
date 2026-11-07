import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk';

export const CLAUDE_SESSION_RECAP_SCRIPT = '/Users/karidoherty/.claude/c-suite/scripts/claude-session-recap.mjs';

const execFileAsync = promisify(execFile);

export interface UsageCapFailoverConfig {
    fromConfigDir: string;
    toConfigDir: string;
}

type RecapCommand = (
    file: string,
    args: string[],
    options: { maxBuffer: number },
) => Promise<{ stdout: string }>;

export function getUsageCapFailoverConfig(
    currentConfigDir: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
): UsageCapFailoverConfig | null {
    const fromConfigDir = env.HAPPY_FAILOVER_FROM_CONFIG_DIR;
    const toConfigDir = env.HAPPY_FAILOVER_TO_CONFIG_DIR;
    if (!fromConfigDir || !toConfigDir || currentConfigDir !== fromConfigDir) {
        return null;
    }
    return { fromConfigDir, toConfigDir };
}

export function isClaudeUsageCapExhausted(error: unknown): boolean {
    const message = errorMessage(error);
    if (!message) {
        return false;
    }
    return USAGE_LIMIT_ERROR_PREFIXES.some(prefix => message.startsWith(prefix));
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'object' && error !== null && 'message' in error) {
        const message = (error as { message?: unknown }).message;
        return typeof message === 'string' ? message : '';
    }
    return '';
}

export async function readClaudeSessionRecap(
    configDir: string,
    sessionId: string | null | undefined,
    runCommand: RecapCommand = execFileAsync,
): Promise<string> {
    // Without a session id the script falls back to the most recently
    // modified transcript in the whole config directory, which can belong
    // to a different concurrent or recent session. That would forward an
    // unrelated session's turns to the fallback account, so skip the recap
    // entirely rather than risk reading the wrong one.
    if (!sessionId) {
        return '';
    }
    const { stdout } = await runCommand(process.execPath, [
        CLAUDE_SESSION_RECAP_SCRIPT,
        '--config-dir',
        configDir,
        '--n',
        '10',
        '--session',
        sessionId,
    ], { maxBuffer: 1024 * 1024 });
    return stdout.trim();
}

export function buildUsageCapFailoverPrompt(recap: string): string {
    const recapText = recap || '(The primary session recap was unavailable.)';
    return `The primary account hit its usage cap. Recap of the last 10 turns from that session:\n\n${recapText}\n\nContinue from here.`;
}

export function withoutClaudeResumeArgs(args: string[] | undefined): string[] | undefined {
    if (!args) {
        return undefined;
    }
    const filtered: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--continue') {
            continue;
        }
        if (args[index] === '--resume') {
            if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
                index += 1;
            }
            continue;
        }
        filtered.push(args[index]);
    }
    return filtered.length > 0 ? filtered : undefined;
}
