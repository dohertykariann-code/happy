import { wavEncode } from '@/utils/wavEncode';

export interface AudioRecorder {
  start(): Promise<void>;
  stop(): Promise<Blob>;
  cancel(): void;
}

/**
 * Web mic capture → 16 kHz mono WAV via the Web Audio API (NOT MediaRecorder,
 * which emits audio/mp4 on iOS Safari — whisper.cpp wants PCM WAV). Captures raw
 * Float32 PCM and hands it to wavEncode on stop.
 */
export function createAudioRecorder(): AudioRecorder {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let chunks: Float32Array[] = [];
  let sampleRate = 16000;

  const teardown = () => {
    processor?.disconnect();
    source?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close();
    ctx = null; stream = null; source = null; processor = null;
  };

  return {
    async start() {
      // Guard double-start: a rapid double-tap can reach start() before React state
      // flips to 'recording', which would open a second getUserMedia stream and orphan
      // the first (mic indicator stuck on). Tear down any existing graph first.
      if (ctx) teardown();
      chunks = [];
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new Ctor();
      sampleRate = ctx.sampleRate;
      source = ctx.createMediaStreamSource(stream);
      // NOTE: ScriptProcessorNode is deprecated. Its replacement, AudioWorkletNode,
      // needs a separate worklet module file that the current Expo bundler can't emit —
      // revisit when the bundler supports worker modules.
      processor = ctx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(ctx.destination);
    },
    async stop() {
      const captured = chunks;
      const rate = sampleRate;
      teardown();
      return wavEncode(captured, rate);
    },
    cancel() {
      chunks = [];
      teardown();
    },
  };
}
