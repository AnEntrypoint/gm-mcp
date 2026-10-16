// Number(null) and Number('') are 0, and 0 coerces to "finite", so a start time that
// was never measured would otherwise read as a process started at the epoch -- about
// 55 years old -- which is the one age an operator is most likely to act on.
export function measuredMs(value) {
    if (value === null || value === undefined || value === '') return null
    const asMs = Number(value)
    return Number.isFinite(asMs) ? asMs : null
}

export function ageMsSince(startedAt, now = Date.now()) {
    const start = measuredMs(startedAt)
    return start === null ? null : now - start
}
