# Live DeepInfra Model List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present the curated public DeepInfra catalog in the OpenHands picker and launch the selected allowed model.

**Architecture:** Share one ordered allowlist between the HTTP detector and the daemon launch plan. Publish detector output as optional machine metadata; the app uses it only for `openhands_deepinfra`, retaining the current fallback on absence.

**Tech Stack:** TypeScript, Zod, Vitest, React.

---

### Task 1: Model allowlist and bounded detector

**Files:** Create `packages/happy-cli/src/daemon/deepInfraModelAllowlist.ts`, `packages/happy-cli/src/utils/detectDeepInfraModels.ts`, `packages/happy-cli/src/utils/detectDeepInfraModels.test.ts`.

- [ ] Define the ordered three-row allowlist with catalog ID, `openai/` ID, and display name; inject `fetch`; cache one result; abort after 10 seconds; return `undefined` for all invalid probe outcomes.
- [ ] Test ordered prefixed output, timeout, non-200, malformed payload, promise caching, and shutdown abort.

### Task 2: Daemon metadata and launch wiring

**Files:** Modify `packages/happy-cli/src/api/apiMachine.ts`, `apiMachine.test.ts`, `api/types.ts`, `api/types.test.ts`, `daemon/openhandsLaunchPlan.ts`, `openhandsLaunchPlan.test.ts`, `daemon/run.ts`.

- [ ] Start/stop the detector with the existing probes and publish only successful results.
- [ ] Validate `modelMode` against the shared allowlist before assigning `LLM_MODEL`; pass it from `run.ts`.

### Task 3: App picker metadata consumption

**Files:** Modify `packages/happy-app/sources/sync/storageTypes.ts`, `storageTypes.spec.ts`, `components/modelModeOptions.ts`, `modelModeOptions.test.ts`, `-session/SessionView.tsx`.

- [ ] Parse optional metadata and present live DeepInfra rows only for `openhands_deepinfra`; retain fallback and leave local OpenHands untouched.
- [ ] Pass machine metadata through SessionView and verify catalog/fallback/local behavior.

### Task 4: Verification

- [ ] Run CLI and app TypeScript checks, requested Vitest suites, and the requested diff secret-pattern scan.
