const TARGET_RATE = 16000;

/** Concatenate Float32 chunks into one buffer. */
function concat(chunks: Float32Array[]): Float32Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Nearest-neighbour downsample to TARGET_RATE (good enough for speech STT). */
function downsample(samples: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_RATE) return samples;
  const ratio = inputRate / TARGET_RATE;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = samples[Math.floor(i * ratio)];
  return out;
}

/**
 * Encode Float32 PCM chunks to a 16 kHz mono 16-bit WAV Blob.
 * @param chunks Float32 PCM in [-1, 1].
 * @param inputSampleRate the capture sample rate (AudioContext.sampleRate).
 */
export function wavEncode(chunks: Float32Array[], inputSampleRate: number): Blob {
  const pcm = downsample(concat(chunks), inputSampleRate);
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buffer);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);          // fmt chunk size
  v.setUint16(20, 1, true);           // PCM
  v.setUint16(22, 1, true);           // mono
  v.setUint32(24, TARGET_RATE, true); // sample rate
  v.setUint32(28, TARGET_RATE * 2, true); // byte rate (rate * blockAlign)
  v.setUint16(32, 2, true);           // block align (mono * 16-bit)
  v.setUint16(34, 16, true);          // bits per sample
  writeStr(36, 'data');
  v.setUint32(40, dataBytes, true);

  let off = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
