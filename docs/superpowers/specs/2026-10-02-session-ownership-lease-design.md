# Session ownership lease (punch 9j), design

Date: 2026-10-02
Status: approved by Kari, not implemented
Repos in scope: `~/code/happy` (CLI, `packages/happy-cli`) and `~/code/happy-cos` (the server that actually runs, `packages/happy-server`)

## Problem

Punch row 9j records that the merged session claim fix narrows but does not
close duplicate session execution: it stops a second claimant joining one
daemon's in-memory registry, and leaves the delivery layer unguarded. Punch
row 9a records the user-visible symptom, one phone message executing in
several live sessions at once.

This design closes the delivery-layer gap.

## Verified facts

Every claim below was checked against source in the session that produced this
document. The running server is the `happy-cos` copy, not the `happy` copy, and
the two have diverged, so each server fact is cited from `happy-cos`.

1. Deployment topology. The live daemon runs with
   `HAPPY_SERVER_URL=http://127.0.0.1:3010` (read from the daemon process
   environment, pid 9660). That port is served by node pid 15430 with cwd
   `/Users/karidoherty/code/happy-cos/packages/happy-server`, and it answers
   `Welcome to Happy Server!`. The CLI default would otherwise be
   `https://api.cluster-fluster.com` (`happy/packages/happy-cli/src/configuration.ts:60`),
   so the self-hosted server is what serves this machine.
2. Single process, embedded database. The running server has neither
   `REDIS_URL` nor `DATABASE_URL` in its environment, and
   `happy-cos/packages/happy-server/sources/storage/db.ts:2` imports `PGlite`.
   So Socket.IO rooms are in-process state, the cross-replica `fetchSockets`
   machinery is inert in this deployment, and the database is an embedded
   single-writer Postgres with real transaction semantics.
3. The fanout is room membership. A session-scoped socket joins
   `user:{userId}:session:{sessionId}`
   (`happy-cos/packages/happy-server/sources/app/events/eventRouter.ts:238`),
   and `new-message` is emitted to that room via the
   `all-interested-in-session` filter (same file, line 307). Nothing rejects a
   second occupant.
4. The client executes on what it receives. `happy/packages/happy-cli/src/api/apiSession.ts:341`
   decrypts the message and calls `routeIncomingMessage`, which feeds the agent
   loop at line 564. N occupants of the room therefore means N executions.
5. RPC is not a fanout vector. `rpcHandler.ts` logs
   `Multiple sockets in ${room}; using first` and sends only to `targets[0]`
   (line 198 region). This file is byte identical between the two repos.
   Arbitrary single delivery is its own smell and is out of scope here.
6. There is a second delivery channel. `apiSession.ts:256` builds
   `receiveSync` over `fetchMessages()`, a REST pull against
   `GET /v1/sessions/:sessionId/messages`. Any design that gates only the
   socket layer is incomplete.
7. There is a natural acquisition door. `POST /v1/sessions` is get or create
   on the unique key `(accountId, tag)`
   (`happy-cos/packages/happy-server/prisma/schema.prisma:113`, route at
   `sources/app/api/routes/sessionRoutes.ts:222` region). Every CLI passes
   through it before executing.
8. Reusable primitives exist. Heartbeats flow through `activityCache` into
   `lastActiveAt` and `active`, and `sources/app/presence/timeout.ts:19` already
   performs a conditional `updateManyAndReturn`, which is a compare and swap
   idiom this codebase already uses. Its sweep window is 10 minutes
   (same file, line 14), which is too slow to serve as a lease expiry.
9. Why server-only exclusivity is impossible. The owner's own reconnect is
   indistinguishable from a second process. The CLI retries 1 second after a
   drop and every 3 seconds after that
   (`apiSession.ts:1057` to `1078`, with `reconnection: false` at line 279 so
   each attempt is a new connection), while the server may keep the dead socket
   in the room for up to about 60 seconds
   (`pingInterval: 15000` plus `pingTimeout: 45000`,
   `happy-cos/packages/happy-server/sources/app/api/socket.ts` server options).
   The handshake carries only `token`, `clientType`, `sessionId` and
   `happyClient` (`apiSession.ts:272` to `277`), which are identical across two
   processes for one session. Refusing the newcomer would therefore let a one
   second network blip terminate a live session.
10. The eviction variant is worse. Admitting the newcomer and disconnecting the
    incumbent produces an eviction war, because the evicted process is alive and
    its own reconnect fires 1 second later (fact 9), so the two processes
    alternate ownership and both execute.

