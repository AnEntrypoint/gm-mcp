// One enumeration of the host process table is the only view that sees a gm-mcp server the child
// ledger never recorded: a stdio server is spawned by the MCP client, not by a dispatch, so
// attributePid answers "unattributed" for it and every ledger-only sweep is blind to it. The
// table is read once per sweep and handed to the callers, so a sweep never pays for two `ps`
// runs and the tests can inject a table instead of reading the host.
import { execFileSync } from 'node:child_process'

const TABLE_TIMEOUT_MS = 15_000

// `ps -eo pid=,ppid=,lstart=,args=` is the one spelling that carries pid, ppid, a start time and
// the full command on both procps and BSD ps. A ps that refuses lstart still answers the shorter
// form, so the start time is optional rather than a reason to see no processes at all.
const POSIX_ARGS = ['-eo', 'pid=,ppid=,lstart=,args=']
const POSIX_ARGS_NO_START = ['-eo', 'pid=,ppid=,args=']
const POSIX_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/
const POSIX_LINE_NO_START = /^\s*(\d+)\s+(\d+)\s+(.*)$/

// Win32_Process.CreationDate is a WMI datetime: YYYYMMDDHHMMSS.ffffff<offset minutes from UTC>.
const WMI_DATE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+(?:([+-]\d{1,4}))?$/

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
    const match = WMI_DATE.exec((text ?? '').trim())
    if (match === null) return null
    const [, year, month, day, hour, minute, second, offset] = match
    const asUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
    if (!Number.isFinite(asUtc)) return null
    // local = UTC + offset, so the instant is the printed wall clock minus the offset.
    return asUtc - Number(offset ?? 0) * 60_000
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
        text = run(exec, 'ps', POSIX_ARGS)
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
