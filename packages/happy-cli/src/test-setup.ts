/**
 * Vitest global setup — runs ONCE before all tests.
 *
 * We only build the CLI here. Integration suites now provision their own
 * isolated environments so each suite can get a fresh lab-rat project copy.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function setup() {
    process.env.VITEST_POOL_TIMEOUT = '60000'
    process.env.HAPPY_RUN_SANDBOX_NETWORK_TESTS = '1'
    const tmpDir = mkdtempSync(join(tmpdir(), 'happy-vitest-'))
    process.env.TMPDIR = tmpDir
    const binDir = join(process.cwd(), '..', '..', 'node_modules', '.bin')

    const commands = [
        ['tsc', ['--noEmit']],
        ['pkgroll', []],
    ] as const
    for (const [command, args] of commands) {
        const buildResult = spawnSync(join(binDir, command), args, { stdio: 'pipe', env: process.env })
        if (buildResult.status !== 0) {
            const errorOutput = buildResult.stderr?.toString() || ''
            const standardOutput = buildResult.stdout?.toString() || ''
            throw new Error(`CLI build step ${command} failed: ${errorOutput || standardOutput}`)
        }
    }
}

export async function teardown() {
    // Per-suite integration environments clean themselves up.
}
