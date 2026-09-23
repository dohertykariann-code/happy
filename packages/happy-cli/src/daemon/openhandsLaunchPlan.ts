export type OpenHandsAgentType = 'openhands_local' | 'openhands_deepinfra';

export type OpenHandsLaunchPlan = {
  args: string[];
  env: Record<string, string>;
};

/**
 * The daemon's two OpenHands presets. Both use Happy's ACP runner; this only
 * supplies the provider-specific environment to the child session.
 */
export function buildOpenHandsLaunchPlan(
  agent: OpenHandsAgentType,
  hostEnvironment: NodeJS.ProcessEnv,
): OpenHandsLaunchPlan | { errorMessage: string } {
  if (agent === 'openhands_local') {
    return {
      args: ['acp', 'openhands', '--started-by', 'daemon'],
      env: {
        LLM_MODEL: 'ollama/qwen2.5:14b',
        LLM_BASE_URL: 'http://localhost:11434',
      },
    };
  }

  const apiKey = hostEnvironment.DEEPINFRA_API_KEY;
  if (!apiKey) {
    return {
      errorMessage: 'OpenHands (DeepInfra) requires DEEPINFRA_API_KEY in the daemon environment. Set it and restart the Happy daemon before starting a session.',
    };
  }

  return {
    args: ['acp', 'openhands', '--started-by', 'daemon'],
    env: {
      LLM_MODEL: 'openai/deepseek-ai/DeepSeek-V4-Flash',
      LLM_BASE_URL: 'https://api.deepinfra.com/v1/openai',
      LLM_API_KEY: apiKey,
    },
  };
}

export function isOpenHandsAgent(agent: string | undefined): agent is OpenHandsAgentType {
  return agent === 'openhands_local' || agent === 'openhands_deepinfra';
}
