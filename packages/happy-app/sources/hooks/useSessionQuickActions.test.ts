import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    messages: [] as any[],
}));

vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({ sessionMessages: { session: { messages: mocks.messages } } }),
    },
    useLocalSetting: vi.fn(),
    useMachine: vi.fn(),
    useSetting: vi.fn(),
    useSession: vi.fn(),
}));
vi.mock('@/hooks/useHappyAction', () => ({ useHappyAction: vi.fn() }));
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/sync/ops', () => ({}));
vi.mock('@/hooks/useWorktreeCleanup', () => ({ maybeCleanupWorktree: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/sync/messageMeta', () => ({ UnsupportedPermissionModeError: class UnsupportedPermissionModeError extends Error {} }));
vi.mock('@/text', () => ({ t: vi.fn() }));
vi.mock('@/utils/errors', () => ({ HappyError: class HappyError extends Error {} }));
vi.mock('@/utils/copySessionMetadataToClipboard', () => ({}));
vi.mock('@/utils/sessionUtils', () => ({ useSessionStatus: vi.fn() }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: vi.fn() }));
vi.mock('@/utils/sessionFork', () => ({ getSessionForkSource: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: vi.fn() }));
vi.mock('@/components/DuplicateSheet', () => ({ DuplicateSheet: vi.fn() }));
vi.mock('@/sync/rig', () => ({ isRigMetadata: vi.fn() }));

import { buildSecondOpinionMessage, getHandoffAvailabilityKey, resolveHandoffTargets } from './useSessionQuickActions';

describe('useSessionQuickActions handoff helpers', () => {
    it('serializes chronological non-thinking conversation turns', () => {
        mocks.messages = [
            { kind: 'agent-text', createdAt: 3, text: 'Private reasoning', isThinking: true },
            { kind: 'agent-text', createdAt: 4, text: 'Final answer' },
            { kind: 'user-text', createdAt: 1, text: 'Initial request' },
            { kind: 'tool-call', createdAt: 2 },
        ];

        expect(buildSecondOpinionMessage('session')).toContain('User: Initial request\n\nAssistant: Final answer');
        expect(buildSecondOpinionMessage('session')).not.toContain('Private reasoning');
    });

    it('caps a single oversized newest turn at the transcript budget', () => {
        mocks.messages = [{ kind: 'user-text', createdAt: 1, text: 'x'.repeat(13000) }];

        const message = buildSecondOpinionMessage('session');

        expect(message).toContain('[Earlier conversation truncated.]');
        expect(message?.endsWith('x'.repeat(12000))).toBe(true);
        expect(message).not.toContain('User:');
    });

    it('maps both OpenHands presets to the shared availability flag', () => {
        expect(getHandoffAvailabilityKey('openhands_local')).toBe('openhands');
        expect(getHandoffAvailabilityKey('openhands_deepinfra')).toBe('openhands');
        expect(getHandoffAvailabilityKey('codex')).toBe('codex');
    });

    describe('resolveHandoffTargets', () => {
        it('excludes the session\'s own OpenHands preset while still offering the other one', () => {
            // Regression case: when both presets shared the generic "acp" flavor,
            // `current` could never equal either preset's agent id, so a session
            // already running openhands_local would wrongly offer itself again.
            const targets = resolveHandoffTargets('openhands_local', { claude: true, codex: true, openhands: true });

            expect(targets).not.toContain('openhands_local');
            expect(targets).toContain('openhands_deepinfra');
            expect(targets).toContain('claude');
            expect(targets).toContain('codex');
        });

        it('excludes the other OpenHands preset symmetrically', () => {
            const targets = resolveHandoffTargets('openhands_deepinfra', { openhands: true });

            expect(targets).toContain('openhands_local');
            expect(targets).not.toContain('openhands_deepinfra');
        });

        it('omits an unavailable target even if it is not the current session', () => {
            const targets = resolveHandoffTargets('claude', { claude: true, codex: false, openhands: true });

            expect(targets).not.toContain('codex');
            expect(targets).toContain('openhands_local');
        });

        it('returns nothing without an availability report', () => {
            expect(resolveHandoffTargets('claude', null)).toEqual([]);
            expect(resolveHandoffTargets('claude', undefined)).toEqual([]);
        });
    });
});