11. Renewal cadence is ample, but delivery is best effort. A live session emits
    `session-alive` every 2 seconds (`happy/packages/happy-cli/src/claude/session.ts:73`
    to `75`, with the first call at line 72), which renews a 60 second lease
    about 30 times over. However the emit is `socket.volatile.emit`
    (`apiSession.ts:912`), which Socket.IO defines as best effort with no
    buffering, so renewals are silently dropped while the socket is down. A
    network outage longer than the lease duration therefore expires the lease of
    a process that is still alive and still executing.
12. An expired lease is not by itself contention. If nobody else claims during
    the outage, the original owner reconnects (fact 9, 1 to 3 seconds) and finds
    its own token still written on the row with a past expiry.

## Decisions

All four were Kari's, taken during the design conversation on 2026-10-02.

1. A losing claimant refuses to start, rather than running as an observer or
   taking over from the incumbent. Takeover is allowed only when the incumbent
   is provably gone. This removes any need for a kill path, which is what 9j's
   standing recommendation asked for.
2. Liveness model is a database lease with instant release on clean exit. The
   row is the authority, with a short expiry renewed by the heartbeats that
   already exist. A clean exit releases at once. A hard crash waits out the
   expiry. A network blip does not release.
3. Threat model is reliability, not security. This protects against racing
   processes under one account, all authenticated with the account token. Punch
   row 9h, the daemon's local control server lacking caller authentication,
   stays a separate item. It is not a prerequisite, because duplicate execution
   runs through the server's authenticated socket and REST API rather than
   through the daemon's local control server.
4. Staging is C-prime: ship detection now, enforce at the already planned
   restart. Detection is server-only and changes no behavior. Enforcement needs
   a per-process identifier in the handshake, therefore a CLI change, a new
   build and a daemon restart, which is batched with the 9l and row 13 cutover
   that Kari already deferred for this reason.

## Piece 1: contention detection, ship now

Server only, `happy-cos/packages/happy-server`. Changes no behavior.

When a session-scoped connection is registered, count the session-scoped
occupants of `user:{userId}:session:{sessionId}`. If the count exceeds one,
emit a structured warning and increment a counter.

Design constraints, each with a reason:

- Detection must never delay or fail a connection. The occupant lookup is
  asynchronous, and `socket.ts` already documents that work between connect and
  handler attachment creates a window where client events are silently dropped.
  So the lookup runs as fire and forget with its own `catch`, after handlers are
  attached, never awaited in the connection path.
- Count after the newcomer has joined, so contention is `count > 1` rather than
  `count > 0`, which avoids a read that races the join.
- Filter on `s.data.clientType === 'session-scoped'`. Room occupancy should
  already be session-scoped only, because user-scoped sockets join a different
  room and the fanout filter unions rooms at emit time (fact 3), but the filter
  makes the detector independent of that invariant rather than dependent on it.
- Log per occupant: connection age and `happyClient`. Age is the only available
  signal that separates a long lived original owner from a freshly arrived
  claimant. Neither is proof, and the log should not claim it is.

Metric: a counter of contention events, labelled by nothing user identifying.

What this buys: a census rather than an inference. Restarting the server empties
all rooms, so every live session reconnects and rejoins, one socket per session.
Any session that produces two occupants after that is a live duplicate, which
directly measures whether the 9l survivors Kari already knows about are
currently doubled up.

## Piece 2: the lease, at the planned restart

Spans both repos.

Server, `happy-cos/packages/happy-server`:

- Schema: add nullable `ownerToken`, `ownerExpiresAt` and `ownerClient` to
  `Session`. Migration runs against PGlite.
- Claim at `POST /v1/sessions`, inside a transaction. If the session has a live
  owner, meaning `ownerExpiresAt` is in the future, and the presented
  `ownerToken` differs, respond 409 with the incumbent's client string and
  expiry, and do not alter the row. Otherwise write the presented token and set
  `ownerExpiresAt` to now plus the lease duration.
- Socket admission: a session-scoped handshake must present an `ownerToken`
  matching the row's live owner, or be rejected with a distinct error code the
  CLI can recognise.
- Renewal: the existing `session-alive` path extends `ownerExpiresAt`, and its
  response must be able to tell the caller it no longer owns the session.
