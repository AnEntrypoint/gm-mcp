import { RUNNER_REGISTRY_VERBS, canonicalName } from './verb-table.js'

export { RUNNER_REGISTRY_VERBS }

export function verbToolName(verb) {
    return canonicalName(verb)
}

export function canonicalToolName(name) {
    return canonicalName(name)
}

export function editDistance(left, right) {
    const row = Array.from({ length: right.length + 1 }, (_, index) => index)
    for (let i = 1; i <= left.length; i++) {
        let diagonal = row[0]
        row[0] = i
        for (let j = 1; j <= right.length; j++) {
            const above = row[j]
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1))
            diagonal = above
        }
    }
    return row[right.length]
}

export function nearestNames(name, candidates, count = 5) {
    return [...candidates]
        .map((candidate) => ({ candidate, distance: editDistance(String(name), candidate) }))
        .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
        .slice(0, count)
        .map((entry) => entry.candidate)
}
