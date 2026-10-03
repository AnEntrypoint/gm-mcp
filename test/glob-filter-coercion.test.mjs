import assert from 'node:assert/strict'
import { withGlobFiltersCoerced } from '../src/dispatch.js'

let failed = 0
function check(name, fn) {
    try {
        fn()
    } catch (error) {
        failed++
        console.error(`FAIL ${name}: ${error.message}`)
    }
}

const coerced = (body, verb = 'codesearch') => withGlobFiltersCoerced(verb, body)
const applied = (body, verb = 'codesearch') => {
    const { value } = coerced(body, verb)
    return value.glob ?? value.path_glob ?? value.include
}
const errorOf = (body, verb = 'codesearch') => coerced(body, verb).error

check('a single string glob passes through trimmed', () => {
    assert.equal(applied({ glob: '  **/*.rs ' }), '**/*.rs')
})

check('an array of globs joins into one brace alternation', () => {
    assert.equal(applied({ glob: ['test/**/*.js', 'tools/**/*.js'] }), '{test/**/*.js,tools/**/*.js}')
})

check('a one-element array is the bare pattern', () => {
    assert.equal(applied({ glob: ['**/*.md'] }), '**/*.md')
})

check('path_glob behaves the same as glob', () => {
    assert.equal(applied({ path_glob: ['src/**/*.cpp', 'src/**/*.h'] }), '{src/**/*.cpp,src/**/*.h}')
})

check('include behaves the same as glob', () => {
    assert.equal(applied({ include: ['a/*.rs', 'b/*.rs'] }, 'grep'), '{a/*.rs,b/*.rs}')
})

check('equal aliases are not a conflict', () => {
    assert.equal(errorOf({ glob: '**/*.rs', path_glob: '**/*.rs' }), undefined)
})

check('conflicting aliases fail loudly instead of dropping one', () => {
    const error = errorOf({ glob: '**/*.rs', path_glob: '**/*.md' })
    assert.match(error, /body\.glob|glob/)
    assert.match(error, /silently dropped/)
})

check('an empty string glob fails loudly, naming the field', () => {
    assert.match(errorOf({ path_glob: '   ' }), /codesearch body\.path_glob/)
})

check('an empty array fails loudly', () => {
    assert.match(errorOf({ glob: [] }), /codesearch body\.glob is an empty array/)
})

check('a non-string non-array value fails loudly, naming the type', () => {
    assert.match(errorOf({ glob: 12 }), /must be a string or an array of strings; received number/)
})

check('a negated pattern fails loudly instead of matching nothing', () => {
    assert.match(errorOf({ glob: '!test/**' }), /negated pattern/)
    assert.match(errorOf({ glob: ['src/**/*.rs', '!src/vendor/**'] }), /negated pattern/)
})

check('a pattern that cannot join into alternation fails loudly', () => {
    assert.match(errorOf({ glob: ['src/**/*.rs', '**/*.{c,h}'] }), /brace-alternation glob/)
})

check('absent and null globs are left alone', () => {
    assert.deepEqual(coerced({ query: 'x' }).value, { query: 'x' })
    assert.equal('glob' in coerced({ glob: null }).value, true)
    assert.equal(coerced({ glob: null }).value.glob, null)
})

check('other fields survive coercion', () => {
    const out = coerced({ query: 'loop', glob: ['a/*.js', 'b/*.js'], limit: 5 }).value
    assert.deepEqual(out, { query: 'loop', glob: '{a/*.js,b/*.js}', limit: 5 })
})

check('non-object bodies are returned untouched', () => {
    assert.equal(coerced(undefined).value, undefined)
})

if (failed > 0) {
    console.error(`${failed} glob-filter coercion test(s) failed`)
    process.exit(1)
}
console.log('glob-filter coercion: all checks passed')
