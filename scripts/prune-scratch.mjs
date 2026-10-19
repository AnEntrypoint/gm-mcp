#!/usr/bin/env node
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const OWNED_PREFIXES = [
  'gm-agentplug-home-',
  'freddie-spill-',
  'casey-gui-check-store-',
  'gm-prune-witness-',
  'gm-witness-',
  'gm-mcp-transport-test',
  'org.chromium',
  'gm-exec',
  'bunx',
];
const SCRATCH_ROOT = '/config/tmp';
const DEFAULT_CAP_HOURS = 24;
const MAX_WALK_ENTRIES = 20000;

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const root = option('--root');
const capHours = Number(option('--cap-hours') ?? DEFAULT_CAP_HOURS);
const apply = args.includes('--apply');

if (!root || !Number.isFinite(capHours) || capHours < 0) {
  console.error('usage: prune-scratch.mjs --root <dir under /config/tmp> [--cap-hours <n>=24] [--apply]');
  process.exit(2);
}

const refuse = (message) => {
  console.error(message);
  process.exit(2);
};

const scratchReal = await realpath(SCRATCH_ROOT);
const inScratch = (path) => path === scratchReal || path.startsWith(scratchReal + sep);

const lexicalRoot = resolve(root);
if ((await lstat(lexicalRoot)).isSymbolicLink()) refuse(`refusing symlinked root ${lexicalRoot}`);
const resolvedRoot = await realpath(lexicalRoot);
if (!inScratch(resolvedRoot)) refuse(`refusing root outside ${SCRATCH_ROOT}: ${resolvedRoot}`);

const cutoff = Date.now() - capHours * 3_600_000;

async function isStale(path) {
  const pending = [path];
  let visited = 0;
  try {
    while (pending.length > 0) {
      if (++visited > MAX_WALK_ENTRIES) return false;
      const current = pending.pop();
      const st = await lstat(current);
      if (st.mtimeMs > cutoff) return false;
      if (st.isDirectory()) {
        for (const name of await readdir(current)) pending.push(join(current, name));
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function inScratchReal(path) {
  try {
    return inScratch(await realpath(path));
  } catch {
    return false;
  }
}

const candidates = [];
const refusedNames = [];
for (const name of await readdir(resolvedRoot)) {
  if (!OWNED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
  const path = join(resolvedRoot, name);
  if (!(await inScratchReal(path))) {
    refusedNames.push(name);
    continue;
  }
  if (await isStale(path)) candidates.push({ name, path });
}

const removed = [];
if (apply) {
  for (const { name, path } of candidates) {
    if (!(await isStale(path)) || !(await inScratchReal(path))) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(name);
  }
}

const byPrefix = Object.fromEntries(OWNED_PREFIXES.map((prefix) => [prefix, candidates.filter((c) => c.name.startsWith(prefix)).length]));

console.log(JSON.stringify({ root: resolvedRoot, cap_hours: capHours, apply, by_prefix: byPrefix, candidates: candidates.map((c) => c.name), refused: refusedNames, removed }, null, 2));
