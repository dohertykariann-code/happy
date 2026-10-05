/** Identifies the encrypted error envelope returned by RPC handler failures. */
export function isRpcHandlerErrorPayload(payload: unknown): payload is { error: string } {
    return typeof payload === 'object'
        && payload !== null
        && 'error' in payload
        && typeof payload.error === 'string';
}
