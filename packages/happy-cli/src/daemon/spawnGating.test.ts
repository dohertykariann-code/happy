import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read the integration test file as TEXT. We must NOT import it, because
// importing would execute its module-level setup code, which may have side
// effects or spawn processes. Static text analysis is all we need.
const integrationTestText = readFileSync(
  join(__dirname, 'daemon.integration.test.ts'),
  'utf-8',
);

// The gate constant and environment variable names. If someone renames either
// one, every detection assertion below would silently become meaningless, so
// we assert their presence up front and fail loudly on any change.
const GATE_CONSTANT = 'RUN_AGENT_SPAWN_TESTS';
const GATE_ENV_VAR = 'HAPPY_RUN_AGENT_SPAWN_TESTS';
const GATE_EXPRESSION = '!RUN_AGENT_SPAWN_TESTS';

interface TestBlock {
  name: string;
  gated: boolean;
  body: string;
}

// Match both `it(` and `it.skipIf(...)(` forms, capturing the test name string
// (the first argument). A backreference to the opening quote handles both
// single and double quoted names. The lazy `[^]*?` ensures we stop at the
// first matching closing quote.
const TEST_DECLARATION_REGEX = /\bit(?:\.skipIf\(([^)]*)\))?\(\s*(['"])([^]*?)\2/g;

function parseTestBlocks(text: string): TestBlock[] {
  const positions: { index: number; name: string; gated: boolean }[] = [];
  let match: RegExpExecArray | null;
  while ((match = TEST_DECLARATION_REGEX.exec(text)) !== null) {
    const skipIfArg = match[1]; // undefined when there is no .skipIf wrapper
    const name = match[3];
    const gated = skipIfArg !== undefined && skipIfArg.trim() === GATE_EXPRESSION;
    positions.push({ index: match.index, name, gated });
  }

  const blocks: TestBlock[] = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index;
    // Each block's body extends to the next test declaration, or to end of
    // file for the last one. This captures the full test including its
    // callback body where spawn calls live.
    const end = i + 1 < positions.length ? positions[i + 1].index : text.length;
    blocks.push({
      name: positions[i].name,
      gated: positions[i].gated,
      body: text.slice(start, end),
    });
  }
  return blocks;
}

// Determine whether a block of text contains a real agent spawn.
//
// Two patterns count:
//   1. Any call to spawnDaemonSession( which posts to the daemon's
//      /spawn-session route and launches a paid agent.
//   2. A call to spawnHappyCLI([ whose first array element is NOT 'daemon'.
//      spawnHappyCLI(['daemon', ...]) starts only a free daemon process.
//      Any other first argument (e.g. '--happy-starting-mode') launches an
//      agent and bills the subscription.
function isAgentSpawn(text: string): boolean {
  if (text.includes('spawnDaemonSession(')) {
    return true;
  }

  const spawnHappyCLIRegex = /spawnHappyCLI\(\[\s*(['"])([^'"]*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = spawnHappyCLIRegex.exec(text)) !== null) {
    if (match[2] !== 'daemon') {
      return true;
    }
  }

  return false;
}

const testBlocks = parseTestBlocks(integrationTestText);
const spawningBlocks = testBlocks.filter((b) => isAgentSpawn(b.body));
const ungatedSpawningBlocks = spawningBlocks.filter((b) => !b.gated);

describe('spawn gating meta-test', () => {
  it('the gate constant and environment variable still exist with the expected names', () => {
    // If either name changes, the detection logic in this file would silently
    // stop matching anything. Fail here so the rename is caught immediately.
    expect(integrationTestText).toContain(GATE_CONSTANT);
    expect(integrationTestText).toContain(GATE_ENV_VAR);
    expect(integrationTestText).toContain(
      `const ${GATE_CONSTANT} = process.env.${GATE_ENV_VAR} === '1';`,
    );
  });

  it('every test that spawns a real agent is wrapped in it.skipIf(!RUN_AGENT_SPAWN_TESTS)', () => {
    const offending = ungatedSpawningBlocks.map((b) => b.name);
    expect(
      offending,
      'The following tests spawn a real paid agent but are NOT wrapped in ' +
        'it.skipIf(!RUN_AGENT_SPAWN_TESTS). An unwrapped spawn bills the ' +
        "operator's subscription on every default run. Wrap them with " +
        'it.skipIf(!RUN_AGENT_SPAWN_TESTS): ' +
        offending.join(', '),
    ).toEqual([]);
  });

  it('the five known spawning tests are each found and gated', () => {
    // Deleting a gate from an existing spawning test is just as dangerous as
    // adding an ungated one. This test pins the five known spawning tests by
    // name and verifies each one is still present and still gated.
    const knownNames = [
      'should spawn & stop a session via HTTP (not testing RPC route, but similar enough)',
      'stress test: spawn / stop',
      'should track both daemon-spawned and terminal sessions',
      'should update session metadata when webhook is called',
      'should handle concurrent session operations',
    ];

    for (const name of knownNames) {
      const block = testBlocks.find((b) => b.name === name);
      expect(
        block,
        `Test "${name}" was not found. It may have been renamed or deleted. ` +
          'If it was renamed, update the known-names list in this meta-test.',
      ).toBeDefined();

      if (block) {
        expect(
          block.gated,
          `Test "${name}" must be gated with it.skipIf(!RUN_AGENT_SPAWN_TESTS) ` +
            'because it spawns a real agent. Removing the gate would bill the ' +
            "operator's subscription on every default run.",
        ).toBe(true);
      }
    }
  });

  it('the spawn detector is not vacuous', () => {
    // A regex that silently matches nothing would pass every other assertion
    // in this file. This guard ensures the detector actually finds at least
    // one spawning block, so we know the detection logic is working.
    expect(spawningBlocks.length).toBeGreaterThan(0);
  });
});
