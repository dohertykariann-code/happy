import { describe, expect, it, vi } from 'vitest';
import { createClaudeModelDetector } from './detectClaudeModels';

const model = {
  value: 'claude-opus-5',
  resolvedModel: 'claude-opus-5',
  displayName: 'Opus 5',
  description: 'Most capable',
};

describe('Claude model detection', () => {
  it('caches one SDK initialization result for the daemon lifetime', async () => {
    const close = vi.fn();
    const createQuery = vi.fn(() => ({
      initializationResult: vi.fn().mockResolvedValue({ models: [model] }),
      close,
    }));
    const detector = createClaudeModelDetector(createQuery, 100);

    await expect(detector.detect()).resolves.toEqual([model]);
    await expect(detector.detect()).resolves.toEqual([model]);

    expect(createQuery).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the SDK initialization fails', async () => {
    const createQuery = vi.fn(() => ({
      initializationResult: vi.fn().mockRejectedValue(new Error('CLI unavailable')),
      close: vi.fn(),
    }));
    const detector = createClaudeModelDetector(createQuery, 100);

    await expect(detector.detect()).resolves.toBeUndefined();
  });

  it('times out, aborts, and closes a stalled probe', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    let controller: AbortController | undefined;
    const createQuery = vi.fn(({ options }) => {
      controller = options.abortController;
      return {
        initializationResult: vi.fn(() => new Promise<{ models?: typeof model[] }>(() => {})),
        close,
      };
    });
    const detector = createClaudeModelDetector(createQuery, 100);

    const result = detector.detect();
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBeUndefined();
    expect(controller?.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('can cancel and close an in-flight probe during daemon shutdown', async () => {
    const close = vi.fn();
    let controller: AbortController | undefined;
    const detector = createClaudeModelDetector(({ options }) => {
      controller = options.abortController;
      return { initializationResult: () => new Promise(() => {}), close };
    }, 10_000);

    const result = detector.detect();
    detector.stop();

    await expect(result).resolves.toBeUndefined();
    expect(controller?.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalled();
  });
});
