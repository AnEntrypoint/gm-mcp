import fs from 'node:fs'
import path from 'node:path'
import { main, flagValue } from './index.js'
import { gmDispatch, replyEnvelopeSelfCheck } from './dispatch.js'
import { runDevSync } from './dev-sync.js'
import { BUNDLE_VERSION } from './bundle-version.js'
import { runningBundle } from './bundle-drift.js'
import { recordRunningImage } from './running-images.js'
import { clearLocalBuildPin, deployedBundleVersion, describeSelfUpdateOutcome, localBuildPinPath, noSelfUpdateFilePath, pinLocalBuild, refreshDeployedBundleNow, selfUpdateStatus } from './self-update.js'
import { defaultHttpPort, ensureHttpSingleton, ensureHttpSupervisor, holderIsOwn, httpMcpUrl, probeHealth, runHttpSupervisor, supervisorIntervalMs, sweepHttpInstances, allocateHttpPort, reclaimDeadPortRegistries, PORT_POOL_FROM, PORT_POOL_TO } from './singleton.js'
import { reapReport, formatFindings } from './leak-reaper.js'
import { formatLeakWatchLine, formatOrphanLine, formatOrphanTreeLine, leakWatchReport } from './leak-watch.js'
import { attributePid, globalLedgerPath } from './child-ledger.js'
import { appendDiagnostic, describeError, logFilePath } from './server-log.js'

function repeatedFlag(name) {
    const values = []
    const argv = process.argv.slice(3)
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (!arg.startsWith('--')) continue
        const body = arg.slice(2)
        const eq = body.indexOf('=')
        const key = eq === -1 ? body : body.slice(0, eq)
        if (key !== name) continue
        if (eq !== -1) values.push(body.slice(eq + 1))
        else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) values.push(argv[i + 1])
        else values.push('true')
    }
    return values.filter((value) => value !== 'true')
}

const DISPATCH_USAGE = `gm-mcp ${BUNDLE_VERSION} dispatch <verb> [--body <json|@file|->] [--raw <text|@file|->] [payload]

Runs the same dispatch the gm MCP tool runs and prints its reply, so gm stays usable
from a shell (or from an agent host that cannot see the MCP tools) with no MCP involved.

  <verb>                  gm verb, e.g. grep, codesearch, fs_read, callers, fetch, health
  [payload]               bare argument before any flag: parsed as JSON body when it starts
                          with { , otherwise sent as the plain-text raw body
  --body <json|@file|->   JSON body; @path reads a file, - reads stdin
  --raw  <text|@file|->   plain-text body for serp/browser/cdp style verbs
  --cwd <dir>             project root holding .gm/exec-spool (default: cwd)
  --no-ignore             include gitignored files: sets body no_ignore for the search verbs
                          (grep, rg, codesearch, code_search)
  --session-id <id>       gm session id (default: gm-cli-<pid>-<now>)
  --timeout <seconds>     give up after this many seconds (default 120)
  --poll <seconds>        spool poll interval (default 0.25)
  --max-chars <n>         trim long text fields to n characters
  --resume <task>         resume a previous dispatch instead of writing a new request
  --full                  return the uncompacted payload
  --timing                include dispatch timing

examples:
  gm dispatch grep --body {"pattern":"foo","output_mode":"content"} --cwd C:/dev/proj
  gm dispatch codesearch '{"query":"chunk merger"}' --cwd C:/dev/proj
  gm dispatch grep '{"pattern":"foo"}' --no-ignore --cwd C:/dev/proj
  gm dispatch health
  gm dispatch fetch --raw https://example.com

(run the same verbs as "node <bundle> dispatch ..." when gm itself is not on PATH)`

const DISPATCH_VALUE_FLAGS = new Set(['body', 'raw', 'cwd', 'session-id', 'timeout', 'poll', 'max-chars', 'resume'])

const NO_IGNORE_VERBS = new Set(['grep', 'rg', 'codesearch', 'code_search'])

function flagNameOf(arg) {
    const name = arg.slice(2)
    const eq = name.indexOf('=')
    return eq === -1 ? { name, inline: undefined } : { name: name.slice(0, eq), inline: name.slice(eq + 1) }
}

function dispatchFlag(argv, wanted) {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (!arg.startsWith('--')) continue
        const { name, inline } = flagNameOf(arg)
        if (name !== wanted) continue
        if (inline !== undefined) return inline
        const next = argv[i + 1]
        return next === undefined || next.startsWith('--') ? undefined : next
    }
    return undefined
}

function dispatchPositional(argv) {
    const positional = []
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i]
        if (!arg.startsWith('--')) {
            positional.push(arg)
            continue
        }
        const { name, inline } = flagNameOf(arg)
        if (inline === undefined && DISPATCH_VALUE_FLAGS.has(name)) i += 1
    }
    return positional
}

