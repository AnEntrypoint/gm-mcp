import { EXEC_LANGS, tableRow } from './verb-table.js'

export { EXEC_LANGS }

const UNDECLARED_NOTE = 'gm-mcp declares no body schema for this verb; send the fields its Rust handler reads and read the refusal when one is wrong.'

export function verbBodySchema(verb) {
    const declared = tableRow(verb)?.body
    if (!declared) return { declared: false, note: UNDECLARED_NOTE }
    return {
        declared: true,
        verb,
        required: declared.required,
        fields: declared.fields,
    }
}

export function describeBodyField(schema, name) {
    if (!schema.declared) return null
    const direct = schema.fields[name]
    if (direct) return { name, ...direct }
    for (const [field, spec] of Object.entries(schema.fields)) {
        if ((spec.aliases ?? []).includes(name)) return { name: field, ...spec }
    }
    return null
}

export function renderBodyHint(verb, fieldName) {
    const schema = verbBodySchema(verb)
    if (!schema.declared) return `${verb} declares no body schema in gm-mcp; ${UNDECLARED_NOTE}`
    const named = fieldName ? describeBodyField(schema, fieldName) : null
    if (named) {
        const aliases = named.aliases?.length ? ` (aliases ${named.aliases.join(', ')})` : ''
        const values = named.enum ? `, one of ${named.enum.join(' | ')}` : ''
        const required = schema.required.includes(named.name) ? 'required' : 'optional'
        return `${verb} body field "${named.name}"${aliases}: ${required} ${named.type}${values} -- ${named.description}`
    }
    const render = (name) => {
        const spec = schema.fields[name]
        const values = spec.enum ? ` one of ${spec.enum.join('|')}` : ''
        return `${name}${schema.required.includes(name) ? '*' : ''}:${spec.type}${values}`
    }
    return `${verb} body accepts ${Object.keys(schema.fields).map(render).join(', ')} (* = required)`
}

export function bodyShapeLine(verb) {
    const schema = verbBodySchema(verb)
    if (!schema.declared) return ''
    const names = Object.keys(schema.fields).map((name) => (schema.required.includes(name) ? name : `${name}?`))
    return ` Body fields: ${names.join(', ')}.`
}
