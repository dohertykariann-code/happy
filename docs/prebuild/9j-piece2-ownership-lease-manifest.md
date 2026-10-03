---
topic: session-ownership-lease-piece2
punch_row: 9j
date: 2026-10-03
tier: standard
security_tier: T2
status: blocked_on_hitl
repos_in_scope:
  - ~/code/happy (packages/happy-cli) -- canonical app repo per happy/CLAUDE.md
  - ~/code/happy-cos (packages/happy-server) -- the server that actually runs
branch: feat/9j-piece2-ownership-lease (cut from origin/main 19162018)
spec: docs/superpowers/specs/2026-10-02-session-ownership-lease-design.md
surfaces:
  llm: false
  external_api: true          # CLI<->server socket + REST, cross-process
  ui: false                   # one CLI stderr message on 409, no UI
  persistent_storage: true    # PGlite schema migration, 3 new Session columns
  money_billing: false
  customer_data_pii: true     # her own session data, single tenant, no third-party
  cron_scheduled: false       # explicitly NOT reusing the 10-min presence sweeper
activated_categories: [2, 3, 11, 13]
cfo_signoff: not_required     # recurring cost: none (one counter, 3 columns)
counsel_signoff: not_required
---

# Prebuild manifest: session ownership lease, Piece 2 (enforcement)

Scope is Piece 2 only: the lease that refuses a duplicate claimant.

Piece 1 (contention detection) was confirmed present on `happy-cos` `fork/cos`
by direct read during this prebuild pass, not taken from the punch row:
`sources/app/events/sessionContention.ts` exists, its counter
`session_contention_events_total` is registered at
`sources/app/monitoring/metrics2.ts:69`, the wiring comment matching the spec's
"count > 1, not count > 0" rule is at `sources/app/events/eventRouter.ts:243`,
and two test files cover it (`sessionContention.test.ts`,
`eventRouter.contention.test.ts`). The live census result (4 reconnecting
session-scoped sockets, zero contention events) is recorded in punch row 9j and
was NOT re-run here.

## Output artifact + trigger

**Output a user sees:** a second process that tries to run an already-owned
session exits immediately with a plain message naming the incumbent, instead of
both processes executing the same phone message (the 9a symptom).

**Triggers:** (1) `POST /v1/sessions` at CLI startup, (2) session-scoped socket
handshake admission, (3) `session-alive` renewal, (4) socket disconnect.

## Category 2: prior art / cousin patterns -- VERIFIED by direct read

Three cousins exist and must be ported rather than reinvented. Each was read
directly at the path below during this pass, not cited from the spec.

1. **Compare-and-swap idiom** -- `happy-cos/packages/happy-server/sources/app/presence/timeout.ts:19-26`.
   `db.session.updateManyAndReturn({ where: { id, active: true }, data: {...} })`
   then `if (updated.length === 0) continue`. The precondition is re-asserted
   inside `where`, and an empty result means the race was lost. This is exactly
   the shape the lease claim needs. Port it; do not write a read-then-write.
2. **Token mint + constant-time compare** -- `happy/packages/happy-cli/src/daemon/controlAuth.ts`,
   confirmed to exist on `origin/main` via `git cat-file -e` (added by PR #14 /
   row 9h). Imports `randomBytes` and `timingSafeEqual` from `node:crypto`.
   Port for `ownerToken` generation and comparison.
3. **Honest-limit framing** -- same file's header comment, which states that the
   token does not defend against code running as the same user. The lease needs
   the equivalent disclaimer (see security tier), because an `ownerToken` looks
   like a credential and is not one.

Not a port overall: the lease itself is new logic. Cousins cover two mechanical
sub-parts.

## Category 3: current best practices

- Prisma `updateManyAndReturn` is already used in this codebase at the cousin
  site above, against PGlite. No new library, no version bump.
- Migration must be a real Prisma migration directory
  (`prisma/migrations/<YYYYMMDDHHMMSS>_<name>/`), matching the four existing
  ones; newest existing is `20260407053500_add_voice_conversation`.
- No context7 lookup needed: no new external library or SDK is introduced.

## Category 13: scope clarity -- exact anchors, each read this pass

Server (`happy-cos/packages/happy-server`):

| What | File:line | Change |
|---|---|---|
| Schema | `prisma/schema.prisma` `model Session` | add nullable `ownerToken`, `ownerExpiresAt`, `ownerClient`. `@@unique([accountId, tag])` already present and is the acquisition door. |
| Claim | `sources/app/api/routes/sessionRoutes.ts:219` (`POST /v1/sessions`) | transactional claim; 409 on live foreign owner |
| Admission | `sources/app/api/socket.ts` handshake | session-scoped handshake must present matching live `ownerToken`; distinct error code |
| Renewal | `sources/app/api/socket/sessionUpdateHandler.ts:140` (`session-alive`) | extend `ownerExpiresAt`; response must be able to report loss of ownership |
| Release | `sources/app/api/socket.ts:189` | **signature change required** -- reads `socket.on('disconnect', () => {...})` today, capturing no reason argument |

CLI (`happy/packages/happy-cli`):

| What | File:line | Change |
|---|---|---|
| Token mint | new module, alongside `src/api/apiSession.ts` | one `ownerToken` per process at startup |
| Handshake | `src/api/apiSession.ts:271-277` | add `ownerToken` to the `auth` object (today: token/clientType/sessionId/happyClient) |
| Claim body | `POST /v1/sessions` call site | send `ownerToken` |
| 409 handling | claim call site | exit with plain message naming incumbent |
| Lost-lease | renewal response handler | stop executing, exit |