function resolvePayloadValue(value) {
    if (value === '-') {
        try {
            return fs.readFileSync(0, 'utf8')
        } catch {
            return ''
        }
    }
    if (value.startsWith('@')) {
        const target = value.slice(1)
        try {
            return fs.readFileSync(target, 'utf8')
        } catch (error) {
            throw new Error(`cannot read ${target}: ${error.message}`)
        }
    }
    return value
}

function parseDispatchArgv(argv) {
    const verb = argv[0]
    const positional = dispatchPositional(argv)
    const rawFlag = dispatchFlag(argv, 'raw')
    const bodyFlag = dispatchFlag(argv, 'body')

    let rawBody
    if (rawFlag !== undefined) rawBody = resolvePayloadValue(rawFlag)
    else if (positional.length > 0 && !positional[0].trimStart().startsWith('{')) rawBody = resolvePayloadValue(positional[0])

    let body
    const bodyText = bodyFlag !== undefined
        ? resolvePayloadValue(bodyFlag)
        : (positional.length > 0 && positional[0].trimStart().startsWith('{') ? positional[0] : undefined)
    if (bodyText !== undefined) {
        try {
            body = JSON.parse(bodyText)
        } catch (error) {
            return { usageError: `gm-mcp dispatch: --body is not valid JSON: ${error.message}` }
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            return { usageError: 'gm-mcp dispatch: --body must be a JSON object' }
        }
    }

    if (argv.includes('--no-ignore')) {
        if (!NO_IGNORE_VERBS.has(verb)) {
            return { usageError: `gm-mcp dispatch: --no-ignore applies to the search verbs (${[...NO_IGNORE_VERBS].join(', ')}), not "${verb}"` }
        }
        if (body === undefined) body = {}
        body.no_ignore = true
    }

    const numberOrUndefined = (value) => {
        const parsed = Number(value)
        return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    }

    return {
        args: {
            verb,
            body,
            raw_body: rawBody,
            session_id: dispatchFlag(argv, 'session-id') || `gm-cli-${process.pid}-${Date.now()}`,
            cwd: dispatchFlag(argv, 'cwd') || undefined,
            timeout_seconds: numberOrUndefined(dispatchFlag(argv, 'timeout')),
            poll_interval_seconds: numberOrUndefined(dispatchFlag(argv, 'poll')),
            max_chars: numberOrUndefined(dispatchFlag(argv, 'max-chars')),
            resume_task: dispatchFlag(argv, 'resume'),
            full_response: argv.includes('--full') ? true : undefined,
            include_timing: argv.includes('--timing') ? true : undefined,
        },
    }
}

async function dispatchCommand() {
    await ensureHttpSingleton({ port: defaultHttpPort(), wait: false }).catch((error) => {
        appendDiagnostic('dispatch-singleton-failed', { error: describeError(error) })
    })

    const argv = process.argv.slice(3)
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
        console.log(DISPATCH_USAGE)
        return 0
    }

    const parsed = parseDispatchArgv(argv)
    if (parsed.usageError) {
        console.error(parsed.usageError)
        return 2
    }

    const text = await gmDispatch(parsed.args)
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
    return text.trimStart().startsWith('error:') ? 1 : 0
}

