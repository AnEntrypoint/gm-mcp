import { execFileSync } from 'node:child_process'

const TABLE_TIMEOUT_MS = 15_000

const POSIX_ARGS_WITH_START = ['-eo', 'pid=,ppid=,lstart=,args=']
const POSIX_ARGS_NO_START = ['-eo', 'pid=,ppid=,args=']
const POSIX_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/
const POSIX_LINE_NO_START = /^\s*(\d+)\s+(\d+)\s+(.*)$/

const WMI_CREATION_DATE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+(?:([+-]\d{1,4}))?$/

const WINDOWS_SCRIPT = [
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  $line = ($_.CommandLine -replace "[\\r\\n\\t]+", " ")',
    '  Write-Output ($_.ProcessId.ToString() + "|" + $_.ParentProcessId.ToString() + "|" + [string]$_.CreationDate + "|" + $line)',
    '}',
].join(' ')

function startedAtFrom(text) {
    if (typeof text !== 'string' || text === '') return null
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : null
}

function wmiStartedAt(text) {
    const match = WMI_CREATION_DATE.exec((text ?? '').trim())
    if (match === null) return null
    const [, year, month, day, hour, minute, second, utcOffsetMinutes] = match
    const asUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
    if (!Number.isFinite(asUtc)) return null
    return asUtc - Number(utcOffsetMinutes ?? 0) * 60_000
}

function run(exec, file, args) {
    return exec(file, args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: TABLE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
}

function posixRows({ exec }) {
    let text = ''
    let withStart = true
    try {
        text = run(exec, 'ps', POSIX_ARGS_WITH_START)
    } catch {
        try {
            text = run(exec, 'ps', POSIX_ARGS_NO_START)
            withStart = false
        } catch {
            return []
        }
    }
    const rows = []
    for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        const match = withStart ? POSIX_LINE.exec(line) : POSIX_LINE_NO_START.exec(line)
        if (match === null) continue
        const pid = Number.parseInt(match[1], 10)
        if (!Number.isInteger(pid) || pid <= 0) continue
        const ppid = Number.parseInt(match[2], 10)
        rows.push({
            pid,
            ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : null,
            started_at: withStart ? startedAtFrom(match[3]) : null,
            command: (withStart ? match[4] : match[3]).trim(),
        })
    }
    return rows
}

function windowsRows({ exec }) {
    let text = ''
    try {
        text = run(exec, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT])
    } catch {
        return []
    }
    const rows = []
    for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        const fields = line.trim().split('|')
        if (fields.length < 4) continue
        const pid = Number.parseInt(fields[0].trim(), 10)
        if (!Number.isInteger(pid) || pid <= 0) continue
        const ppid = Number.parseInt(fields[1].trim(), 10)
        rows.push({
            pid,
            ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : null,
            started_at: wmiStartedAt(fields[2]),
            command: fields.slice(3).join('|').trim(),
        })
    }
    return rows
}

export function readProcessTable({ exec = execFileSync, platform = process.platform } = {}) {
    try {
        return platform === 'win32' ? windowsRows({ exec }) : posixRows({ exec })
    } catch {
        return []
    }
}
