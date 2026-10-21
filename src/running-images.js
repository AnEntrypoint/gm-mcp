import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { agentplugDir } from './paths.js'
import { readProcessTableAsync } from './process-table.js'

const IMAGE_DIR_NAME = 'gm-mcp-images'

function imageDir() {
    return path.join(agentplugDir(), IMAGE_DIR_NAME)
}

function isLivePid(pid) {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return error?.code === 'EPERM'
    }
}

// One record per live gm-mcp process, holding the bundle image it was launched from. The record is
// written by a staged file and renamed into place, and removed when the process exits.
export function recordRunningImage(role, image) {
    try {
        const dir = imageDir()
        mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `${process.pid}.json`)
        const staging = `${file}.staging`
        const record = { pid: process.pid, role, version: image.version, sha256: image.sha256, started_at: new Date().toISOString() }
        writeFileSync(staging, `${JSON.stringify(record)}\n`)
        renameSync(staging, file)
        process.once('exit', () => {
            try {
                unlinkSync(file)
            } catch {
            }
        })
        return record
    } catch {
        return null
    }
}

const BUNDLE_PROCESS_COMMAND = /^(\S*[\\/])?node(\.exe)?\s.*gm-mcp-server\.m?js(\s|$)/
const BUNDLE_LAUNCHER_COMMAND = /(^|[\\/\s])node(\.exe)?\s+-e\s/

// Live gm-mcp bundle processes that wrote no image record (launched by a bundle that predates the record, or
// whose record write failed). A process that started before the deployed bundle file was last written is running
// an image that is no longer deployed, so it is stale: true. Any other one has an unknown image: 'unknown', never false.
export async function unrecordedBundleProcesses(recordedPids, deployedMtimeMs = null) {
    return (await readProcessTableAsync())
        .filter((row) => row.pid !== process.pid && !recordedPids.has(row.pid))
        .filter((row) => BUNDLE_PROCESS_COMMAND.test(row.command) && !BUNDLE_LAUNCHER_COMMAND.test(row.command))
        .map((row) => {
            const startedMs = row.started_at === null ? null : new Date(row.started_at).getTime()
            const predatesDeployed = deployedMtimeMs !== null && startedMs !== null && startedMs < deployedMtimeMs
            return {
                pid: row.pid,
                role: 'unrecorded',
                version: null,
                sha256: null,
                started_at: row.started_at === null ? null : new Date(row.started_at).toISOString(),
                stale: predatesDeployed ? true : 'unknown',
            }
        })
}

// Lists the records of processes that are still alive and deletes the records of processes that are not.
export function liveRunningImages() {
    let names = []
    try {
        names = readdirSync(imageDir())
    } catch {
        return []
    }
    const images = []
    for (const name of names) {
        if (!name.endsWith('.json')) continue
        const file = path.join(imageDir(), name)
        let record = null
        try {
            record = JSON.parse(readFileSync(file, 'utf8'))
        } catch {
            record = null
        }
        if (!record || !isLivePid(record.pid)) {
            try {
                unlinkSync(file)
            } catch {
            }
            continue
        }
        images.push(record)
    }
    return images
}
