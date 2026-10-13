import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as yaml from 'js-yaml'
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

function linkAt(target, linkPath) {
    if (process.platform === 'win32') fs.symlinkSync(target, linkPath, 'junction')
    else fs.symlinkSync(target, linkPath)
}

function makeTarget(dir, name) {
    const target = path.join(dir, name)
    if (process.platform === 'win32') fs.mkdirSync(target)
    else fs.writeFileSync(target, JSON.stringify({ secret: `${name}-secret` }))
    return target
}

await test('a landed link is refused as a non-regular file, without reading its target', async () => {
    const { root, out } = fixture()
    try {
        linkAt(makeTarget(out, 'target'), path.join(out, 'instruction-link.json'))
        const reply = await readLanded(root, 'link')
        assert.match(reply.error, /unlinked regular spool file/, JSON.stringify(reply))
        assert.doesNotMatch(reply.error, /secret|target/)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

await test('a landed link that escapes the spool is refused before its target is resolved', async () => {
    const { root, out } = fixture()
    try {
        linkAt(makeTarget(root, 'outside'), path.join(out, 'instruction-escape.json'))
        const reply = await readLanded(root, 'escape')
        assert.match(reply.error, /unlinked regular spool file/, JSON.stringify(reply))
        assert.doesNotMatch(reply.error, /secret|outside/)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

await test('a spool out directory that is a link elsewhere is refused', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-landed-output-'))
    try {
        const realOut = path.join(root, 'realout')
        fs.mkdirSync(realOut, { recursive: true })
        fs.writeFileSync(path.join(realOut, 'instruction-linked.json'), JSON.stringify({ ok: true, value: 'linked-out-secret' }))
        const out = path.join(root, '.gm', 'exec-spool', 'out')
        fs.mkdirSync(path.dirname(out), { recursive: true })
        linkAt(realOut, out)
        const reply = await readLanded(root, 'linked')
        assert.match(reply.error, /resolves outside the .gm\/exec-spool\/out directory/, JSON.stringify(reply))
        assert.doesNotMatch(reply.error, /out-secret/)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
