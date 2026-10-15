// Lock and status byte primitives for the spool. dispatch.js decides what a
// lock means; this module reads and writes the bytes. Every fs call goes
// through spoolFs, the same port dispatch.js uses.

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

export function writeTextAtomically(file, text) {
    const tempPath = `${file}.tmp`
    fs.writeFileSync(tempPath, text, 'utf8')
    fs.renameSync(tempPath, file)
}

export function writeText(file, text) {
    fs.writeFileSync(file, text, 'utf8')
}

export function readPidTsLock(file) {
    const [pid, ts] = fs.readFileSync(file, 'utf8').trim().split(/\s+/).map(Number)
    return { pid, ts }
}

export function readLockHolderPid(file) {
    return Number.parseInt(fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0], 10)
}

// Writes text to a private temp file, then hard-links it to lockPath. The link
// fails with EEXIST when another holder owns the lock; any other error throws.
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

// Creates lockPath exclusively (EEXIST when held) and writes text into it.
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

// Moves a stale lock aside under a unique name, then removes it. Only the
// caller that wins the rename owns the reclaim; a loser's rename throws ENOENT.
export function reclaimLockByRename(lockPath) {
    const stalePath = `${lockPath}.${process.pid}.${Date.now()}.stale`
    fs.renameSync(lockPath, stalePath)
    fs.unlinkSync(stalePath)
}
