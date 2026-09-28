import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import type { Model, ModelListResponse } from '@/codex/codexAppServerTypes';

export type CodexModelInfo = Pick<
    Model,
    | 'id'
    | 'model'
    | 'displayName'
    | 'description'
    | 'hidden'
    | 'isDefault'
    | 'defaultReasoningEffort'
    | 'supportedReasoningEfforts'
>;

type CodexAppServerClientLike = {
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
    listModels: (opts?: { cursor?: string; includeHidden?: boolean; limit?: number }) => Promise<ModelListResponse>;
};

type CreateCodexAppServerClient = () => CodexAppServerClientLike;

export const CODEX_MODEL_PROBE_TIMEOUT_MS = 10_000;
const MAX_CODEX_MODEL_PAGES = 2;

export type CodexModelDetector = {
    detect: () => Promise<CodexModelInfo[] | undefined>;
    stop: () => void;
};

/**
 * Starts one bounded Codex app-server model/list probe and caches its result
 * for this daemon process. Codex installs are not expected to change
 * mid-process, so avoiding repeated CLI process spawns is preferable to
 * minute-by-minute data.
 */
export function createCodexModelDetector(
    createClient: CreateCodexAppServerClient = () => new CodexAppServerClient(),
    timeoutMs = CODEX_MODEL_PROBE_TIMEOUT_MS,
): CodexModelDetector {
    let cached: Promise<CodexModelInfo[] | undefined> | undefined;
    let activeClient: CodexAppServerClientLike | undefined;
    let resolveStop: ((value?: undefined) => void) | undefined;

    const stop = () => {
        void activeClient?.disconnect();
        activeClient = undefined;
        resolveStop?.();
    };

    const detect = (): Promise<CodexModelInfo[] | undefined> => {
        if (cached) return cached;

        cached = (async () => {
            const client = createClient();
            activeClient = client;

            const probe = (async (): Promise<CodexModelInfo[] | undefined> => {
                try {
                    await client.connect();
                    const models: CodexModelInfo[] = [];
                    let cursor: string | undefined;

                    for (let page = 0; page < MAX_CODEX_MODEL_PAGES; page += 1) {
                        const response = await client.listModels(cursor === undefined ? {} : { cursor });
                        models.push(...response.data.filter((model) => !model.hidden));
                        if (!response.nextCursor) break;
                        cursor = response.nextCursor;
                    }

                    return models;
                } catch {
                    return undefined;
                }
            })();

            let timeout: NodeJS.Timeout | undefined;
            const timedOut = new Promise<undefined>((resolve) => {
                timeout = setTimeout(() => {
                    void client.disconnect();
                    resolve(undefined);
                }, timeoutMs);
            });
            const stopped = new Promise<undefined>((resolve) => {
                resolveStop = resolve;
            });

            try {
                return await Promise.race([probe, timedOut, stopped]);
            } finally {
                if (timeout) clearTimeout(timeout);
                await client.disconnect();
                if (activeClient === client) activeClient = undefined;
                resolveStop = undefined;
            }
        })();

        return cached;
    };

    return { detect, stop };
}

const detector = createCodexModelDetector();

export const detectCodexModels = detector.detect;
export const stopCodexModelProbe = detector.stop;
