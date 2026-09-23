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

import { buildSecondOpinionMessage, getHandoffAvailabilityKey } from './useSessionQuickActions';

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
});
