import fs from 'node:fs'
import { main, flagValue } from './index.js'
import { gmDispatch } from './dispatch.js'
import { BUNDLE_VERSION } from './bundle-version.js'
import { setDiagnosticStderrEcho } from './server-log.js'
import { clearLocalBuildPin, localBuildPinPath, noSelfUpdateFilePath, pinLocalBuild, selfUpdateStatus } from './self-update.js'
import { defaultHttpPort, ensureHttpSingleton, ensureHttpSupervisor, httpMcpUrl, installHttpAutostart, installHttpScheduledTask, probeHealth, runHttpSupervisor, supervisorIntervalMs } from './singleton.js'

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
  gm dispatch health
  gm dispatch fetch --raw https://example.com

(run the same verbs as "node <bundle> dispatch ..." when gm itself is not on PATH)`

const DISPATCH_VALUE_FLAGS = new Set(['body', 'raw', 'cwd', 'session-id', 'timeout', 'poll', 'max-chars', 'resume'])

// The verbs whose scan universe can be widened past .gitignore. "search" is codesearch's own alias
// but is also the name of other verbs elsewhere, so it is left to the body field.
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

async function dispatchCommand() {
    setDiagnosticStderrEcho(false)
    const argv = process.argv.slice(3)
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
        console.log(DISPATCH_USAGE)
        return 0
    }

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
            console.error(`gm-mcp dispatch: --body is not valid JSON: ${error.message}`)
            return 2
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            console.error('gm-mcp dispatch: --body must be a JSON object')
            return 2
        }
    }

    // --no-ignore is the shell spelling of a scan body's own "no_ignore": one flag rather than a
    // field a caller has to splice into hand-written JSON. It is refused on the verbs that have no
    // such field, because a flag that silently does nothing is worse than one that says so.
    if (argv.includes('--no-ignore')) {
        if (!NO_IGNORE_VERBS.has(verb)) {
            console.error(`gm-mcp dispatch: --no-ignore applies to the search verbs (${[...NO_IGNORE_VERBS].join(', ')}), not "${verb}"`)
            return 2
        }
        if (body === undefined) body = {}
        body.no_ignore = true
    }

    const numberOrUndefined = (value) => {
        const parsed = Number(value)
        return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    }

    const args = {
        verb,
        body,
        raw_body: rawBody,
        session_id: dispatchFlag(argv, 'session-id') || `gm-cli-${process.pid}-${Date.now()}`,
        cwd: dispatchFlag(argv, 'cwd') || process.cwd(),
        timeout_seconds: numberOrUndefined(dispatchFlag(argv, 'timeout')),
        poll_interval_seconds: numberOrUndefined(dispatchFlag(argv, 'poll')),
        max_chars: numberOrUndefined(dispatchFlag(argv, 'max-chars')),
        resume_task: dispatchFlag(argv, 'resume'),
        full_response: argv.includes('--full') ? true : undefined,
        include_timing: argv.includes('--timing') ? true : undefined,
    }

    const text = await gmDispatch(args)
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
    return text.trimStart().startsWith('error:') ? 1 : 0
}

const COMMANDS = {
    dispatch: dispatchCommand,
    'pin-local-build': () => {
        const deployedPath = process.argv[3]
        const pin = deployedPath ? pinLocalBuild(deployedPath) : pinLocalBuild()
        console.log(`gm-mcp ${BUNDLE_VERSION}: pinned ${pin.path} (sha256 ${pin.sha256}) as a local build in ${localBuildPinPath()} -- the release channel can no longer overwrite it`)
        return 0
    },
    'unpin-local-build': () => {
        const pinPath = clearLocalBuildPin()
        console.log(`gm-mcp ${BUNDLE_VERSION}: cleared the local-build pin at ${pinPath} -- the release channel may update the deployed bundle again`)
        return 0
    },
    'self-update-status': () => {
        console.log(JSON.stringify(selfUpdateStatus(), null, 2))
        return 0
    },
    'ensure-http': async () => {
        const port = defaultHttpPort()
        const result = await ensureHttpSingleton({ port })
        if (!result.url) {
            console.error(`gm-mcp ${BUNDLE_VERSION}: ${result.error}`)
            return 1
        }
        const autostart = installHttpAutostart({ port })
        const supervisor = await ensureHttpSupervisor({ port })
        const task = installHttpScheduledTask({ port })
        console.log(`gm-mcp ${BUNDLE_VERSION}: ${result.reused ? 'reusing' : 'started'} the shared HTTP server (pid ${result.pid}) -- ${result.url}`)
        console.log(`gm-mcp ${BUNDLE_VERSION}: supervisor ${supervisor.reason} (pid ${supervisor.pid ?? 'none'}) -- restarts the server when it stops answering`)
        console.log(`gm-mcp ${BUNDLE_VERSION}: autostart ${autostart.installed ? (autostart.changed ? 'written' : 'already current') : `skipped (${autostart.reason})`} -- ${autostart.path ?? 'none'}`)
        console.log(`gm-mcp ${BUNDLE_VERSION}: task ${task.installed ? `${task.task} every ${task.minutes} min` : `skipped (${task.reason})`} -- restarts the supervisor when nothing else can`)
        return 0
    },
    'http-status': async () => {
        const port = defaultHttpPort()
        const health = await probeHealth(port)
        console.log(JSON.stringify({ port, url: httpMcpUrl(port), running: Boolean(health), health }, null, 2))
        return 0
    },
    'http-supervise': async () => {
        const port = Number(flagValue('port')) || defaultHttpPort()
        const seconds = Number(flagValue('interval'))
        const intervalMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : supervisorIntervalMs()
        const result = await runHttpSupervisor({ port, intervalMs })
        console.log(`gm-mcp ${BUNDLE_VERSION}: http-supervise ${port} ended -- ${result.reason ?? 'stopped'}`)
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
  gm-mcp-server.js ensure-http     start the shared HTTP server if none is listening, arm its supervisor and print its url
  gm-mcp-server.js http-status     report whether the shared HTTP server is answering
  gm-mcp-server.js http-supervise [--port N] [--interval S]
                                   watch the shared HTTP server and restart it when it stops answering
                                   (a --http server starts one for itself unless ${'GM_MCP_HTTP_SUPERVISOR'}=0)
  gm-mcp-server.js dispatch <verb> [--body <json>] [--raw <text>] [--cwd <dir>] [--help]
                                   run a gm dispatch from the shell and print its reply,
                                   with no MCP client involved
  gm-mcp-server.js pin-local-build [path]   pin the deployed bundle (default ~/.gm-tools/gm-mcp-server.mjs) so a self-update cannot overwrite it
  gm-mcp-server.js unpin-local-build        clear that pin
  gm-mcp-server.js self-update-status       print freeze state, local-build pin and deployed bundle sha256

register the durable transport instead of stdio with:
  claude mcp remove gm -s user && claude mcp add --transport http gm ${'http://127.0.0.1:'}${defaultHttpPort()}${'/mcp'} -s user

freeze a self-update without a pin by setting ${'GM_MCP_NO_SELF_UPDATE'}=1 or creating ${noSelfUpdateFilePath()}`)
    process.exit(0)
}

if (command && COMMANDS[command]) {
    try {
        process.exit(await COMMANDS[command]())
    } catch (error) {
        console.error(`gm-mcp: ${command} failed: ${error.message}`)
        process.exit(1)
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
