import { describe, expect, it, vi } from 'vitest';
import { createDeepInfraModelDetector } from './detectDeepInfraModels';

const catalog = {
  data: [
    { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo' },
    { id: 'unrelated/model' },
    { id: 'deepseek-ai/DeepSeek-V4-Flash' },
    { id: 'zai-org/GLM-5.2' },
  ],
};

describe('DeepInfra model detection', () => {
  it('filters the live catalog into the ordered, prefixed curated picker rows', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(catalog) });
    const detector = createDeepInfraModelDetector(fetchFn, 100);

    await expect(detector.detect()).resolves.toEqual([
      { id: 'openai/deepseek-ai/DeepSeek-V4-Flash', displayName: 'DeepSeek V4 Flash' },
      { id: 'openai/zai-org/GLM-5.2', displayName: 'GLM-5.2' },
      { id: 'openai/Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo', displayName: 'Qwen3-Coder Turbo' },
    ]);
  });

  it('returns undefined for non-200 and malformed responses', async () => {
    await expect(createDeepInfraModelDetector(vi.fn().mockResolvedValue({ ok: false, json: vi.fn() }), 100).detect()).resolves.toBeUndefined();
    await expect(createDeepInfraModelDetector(vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ models: [] }) }), 100).detect()).resolves.toBeUndefined();
  });

  it('keeps hardcoded rows when the live catalog has a partial allowlist miss', async () => {
    const detector = createDeepInfraModelDetector(vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: [{ id: 'zai-org/GLM-5.2' }] }),
    }), 100);

    await expect(detector.detect()).resolves.toEqual([
      { id: 'openai/deepseek-ai/DeepSeek-V4-Flash', displayName: 'DeepSeek V4 Flash' },
      { id: 'openai/zai-org/GLM-5.2', displayName: 'GLM-5.2' },
      { id: 'openai/Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo', displayName: 'Qwen3-Coder Turbo' },
    ]);
  });

  it('times out and aborts a stalled probe', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const stalledFetch = vi.fn((_url: string, options?: RequestInit): Promise<Pick<Response, 'ok' | 'json'>> => {
      signal = options?.signal as AbortSignal | undefined;
      return new Promise(() => {});
    });
    const detector = createDeepInfraModelDetector(stalledFetch, 100);
    const result = detector.detect();
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('caches the same probe promise for the daemon lifetime', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(catalog) });
    const detector = createDeepInfraModelDetector(fetchFn, 100);
    const first = detector.detect();
    const second = detector.detect();

    expect(second).toBe(first);
    await expect(first).resolves.toHaveLength(3);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed probe, so a later call retries', async () => {
    // Punch 3a: the detector is correct in isolation (proven by the tests
    // above), but a one-off transient failure in production left the picker
    // stuck at its single hardcoded fallback row until a manual daemon
    // restart. Caching only successes, not failures, is the fix.
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: vi.fn() })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(catalog) });
    const detector = createDeepInfraModelDetector(fetchFn, 100);

    await expect(detector.detect()).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await expect(detector.detect()).resolves.toHaveLength(3);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    // A success, once cached, still behaves like the "daemon lifetime" test
    // above: a further call does not hit the network again.
    await expect(detector.detect()).resolves.toHaveLength(3);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight probe when stopped during daemon shutdown', async () => {
    let signal: AbortSignal | undefined;
    const stalledFetch = vi.fn((_url: string, options?: RequestInit): Promise<Pick<Response, 'ok' | 'json'>> => {
      signal = options?.signal as AbortSignal | undefined;
      return new Promise(() => {});
    });
    const detector = createDeepInfraModelDetector(stalledFetch, 10_000);
    const result = detector.detect();
    detector.stop();

    await expect(result).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });
});
