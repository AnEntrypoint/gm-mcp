import assert from 'node:assert/strict'
import { normalizedObjectBody } from '../src/dispatch.js'

let passed = 0
function test(name, fn) {
    try {
        fn()
        passed += 1
        console.log(`ok   ${name}`)
    } catch (error) {
        console.error(`FAIL ${name}`)
        console.error(error)
        process.exitCode = 1
    }
}

const valueOf = (body) => {
    const out = normalizedObjectBody('codesearch', body)
    assert.equal(out.error, undefined, `unexpected error: ${out.error}`)
    return out.value
}

test('an object body is passed through unchanged, braces included', () => {
    assert.deepEqual(valueOf({ query: 'function [a-z]{2}' }), { query: 'function [a-z]{2}' })
    assert.deepEqual(valueOf({ query: 'a}b', mode: 'literal', k: 5 }), { query: 'a}b', mode: 'literal', k: 5 })
})

test('a JSON string body is parsed as JSON, not scanned for braces', () => {
    assert.deepEqual(valueOf('{"query":"a}b"}'), { query: 'a}b' })
    assert.deepEqual(valueOf('{"query":"a{b"}'), { query: 'a{b' })
    assert.deepEqual(valueOf('{"query":"}{"}'), { query: '}{' })
    assert.deepEqual(valueOf('{"query":"[a-z]{2}","mode":"regex"}'), { query: '[a-z]{2}', mode: 'regex' })
    assert.deepEqual(valueOf('{"query":"x","path":"src/a}b.rs"}'), { query: 'x', path: 'src/a}b.rs' })
})

test('an escaped backslash in a JSON string body survives the round trip', () => {
    assert.deepEqual(valueOf('{"query":"function [a-z]\\\\{2\\\\}"}'), { query: 'function [a-z]\\{2\\}' })
    assert.deepEqual(valueOf('{"query":"\\\\}"}'), { query: '\\}' })
    assert.deepEqual(valueOf('{"query":"a\\\\b"}'), { query: 'a\\b' })
})

test('an escaped quote in a JSON string body survives the round trip', () => {
    assert.deepEqual(valueOf('{"query":"say \\"hi\\""}'), { query: 'say "hi"' })
    assert.deepEqual(valueOf('{"query":"\\"}\\""}'), { query: '"}"' })
})

test('a value carrying a quote-then-closing-brace is one value, not a truncated one', () => {
    // The repair pass used to read the "}" after the inner quote as the object's closing brace,
    // cutting the value to "a" and failing the parse on the "}b" left behind. The value has to be
    // repaired to a\"}b and parsed whole.
    assert.deepEqual(valueOf('{"query":"a"}b"}'), { query: 'a"}b' })
    assert.deepEqual(valueOf('{"query":"a"}b","mode":"literal"}'), { query: 'a"}b', mode: 'literal' })
    assert.deepEqual(valueOf('{"query":"say "hi"}"}'), { query: 'say "hi"}' })
})

test('a raw newline inside a value is repaired in nested containers too', () => {
    assert.deepEqual(valueOf('{"query":"a}\nb"}'), { query: 'a}\nb' })
    assert.deepEqual(valueOf('{"a":{"b":"c\nd"}}'), { a: { b: 'c\nd' } })
    assert.deepEqual(valueOf('{"a":["x\ny"]}'), { a: ['x\ny'] })
    assert.deepEqual(valueOf('{"query":"a\nb","mode":"literal"}'), { query: 'a\nb', mode: 'literal' })
})

test('a body that is not JSON at all still reports an actionable error', () => {
    for (const body of ['{"query":"a\\{2\\}"}', '{"query":"a}b"', '{"query":"a" ']) {
        const out = normalizedObjectBody('codesearch', body)
        assert.match(out.error, /^codesearch body/)
        assert.match(out.error, /is not valid JSON/)
        assert.match(out.error, /Repair it:/)
    }
    const badEscape = normalizedObjectBody('codesearch', '{"query":"a\\{2\\}"}')
    assert.match(badEscape.error, /one backslash is written \\\\/)
    assert.match(badEscape.error, /\\\\\}/)
})

test('a non-object body is refused without touching the parse', () => {
    assert.match(normalizedObjectBody('codesearch', '[1,2]').error, /body string must decode to a JSON object/)
    assert.match(normalizedObjectBody('codesearch', ['a']).error, /body must be a JSON object/)
})

console.log(`\n${passed} passed, ${process.exitCode ? 'FAILED' : '0 failed'}`)
