---
topic: session-handoff
tier: standard
security_tier: T1
surfaces:
  - user-facing UI
  - external agent-session RPC
decisions:
  - Port the shipped happy-cos implementation; do not redesign its transcript or spawn flow.
  - Map both OpenHands presets to the existing single `openhands` CLI capability.
  - Keep the existing `expResumeSession` rollout gate.
scaffolds_wired:
  - Session quick-action menu invokes the handoff callback.
---

# Session Handoff Manifest

The user-visible output is a context-menu action that opens a fresh available agent session with a bounded, non-thinking transcript as its kickoff. The trigger is a selected “Ask …” action. This is a direct port from the named sibling checkout, with only the established OpenHands capability mapping added.

No new dependency, API, credential, storage schema, paid service, or scheduled work is introduced. The target machine already owns agent-session spawning. T1 is appropriate because the change only passes a user-selected session transcript through the pre-existing machine RPC.
