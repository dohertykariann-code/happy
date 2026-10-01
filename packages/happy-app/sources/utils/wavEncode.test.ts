import { describe, it, expect } from 'vitest';
import { wavEncode } from './wavEncode';

function u32(view: DataView, off: number) { return view.getUint32(off, true); }
function u16(view: DataView, off: number) { return view.getUint16(off, true); }

async function bytes(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

describe('wavEncode', () => {
  it('produces a valid 16kHz mono 16-bit WAV header', async () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = wavEncode([pcm], 16000);
    const v = await bytes(blob);
    expect(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))).toBe('RIFF');
    expect(String.fromCharCode(v.getUint8(8), v.getUint8(9), v.getUint8(10), v.getUint8(11))).toBe('WAVE');
    expect(u16(v, 20)).toBe(1);      // PCM
    expect(u16(v, 22)).toBe(1);      // mono
    expect(u32(v, 24)).toBe(16000);  // sample rate
    expect(u16(v, 34)).toBe(16);     // bits per sample
    expect(u32(v, 40)).toBe(10);     // data chunk = 5 samples * 2 bytes
    expect(v.byteLength).toBe(44 + 10);
  });

  it('clamps and converts sample values to 16-bit', async () => {
    const blob = wavEncode([new Float32Array([1, -1, 0])], 16000);
    const v = await bytes(blob);
    expect(v.getInt16(44, true)).toBe(32767);   // +1 clamped
    expect(v.getInt16(46, true)).toBe(-32768);  // -1 clamped
    expect(v.getInt16(48, true)).toBe(0);
  });

  it('downsamples a higher input rate to 16kHz (halves 32kHz length)', async () => {
    const input = new Float32Array(32); // 32 samples @ 32kHz
    const blob = wavEncode([input], 32000);
    const v = await bytes(blob);
    expect(u32(v, 24)).toBe(16000);
    expect(u32(v, 40)).toBe(16 * 2); // 16 output samples * 2 bytes
  });
});
