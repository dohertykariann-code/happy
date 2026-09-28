import { describe, expect, it, vi } from 'vitest';
import type { ModelListResponse } from '@/codex/codexAppServerTypes';
import { createCodexModelDetector } from './detectCodexModels';

const model = {
    id: 'gpt-6-astra',
    model: 'gpt-6-astra',
    displayName: 'GPT-6 Astra',
    description: 'Most capable',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
};

describe('Codex model detection', () => {
    it('caches one app-server probe for the daemon lifetime', async () => {
        const disconnect = vi.fn().mockResolvedValue(undefined);
        const createClient = vi.fn(() => ({
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect,
            listModels: vi.fn().mockResolvedValue({ data: [model], nextCursor: null }),
        }));
        const detector = createCodexModelDetector(createClient, 100);

        await expect(detector.detect()).resolves.toEqual([model]);
        await expect(detector.detect()).resolves.toEqual([model]);

        expect(createClient).toHaveBeenCalledTimes(1);
        expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('returns undefined when the app-server probe fails', async () => {
        const detector = createCodexModelDetector(() => ({
            connect: vi.fn().mockRejectedValue(new Error('Codex unavailable')),
            disconnect: vi.fn().mockResolvedValue(undefined),
            listModels: vi.fn(),
        }), 100);

        await expect(detector.detect()).resolves.toBeUndefined();
    });

    it('times out and cleans up a stalled probe', async () => {
        vi.useFakeTimers();
        const disconnect = vi.fn().mockResolvedValue(undefined);
        const detector = createCodexModelDetector(() => ({
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect,
            listModels: vi.fn(() => new Promise<ModelListResponse>(() => {})),
        }), 100);

        const result = detector.detect();
        await vi.advanceTimersByTimeAsync(100);

        await expect(result).resolves.toBeUndefined();
        expect(disconnect).toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('can cancel and clean up an in-flight probe during daemon shutdown', async () => {
        const disconnect = vi.fn().mockResolvedValue(undefined);
        const detector = createCodexModelDetector(() => ({
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect,
            listModels: vi.fn(() => new Promise<ModelListResponse>(() => {})),
        }), 10_000);

        const result = detector.detect();
        detector.stop();

        await expect(result).resolves.toBeUndefined();
        expect(disconnect).toHaveBeenCalled();
    });
});
