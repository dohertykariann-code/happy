import { DEEPINFRA_MODEL_CATALOG } from '@/daemon/deepInfraModelAllowlist';

export type DeepInfraModelInfo = {
  id: string;
  displayName: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;

export const DEEPINFRA_MODEL_PROBE_TIMEOUT_MS = 10_000;
const DEEPINFRA_MODELS_URL = 'https://api.deepinfra.com/v1/openai/models';

export type DeepInfraModelDetector = {
  detect: () => Promise<DeepInfraModelInfo[] | undefined>;
  stop: () => void;
};

function hasModelData(payload: unknown): payload is { data: Array<{ id: string }> } {
  return typeof payload === 'object'
    && payload !== null
    && 'data' in payload
    && Array.isArray(payload.data)
    && payload.data.every((model) => typeof model === 'object' && model !== null && typeof model.id === 'string');
}

/**
 * Fetches the public DeepInfra catalog once per daemon process. The curated
 * fallback rows stay available when upstream has renamed or retired one item,
 * so a partial catalog miss is not treated as a complete probe failure.
 */
export function createDeepInfraModelDetector(
  fetchFn: FetchLike = fetch,
  timeoutMs = DEEPINFRA_MODEL_PROBE_TIMEOUT_MS,
): DeepInfraModelDetector {
  let cached: Promise<DeepInfraModelInfo[] | undefined> | undefined;
  let activeAbortController: AbortController | undefined;
  let resolveStop: ((value?: undefined) => void) | undefined;

  const stop = () => {
    activeAbortController?.abort();
    resolveStop?.();
  };

  const detect = (): Promise<DeepInfraModelInfo[] | undefined> => {
    if (cached) return cached;

    cached = (async () => {
      const abortController = new AbortController();
      activeAbortController = abortController;
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
      const probe = (async (): Promise<DeepInfraModelInfo[] | undefined> => {
        try {
          const response = await fetchFn(DEEPINFRA_MODELS_URL, { signal: abortController.signal });
          if (!response.ok) return undefined;
          const payload: unknown = await response.json();
          if (!hasModelData(payload)) return undefined;

          if (payload.data.length === 0) return undefined;
          // Always return the fixed, ordered allowlist rather than whatever
          // subset the live catalog contains: a successful fetch only proves
          // the API is reachable, and a renamed/retired upstream ID should
          // not silently drop the current default from the picker.
          return DEEPINFRA_MODEL_CATALOG.map((model) => ({ id: model.id, displayName: model.displayName }));
        } catch {
          return undefined;
        }
      })();

      try {
        return await Promise.race([probe, timedOut, stopped]);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (activeAbortController === abortController) activeAbortController = undefined;
        resolveStop = undefined;
      }
    })();

    return cached;
  };

  return { detect, stop };
}

const detector = createDeepInfraModelDetector();

export const detectDeepInfraModels = detector.detect;
export const stopDeepInfraModelProbe = detector.stop;
