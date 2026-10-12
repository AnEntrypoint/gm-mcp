import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gmDispatch, pollTimeoutMs, withTimeoutMsPrefix, execLimitMs, pollTimeoutCeilingMs } from '../src/dispatch.js'

const POLL_CEILING_MS = 600_000
const EXEC_CEILING_MS = 900_000
const EXEC_DEFAULT_MS = 300_000

let passed = 0
async function test(name, fn) {
    try {
        await fn()
        passed += 1
        console.log(`ok   ${name}`)
    } catch (error) {
        console.error(`FAIL ${name}`)
        console.error(error)
        process.exitCode = 1
    }
}

test('non-finite explicit timeouts fall back to a finite polling interval', () => {
    assert.equal(pollTimeoutMs('bash', 'echo ok', Infinity), 120_000)
    assert.equal(withTimeoutMsPrefix('bash', 'echo ok', Infinity), 'timeoutMs=300000\necho ok')
})

test('oversized timeout directives cannot create a non-finite polling deadline', () => {
    const timeout = pollTimeoutMs('bash', `timeoutMs=${'9'.repeat(400)}\necho ok`)
    assert.ok(Number.isSafeInteger(timeout))
    assert.ok(timeout <= 2_147_483_647)
})

test('timeout directives require a complete first line', () => {
    assert.equal(pollTimeoutMs('bash', 'timeoutMs=10ms\necho ok'), 120_000)
})

test('a caller poll budget past the old 240s ceiling buys the child a matching exec budget', () => {
    assert.equal(execLimitMs('bash', 'echo ok', 400), 395_000)
    assert.equal(withTimeoutMsPrefix('bash', 'echo ok', 400), 'timeoutMs=395000\necho ok')
})

test('an exec budget is never shortened below the daemon default by a short poll', () => {
    assert.equal(execLimitMs('bash', 'echo ok', undefined), EXEC_DEFAULT_MS)
    assert.equal(execLimitMs('bash', 'echo ok', 10), EXEC_DEFAULT_MS)
})

test('an exec budget asked for beyond the poll ceiling lands on the ceiling, and never above the exec ceiling', () => {
    assert.equal(execLimitMs('bash', 'echo ok', 5000), POLL_CEILING_MS - 5000)
    assert.ok(execLimitMs('bash', 'echo ok', 1e9) <= EXEC_CEILING_MS)
})

test('an explicit timeoutMs prefix still wins over the caller poll budget', () => {
    assert.equal(execLimitMs('bash', 'timeoutMs=420000\necho ok', 999), 420_000)
    assert.equal(withTimeoutMsPrefix('bash', 'timeoutMs=420000\necho ok', 999), 'timeoutMs=420000\necho ok')
})

test('the poll ceiling defaults to the 600s harness tool-call max and is configurable', () => {
    assert.equal(pollTimeoutCeilingMs(), POLL_CEILING_MS)
    const previous = process.env.GM_MCP_POLL_TIMEOUT_CEILING_MS
    try {
        process.env.GM_MCP_POLL_TIMEOUT_CEILING_MS = '900000'
        assert.equal(pollTimeoutCeilingMs(), 900_000)
        assert.equal(execLimitMs('bash', 'echo ok', 800), 795_000)
    } finally {
        if (previous === undefined) delete process.env.GM_MCP_POLL_TIMEOUT_CEILING_MS
        else process.env.GM_MCP_POLL_TIMEOUT_CEILING_MS = previous
    }
    assert.equal(pollTimeoutCeilingMs(), POLL_CEILING_MS)
})

const scratch = mkdtempSync(path.join(tmpdir(), 'gm-timeout-validation-'))

await test('invalid explicit timeouts are rejected before a dispatch is written', async () => {
    const reply = await gmDispatch({ verb: 'bash', raw_body: 'echo ok', session_id: 'timeout-validation', cwd: scratch, timeout_seconds: Infinity })
    assert.match(reply, /timeout_seconds must be a finite number/)
})

await test('oversized timeout directives are rejected before a dispatch is written', async () => {
    const reply = await gmDispatch({ verb: 'bash', raw_body: `timeoutMs=${'9'.repeat(400)}\necho ok`, session_id: 'timeout-validation', cwd: scratch })
    assert.match(reply, /timeoutMs must not exceed/)
})

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
