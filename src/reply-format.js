import { encode, decode } from '@toon-format/toon'
import * as yaml from 'js-yaml'

export function renderReply(value) {
    return encode(value, { indent: 2 })
}

export function parseReply(text) {
    const trimmed = String(text).trim()
    if (trimmed.startsWith('{')) return JSON.parse(trimmed)
    try {
        return decode(trimmed)
    } catch {
        return yaml.load(trimmed)
    }
}
