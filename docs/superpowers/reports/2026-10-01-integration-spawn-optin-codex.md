# Daemon real-agent-spawn tests: opt-in gate

Status: submitted for independent review. This report does not claim the work is done.

## Scope and safety

- Repository touched: `/Users/karidoherty/code/happy-wt-9l` only.
- No integration suite was run. No daemon or Happy session was started, stopped, or signalled by this work.
- The authenticated-integration list command was attempted because the brief required it. It did not run a test, but Vitest's authenticated setup attempted to bind `127.0.0.1`; it was blocked by the sandbox. Per the brief, it was not retried.
- A pnpm cache directory created by the failed build setup (`.pnpm-store`, one file) was moved recoverably to `/private/tmp/happy-wt-9l-pnpm-store-2026-10-01`; it is not left in the worktree.

## Source confirmation

`git show origin/main:packages/happy-cli/src/daemon/daemon.integration.test.ts | nl -ba` confirmed every named test and line number in the brief:

| Line | Test | Expected real sessions |
| --- | --- | --- |
| 238 | `should spawn & stop a session via HTTP (not testing RPC route, but similar enough)` | 1 |
| 258 | `stress test: spawn / stop` | 20 |
| 288 | `should track both daemon-spawned and terminal sessions` | 2 |
| 337 | `should update session metadata when webhook is called` | 1 |
| 376 | `should handle concurrent session operations` | 3 |

The supplied current-log block was not the actual log of this worktree after its tip. `83c1ce56` was the current HEAD and branch was correct, but the next entries were `028435e2`, `24ab2fe3`, and merge/revert commits rather than the supplied entries. No change was made based on that discrepancy.

## Changes

- `packages/happy-cli/src/testing/realAgentSpawnTestGate.ts`
  - Adds `shouldRunRealAgentSpawnTests`, the sole environment predicate. It returns true only when `HAPPY_RUN_REAL_AGENT_SPAWN_TESTS === '1'`.
  - Adds `assertRealAgentSpawnTestsEnabled`, a runtime guard that throws a clear message naming the variable and explaining that it protects real Claude-session quota.
- `packages/happy-cli/src/testing/realAgentSpawnTestGate.test.ts`
  - New unit coverage for unset (blocked), `1` (allowed), and another value (`true`, blocked). The blocking assertions verify that the error names `HAPPY_RUN_REAL_AGENT_SPAWN_TESTS`.
- `packages/happy-cli/src/daemon/daemon.integration.test.ts`
  - Imports the predicate and guard, derives one module-level `RUN_REAL_AGENT_SPAWN_TESTS` value, and wraps all five real-spawn tests with `it.skipIf(!RUN_REAL_AGENT_SPAWN_TESTS)`.
  - Calls the runtime guard at the beginning of each gated body.
  - Adds a three-line cost comment before the gated section with the measured 3,681,766 cache-read, 723,173 cache-creation, and 32,520 output tokens.
  - All pre-existing test assertions remain unchanged.

There is no shared `src/testing` spawn helper used by these tests: `rg -n "spawnDaemonSession\\("` found the control-client definition and the five direct calls in this integration test only. Therefore the runtime guard is called directly at the top of each gated test.

## Verification commands and real output

### Repository/source inspection

```text
$ git status --short && git branch --show-current
fix/integration-spawn-tests-opt-in

$ git log --oneline -12
83c1ce56 fix(cli/daemon): make a happySessionId an exclusive claim, with no webhook kill path (#10)
028435e2 fix(app): resolve the default Claude model against the live catalog (#9)
24ab2fe3 fix(app): derive the Claude model picker label from the live resolvedModel (#8)
ae4b51e2 Revert "fix(app,cli): clean up expo-doctor findings blocking a clean build"
a7b8a85e Merge pull request #6 from dohertykariann-code/fix/expo-doctor-cleanup
67a7363d fix(app,cli): clean up expo-doctor findings blocking a clean build
116e571d Merge pull request #5 from dohertykariann-code/feat/live-deepinfra-model-list
2881b615 feat(app,cli): populate the DeepInfra model picker and wire it to launch
2d23d6fa Merge pull request #4 from dohertykariann-code/feat/live-codex-model-list
7691ef45 feat(app,cli): populate the Codex model picker from the installed CLI
8233a509 Merge pull request #3 from dohertykariann-code/feat/live-claude-model-list
```