Lease duration 60s, renewed by the existing 2s `session-alive` cadence
(`happy/packages/happy-cli/src/claude/session.ts:73-75`).

## Security tier: T2, with one explicit non-claim

Recorded T2, not T3, deliberately. Spec decision 3 scopes the threat model to
reliability: every racing process is already authenticated with the same account
token, and duplicate execution runs through the server's authenticated
socket/REST API rather than the daemon's local control server (row 9h, closed
separately and verified closed on 2026-10-03).

**`ownerToken` is NOT a security boundary and must not be documented as one.**
It is a process discriminator answering "are you the same process that claimed
this session," which the existing handshake fields cannot answer, since per spec
fact 9 they are byte-identical across two processes for one session. Any
same-uid process can read it. This disclaimer belongs in the implementation's
header comment, mirroring cousin 3.

T2 minimum layers: L3 transport (TLS/loopback via Caddy, pre-existing), L10
session (this work), L11 rate limit (N/A, no new public endpoint), L12 audit log
(Piece 1's contention counter plus claim-refusal logging).

## Category 11: failure-mode catalog

The first three turn this feature into an outage if implemented naively.

1. **Release fires on a network blip** -> session handed away while the owner is
   still executing. Cause: implementing release at `socket.ts:189` without
   widening the handler to capture `reason`. Fallback: release ONLY on explicit
   client-initiated disconnect reasons, never on `transport close` or
   `ping timeout`. Mutation proof required. Highest-risk line in the build.
2. **Volatile renewal silently dropped** -> a live session's lease expires
   mid-run. Cause: `session-alive` is `socket.volatile.emit`
   (`apiSession.ts:912`), best effort, buffered nowhere while disconnected.
   Fallback: successful admission itself re-extends `ownerExpiresAt`; the owner
   reconnects every 1-3s, so admission covers what volatile renewal loses.
3. **Strict admission kills a live session after an outage** -> worse than the
   bug being fixed. Fallback: an expired-but-uncontested lease is re-claimable by
   the SAME token, and that admission re-extends expiry. Only a different token
   claiming in the interim blocks re-claim.
4. **Pre-change CLI build presents no `ownerToken`** -> see HITL below.
   Unresolved.
5. **Migration fails on PGlite** -> single-writer embedded Postgres, no replica.
   Fallback: all three columns are nullable, so the migration is additive and
   backward-compatible; a failed migration leaves the old schema and the CLI's
   claim has no column to write.
6. **Claim race between two simultaneous first-starts** -> both read "free".
   Fallback: the CAS cousin -- conditional `updateManyAndReturn`, loser sees an
   empty result and is refused.

## HITL checkpoint -- BLOCKING, needs Kari before implementation

The spec's own open item, never answered: **what does the server do with a
session-scoped connection presenting no `ownerToken` at all?**

Every CLI build predating this change presents none. Evidence this matters, from
`git worktree list` run this pass: five worktrees able to launch a CLI exist
(`happy`, `happy-wt-9l`, `happy-wt-fanout`, `happy-wt-lease`, `happy-wt-main`),
and the live daemon's processes were observed running from `happy-wt-main`.

- **Tolerate and log** (spec's recommendation, and mine): accept token-less
  session-scoped connections for one release, log each, with a server setting to
  flip strict. Every worktree keeps working. Cost: a CLI build that has not been
  refreshed still reaches the 9a duplicate-execution path, because by
  construction nothing refuses it.
- **Refuse**: strictly correct, closes 9a immediately, breaks every worktree
  until each is individually rebuilt.

## Deferrals (v1 vs v2)

Out of scope, each named in the spec: row 9h (closed separately), the
`targets[0]` arbitrary RPC choice, replacing the 10-minute presence sweeper, and
the REST message-fetch path (refusal at the acquisition door means a non-owner
never reaches it).

## Testing + Definition of Done

Unit, per spec: claim succeeds on a free session; 409 against a live owner;
succeeds once expired; renewal extends; renewal against a foreign-owned session
reports loss; the same token re-claims an expired-uncontested lease and
re-extends it; a different token blocks that re-claim; release fires on explicit
disconnect and does NOT fire on `transport close` or `ping timeout`.

Two mutation proofs are mandatory before this counts as done:
1. Invert the disconnect-reason check -> the blip-safety test must redden.
2. Force the claim predicate to always allow -> the 409 test must redden.

Integration deliberately excluded: rows 9m, 9o and 12 record that the daemon
integration suite spawns real paid agent sessions. Row 9o's gate
(`HAPPY_RUN_REAL_AGENT_SPAWN_TESTS`) keeps those off by default.

## Deployment

Server: restart the local relay through the sanctioned launcher path
(`happy-cos/scripts/launcher/engine-supervisor.sh`), reading the exact command
out of that script at deploy time rather than assuming it. Live sessions drop
and reconnect in ~1-3s.

CLI: requires a rebuild, then the daemon restart batched with the row 13 / 9l
cutover, built in `happy-wt-main` (the worktree row 13 prepped), never in the
live daemon's own tree (row 9q containment rule).

Recurring cost: none. One in-process counter and three nullable columns. No
scheduled work, no paid API calls.

## Offload routing

Per P3: server-side and CLI-side implementation are each single-repo,
spec-driven and multi-file -> Codex via `codex-dispatch.mjs`, one dispatch per
repo, with `git log --oneline -20` pasted verbatim into each brief per the Codex
pre-flight hard gate. Claude retains: this manifest, the plan, both mutation
proofs, and the merge decision. The "not a credential" framing stays with
Claude.
