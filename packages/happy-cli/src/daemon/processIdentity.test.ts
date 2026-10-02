import { describe, it, expect } from 'vitest';
import { readProcessStartTime, isSameProcessIncarnation } from './processIdentity';

describe('readProcessStartTime', () => {
  it('returns the trimmed start time for a pid ps knows about', () => {
    const exec = (_cmd: string) => 'Wed Sep 30 07:16:31 2026    \n';
    expect(readProcessStartTime(94167, exec)).toBe('Wed Sep 30 07:16:31 2026');
  });

  it('returns undefined when ps exits non-zero', () => {
    const exec = (_cmd: string) => { throw new Error('ps: process id too large'); };
    expect(readProcessStartTime(999999, exec)).toBeUndefined();
  });

  it('returns undefined when ps prints nothing', () => {
    const exec = (_cmd: string) => '   \n';
    expect(readProcessStartTime(1234, exec)).toBeUndefined();
  });

  it('refuses a pid that is not a positive safe integer, without calling ps', () => {
    let called = false;
    const exec = (_cmd: string) => { called = true; return 'x'; };
    expect(readProcessStartTime(-1, exec)).toBeUndefined();
    expect(readProcessStartTime(0, exec)).toBeUndefined();
    expect(readProcessStartTime(1.5, exec)).toBeUndefined();
    expect(readProcessStartTime(Number.NaN, exec)).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe('isSameProcessIncarnation', () => {
  it('is true only when both start times are present and equal', () => {
    expect(isSameProcessIncarnation('Wed Sep 30 07:16:31 2026', 'Wed Sep 30 07:16:31 2026')).toBe(true);
  });

  it('is false when the start times differ, which is how pid reuse is caught', () => {
    expect(isSameProcessIncarnation('Wed Sep 30 07:16:31 2026', 'Thu Oct  1 09:02:11 2026')).toBe(false);
  });

  it('is false when either side is absent, so unverifiable identity never passes', () => {
    expect(isSameProcessIncarnation(undefined, 'Wed Sep 30 07:16:31 2026')).toBe(false);
    expect(isSameProcessIncarnation('Wed Sep 30 07:16:31 2026', undefined)).toBe(false);
    expect(isSameProcessIncarnation(undefined, undefined)).toBe(false);
    expect(isSameProcessIncarnation('', '')).toBe(false);
  });
});
