# 9j scoping: server-side session ownership lease

Scoped on Sonnet-5 2026-10-02 per Kari's instruction to switch to Opus for the
actual lease design. This is pre-design fact-gathering only, not a design.

## What 9j is

Punch list row 9j (`c-suite/punch-lists/happy-reliability.md`), status BLOCKED.
Second independent Codex review of `028435e2..0f4b301e` found the merged claim
fix only narrows duplicate session execution, it does not close it: it stops a
second webhook claimant joining ONE running daemon's in-memory registry, but
there is no atomic ownership claim at the delivery/server layer, so duplicate
delivery that originates server-side, or spans separate daemons/machines, can
still produce two live processes for one session.

**Pending recommendation already on the row, not yet actioned by Kari:**
delete the webhook kill path entirely (refuse-to-register is enough to stop
the fanout; the first review's own reasoning already supports this) and move
durable dedupe to a server-side ownership lease. That deletion is independent
of the lease timeline and could be decided now.

Review cap N=2 was reached on the BLOCK; a round-3 review needs Kari's
go-ahead, and any new lease design will need its own fresh review pass
(mandatory Codex high-stakes dispatch, security-critical work).

## Architecture facts verified this session (not inferred)

- `happy/packages/happy-server` is the only component that is a real
  multi-device server (`README.md`): "Minimal backend for open-source
  end-to-end encrypted Claude Code clients... zero knowledge... Multi-device."
  It is the one thing every daemon/client instance for an account talks
  through, which makes it the only plausible home for a lease that needs to
  work across daemons/machines, not just within one daemon's process memory.
- `prisma/schema.prisma` `model Session` (line 95): columns are `id`, `tag`,
  `accountId`, `projectId`, `metadata` (opaque `String`, E2E-encrypted),
  `metadataVersion`, `agentState` (opaque), `agentStateVersion`,
  `dataEncryptionKey`, `seq`, `active` (`Boolean`), `lastActiveAt`,
  `createdAt`, `updatedAt`. No owner/claimant/lease field exists today.
  `active` and `lastActiveAt` are the closest existing precedent for
  server-held, non-content session state. Adding something like
  `ownerId`/`leaseExpiresAt` as plaintext columns would be consistent with
  that precedent, not a new category of server knowledge.
- The daemon's local control server (`packages/happy-cli/src/daemon/controlServer.ts`)
  has no caller authentication at all (row 9h, confirmed against source
  2026-10-01): `POST /session-started` takes `metadata: z.any()`, zero hits
  for `auth|token|bearer|secret|verify` in the file, and the port is read
  from a world-readable state file. A lease that can be claimed by an
  unauthenticated local caller does not close the gap 9j describes, so 9h's
  lack of authentication is a prerequisite or parallel-track fix, not a
  separate concern.
- Current merged fix (9l, `de733b13` on `origin/main`) persists claims as
  PID plus OS start-time pairs in the daemon's own state, rehydrated at boot.
  That is deliberately per-daemon (per the row's own text: "still per-daemon
  rather than the server-side lease (9j)"). It does not and cannot cover
  cross-daemon or cross-machine duplicate delivery.

## Open design questions for the Opus pass

1. Where does the lease actually live: `happy-server` (Postgres, via Prisma),
   or something lighter the server mediates? Given the facts above, server-held
   is the only option that closes the cross-daemon gap; worth confirming there
   isn't a simpler mediating primitive (e.g. a single compare-and-swap on an
   existing field) before adding new schema.
2. Claim/lease lifecycle: acquire, heartbeat/renew cadence, expiry on daemon
   crash, and the legitimate-takeover case (user intentionally resumes the
   same session on a new device) vs. the accidental-duplicate case (same
   daemon or same account racing). These need different outcomes.
3. How row 9h's authentication gap gets closed in the same design: a lease
   is only as trustworthy as the identity backing a claim request.
4. Backward compatibility: older CLI/daemon builds that don't speak the lease
   protocol at all.
5. Whether the webhook-kill-path deletion (the pending recommendation) ships
   now, independent of lease timeline, or waits to ship together. This part
   does not need Opus, it needs a yes/no from Kari.

## Not done here

No design decisions, no schema changes, no code. This branch
(`scope/9j-ownership-lease`, cut from `origin/main`) holds only this note.