const COMMANDS = {
    dispatch: dispatchCommand,
    'pin-local-build': () => {
        const deployedPath = process.argv[3]
        const localBuildPin = deployedPath ? pinLocalBuild(deployedPath) : pinLocalBuild()
        console.log(`gm-mcp ${BUNDLE_VERSION}: pinned ${localBuildPin.path} (sha256 ${localBuildPin.sha256}) as a local build in ${localBuildPinPath()} -- the release channel can no longer overwrite it`)
        return 0
    },
    'unpin-local-build': () => {
        const clearedLocalBuildPinPath = clearLocalBuildPin()
        console.log(`gm-mcp ${BUNDLE_VERSION}: cleared the local-build pin at ${clearedLocalBuildPinPath} --the release channel may update the deployed bundle again`)
        return 0
    },
    'self-update-status': () => {
        console.log(JSON.stringify(selfUpdateStatus(), null, 2))
        return 0
    },
    'self-update-now': async () => {
        // Read-only apart from the deployed bundle and its stamp: no server is started, no port is
        // bound, nothing is signalled, and this process is never handed over to the bundle it installs.
        const { deployed_bundle: deployedPath } = selfUpdateStatus()
        const before = deployedBundleVersion(deployedPath)
        const result = await refreshDeployedBundleNow(deployedPath)
        const after = deployedBundleVersion(deployedPath)
        const moved = result.outcome === 'refreshed'
        const versions = moved ? `${before} -> ${after}` : `${after ?? before ?? 'unknown version'}`
        console.log(`gm-mcp ${BUNDLE_VERSION}: deployed bundle ${versions} -- ${describeSelfUpdateOutcome(result)}`)
        if (moved) {
            const takesEffect = result.self === true ? 'takes effect on next connect' : 'takes effect for whoever launches the deployed copy next'
            console.log(`  ${deployedPath} -- ${takesEffect} (previous kept as ${path.basename(deployedPath)}.prev)`)
        }
        return 0
    },
    'dev-sync': async () => {
        const report = runDevSync(flagValue('root') || process.cwd())
        console.log(JSON.stringify(report, null, 2))
        return 0
    },
    'self-check': () => {
        const envelopes = replyEnvelopeSelfCheck()
        console.log(JSON.stringify(envelopes, null, 2))
        return Object.values(envelopes).some((reply) => reply.diagnostics_failed !== undefined) ? 1 : 0
    },
    'ensure-http': async () => {
        const port = defaultHttpPort()
        await sweepHttpInstances()
        const result = await ensureHttpSingleton({ port })
        if (!result.url) {
            console.error(`gm-mcp ${BUNDLE_VERSION}: ${result.error}`)
            return 1
        }
        console.log(`gm-mcp ${BUNDLE_VERSION}: ${result.reused ? 'reusing' : 'started'} the shared HTTP server (pid ${result.pid}) -- ${result.url}`)
        const ours = !result.reused || await holderIsOwn(port, result.pid)
        const supervision = ours ? ensureHttpSupervisor({ port }) : { started: false, reason: 'foreign-holder-not-supervised' }
        if (supervision.started) {
            console.log(`gm-mcp ${BUNDLE_VERSION}: armed the http supervisor (pid ${supervision.pid}, probing every ${Math.round(supervisorIntervalMs() / 1000)}s) -- it restarts ${result.url} when /health stops answering`)
        } else {
            console.log(`gm-mcp ${BUNDLE_VERSION}: supervisor ${supervision.reason}${supervision.pid ? ` (pid ${supervision.pid})` : ''}`)
        }
        return 0
    },
    'http-supervise': async () => {
        const portFlag = Number(flagValue('port'))
        const port = Number.isInteger(portFlag) && portFlag > 0 ? portFlag : defaultHttpPort()
        const seconds = Number(flagValue('interval'))
        const intervalMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : supervisorIntervalMs()
        recordRunningImage('supervisor', runningBundle())
        const result = await runHttpSupervisor({ port, intervalMs })
        console.error(`gm-mcp ${BUNDLE_VERSION}: ${result.reason}`)
        return result.supervised === false ? 1 : 0
    },
    'http-status': async () => {
        const port = defaultHttpPort()
        const health = await probeHealth(port)
        console.log(JSON.stringify({ port, url: httpMcpUrl(port), running: Boolean(health), health }, null, 2))
        return 0
    },
    'reap': async () => {
        const apply = process.argv.includes('--apply')
        const roots = repeatedFlag('root')
        if (roots.length === 0) roots.push(process.cwd())
        const report = await reapReport({ roots: roots.map((root) => path.resolve(root)), apply })
        if (process.argv.includes('--json')) {
            console.log(JSON.stringify(report, null, 2))
        } else {
            console.log(formatFindings(report))
            if (!apply && report.counts.retire > 0) {
                console.log(`\n(dry run: nothing was signalled -- re-run with --apply to retire the ${report.counts.retire} above)`)
            }
        }
        return 0
    },
    'leak-watch': async () => {
        const apply = process.argv.includes('--apply')
        const roots = repeatedFlag('root')
        const report = await leakWatchReport({ roots: roots.length > 0 ? roots.map((root) => path.resolve(root)) : null, apply })
        if (process.argv.includes('--json')) {
            console.log(JSON.stringify(report, null, 2))
        } else {
            console.log(formatLeakWatchLine(report))
            for (const entry of report.auto_apply.skipped) {
                console.log(`  SKIPPED pid ${entry.pid} -- blocked by ${entry.blocked_by.join(', ')}`)
            }
            if (report.orphans?.count > 0) {
                for (const item of report.orphans.items) console.log(formatOrphanLine(item))
                for (const tree of report.orphans.trees) if (tree.member_count > 0) console.log(formatOrphanTreeLine(tree))
                console.log(`\n(report only: an orphan is a process gm never spawned, so nothing here retires it -- classify pid(s) ${report.orphans.items.map((item) => item.pid).join(',')} by hand, thresholds ${JSON.stringify(report.orphans.thresholds)})`)
            }
            if (!apply && report.population.retireable > 0) {
                console.log(`\n(report only: nothing was signalled -- re-run with --apply, or set GM_MCP_LEAK_AUTO_APPLY=1 to let the hourly pass retire them)`)
            }
        }
        return 0
    },
    'attribute': async () => {
        const pid = Number(flagValue('pid'))
        if (!Number.isInteger(pid) || pid <= 0) {
            console.error('gm-mcp attribute: --pid <n> is required')
            return 2
        }
        const roots = repeatedFlag('root')
        if (roots.length === 0) roots.push(process.cwd())
        const rows = roots.map((root) => attributePid(pid, { root: path.resolve(root) }))
        const attributed = rows.find((row) => row.attributed === true)
        const answer = attributed ?? rows[0]
        console.log(JSON.stringify({ ...answer, ledger: globalLedgerPath(), roots: roots.map((root) => path.resolve(root)) }, null, 2))
        return attributed ? 0 : 1
    },
    'port-pool': async () => {
        const reclaimed = await reclaimDeadPortRegistries()
        const preferred = Number(flagValue('preferred')) || defaultHttpPort()
        const next = await allocateHttpPort({ preferred })
        console.log(JSON.stringify({ range: [PORT_POOL_FROM, PORT_POOL_TO], preferred, reclaimed, allocated: next }, null, 2))
        return 0
    },
}

