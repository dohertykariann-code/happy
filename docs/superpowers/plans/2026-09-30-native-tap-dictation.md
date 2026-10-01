# Native Tap Dictation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ElevenLabs realtime voice button in the session composer with native tap-to-start / tap-to-stop dictation that records WAV on device, posts it to the already-running local whisper sidecar, and inserts the transcript into the composer.

**Architecture:** `expo-audio` records 16 kHz mono LINEARPCM to a file; the file's bytes are read with `expo-file-system` and POSTed as `audio/wav` to `getServerUrl() + '/stt/transcribe'`, which Caddy proxies to the whisper sidecar. The platform-agnostic transcription and WAV helpers are recovered from the parked branch rather than rewritten. A single `useVoiceDictation` hook owns an explicit state machine so the one mic button can mean start, stop, or busy.

**Tech Stack:** React Native / Expo, `expo-audio` 55.0.9, `expo-file-system` 55.0.11, TypeScript, vitest.

**Spec:** `~/.claude/c-suite/prebuild/happy-reliability-overhaul-manifest.md`, workstream 2 ("Native dictation (app)"). Its open question Q2 (dictation feel) was answered by Kari on 2026-09-30: **tap to start, tap to stop.** Hold-to-talk is explicitly rejected and must not be implemented.

## Global Constraints

- **Repo is `~/code/happy`**, the canonical app. `~/code/happy-cos/packages/happy-app/` is DEAD CODE per that repo's `CLAUDE.md`; do not touch it.
- **The only client is the installed native iOS app.** There is no web client to preserve. Anything that only works under a browser origin is not a solution.
- **Do not add dependencies.** `expo-audio` 55.0.9 and `expo-file-system` 55.0.11 are already installed at the workspace root. Keep exact versions; do not bump.
- **The STT backend already exists and is running.** Caddy routes `/stt/*` to `127.0.0.1:8123` with the prefix stripped (`~/code/happy-cos/scripts/launcher/Caddyfile:28-30`), and the sidecar serves `/transcribe` at its root. Do not build, modify or restart any server-side component.
- **Audio must be 16 kHz mono 16-bit.** The sidecar's own body cap comments this shape (`~/code/happy-cos/scripts/stt/server.mjs:30`, 25 MB is about 13 min at 16 kHz mono 16-bit).
- **Request size.** Keep a client-side duration cap well under the 25 MB body limit.
- **Tests run with vitest** from `packages/happy-app`. Pure logic must be unit-testable in the node environment, so no React or native module imports in the transcription or encoding helpers.
- Use 4 spaces for indentation, matching the surrounding app sources.
- No `Co-Authored-By` or generated-by trailers in commits (`profile.yaml: include_co_authored_by: false`).

## Recovered prior art

Commit `69b6deb9` on branch `parked/web-only-dictation-69b6deb9` (pushed to origin) contains a web-only version of this feature. It was parked because it used `getUserMedia`/`AudioContext`. Measured reuse:

| File | Web APIs | Verdict |
|---|---|---|
| `realtime/audioRecorder.ts` (63 lines) | 5 | **Discard.** This is the web-only part. |
| `realtime/transcribeWav.ts` (35 lines) | 0 | **Reuse**, with one change (see Task 1). |
| `realtime/useVoiceDictation.ts` (72 lines) | 0 | **Reuse as a starting point**, rework the state machine for tap/tap. |
| `utils/wavEncode.ts` (59 lines) | 1 | **Reuse unchanged.** Its only "web" hit is a doc comment mentioning `AudioContext.sampleRate`. |

Retrieve a file with:
```bash
git show parked/web-only-dictation-69b6deb9:packages/happy-app/sources/realtime/transcribeWav.ts
```

**Known defect in the parked `transcribeWav`:** it defaults to the relative path `'/stt/transcribe'`. That resolves against a browser origin and is meaningless in a native app. Task 1 fixes this.

