import { describe, expect, it, vi } from 'vitest'

const { mockSdkQuery } = vi.hoisted(() => ({
    mockSdkQuery: vi.fn((_args: { prompt: unknown; options: { pathToClaudeCodeExecutable?: string } }) => ({
        [Symbol.asyncIterator]: async function* () {},
    })),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: mockSdkQuery,
}))

import { query } from './query'

function lastSdkCallOptions(): { pathToClaudeCodeExecutable?: string } {
    const calls = mockSdkQuery.mock.calls
    const lastCall = calls.at(-1)
    if (!lastCall) throw new Error('mockSdkQuery was not called')
    return lastCall[0].options
}

describe('query', () => {
    it('passes pathToClaudeCodeExecutable through to the official SDK when set', () => {
        query({ prompt: 'hi', options: { pathToClaudeCodeExecutable: '/custom/bin/claude' } })

        expect(lastSdkCallOptions().pathToClaudeCodeExecutable).toBe('/custom/bin/claude')
    })

    it('leaves pathToClaudeCodeExecutable undefined when not set, so the SDK uses its built-in executable', () => {
        query({ prompt: 'hi', options: {} })

        expect(lastSdkCallOptions().pathToClaudeCodeExecutable).toBeUndefined()
    })
})
