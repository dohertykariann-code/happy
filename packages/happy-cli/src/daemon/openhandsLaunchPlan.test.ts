import { describe, expect, it } from 'vitest';

import { buildOpenHandsLaunchPlan } from './openhandsLaunchPlan';

describe('OpenHands daemon launch plans', () => {
  it('launches the local preset through ACP with its Ollama configuration and native tool calling disabled', () => {
    expect(buildOpenHandsLaunchPlan('openhands_local', {})).toEqual({
      args: ['acp', 'openhands_local', '--started-by', 'daemon'],
      env: {
        LLM_MODEL: 'ollama/qwen2.5:14b',
        LLM_BASE_URL: 'http://localhost:11434',
        LLM_NATIVE_TOOL_CALLING: 'false',
      },
    });
  });

  it('launches the DeepInfra preset through ACP and maps the host key only to the child key', () => {
    const plan = buildOpenHandsLaunchPlan('openhands_deepinfra', { DEEPINFRA_API_KEY: 'test-key' });

    expect(plan).toMatchObject({
      args: ['acp', 'openhands_deepinfra', '--started-by', 'daemon'],
      env: {
        LLM_MODEL: 'openai/deepseek-ai/DeepSeek-V4-Flash',
        LLM_BASE_URL: 'https://api.deepinfra.com/v1/openai',
      },
    });
    expect('errorMessage' in plan).toBe(false);
    if ('env' in plan) {
      expect(plan.env).toHaveProperty('LLM_API_KEY');
      expect(plan.env).not.toHaveProperty('DEEPINFRA_API_KEY');
      expect(plan.env).not.toHaveProperty('LLM_NATIVE_TOOL_CALLING');
    }
  });

  it('fails before spawning when the DeepInfra key is absent', () => {
    expect(buildOpenHandsLaunchPlan('openhands_deepinfra', {})).toEqual({
      errorMessage: expect.stringContaining('DEEPINFRA_API_KEY'),
    });
  });
});