**Note on `wavEncode`:** it exists because Web Audio hands back raw Float32 PCM that needs a WAV container. On iOS, `expo-audio` with `extension: '.wav'` and `ios.outputFormat: LINEARPCM` writes a real WAV file, so the encoder is **not** on the native recording path. Port it anyway (Task 1) because its tests are cheap, it is already written, and Task 5 asserts against a real recording whether the container is genuinely WAV. If that assertion shows iOS is NOT producing a usable WAV header, `wavEncode` is the fallback and Task 5 says so.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/happy-app/sources/utils/wavEncode.ts` | Float32 PCM to WAV container | Create (port from parked branch, unchanged) |
| `packages/happy-app/sources/utils/wavEncode.test.ts` | Its tests | Create (port from parked branch) |
| `packages/happy-app/sources/realtime/transcribeWav.ts` | POST bytes to the sidecar, return transcript | Create (port, absolute endpoint) |
| `packages/happy-app/sources/realtime/transcribeWav.test.ts` | Its tests | Create (port, plus endpoint cases) |
| `packages/happy-app/sources/realtime/nativeAudioRecorder.ts` | expo-audio capture to a WAV file, read bytes | Create |
| `packages/happy-app/sources/realtime/dictationMachine.ts` | Pure tap/tap state machine | Create |
| `packages/happy-app/sources/realtime/dictationMachine.test.ts` | Its tests | Create |
| `packages/happy-app/sources/realtime/useVoiceDictation.ts` | Hook binding recorder plus machine plus transcription | Create |
| `packages/happy-app/sources/-session/SessionView.tsx` | Session UI; owns the composer mic button | Modify: replace the ElevenLabs mic handler |

The state machine is deliberately split from the hook so the tap/tap logic is testable in node without a native module or a React renderer. That split is the main reason this plan is cheap to verify.

---

### Task 1: Recover the platform-agnostic helpers and fix the endpoint

**Files:**
- Create: `packages/happy-app/sources/utils/wavEncode.ts`, `packages/happy-app/sources/utils/wavEncode.test.ts`
- Create: `packages/happy-app/sources/realtime/transcribeWav.ts`, `packages/happy-app/sources/realtime/transcribeWav.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `transcribeWav(body: Uint8Array | Blob, token: string | undefined, opts?: TranscribeOptions): Promise<string | null>` where `TranscribeOptions = { fetchImpl?: typeof fetch; signal?: AbortSignal; endpoint?: string }`. Also an encoder from `wavEncode.ts`. Whatever the parked signatures actually are, copy them verbatim and report them; this plan read those files but could still have transcribed a name imprecisely.

- [ ] **Step 1: Port the two helpers and their tests verbatim**

```bash
cd ~/code/happy
for f in utils/wavEncode.ts utils/wavEncode.test.ts realtime/transcribeWav.ts realtime/transcribeWav.test.ts; do
  git show "parked/web-only-dictation-69b6deb9:packages/happy-app/sources/$f" > "packages/happy-app/sources/$f"
done
```

Do not edit them yet. Read all four and report the exact exported signatures, because later tasks depend on the real names rather than this plan's guess.

- [ ] **Step 2: Run the ported tests to confirm the baseline is green**

```bash
cd ~/code/happy/packages/happy-app && pnpm vitest run sources/utils/wavEncode.test.ts sources/realtime/transcribeWav.test.ts
```

Expected: PASS. If they fail, the port is wrong (wrong path, missing import). Fix the port, do not modify the tests.

- [ ] **Step 3: Write the failing test for an absolute endpoint**

Add to `transcribeWav.test.ts`:

```ts
it('posts to an absolute endpoint when one is given', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
        calls.push(String(url));
        return { ok: true, json: async () => ({ text: 'hello' }) };
    }) as unknown as typeof fetch;

    const result = await transcribeWav(new Uint8Array([1, 2, 3]), undefined, {
        fetchImpl,
        endpoint: 'https://example.test:8443/stt/transcribe',
    });

    expect(result).toBe('hello');
    expect(calls).toEqual(['https://example.test:8443/stt/transcribe']);
});

it('refuses a relative endpoint, which cannot resolve in a native app', async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ text: 'x' }) })) as unknown as typeof fetch;
    await expect(
        transcribeWav(new Uint8Array([1]), undefined, { fetchImpl, endpoint: '/stt/transcribe' }),
    ).rejects.toThrow(/absolute/i);
});
```

- [ ] **Step 4: Run it and watch it fail**

```bash
cd ~/code/happy/packages/happy-app && pnpm vitest run sources/realtime/transcribeWav.test.ts
```

Expected: the second case FAILS, because the parked version accepts a relative default.

- [ ] **Step 5: Make the endpoint required and absolute**

In `transcribeWav.ts`: remove the `'/stt/transcribe'` default, require `opts.endpoint`, and reject a value that is not absolute. Accept `Uint8Array` as well as `Blob` for the body, since the native path supplies bytes.

