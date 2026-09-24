import { describe, expect, it } from 'vitest';

import { resolveMachineAgent } from './newSessionAgentSelection';

describe('resolveMachineAgent', () => {
    it('replaces a stale Claude draft with the installed Codex CLI', () => {
        expect(resolveMachineAgent('claude', {
            claude: false,
            codex: true,
            openclaw: false,
            gemini: false,
        })).toBe('codex');
    });

    it('keeps an installed selection', () => {
        expect(resolveMachineAgent('codex', {
            claude: true,
            codex: true,
        })).toBe('codex');
    });

    it('selects Rig on a Rig-only machine', () => {
        expect(resolveMachineAgent('claude', {
            rig: true,
            claude: false,
            codex: false,
        })).toBe('rig');
    });

    it('keeps the persisted selection when capability metadata is missing', () => {
        expect(resolveMachineAgent('claude', undefined)).toBe('claude');
    });

    it('keeps the persisted selection when no CLI is reported', () => {
        expect(resolveMachineAgent('claude', {
            claude: false,
            codex: false,
            openclaw: false,
            gemini: false,
        })).toBe('claude');
    });

    // Gemini's login is dead and OpenClaw is shelved, so a draft pointing at
    // either has to move even though the binary is still on the machine.
    it('migrates off a retired harness whose CLI is still installed', () => {
        expect(resolveMachineAgent('gemini', {
            gemini: true,
            claude: true,
            codex: true,
        })).toBe('claude');

        expect(resolveMachineAgent('openclaw', {
            openclaw: true,
            codex: true,
        })).toBe('codex');
    });

    it('migrates off a retired harness when capability metadata is missing', () => {
        expect(resolveMachineAgent('gemini', undefined)).toBe('claude');
    });

    // OpenHands has one CLI binary; a machine reports it under the shared
    // `openhands` key, never under `openhands_local`/`openhands_deepinfra`
    // themselves. A raw `availability[selectedAgent]` lookup would find
    // nothing for either preset and silently fall back to the next available
    // harness even though the machine genuinely has OpenHands installed.
    it('keeps an OpenHands preset selection when the shared openhands key is available', () => {
        expect(resolveMachineAgent('openhands_local', {
            claude: true,
            openhands: true,
        })).toBe('openhands_local');

        expect(resolveMachineAgent('openhands_deepinfra', {
            claude: true,
            openhands: true,
        })).toBe('openhands_deepinfra');
    });

    it('falls back off an OpenHands preset when the shared openhands key is unavailable', () => {
        expect(resolveMachineAgent('openhands_local', {
            claude: true,
            openhands: false,
        })).toBe('claude');
    });
});
