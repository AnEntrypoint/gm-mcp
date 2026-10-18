import { execFileSync } from 'node:child_process'

import { commandTokens } from './gm-cmdline.js'

const TABLE_TIMEOUT_MS = 15_000

const LIVE_SESSION_NAMES = new Set([
    's6-svscan', 's6-supervise', 'runit', 'runit-init', 'systemd', 'launchd', 'init', 'tini', 'dumb-init', 'supervisord',
    'selkies', 'xfdesktop', 'xfce4-session', 'xfce4-panel', 'xfwm4', 'xfsettingsd', 'xfce4-terminal', 'mate-session', 'gnome-session',
    'xvfb', 'xorg', 'xwayland', 'x11vnc', 'xrdp', 'novnc', 'websockify', 'pulseaudio', 'pipewire', 'wireplumber', 'dbus-daemon',
])

const POSIX_ARGS_WITH_START = ['-eo', 'pid=,ppid=,lstart=,args=']
const POSIX_ARGS_NO_START = ['-eo', 'pid=,ppid=,args=']
const POSIX_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/
const POSIX_LINE_NO_START = /^\s*(\d+)\s+(\d+)\s+(.*)$/

const WMI_CREATION_DATE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+(?:([+-]\d{1,4}))?$/

const WINDOWS_SCRIPT = [
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  $line = ($_.CommandLine -replace "[\\r\\n\\t]+", " ")',
    '  $started = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { "" }',
    '  Write-Output ($_.ProcessId.ToString() + "|" + $_.ParentProcessId.ToString() + "|" + $started + "|" + $line)',
    '}',
].join('\n')
const WINDOWS_ENCODED_SCRIPT = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')

let lastError = null

export function lastTableError() {
    return lastError
}

const ISO_UTC = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function startedAtFrom(text) {
    if (typeof text !== 'string' || text === '') return null
    const iso = ISO_UTC.exec(text.trim())
    const parsed = Date.parse(iso === null ? text : `${iso[1]}${iso[2] ? `.${iso[2].slice(1, 4).padEnd(3, '0')}` : ''}${iso[3]}`)
    return Number.isFinite(parsed) ? parsed : null
}

function windowsStartedAt(text) {
    return startedAtFrom(text) ?? wmiStartedAt(text)
}

function wmiStartedAt(text) {
    const match = WMI_CREATION_DATE.exec((text ?? '').trim())
    if (match === null) return null
    const [, year, month, day, hour, minute, second, utcOffsetMinutes] = match
    const asUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
    if (!Number.isFinite(asUtc)) return null
    return asUtc - Number(utcOffsetMinutes ?? 0) * 60_000
}

function failureReason(error) {
    if (error?.status != null) {
        const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : ''
        return `powershell exit ${error.status}${stderr ? `: ${stderr}` : ''}`
    }
    return error?.code ?? error?.message ?? String(error)
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
        text = run(exec, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_ENCODED_SCRIPT])
    } catch (error) {
        lastError = failureReason(error)
        text = typeof error?.stdout === 'string' ? error.stdout : ''
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
            started_at: windowsStartedAt(fields[2]),
            command: fields.slice(3).join('|').trim(),
        })
    }
    return rows
}

export function liveSessionNameOf(command) {
    if (typeof command !== 'string' || command === '') return null
    const tokens = commandTokens(command)
    if (tokens.length === 0) return null
    const program = tokens[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()
    return LIVE_SESSION_NAMES.has(program) ? program : null
}

export function readProcessTable({ exec = execFileSync, platform = process.platform } = {}) {
    lastError = null
    try {
        return platform === 'win32' ? windowsRows({ exec }) : posixRows({ exec })
    } catch (error) {
        lastError = failureReason(error)
        return []
    }
}