```ts
const endpoint = opts.endpoint;
if (!endpoint || !/^https?:\/\//i.test(endpoint)) {
    throw new Error(
        `transcribeWav needs an absolute endpoint; got ${endpoint ?? 'undefined'}. ` +
        `A relative path only resolves against a browser origin, and this app is native.`,
    );
}
```

Keep everything else as ported: `Content-Type: audio/wav`, optional bearer token, throw on non-OK, return the trimmed text or `null` when empty.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd ~/code/happy/packages/happy-app && pnpm vitest run sources/utils/wavEncode.test.ts sources/realtime/transcribeWav.test.ts
```

Expected: PASS, including both new cases.

- [ ] **Step 7: Commit**

```bash
cd ~/code/happy
git add packages/happy-app/sources/utils/wavEncode.ts packages/happy-app/sources/utils/wavEncode.test.ts packages/happy-app/sources/realtime/transcribeWav.ts packages/happy-app/sources/realtime/transcribeWav.test.ts
git commit -m "feat(app): recover WAV helpers from the parked branch, require an absolute STT endpoint"
```

---

### Task 2: Native WAV capture with expo-audio

**Files:**
- Create: `packages/happy-app/sources/realtime/nativeAudioRecorder.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `DICTATION_RECORDING_OPTIONS: RecordingOptions`, the exact options object, exported so a test can assert its shape.
  - `readRecordingBytes(uri: string): Promise<Uint8Array>`
  - `MAX_DICTATION_SECONDS: number`

**Verified API, measured from the installed type definitions. Do not re-derive and do not guess alternatives:**
- `useAudioRecorder(options: RecordingOptions, statusListener?): AudioRecorder` (`expo-audio/build/ExpoAudio.d.ts:145`)
- `AudioRecorder` has `record(): void`, `stop(): Promise<void>`, `uri: string | null`, `isRecording: boolean` (`AudioModule.types.d.ts:220-270`)
- `requestRecordingPermissionsAsync()` is exported from `expo-audio`
- `RecordingOptions` requires `extension`, `sampleRate`, `numberOfChannels`; `ios.outputFormat` and `ios.audioQuality` exist (`Audio.types.d.ts:331-418`)
- `IOSOutputFormat.LINEARPCM === 'lpcm'` (`RecordingConstants.d.ts:13`)

- [ ] **Step 1: Write the options object and a test for its shape**

Create `nativeAudioRecorder.ts`:

```ts
import { IOSOutputFormat, type RecordingOptions } from 'expo-audio';
import * as FileSystem from 'expo-file-system';

/** Whisper wants 16 kHz mono. The sidecar's 25 MB cap is about 13 min at this shape. */
export const DICTATION_RECORDING_OPTIONS: RecordingOptions = {
    extension: '.wav',
    sampleRate: 16000,
    numberOfChannels: 1,
    isMeteringEnabled: true,
    ios: {
        outputFormat: IOSOutputFormat.LINEARPCM,
        audioQuality: 96,
        linearPCMBitDepth: 16,
        linearPCMIsBigEndian: false,
        linearPCMIsFloat: false,
    },
} as RecordingOptions;

/** Hard stop so a forgotten open mic cannot exceed the sidecar's body limit. */
export const MAX_DICTATION_SECONDS = 120;
```

If any `ios` sub-field above is not in the installed `RecordingOptions` type, remove that field rather than casting it away, and report which ones you removed. Do not silence a type error with `any`.

Add a small test asserting the constant:

```ts
it('records 16 kHz mono WAV, which is what the sidecar expects', () => {
    expect(DICTATION_RECORDING_OPTIONS.extension).toBe('.wav');
    expect(DICTATION_RECORDING_OPTIONS.sampleRate).toBe(16000);
    expect(DICTATION_RECORDING_OPTIONS.numberOfChannels).toBe(1);
});
```

- [ ] **Step 2: Implement the byte reader**

```ts
/**
 * Read a finished recording as bytes. The native recorder hands back a file
 * URI, not a Blob, so the transcription call needs the contents read out.
 */
export async function readRecordingBytes(uri: string): Promise<Uint8Array> {
    const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
    });
    const binary = globalThis.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
```

`expo-file-system` 55 may expose a newer file API alongside the legacy one. Check `node_modules/expo-file-system/build/FileSystem.d.ts` for what is actually exported before committing to `readAsStringAsync`, and if a direct bytes read exists, prefer it and drop the base64 hop. Report which API you used and why.

