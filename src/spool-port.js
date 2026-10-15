let installed = null
let builtin = null

export function installSpoolPort(port) {
    if (typeof port?.fs !== 'object' || port.fs === null || typeof port.spawn !== 'function') {
        throw new Error('installSpoolPort needs { fs, spawn }')
    }
    installed = port
}

function activePort() {
    if (installed !== null) return installed
    if (builtin === null) {
        const fs = process.getBuiltinModule?.('node:fs')
        const child = process.getBuiltinModule?.('node:child_process')
        if (!fs || !child) throw new Error('spool port unavailable: no installed port and no process.getBuiltinModule')
        builtin = { fs, spawn: child.spawn }
    }
    return builtin
}

export const spoolFs = new Proxy({}, { get: (_target, name) => activePort().fs[name] })

export function spoolSpawn(...args) {
    return activePort().spawn(...args)
}
