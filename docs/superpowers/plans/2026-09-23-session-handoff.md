# Session Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the shipped second-opinion handoff into Happy and offer both existing OpenHands presets when the machine reports OpenHands available.

**Architecture:** Keep serialization and spawning in `useSessionQuickActions`, matching the shipped sibling implementation. Map both OpenHands preset IDs to the machine's one `openhands` capability and add menu shortcut identities so the existing typed action-menu consumer stays complete.

**Tech Stack:** TypeScript, React hooks, Vitest.

---

### Task 1: Add the handoff serialization and availability behavior

**Files:**
- Modify: `packages/happy-app/sources/hooks/useSessionQuickActions.ts`
- Test: `packages/happy-app/sources/hooks/useSessionQuickActions.test.ts`

- [ ] **Step 1: Write failing helper tests**

Test that a transcript excludes thinking blocks, keeps chronological recent turns within 12,000 characters, and maps both OpenHands target IDs to `openhands`.

- [ ] **Step 2: Implement the port**

Add the shipped `buildSecondOpinionMessage` budget logic, the five-member `HandoffAgent` catalog, the `expResumeSession`-gated target memo, and the spawn/refresh/send/navigate callback.

- [ ] **Step 3: Run the focused test**

Run: `pnpm --filter happy-app exec vitest run sources/hooks/useSessionQuickActions.test.ts`

Expected: PASS.

### Task 2: Keep the typed session menu complete

**Files:**
- Modify: `packages/happy-app/sources/keyboard/shortcuts.ts`
- Modify: `packages/happy-app/sources/keyboard/shortcuts.test.ts`

- [ ] **Step 1: Add the four handoff action IDs and chords**

Use distinct shortcut IDs and chords so the existing popover can format and match every handoff action without an unsafe cast.

- [ ] **Step 2: Update the keyboard-catalog expectation**

Assert the new IDs are present with the rest of the session actions.

- [ ] **Step 3: Run the focused keyboard test**

Run: `pnpm --filter happy-app exec vitest run sources/keyboard/shortcuts.test.ts`

Expected: PASS.

### Task 3: Validate the app package and record the result

**Files:**
- Create: `/tmp/happy-personal-fork-openhands/CODEX_HANDOFF_RESULT.md`

- [ ] **Step 1: Run package tests and typecheck**

Run the real `happy-app` test and typecheck scripts from its package manifest.

- [ ] **Step 2: Record exact commands and outcomes**

Write the requested result file with changed files, verification output, and residual risk.

- [ ] **Step 3: Commit only task files**

Stage the implementation, tests, required planning artifacts, and result file only after reviewing the staged names and secret-safe diff.