const command = process.argv[2]

if (command === '--help' || command === '-h') {
    console.log(`gm-mcp ${BUNDLE_VERSION}

usage:
  gm-mcp-server.js                 start the MCP stdio server
  gm-mcp-server.js --http [--port N] [--host H]
                                   serve MCP streamable HTTP on http://127.0.0.1:N/mcp
                                   (stateless, so a dropped client is just another request)
  gm-mcp-server.js ensure-http     start the shared HTTP server if none is listening and print its url
  gm-mcp-server.js http-status     report whether the shared HTTP server is answering
  gm-mcp-server.js http-supervise [--port N] [--interval S]
                                   watch the shared HTTP server forever and restart it when
                                   /health stops answering (ensure-http arms one for you)
  gm-mcp-server.js dispatch <verb> [--body <json>] [--raw <text>] [--cwd <dir>] [--no-ignore] [--help]
                                   run a gm dispatch from the shell and print its reply,
                                   with no MCP client involved
  gm-mcp-server.js self-check        build every reply a dispatch can end on and print them; exits non-zero when one fell back
  gm-mcp-server.js reap [--apply] [--root <dir>]... [--json]
                                   report leaked processes and leases; without --apply it only
                                   prints what it WOULD retire, and it never signals a pid it
                                   cannot attribute or a record whose death it cannot measure
  gm-mcp-server.js leak-watch [--apply] [--root <dir>]... [--json]
                                   the same pass the server runs hourly: how many gm-mcp
                                   processes are alive, how many are unattributed or
                                   retireable, how many duplicate supervisors a port has,
                                   and which heavyweight orphans (ppid 1, not ours) are
                                   holding memory while burning no CPU
  gm-mcp-server.js attribute --pid N [--root <dir>]...
                                   print which dispatch spawned pid N (exit 1 if unattributed)
  gm-mcp-server.js port-pool [--preferred N]
                                   reclaim dead port registries and print the port that would
                                   be allocated next (lowest free, so ports stop ratcheting)
  gm-mcp-server.js pin-local-build [path]   pin the deployed bundle (default ~/.gm-tools/gm-mcp-server.mjs) so a self-update cannot overwrite it
  gm-mcp-server.js unpin-local-build        clear that pin
  gm-mcp-server.js self-update-status       print no-self-update state, local-build pin and deployed bundle sha256
  gm-mcp-server.js self-update-now          check the release channel NOW, ignoring the hourly stamp (safe beside a
                                   running server: it starts none, binds no port and signals no process)

register the durable transport instead of stdio with:
  claude mcp remove gm -s user && claude mcp add --transport http gm ${'http://127.0.0.1:'}${defaultHttpPort()}${'/mcp'} -s user

suppress self-update without a pin by setting ${'GM_MCP_NO_SELF_UPDATE'}=1 or creating ${noSelfUpdateFilePath()}`)
    process.exit(0)
}

if (command && COMMANDS[command]) {
    try {
        process.exit(await COMMANDS[command]())
    } catch (error) {
        const dispatchNote = error?.dispatch_id ? ` dispatch_id=${error.dispatch_id}` : ''
        console.error(`gm-mcp: ${command} failed: ${error.message}${dispatchNote} pid=${process.pid} log=${logFilePath()}`)
        process.exit(1)
    }
}

main().catch((e) => {
    console.error(e)
    const dispatchNote = e?.dispatch_id ? ` dispatch_id=${e.dispatch_id}` : ''
    console.error(`gm-mcp: crashed${dispatchNote} pid=${process.pid} log=${logFilePath()}`)
    process.exit(1)
})
