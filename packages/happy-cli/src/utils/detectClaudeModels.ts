import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk';

export type ClaudeModelInfo = Pick<
  ModelInfo,
  | 'value'
  | 'resolvedModel'
  | 'displayName'
  | 'description'
  | 'supportsEffort'
  | 'supportedEffortLevels'
  | 'supportsAdaptiveThinking'
  | 'supportsFastMode'
>;

type QueryLike = {
  initializationResult?: () => Promise<{ models?: ClaudeModelInfo[] }>;
  close?: () => void;
};

type CreateQuery = (params: {
  prompt: string;
  options: { abortController: AbortController; maxTurns: number };
}) => QueryLike;

export const CLAUDE_MODEL_PROBE_TIMEOUT_MS = 10_000;

export type ClaudeModelDetector = {
  detect: () => Promise<ClaudeModelInfo[] | undefined>;
  stop: () => void;
};

/**
 * Starts one bounded Agent SDK initialize handshake and caches its result for
 * this daemon process. CLI installs are not expected to change mid-process,
 * so avoiding repeated process spawns is preferable to minute-by-minute data.
 */
export function createClaudeModelDetector(
  createQuery: CreateQuery = query as CreateQuery,
  timeoutMs = CLAUDE_MODEL_PROBE_TIMEOUT_MS,
): ClaudeModelDetector {
  let cached: Promise<ClaudeModelInfo[] | undefined> | undefined;
  let activeAbortController: AbortController | undefined;
  let activeQuery: QueryLike | undefined;
  let resolveStop: ((value?: undefined) => void) | undefined;

  const stop = () => {
    activeAbortController?.abort();
    activeQuery?.close?.();
    activeQuery = undefined;
    resolveStop?.();
  };

  const detect = (): Promise<ClaudeModelInfo[] | undefined> => {
    if (cached) return cached;

    cached = (async () => {
      const abortController = new AbortController();
      activeAbortController = abortController;

      try {
        const probe = createQuery({
          prompt: '',
          options: { abortController, maxTurns: 0 },
        });
        activeQuery = probe;
        if (!probe.initializationResult) return undefined;

        let timeout: NodeJS.Timeout | undefined;
        const timedOut = new Promise<undefined>((resolve) => {
          timeout = setTimeout(() => {
            abortController.abort();
            resolve(undefined);
          }, timeoutMs);
        });
        const stopped = new Promise<undefined>((resolve) => {
          resolveStop = resolve;
        });
        try {
          return await Promise.race([probe.initializationResult().then((result) => result.models), timedOut, stopped]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      } catch {
        return undefined;
      } finally {
        activeQuery?.close?.();
        if (activeAbortController === abortController) activeAbortController = undefined;
        if (activeQuery && activeAbortController === undefined) activeQuery = undefined;
        resolveStop = undefined;
      }
    })();

    return cached;
  };

  return { detect, stop };
}

const detector = createClaudeModelDetector();

export const detectClaudeModels = detector.detect;
export const stopClaudeModelProbe = detector.stop;
