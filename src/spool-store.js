import path from 'node:path'
import { spoolFs as fs } from './spool-port.js'

export function readTextOrNull(file) {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return null
    }
}

export function readJsonOrNull(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        return null
    }
}

export function readStatusJson(spoolDir) {
    return JSON.parse(fs.readFileSync(path.join(spoolDir, '.status.json'), 'utf8'))
}

export function readOwnerText(file) {
    return fs.readFileSync(file, 'utf8').trim()
}

export const SPOOL_FILE_MODE = 0o600
export const SPOOL_DIR_MODE = 0o700

export function writeTextAtomically(file, text) {
    const tempPath = `${file}.tmp`
    try {
        fs.writeFileSync(tempPath, text, { encoding: 'utf8', mode: SPOOL_FILE_MODE })
        fs.renameSync(tempPath, file)
    } catch (error) {
        try {
            fs.unlinkSync(tempPath)
        } catch {
        }
        throw error
    }
}

export function writeText(file, text) {
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: SPOOL_FILE_MODE })
}

export function readPidTsLock(file) {
    const [pid, ts] = fs.readFileSync(file, 'utf8').trim().split(/\s+/).map(Number)
    return { pid, ts }
}

export function readLockHolderPid(file) {
    return Number.parseInt(fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0], 10)
}

export function claimByLink(lockPath, tempPrefix, text, mode) {
    const tempPath = `${tempPrefix}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    try {
        fs.writeFileSync(tempPath, text, { flag: 'wx', mode })
        fs.linkSync(tempPath, lockPath)
        return true
    } catch (error) {
        if (error?.code === 'EEXIST') return false
        throw error
    } finally {
        try {
            fs.unlinkSync(tempPath)
        } catch {
        }
    }
}

export function claimByCreate(lockPath, text, mode) {
    const fd = fs.openSync(lockPath, 'wx', mode)
    try {
        fs.writeFileSync(fd, text, 'utf8')
    } finally {
        fs.closeSync(fd)
    }
    return true
}

export function replaceLockText(file, text) {
    fs.writeFileSync(file, text, 'utf8')
}

export function reclaimLockByRename(lockPath) {
    const stalePath = `${lockPath}.${process.pid}.${Date.now()}.stale`
    fs.renameSync(lockPath, stalePath)
    fs.unlinkSync(stalePath)
}