### TypeScript

```text
$ cd packages/happy-cli && npx tsc --noEmit
exit 0

npm warn Unknown project config "shamefully-hoist".
npm warn Unknown project config "node-linker".
npm warn Unknown project config "strict-peer-dependencies".
npm warn Unknown project config "auto-install-peers".
```

### Unit project

```text
$ cd packages/happy-cli && npx vitest run --project unit
exit 1

✓ |unit| src/testing/realAgentSpawnTestGate.test.ts (3 tests) 3ms

Test Files  1 failed | 93 passed (94)
Tests  8 failed | 881 passed (889)
```

The eight failures are all pre-existing `src/claude/utils/sessionScanner.test.ts` setup failures: the sandbox denied creation of fixture directories under `/Users/karidoherty/.claude/projects/...` with `EPERM`. This run also logged an unrelated Corepack/pnpm signature-verification refusal from Vitest's global `pnpm build` setup. The added gate test passed (3/3). The actual count increased from the stated 886-test baseline to 889 because this change adds three tests; the baseline's stated 93 files is now 94 because it adds one test file.

### Required integration listing (stopped on boot attempt)

```text
$ cd packages/happy-cli && npx vitest list --project integration-authenticated
exit 1

Build stderr: [ERROR] Refusing to run pnpm@10.11.0: its npm registry signature could not be verified ...
Error: listen EPERM: operation not permitted 127.0.0.1
Serialized Error: { code: 'EPERM', errno: -1, syscall: 'listen', address: '127.0.0.1' }
```

The command produced no test-name list. It was not retried because the brief says to stop if listing tries to execute or boot anything. Skip behavior was **not** proven by executing the integration suite, because doing so would spawn real Claude sessions and read/write the operator's live Happy home.

### Required wrapper grep

```text
$ grep -n "skipIf\\|it(" src/daemon/daemon.integration.test.ts
127:  it('should list sessions (initially empty)', async () => {
132:  it('should track session-started webhook from terminal session', async () => {
158:  it('keeps exactly one claimant when two live processes report the same session ID', async () => {
182:  it('replaces a dead claimant when a live process re-reports its session ID', async () => {
204:  it('never registers a second claimant, so the registry cannot become ambiguous', async () => {
227:  it('accepts a same-process session re-report without creating a collision', async () => {
247:  it.skipIf(!RUN_REAL_AGENT_SPAWN_TESTS)('should spawn & stop a session via HTTP (not testing RPC route, but similar enough)', async () => {
268:  it.skipIf(!RUN_REAL_AGENT_SPAWN_TESTS)('stress test: spawn / stop', { timeout: 60_000 }, async () => {
292:  it('should handle daemon stop request gracefully', async () => {
299:  it.skipIf(!RUN_REAL_AGENT_SPAWN_TESTS)('should track both daemon-spawned and terminal sessions', async () => {
349:  it.skipIf(!RUN_REAL_AGENT_SPAWN_TESTS)('should update session metadata when webhook is called', async () => {
363:  it('should not allow starting a second daemon', async () => {
389:  it.skipIf(!RUN_REAL_AGENT_SPAWN_TESTS)('should handle concurrent session operations', async () => {
427:  it('should die with logs when SIGKILL is sent', async () => {
461:  it('should die with cleanup logs when SIGTERM is sent', async () => {
```

### Diff hygiene

```text
$ git diff --check
exit 0
```

## Review focus

1. Confirm importing the predicate from the unit-tested helper is acceptable for the requested single opt-in gate.
2. Run the authenticated integration project only in an approved isolated environment, first without the flag to observe the five skips, then with `HAPPY_RUN_REAL_AGENT_SPAWN_TESTS=1` only if exercising real Agent SDK sessions is intentionally authorized.

