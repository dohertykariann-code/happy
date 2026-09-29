export interface TranscribeOptions {
  /** Injectable fetch (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Abort signal (the hook wires a timeout). */
  signal?: AbortSignal;
  /** Override endpoint (defaults to the same-origin Caddy /stt route). */
  endpoint?: string;
}

/**
 * POST a WAV blob to the local whisper.cpp STT sidecar and return the transcript.
 * Pure (no React / Web Audio) so it is unit-testable in the node vitest env.
 * @returns the trimmed transcript, or null if the transcript is empty.
 * @throws on a non-OK HTTP response (caller maps this to an error state).
 */
export async function transcribeWav(
  wav: Blob,
  token: string | undefined,
  opts: TranscribeOptions = {},
): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(opts.endpoint ?? '/stt/transcribe', {
    method: 'POST',
    headers: {
      'Content-Type': 'audio/wav',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: wav,
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`STT ${res.status}`);
  const data = await res.json();
  const text = ((data?.text ?? '') as string).trim();
  return text || null;
}
