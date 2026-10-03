# On-device build checklist

Run this on your phone after installing any new EAS build or OTA update,
before calling that build "done." About 2 minutes. If anything fails,
the build is not done yet; go fix it first.

This exists because a new build can pass every automated test and still
break a daily flow nothing automated checks (the build gate, from the
happy-reliability-overhaul manifest, workstream 6).

## The checklist

1. **App opens to your session list.** Not stuck on a loading spinner,
   not bounced back to the QR auth screen.
2. **Open an existing chat.** History loads and scrolls. If it's empty
   or stuck loading, stop here: that's a sync/encryption regression.
3. **Send a message in that chat and get a real reply.** Not just
   "sending..." forever.
4. **Create a brand new chat from scratch.** This exercises the daemon
   spawn path specifically, not just an already-open session.
5. **Tap dictation/mic.** One of two things must happen, never a silent
   nothing: it transcribes your speech into the text box, or it shows a
   clear error (mic permission denied, prompt to open Settings; STT
   down, text box still works, just no transcription).
6. **If this build touched a specific feature, test that feature
   explicitly first,** before the generic checks above. A build that
   passes 1-5 but breaks the one thing it was supposed to change is
   not done.

## What this does NOT replace

- Automated tests (`pnpm test`, `tsc --noEmit`) still run before a build
  ships. This is the on-device check nothing automated reaches, not a
  substitute for it.
- Codex's high-stakes review pass on relay/DB changes, which runs before
  merge, not after a build is already on your phone.
