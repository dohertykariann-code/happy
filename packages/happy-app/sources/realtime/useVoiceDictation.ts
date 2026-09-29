import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { getServerUrl } from '@/sync/serverConfig';
import { createAudioRecorder, AudioRecorder } from './audioRecorder';
import { transcribeWav } from './transcribeWav';

export type DictationState = 'idle' | 'recording' | 'transcribing' | 'error';

const TRANSCRIBE_TIMEOUT_MS = 30000;

/**
 * Push-to-talk dictation for the web composer: start() opens the mic, stop()
 * encodes the WAV, sends it to the local whisper.cpp sidecar, and resolves with
 * the transcript (or null on failure/empty). The network contract lives in the
 * tested pure `transcribeWav`; this hook is the thin React + Web Audio glue.
 */
export function useVoiceDictation() {
  const { credentials } = useAuth();
  const [state, setState] = useState<DictationState>('idle');
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);

  const start = useCallback(async () => {
    // Ignore re-entry while a recording is already live (e.g. a second tap during
    // 'transcribing') — otherwise a second MediaStream opens and stop()'s state
    // reset orphans it. Ref-based so there's no stale-closure on `state`.
    if (recorderRef.current) return;
    setError(null);
    try {
      const rec = createAudioRecorder();
      await rec.start();
      recorderRef.current = rec;
      setState('recording');
    } catch (e) {
      setState('error');
      setError(String((e as Error)?.message ?? e));
    }
  }, []);

  const cancel = useCallback(() => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setState('idle');
  }, []);

  // Release the mic if the component unmounts mid-recording (otherwise the
  // MediaStream + the iOS recording indicator stay open after navigating away).
  useEffect(() => () => { recorderRef.current?.cancel(); recorderRef.current = null; }, []);

  const stop = useCallback(async (): Promise<string | null> => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec) { setState('idle'); return null; }
    setState('transcribing');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
      const wav = await rec.stop();
      const text = await transcribeWav(wav, credentials?.token, { signal: controller.signal, endpoint: `${getServerUrl()}/stt/transcribe` });
      setState('idle');
      return text;
    } catch (e) {
      setState('error');
      setError(String((e as Error)?.message ?? e));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }, [credentials?.token]);

  return { state, error, start, stop, cancel };
}
