---
schema_version: 1
topic: live-deepinfra-model-list
date: 2026-09-28
tier: standard
security_tier: T2
surfaces: [external API or data source, user-facing UI]
cousin_pattern: port-plan
activated_categories: [1, 2, 6, 11, 13]
decisions:
  model: "DeepInfra catalog is public; session launch remains user-provided-key only."
  caching: { strategy: "one bounded probe per daemon", cache_control: false }
scaffolds_wired: ["ApiMachineClient starts and stops the detector", "run.ts passes modelMode to the OpenHands launch plan"]
budget_ceiling: { usd: 0, tokens: null, wall_clock_s: null, recursion_depth: null }
cfo_signoff: not-required-no-new-cost-path
counsel_signoff: not-required-no-client-data
---

# Prebuild Manifest: live-deepinfra-model-list

## What we're building

The OpenHands DeepInfra picker receives the curated live catalog after daemon connection, and its selected ID becomes the allowlist-validated `LLM_MODEL` at session launch.

## v1 vs v2

- v1: fixed three-model allowlist, public bounded fetch, hardcoded picker fallback, validated launch selection.
- v2 (deferred): dynamic expansion of the allowlist or authenticated catalog access.

## Category status

| # | Category | Status | Notes |
|---|---|---|---|
| 1 | Eval-first | PASS | Unit coverage for detector, metadata, picker, and launch validation. |
| 2 | Prior art | PASS | Ports Claude/Codex detector and picker patterns. |
| 6 | Guardrails stack | PASS | Timeout, fail-closed result, and allowlist at paid API boundary. |
| 11 | Failure-mode catalog | PASS | Probe failure retains fallback; invalid selection retains default. |
| 13 | Scope clarity | PASS | `openhands_local` and all other agent flavors are unchanged. |

## Failure-mode catalog

| Failure mode | Fallback |
|---|---|
| Offline, timeout, malformed, or non-200 catalog response | Do not publish metadata; app hardcoded default stays available. |
| Upstream model disappears | Detector preserves the curated hardcoded row in fixed order. |
| Arbitrary app-supplied launch model | Launch plan uses the existing DeepSeek default. |
