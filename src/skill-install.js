// The skill roots a host reads. gm never writes skill copies there: the gm skill is served over MCP
// (gm_skill, src/skill-verb.js) from the bundle itself, so a host that enumerated its skills before gm ran
// reads the same text through the protocol and nothing is installed into ~/.claude or ~/.agents.
import os from 'node:os'
import path from 'node:path'

export function skillInstallRoots(home = os.homedir()) {
    return [path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills')]
}
