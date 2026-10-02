import { describe, expect, it } from 'vitest';
import {
  assertRealAgentSpawnTestsEnabled,
  REAL_AGENT_SPAWN_TESTS_ENV,
  shouldRunRealAgentSpawnTests,
} from './realAgentSpawnTestGate';

describe('real agent spawn test gate', () => {
  it('blocks when the opt-in variable is unset', () => {
    expect(shouldRunRealAgentSpawnTests({})).toBe(false);
    expect(() => assertRealAgentSpawnTestsEnabled({})).toThrow(REAL_AGENT_SPAWN_TESTS_ENV);
  });

  it('allows an explicit opt-in value of 1', () => {
    expect(shouldRunRealAgentSpawnTests({ [REAL_AGENT_SPAWN_TESTS_ENV]: '1' })).toBe(true);
    expect(() => assertRealAgentSpawnTestsEnabled({ [REAL_AGENT_SPAWN_TESTS_ENV]: '1' })).not.toThrow();
  });

  it('blocks values other than 1', () => {
    expect(shouldRunRealAgentSpawnTests({ [REAL_AGENT_SPAWN_TESTS_ENV]: 'true' })).toBe(false);
    expect(() => assertRealAgentSpawnTestsEnabled({ [REAL_AGENT_SPAWN_TESTS_ENV]: 'true' })).toThrow(
      REAL_AGENT_SPAWN_TESTS_ENV,
    );
  });
});