- [ ] **Step 3: Typecheck**

```bash
cd ~/code/happy/packages/happy-app && pnpm tsc --noEmit
```

Expected: clean. A type error here means an assumed field does not exist; fix by removing the field, not by casting.

- [ ] **Step 4: Commit**

```bash
cd ~/code/happy
git add packages/happy-app/sources/realtime/nativeAudioRecorder.ts
git commit -m "feat(app): native 16kHz mono WAV capture options and byte reader"
```

**Open question this task must not assume away:** does iOS with these options actually write a parseable WAV header? It is asserted on real hardware in Task 5 Step 3, with a named fallback.

---

### Task 3: The tap-to-start / tap-to-stop state machine

**Files:**
- Create: `packages/happy-app/sources/realtime/dictationMachine.ts`
- Create: `packages/happy-app/sources/realtime/dictationMachine.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type DictationState = 'idle' | 'recording' | 'transcribing' | 'error'`
  - `type DictationEvent = { type: 'TAP' } | { type: 'STOPPED' } | { type: 'TRANSCRIBED' } | { type: 'FAILED'; message: string } | { type: 'RESET' }`
  - `nextDictationState(state: DictationState, event: DictationEvent): DictationState`
  - `micButtonLabel(state: DictationState): string`

Kari chose tap/tap, so one button carries three meanings and the machine is what keeps that honest. The rule that matters: **a tap while transcribing must be ignored**, or a fast double tap sends two requests and inserts the transcript twice.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { nextDictationState, micButtonLabel } from './dictationMachine';

