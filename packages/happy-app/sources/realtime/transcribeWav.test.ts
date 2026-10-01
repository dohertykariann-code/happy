import { describe, it, expect, vi } from 'vitest';
import { transcribeWav } from './transcribeWav';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('transcribeWav', () => {
  it('POSTs the WAV to /stt/transcribe with the bearer token and returns trimmed text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ text: '  hello there  ' }));
    const wav = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });

    const text = await transcribeWav(wav, 'TOKEN', { fetchImpl });

    expect(text).toBe('hello there');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/stt/transcribe');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('audio/wav');
    expect(init.headers.Authorization).toBe('Bearer TOKEN');
    expect(init.body).toBe(wav);
  });

  it('omits the Authorization header when there is no token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ text: 'hi' }));
    await transcribeWav(new Blob([]), undefined, { fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('returns null when the transcript is empty/whitespace', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ text: '   ' }));
    expect(await transcribeWav(new Blob([]), 'T', { fetchImpl })).toBeNull();
  });

  it('throws on a non-OK response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(transcribeWav(new Blob([]), 'T', { fetchImpl })).rejects.toThrow('STT 500');
  });
  it('posts to an absolute endpoint when one is given', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ text: 'hello' }) };
    }) as unknown as typeof fetch;

    const result = await transcribeWav(new Blob([new Uint8Array([1, 2, 3])]), undefined, {
      fetchImpl,
      endpoint: 'https://example.test:8443/stt/transcribe',
    });

    expect(result).toBe('hello');
    expect(calls).toEqual(['https://example.test:8443/stt/transcribe']);
  });

  it('refuses a relative endpoint, which cannot resolve in a native app', async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ text: 'x' }) })) as unknown as typeof fetch;
    await expect(
      transcribeWav(new Blob([new Uint8Array([1])]), undefined, { fetchImpl, endpoint: '/stt/transcribe' }),
    ).rejects.toThrow(/absolute/i);
  });
});
