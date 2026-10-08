import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gmDispatch, pollTimeoutMs, withTimeoutMsPrefix } from '../src/dispatch.js'

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