describe('dictation machine', () => {
    it('starts recording on the first tap', () => {
        expect(nextDictationState('idle', { type: 'TAP' })).toBe('recording');
    });

    it('stops recording on the second tap and waits for the transcript', () => {
        expect(nextDictationState('recording', { type: 'TAP' })).toBe('transcribing');
    });

    it('ignores a tap while transcribing, so a double tap cannot double-send', () => {
        expect(nextDictationState('transcribing', { type: 'TAP' })).toBe('transcribing');
    });

    it('returns to idle once the transcript arrives', () => {
        expect(nextDictationState('transcribing', { type: 'TRANSCRIBED' })).toBe('idle');
    });

    it('surfaces a failure instead of silently returning to idle', () => {
        expect(nextDictationState('transcribing', { type: 'FAILED', message: 'STT 500' })).toBe('error');
    });

    it('lets a tap retry from the error state', () => {
        expect(nextDictationState('error', { type: 'TAP' })).toBe('recording');
    });

    it('labels the button differently in each state', () => {
        const labels = (['idle', 'recording', 'transcribing', 'error'] as const).map(micButtonLabel);
        expect(new Set(labels).size).toBe(4);
    });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd ~/code/happy/packages/happy-app && pnpm vitest run sources/realtime/dictationMachine.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement the machine**

```ts
export type DictationState = 'idle' | 'recording' | 'transcribing' | 'error';

export type DictationEvent =
    | { type: 'TAP' }
    | { type: 'STOPPED' }
    | { type: 'TRANSCRIBED' }
    | { type: 'FAILED'; message: string }
    | { type: 'RESET' };

/**
 * Tap to start, tap to stop (Kari's choice, 2026-09-30; hold-to-talk was
 * rejected). A tap during transcription is deliberately swallowed: the one
 * button means three things, and without this a fast double tap would post
 * the audio twice and insert the transcript twice.
 */
export function nextDictationState(state: DictationState, event: DictationEvent): DictationState {
    switch (event.type) {
        case 'TAP':
            if (state === 'idle' || state === 'error') return 'recording';
            if (state === 'recording') return 'transcribing';
            return state;
        case 'STOPPED':
            return state === 'recording' ? 'transcribing' : state;
        case 'TRANSCRIBED':
            return 'idle';
        case 'FAILED':
            return 'error';
        case 'RESET':
            return 'idle';
    }
}

export function micButtonLabel(state: DictationState): string {
    switch (state) {
        case 'idle': return 'Start dictation';
        case 'recording': return 'Stop dictation';
        case 'transcribing': return 'Transcribing';
        case 'error': return 'Dictation failed, tap to retry';
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd ~/code/happy/packages/happy-app && pnpm vitest run sources/realtime/dictationMachine.test.ts
```

Expected: PASS, 7 cases.

- [ ] **Step 5: Prove the double-tap guard is load-bearing**

Temporarily change the `TAP` case so `transcribing` returns `'recording'`, re-run, and confirm the "ignores a tap while transcribing" case FAILS. Revert. Paste both outputs. A guard whose test never fails is not a guard.

- [ ] **Step 6: Commit**

```bash
cd ~/code/happy
git add packages/happy-app/sources/realtime/dictationMachine.ts packages/happy-app/sources/realtime/dictationMachine.test.ts
git commit -m "feat(app): tap-to-start/tap-to-stop dictation state machine"
```

---

### Task 4: The hook, and replacing the ElevenLabs mic button

**Files:**
- Create: `packages/happy-app/sources/realtime/useVoiceDictation.ts`
- Modify: `packages/happy-app/sources/-session/SessionView.tsx` (the mic handler near `handleMicrophonePress`, about line 934; locate it by reading, line numbers will have moved)

**Interfaces:**
- Consumes: `nextDictationState`, `micButtonLabel` (Task 3); `DICTATION_RECORDING_OPTIONS`, `readRecordingBytes`, `MAX_DICTATION_SECONDS` (Task 2); `transcribeWav` (Task 1); `getServerUrl` from `@/sync/serverConfig`.
- Produces: `useVoiceDictation({ onTranscript }: { onTranscript: (text: string) => void }): { state: DictationState; label: string; onMicPress: () => void; error: string | null }`

- [ ] **Step 1: Read the parked hook first**

```bash
cd ~/code/happy && git show parked/web-only-dictation-69b6deb9:packages/happy-app/sources/realtime/useVoiceDictation.ts
```

It is 72 lines and has no web APIs, so its structure (timeout wiring, abort handling, token lookup) is reusable. Keep what applies; replace its recorder calls with `expo-audio` and its implicit state handling with the Task 3 machine. Report what you kept versus replaced.

- [ ] **Step 2: Implement the hook**

Requirements, each of which exists for a reason:

1. Call `requestRecordingPermissionsAsync()` before the first recording and route a denial to `FAILED` with a message naming the permission. A silent no-op mic is the worst outcome.
2. Build the endpoint as `getServerUrl() + '/stt/transcribe'`. Never a relative path; Task 1 now throws on one.
3. Pass the auth token the parked hook used, if it used one. Check how sibling modules in `sources/sync/` obtain it and follow that, rather than inventing a new lookup.
4. Enforce `MAX_DICTATION_SECONDS` with a timer that stops the recording and proceeds to transcription, so an open mic cannot exceed the sidecar's body cap.
5. Wire an `AbortSignal` into `transcribeWav` and abort it on unmount.
6. On success with a non-empty transcript, call `onTranscript(text)` and dispatch `TRANSCRIBED`. On an empty transcript (the helper returns `null`), go to `idle` without calling `onTranscript`.
7. On any throw, dispatch `FAILED` with the message and keep it in `error` for the UI. Per the manifest's observability item, dictation failure must be surfaced, not silent.
8. Delete the temporary recording file after reading its bytes.

- [ ] **Step 3: Replace the ElevenLabs mic handler in SessionView**

Read `handleMicrophonePress` and the surrounding memoized mic state (search for `handleMicrophonePress` and `elevenlabs_conversation_id`). Replace that handler with `onMicPress` from the hook, and feed `onTranscript` into the composer's existing text-setting path so the transcript lands in the input where Kari can edit before sending. **Do not auto-send.**

Per the manifest, the ElevenLabs button is replaced entirely. Remove the now-dead ElevenLabs realtime handler and any imports it alone used. Do not remove unrelated voice code: `RealtimeVoiceSession`, `VoiceAssistantStatusBar` and `VoiceBars` may have other callers. Grep for each before deleting anything, and if a file still has a caller, leave it.

- [ ] **Step 4: Typecheck and run the full app suite**

```bash
cd ~/code/happy/packages/happy-app && pnpm tsc --noEmit && pnpm vitest run
```

Expected: typecheck clean, suite green with no pre-existing test broken. Record the before and after test counts.

- [ ] **Step 5: Remove unused imports and commit**

```bash
cd ~/code/happy
git add packages/happy-app/sources/realtime/useVoiceDictation.ts packages/happy-app/sources/-session/SessionView.tsx
git commit -m "feat(app): native tap dictation in the composer, replacing the ElevenLabs mic"
```

---

### Task 5: Prove it on the device

Unit tests cannot show that a real iPhone records audio the sidecar can transcribe. Nothing in this plan is done until this task passes on hardware.

**Files:** none. This task is a verification gate.

- [ ] **Step 1: Confirm the backend is up before blaming the app**

```bash
for p in 8123 8124; do printf "port %s: " $p; lsof -ti tcp:$p -sTCP:LISTEN >/dev/null 2>&1 && echo LISTENING || echo DOWN; done
```

Expected: both LISTENING. They were on 2026-09-30. If either is down, stop: that is the supervisor's business, not the app's.

- [ ] **Step 2: Prove the sidecar transcribes a known WAV, independent of the app**

Record or synthesise a short 16 kHz mono WAV on the Mac, POST it directly, and confirm a transcript comes back. This isolates the sidecar from the app so a later failure is attributable.

```bash
curl -s -X POST --data-binary @/private/tmp/sample.wav \
  -H 'Content-Type: audio/wav' \
  http://127.0.0.1:8123/transcribe
```

Expected: JSON with a `text` field. Record the exact output.

- [ ] **Step 3: Confirm iOS actually writes a parseable WAV**

This is Task 2's open question. On the device build, record a short clip and inspect the first bytes of the produced file before transcription: a WAV begins with `RIFF` and contains `WAVE`. Log the first 12 bytes once, behind a temporary debug line, or assert it in the hook during this verification pass.

If it is NOT RIFF/WAVE, **stop and report.** The fallback is to feed the raw PCM through `wavEncode` from Task 1 rather than improvise a container. Do not ship a guess.

- [ ] **Step 4: EAS build and install**

This costs build minutes, so do it once, after Tasks 1 to 4 are green. Use the same profile as the 2026-09-27 build (`6f64ebaf`) unless Kari says otherwise. Confirm with her before starting the build, since it is the step that spends money.

- [ ] **Step 5: On-device checklist, all of it, on the real phone**

- [ ] Tap the mic: it visibly enters recording state.
- [ ] Speak a sentence, tap again: it enters transcribing, then the text appears in the composer.
- [ ] The transcript is **not** auto-sent; it is editable first.
- [ ] Tap rapidly twice while transcribing: exactly one transcript is inserted.
- [ ] Deny the microphone permission: a visible error appears, not a dead button.
- [ ] Airplane mode or sidecar stopped: a visible error appears, and the button recovers on the next tap.
- [ ] Record for over `MAX_DICTATION_SECONDS`: it stops itself and still transcribes.
- [ ] The old ElevenLabs button is gone, and nothing else in the composer regressed.

- [ ] **Step 6: Report, do not self-certify**

Paste the checklist with real results, the Step 2 sidecar output, and the Step 3 byte check. Any unticked box means not done. Then dispatch an independent review pass: this touches the session composer, which is the surface Kari uses most.

---

## Self-Review

**Spec coverage.** The manifest's workstream 2 says "expo-audio LINEARPCM WAV to existing `transcribeWav` to Caddy /stt. Replace the ElevenLabs button entirely. Device-verified." Task 2 covers LINEARPCM capture, Task 1 the `transcribeWav` path and the endpoint correction, Task 4 the button replacement, Task 5 device verification. The manifest's category-8 observability item ("dictation failure surfaced, not silent") is Task 4 Step 2 requirements 1 and 7, plus two Task 5 checklist rows. Q2 is answered and is implemented by Task 3.

**Gaps I am leaving deliberately, stated rather than hidden.** Android is not covered: the only client is the installed iOS app, and `RecordingOptions.android` is left unset. If Android ever matters, `android.outputFormat` and `android.audioEncoder` are required fields and this plan does not supply them. Metering is enabled but no waveform UI is specified; `VoiceBars` exists and may be reusable, but wiring it is not in scope.

**Placeholder scan.** No TBDs. Every code step carries real code. The two places I deliberately defer to measurement rather than assert are flagged as such with a named fallback: the `ios` sub-fields in Task 2 Step 1, and the WAV container question in Task 5 Step 3.

**Type consistency.** `DictationState` and `DictationEvent` are defined in Task 3 and consumed by name in Task 4. `DICTATION_RECORDING_OPTIONS`, `readRecordingBytes` and `MAX_DICTATION_SECONDS` are defined in Task 2 and consumed in Task 4. `transcribeWav`'s signature is defined in Task 1, and Task 1 Step 1 explicitly requires reporting the real ported signatures, because this plan read those files but could still have transcribed a name imprecisely.
