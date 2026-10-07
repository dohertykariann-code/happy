export const DEEPINFRA_MODEL_CATALOG = [
  {
    catalogId: 'deepseek-ai/DeepSeek-V4-Flash',
    id: 'openai/deepseek-ai/DeepSeek-V4-Flash',
    displayName: 'DeepSeek V4 Flash',
  },
  {
    catalogId: 'moonshotai/Kimi-K2.6',
    id: 'deepinfra/moonshotai/Kimi-K2.6',
    displayName: 'Kimi K2.6 (vision)',
  },
  {
    catalogId: 'zai-org/GLM-5.2',
    id: 'openai/zai-org/GLM-5.2',
    displayName: 'GLM-5.2',
  },
  {
    catalogId: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo',
    id: 'openai/Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo',
    displayName: 'Qwen3-Coder Turbo',
  },
] as const;

export const DEEPINFRA_MODEL_ALLOWLIST: readonly string[] = DEEPINFRA_MODEL_CATALOG.map((model) => model.id);
export const DEFAULT_DEEPINFRA_MODEL = DEEPINFRA_MODEL_CATALOG[0].id;
