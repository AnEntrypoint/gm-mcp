import { homedir } from 'node:os'
import path from 'node:path'

export function toolsDir() {
    return path.resolve(process.env.GM_TOOLS_DIR?.trim() || path.join(homedir(), '.gm-tools'))
}

export function agentplugDir() {
    return path.resolve(process.env.AGENTPLUG_HOME?.trim() || path.join(homedir(), '.agentplug'))
}

export function spoolDirOf(root) {
    return path.join(root, '.gm', 'exec-spool')
}
