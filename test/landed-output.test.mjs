import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as yaml from 'js-yaml'
import { gmDispatch } from '../src/dispatch.js'

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

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-landed-output-'))
    const out = path.join(root, '.gm', 'exec-spool', 'out')
    fs.mkdirSync(out, { recursive: true })
    return { root, out }
}

async function readLanded(root, task) {
    return yaml.load(await gmDispatch({ verb: 'instruction', body: {}, session_id: 'landed-output', cwd: root, resume_task: task }))
}

await test('a regular landed response is read from the spool descriptor', async () => {
    const { root, out } = fixture()
    try {
        fs.writeFileSync(path.join(out, 'instruction-regular.json'), JSON.stringify({ ok: true, value: 'regular' }))
        const reply = await readLanded(root, 'regular')
        assert.equal(reply.ok, true)
        assert.equal(reply.value, 'regular')
        assert.equal(reply.resumed.task, 'regular')
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

await test('a landed hardlink is rejected without reading its target', async () => {
    const { root, out } = fixture()
    try {
        const outside = path.join(root, 'secret.json')
        fs.writeFileSync(outside, JSON.stringify({ secret: 'outside' }))
        fs.linkSync(outside, path.join(out, 'instruction-hardlink.json'))
        const reply = await readLanded(root, 'hardlink')
        assert.match(reply.error, /unlinked regular spool file/)
        assert.doesNotMatch(reply.error, /outside/)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

if (process.platform !== 'win32') {
    await test('a landed symlink is rejected without reading its target', async () => {
        const { root, out } = fixture()
        try {
            const outside = path.join(root, 'secret.json')
            fs.writeFileSync(outside, JSON.stringify({ secret: 'outside' }))
            fs.symlinkSync(outside, path.join(out, 'instruction-symlink.json'))
            const reply = await readLanded(root, 'symlink')
            assert.match(reply.error, /unlinked regular spool file/)
            assert.doesNotMatch(reply.error, /outside/)
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    })
}

console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
