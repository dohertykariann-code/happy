# Live Claude Model List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the Claude picker from the current machine's installed Claude CLI model catalog without delaying daemon startup, while retaining the existing hardcoded list as fallback.

**Architecture:** `detectClaudeModels.ts` will start one bounded SDK Query and read `initializationResult().models`, then immediately close it. `ApiMachineClient` will trigger this detached after socket connection and use its existing versioned `updateMachineMetadata` channel to publish a successful result. `SessionView` will read its machine metadata and pass the list to the existing model-option resolver.

**Tech Stack:** TypeScript, Vitest, Zod, `@anthropic-ai/claude-agent-sdk`, pnpm workspaces.

---

### Task 1: Add the bounded Claude model probe

**Files:**
- Create: `packages/happy-cli/src/utils/detectClaudeModels.ts`
- Test: `packages/happy-cli/src/utils/detectClaudeModels.test.ts`

- [ ] **Step 1: Write failing probe tests**

Cover a successful initialization result, a cached second call that does not create another Query, rejected initialization, timeout, and explicit cancellation closing the active Query.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm --filter happy exec vitest run src/utils/detectClaudeModels.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the smallest bounded probe**

Inject the SDK query creator for tests. Create an abort controller, race `initializationResult()` with a short timeout, return its `models`, and close the Query in `finally`. Cache the shared promise for the daemon lifetime and expose a cancellation function for shutdown.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm --filter happy exec vitest run src/utils/detectClaudeModels.test.ts`

Expected: PASS.

### Task 2: Publish the optional model list through machine metadata

**Files:**
- Modify: `packages/happy-cli/src/api/types.ts`
- Modify: `packages/happy-cli/src/api/apiMachine.ts`
- Modify: `packages/happy-app/sources/sync/storageTypes.ts`
- Test: `packages/happy-cli/src/api/types.test.ts`
- Test: `packages/happy-cli/src/api/apiMachine.test.ts`
- Test: `packages/happy-app/sources/sync/storageTypes.spec.ts`

- [ ] **Step 1: Write failing schema and detached-start tests**

Prove old metadata without `claudeModels` parses, a live model list parses, and socket connection invokes the probe without awaiting it while publishing the result through `updateMachineMetadata`.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `pnpm --filter happy exec vitest run src/api/types.test.ts src/api/apiMachine.test.ts && pnpm --filter happy-app exec vitest run sources/sync/storageTypes.spec.ts`

Expected: FAIL because `claudeModels` and the detached probe wiring do not exist.

- [ ] **Step 3: Implement the additive metadata field and detached sync**

Add the optional model shape to both machine schemas. Start the probe after connection without `await`, publish only successful results through `updateMachineMetadata`, and cancel the probe from `ApiMachineClient.shutdown()`.

- [ ] **Step 4: Run focused tests to verify pass**

Run: `pnpm --filter happy exec vitest run src/api/types.test.ts src/api/apiMachine.test.ts && pnpm --filter happy-app exec vitest run sources/sync/storageTypes.spec.ts`

Expected: PASS.

### Task 3: Render Claude rows from current-machine metadata with fallback

**Files:**
- Modify: `packages/happy-app/sources/components/modelModeOptions.ts`
- Modify: `packages/happy-app/sources/components/modelModeOptions.test.ts`
- Modify: `packages/happy-app/sources/-session/SessionView.tsx`

- [ ] **Step 1: Write failing mapping tests**

Call `getClaudeModelModes()` with live SDK-shaped rows and assert `value`, `displayName`, and `description` map to `ModelMode`; call it without rows and assert the five hardcoded rows remain unchanged.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm --filter happy-app exec vitest run sources/components/modelModeOptions.test.ts`

Expected: FAIL because the function has no live-list input.

- [ ] **Step 3: Implement live mapping and current-machine lookup**

Add the narrow Claude model-list input to `getClaudeModelModes`/`getAvailableModels`. In `SessionView`, read the session's machine with `useMachine` and supply `machine.metadata.claudeModels`; all absent, pending, failed, and old-client cases continue through the hardcoded fallback.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm --filter happy-app exec vitest run sources/components/modelModeOptions.test.ts`

Expected: PASS.

### Task 4: Verify, summarize, and commit

**Files:**
- Create: `.codex-live-model-list-summary.md`

- [ ] **Step 1: Run formatting, typechecks, and complete package suites**

Run the configured formatter if present, then `pnpm --filter happy typecheck`, `pnpm --filter happy-app typecheck`, `pnpm --filter happy test`, and the non-watch full Vitest command for happy-app.

- [ ] **Step 2: Run the requested secret scan and inspect the staged diff**

Run `git diff --cached | grep -iE 'sk-ant|api[_-]?key'` and confirm no matches, allowing grep exit 1.

- [ ] **Step 3: Write the requested implementation summary and commit only feature files**

Record SDK call shape, cache strategy, async metadata sync, verification outputs, and commit hash in `.codex-live-model-list-summary.md`; stage only files named in this plan and create one clear commit on `feat/live-claude-model-list`.
