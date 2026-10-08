import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as yaml from 'js-yaml'
import { gmDispatch, unsafeSpoolName } from '../src/dispatch.js'

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

test('spool component limits use UTF-8 bytes', () => {
    assert.equal(unsafeSpoolName('verb', 'v'.repeat(255)), null)
    assert.match(unsafeSpoolName('verb', 'v'.repeat(256)), /256 UTF-8 bytes/)
    assert.equal(unsafeSpoolName('session_id', 'é'.repeat(75)), null)
    assert.match(unsafeSpoolName('session_id', 'é'.repeat(76)), /152 UTF-8 bytes/)
    assert.equal(unsafeSpoolName('task', 'é'.repeat(100)), null)
    assert.match(unsafeSpoolName('task', 'é'.repeat(101)), /202 UTF-8 bytes/)
})

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-spool-name-'))

await test('oversized spool components fail before filesystem paths are created', async () => {
    for (const request of [
        { verb: 'v'.repeat(256), session_id: 'session' },
        { verb: 'instruction', session_id: 'é'.repeat(76) },
        { verb: 'instruction', session_id: 'session', resume_task: 'é'.repeat(101) },
    ]) {
        const reply = await gmDispatch({ ...request, body: {}, cwd: root })
        assert.match(reply, /spool component limit/)
        assert.doesNotMatch(reply, /ENAMETOOLONG/)
    }
    assert.equal(fs.existsSync(path.join(root, '.gm')), false)
})

await test('a boundary-sized multibyte task reads a landed response', async () => {
    const task = 'é'.repeat(100)
    const out = path.join(root, '.gm', 'exec-spool', 'out')
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, `instruction-${task}.json`), JSON.stringify({ ok: true, value: 'boundary' }))
    const reply = yaml.load(await gmDispatch({ verb: 'instruction', body: {}, session_id: 'session', cwd: root, resume_task: task }))
    assert.equal(reply.ok, true)
    assert.equal(reply.value, 'boundary')
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