- Admission also renews. Because renewal delivery is best effort (fact 11), a
  successful session-scoped handshake must itself extend `ownerExpiresAt`. The
  owner reconnects every 1 to 3 seconds, so admission-renewal covers any blip
  that volatile renewal drops.
- An expired but uncontested lease is re-claimable by the same token. Admission
  succeeds when the presented token matches the row even if `ownerExpiresAt` has
  passed, provided no different token has claimed in the meantime, and that
  admission re-extends the expiry (fact 12). Writing this rule down is the point:
  the strict reading, where admission requires an unexpired owner, would
  terminate a live session after any outage longer than the lease, which is the
  failure this design exists to avoid.
- Release: clear the owner on explicit, client initiated disconnect only.
  Socket.IO's disconnect reason distinguishes an explicit namespace disconnect
  from `transport close` and `ping timeout`. Releasing on the explicit reasons
  gives the instant clean release of decision 2, and declining to release on the
  network reasons is what keeps a blip from handing the session away. This
  distinction is the mechanism that makes enforcement safe where the rejected
  socket-only approach was not (facts 9 and 10).

CLI, `happy/packages/happy-cli`:

- Generate one `ownerToken` per process at startup.
- Send it in the `POST /v1/sessions` body and in the socket handshake auth.
- On a 409 at claim time, exit with a plain message naming the incumbent, per
  decision 1.
- On a lost-lease answer from renewal, stop executing and exit.

Lease duration: 60 seconds, renewed by heartbeat. Chosen so a hard crash costs
at most about a minute before a phone initiated resume succeeds, against the
10 minute sweep that exists today (fact 8). The sweeper is not reused for
expiry, and is left alone.

Open item requiring a decision before Piece 2 implementation: what the server
does with a session-scoped connection that presents no `ownerToken` at all,
which is every CLI build predating this change. Tolerating it preserves other
worktrees that may launch older builds, at the cost of an unenforced path.
Refusing it is strict but will break those worktrees until each is rebuilt.
Recommendation is to tolerate and log for one release, with a server setting to
flip to strict, but Kari has not been asked yet.

## Testing

Piece 1:

- Unit: two session-scoped connections to one session increment the counter and
  log; a single connection does not; a user-scoped connection alongside a
  session-scoped one does not.
- Mutation proof, required before the work counts as done: blind the
  `clientType` filter so it can never match and confirm the contention test
  reddens, and separately force the predicate false and confirm the same. A
  detector that silently matches nothing must fail its own test, per the
  non-vacuity standard used in punch row 9q.

Piece 2:

- Unit: claim succeeds on a free session; claim returns 409 against a live
  owner; claim succeeds once the expiry has passed; renewal extends expiry;
  renewal against a session owned by someone else reports loss.
- Unit: the same token re-claims an expired but uncontested lease and the expiry
  is extended; a different token claiming first blocks that re-claim.
- Unit: release fires on an explicit disconnect reason and does not fire on
  `transport close` or `ping timeout`. This is the blip safety property and it
  gets its own mutation proof, by inverting the reason check and confirming the
  test reddens.
- Integration is deliberately excluded. Punch rows 9m, 9o and 12 record that the
  daemon integration suite spawns real paid agent sessions and reads live daemon
  state, so it is not run here.

## Deployment

Piece 1: restart the local server only. The server is supervised, with the chain
pnpm (15416) to tsx (15429) to node (15430) under parent 15390, and
`happy-cos/scripts/launcher/engine-supervisor.sh` exists, so the restart goes
through the launcher rather than killing the node pid directly. The exact
command must be read out of that script at deploy time rather than assumed. The
daemon is not restarted and keeps running. Live sessions do drop their server
socket and reconnect within about 1 to 3 seconds (fact 9), so this is brief
disruption rather than none.

Piece 2: rides the already planned daemon restart for the 9l and row 13
cutover. Requires a CLI rebuild first.

Recurring cost of both pieces: none. An in-process counter and a database column
add no scheduled work and no paid API calls.

## Out of scope

- Punch row 9h, the daemon control server's absent caller authentication, per
  decision 3.
- The arbitrary `targets[0]` choice in RPC routing, fact 5.
- Replacing the 10 minute presence sweeper.
- The REST message fetch path, fact 6. With refusal at the acquisition door a
  non-owner never reaches it, and a process that loses its lease mid-run exits
  on the renewal answer instead. The phone app uses those same endpoints to
  display conversations, so gating them would require an app-side protocol
  change.
