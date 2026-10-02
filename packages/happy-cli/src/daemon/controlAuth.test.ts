import { describe, expect, it } from 'vitest';
import { controlTokensMatch, extractBearerToken, generateControlToken } from './controlAuth';

describe('control auth tokens', () => {
  it('generates unique 32-byte hex tokens', () => {
    const tokens = Array.from({ length: 100 }, () => generateControlToken());

    expect(tokens).toHaveLength(new Set(tokens).size);
    for (const token of tokens) {
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('accepts only an exact non-empty token match', () => {
    const token = generateControlToken();

    expect(controlTokensMatch(token, token)).toBe(true);
    expect(controlTokensMatch(token, `${token.slice(0, -1)}0`)).toBe(false);
    expect(() => controlTokensMatch(token, 'different-length')).not.toThrow();
    expect(controlTokensMatch(token, 'different-length')).toBe(false);
    expect(controlTokensMatch(token, token.slice(0, -1))).toBe(false);
    expect(controlTokensMatch(undefined, token)).toBe(false);
    expect(controlTokensMatch(token, undefined)).toBe(false);
    expect(controlTokensMatch('', token)).toBe(false);
    expect(controlTokensMatch(token, '')).toBe(false);
  });
});

describe('extractBearerToken', () => {
  it.each([
    ['Bearer token', 'token'],
    ['bearer token', 'token'],
    ['  BEARER   token  ', 'token'],
    ['Basic token', undefined],
    ['token', undefined],
    ['Bearer', undefined],
    ['Bearer    ', undefined],
    [['Bearer token'], undefined],
    [undefined, undefined],
  ])('parses %j as %j', (headerValue: string | string[] | undefined, expected: string | undefined) => {
    expect(extractBearerToken(headerValue)).toBe(expected);
  });
});
