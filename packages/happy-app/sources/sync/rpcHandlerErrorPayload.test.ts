import { describe, expect, it } from 'vitest';
import { isRpcHandlerErrorPayload } from './rpcHandlerErrorPayload';

describe('isRpcHandlerErrorPayload', () => {
    it('recognizes an RPC handler error envelope', () => {
        expect(isRpcHandlerErrorPayload({ error: 'Directory creation failed' })).toBe(true);
    });

    it.each([
        null,
        undefined,
        'error',
        42,
        {},
        { error: 42 },
        { message: 'Directory creation failed' },
    ])('rejects a non-error payload: %j', (payload) => {
        expect(isRpcHandlerErrorPayload(payload)).toBe(false);
    });
});
