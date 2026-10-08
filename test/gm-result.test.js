import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import * as yaml from 'js-yaml'
import { gmResult } from '../src/dispatch.js'

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-result-'))
    const out = path.join(root, '.gm', 'exec-spool', 'out')
    fs.mkdirSync(out, { recursive: true })
    return { root, out }
}

function read(args) {
    return yaml.load(gmResult(args))
}

function write(out, name, content) {
    const file = path.join(out, name)
    fs.writeFileSync(file, content)
    return file
}

test('paginates raw UTF-8 spool output without parsing it as JSON', t => {
    const { root, out } = fixture()
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const file = write(out, 'raw.txt', 'αβγδ')
    const first = read({ cwd: root, result_file: file, offset: 1, limit: 2 })
    assert.deepEqual(first, {
        result_file: file,
        offset: 1,
        returned_characters: 2,
        total_characters: 4,
        next_offset: 3,
        content: 'βγ',
    })
    const last = read({ cwd: root, result_file: file, offset: 3, limit: 2 })
    assert.equal(last.complete, true)
    assert.equal(last.content, 'δ')
})

test('bounds oversized spool results before reading or parsing them', t => {
    const { root, out } = fixture()
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const file = write(out, 'oversized.json', 'x'.repeat(4 * 1024 * 1024 + 1))
    const result = read({ cwd: root, result_file: file })
    assert.match(result.error, /exceeds 4194304 byte limit/)
})

test('rejects traversal, symlinks, and hardlinks outside the spool', t => {
    const { root, out } = fixture()
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const outside = path.join(root, 'outside.json')
    fs.writeFileSync(outside, '{"secret":true}')
    assert.match(read({ cwd: root, result_file: outside }).error, /spool/)
    if (process.platform !== 'win32') {
        const symlink = path.join(out, 'link.json')
        fs.symlinkSync(outside, symlink)
        assert.match(read({ cwd: root, result_file: symlink }).error, /spool/)
    }
    const hardlink = path.join(out, 'hardlink.json')
    fs.linkSync(outside, hardlink)
    assert.match(read({ cwd: root, result_file: hardlink }).error, /unlinked regular spool file/)
})

test('field lookup owns every segment and reports malformed result files', t => {
    const { root, out } = fixture()
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const valid = write(out, 'valid.json', JSON.stringify({ data: { nested: ['zero', 'one'] } }))
    const field = read({ cwd: root, result_file: valid, field: 'nested.1' })
    assert.equal(field.field, 'data.nested.1')
    assert.equal(field.content, '"one"')
    assert.match(read({ cwd: root, result_file: valid, field: '__proto__.toString' }).error, /could not be read/)
    const malformed = write(out, 'malformed.json', '{')
    assert.match(read({ cwd: root, result_file: malformed, field: 'data' }).error, /could not be read/)
})
