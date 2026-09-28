---
topic: live-claude-model-list
tier: standard
security_tier: T1
surfaces:
  - user-facing UI
  - external agent-session RPC
decisions:
  - Query the installed Claude Agent SDK asynchronously and use its initial initialize response's models list.
  - Cache one successful or failed probe result for the daemon lifetime, with one in-flight probe at a time.
  - Publish completed results through the existing versioned machine metadata update; absent results preserve the static fallback.
scaffolds_wired:
  - ApiMachineClient starts the detached probe after its socket connects and publishes claudeModels through updateMachineMetadata.
  - SessionView reads its current machine's claudeModels and passes them to getAvailableModels.
---

# Live Claude Model List Manifest

The picker continues to show its existing curated Claude rows until its machine asynchronously reports a CLI-verified model list. A daemon socket connection triggers one bounded probe; the probe neither delays machine registration nor session creation.

The change introduces no API keys, paid API calls, persistent storage, scheduled work, or customer data. It starts the locally installed Claude Agent SDK CLI only to complete its initialize handshake, then closes that Query. T1 is appropriate.
