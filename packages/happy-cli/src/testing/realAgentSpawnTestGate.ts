export const REAL_AGENT_SPAWN_TESTS_ENV = 'HAPPY_RUN_REAL_AGENT_SPAWN_TESTS';

export function shouldRunRealAgentSpawnTests(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[REAL_AGENT_SPAWN_TESTS_ENV] === '1';
}

export function assertRealAgentSpawnTestsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!shouldRunRealAgentSpawnTests(env)) {
    throw new Error(
      `Real agent spawn tests are disabled. Set ${REAL_AGENT_SPAWN_TESTS_ENV}=1 to run them; the gate prevents tests from consuming real Claude session quota by default.`,
    );
  }
}
