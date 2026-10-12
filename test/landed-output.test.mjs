import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as yaml from 'js-yaml'
// These roots are throwaway temp dirs, so nothing may be spawned inside them: a detached spool
// runner holds its cwd, which on Windows makes the fixture directory undeletable and leaves a live
// daemon behind after the run. The verbs under test read a landed result, never a runner.
process.env.GM_MCP_DAEMON_RESPAWN = '0'
process.env.GM_MCP_RUNNER_WATCHDOG = '0'
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
        assert.equal(reply.ok, true, JSON.stringify(reply))
        assert.equal(reply.value, 'regular', JSON.stringify(reply))
        assert.equal(reply.resumed.task, 'regular', JSON.stringify(reply))
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
    await test('a landed symlink is rejected as a non-regular file, without reading its target', async () => {
        const { root, out } = fixture()
        try {
            const target = path.join(out, 'target.json')
            fs.writeFileSync(target, JSON.stringify({ secret: 'target' }))
            fs.symlinkSync(target, path.join(out, 'instruction-symlink.json'))
            const reply = await readLanded(root, 'symlink')
            assert.match(reply.error, /unlinked regular spool file/, JSON.stringify(reply))
            assert.doesNotMatch(reply.error, /secret|target.json/)
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    })

    await test('a landed symlink that escapes the spool is refused without reading its target', async () => {
        const { root, out } = fixture()
        try {
            const outside = path.join(root, 'secret.json')
            fs.writeFileSync(outside, JSON.stringify({ secret: 'escaped' }))
            fs.symlinkSync(outside, path.join(out, 'instruction-escape.json'))
            const reply = await readLanded(root, 'escape')
            assert.match(reply.error, /spool file/, JSON.stringify(reply))
            assert.doesNotMatch(reply.error, /secret/)
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    })
}

console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
