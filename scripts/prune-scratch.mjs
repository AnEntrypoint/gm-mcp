#!/usr/bin/env node
import { lstat, readdir, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
const DEFAULT_CAP_HOURS = 24;
const MAX_WALK_ENTRIES = 20000;

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const root = option('--root') ?? tmpdir();
const capHours = Number(option('--cap-hours') ?? DEFAULT_CAP_HOURS);
const apply = args.includes('--apply');
const explicitPrefixes = args.flatMap((arg, i) => (arg === '--prefix' && args[i + 1] ? [args[i + 1]] : []));

if (!root || !Number.isFinite(capHours) || capHours < 0) {
  console.error('usage: prune-scratch.mjs [--root <dir>=os.tmpdir()] [--cap-hours <n>=24] [--prefix <p>]... [--apply]\n  decision: unowned stale entries under the root are reported (unowned_stale_total) and never removed; --prefix <p> is the opt-in removal.');
  process.exit(2);
}

const refuse = (message) => {
  console.error(message);
  process.exit(2);
};

const lexicalRoot = resolve(root);
let resolvedRoot;
try {
  if ((await lstat(lexicalRoot)).isSymbolicLink()) refuse(`refusing symlinked root ${lexicalRoot}`);
  resolvedRoot = await realpath(lexicalRoot);
} catch (error) {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') refuse(`refusing missing root ${lexicalRoot}: no such directory`);
  throw error;
}
const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
const inRoot = (path) => path === resolvedRoot || path.startsWith(rootPrefix);

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

async function inRootReal(path) {
  try {
    return inRoot(await realpath(path));
  } catch {
    return false;
  }
}

const SEPARATORS = /[-._]/;
const matchesPrefix = (name, prefix) =>
  name === prefix ||
  (name.startsWith(prefix) && (SEPARATORS.test(prefix.at(-1)) || SEPARATORS.test(name.charAt(prefix.length))));
const isOwned = (name) => OWNED_PREFIXES.some((prefix) => matchesPrefix(name, prefix));
const isNamed = (name) => explicitPrefixes.some((prefix) => matchesPrefix(name, prefix));
const unownedPrefixOf = (name) => name.split(/[-._]/)[0] || name;

const candidates = [];
const refusedNames = [];
const unownedByPrefix = {};
for (const name of await readdir(resolvedRoot)) {
  const path = join(resolvedRoot, name);
  if (!isOwned(name) && !isNamed(name)) {
    if ((await inRootReal(path)) && (await isStale(path))) {
      const prefix = unownedPrefixOf(name);
      unownedByPrefix[prefix] = (unownedByPrefix[prefix] ?? 0) + 1;
    }
    continue;
  }
  if (!(await inRootReal(path))) {
    refusedNames.push(name);
    continue;
  }
  if (await isStale(path)) candidates.push({ name, path });
}

const PROC_ROOT = '/proc';
const UNREADABLE = new Set(['EACCES', 'EPERM']);

async function uidOf(pid) {
  try {
    const match = /^Uid:\s+(\d+)/m.exec(await readFile(join(PROC_ROOT, pid, 'status'), 'utf8'));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function liveHolders(paths) {
  const holders = new Map(paths.map((path) => [path, new Set()]));
  const unreadablePids = new Set();
  const readablePids = new Set();
  let pids;
  try {
    pids = (await readdir(PROC_ROOT)).filter((name) => /^\d+$/.test(name));
  } catch {
    return { holders, noProc: true, unreadable: [] };
  }
  const claim = (pid, target) => {
    for (const path of paths) if (target === path || target.startsWith(path + sep)) holders.get(path).add(Number(pid));
  };
  const probe = async (pid, read) => {
    try {
      await read();
      readablePids.add(pid);
    } catch (err) {
      if (UNREADABLE.has(err.code)) unreadablePids.add(pid);
    }
  };
  for (const pid of pids) {
    const base = join(PROC_ROOT, pid);
    await probe(pid, async () => claim(pid, await readlink(join(base, 'cwd'))));
    await probe(pid, async () => {
      for (const fd of await readdir(join(base, 'fd'))) {
        await probe(pid, async () => claim(pid, await readlink(join(base, 'fd', fd))));
      }
    });
    await probe(pid, async () => {
      for (const arg of (await readFile(join(base, 'cmdline'), 'utf8')).split('\0')) claim(pid, arg);
    });
  }
  const opaque = [...unreadablePids].filter((pid) => !readablePids.has(pid));
  const unreadable = await Promise.all(opaque.map(async (pid) => ({ pid: Number(pid), uid: await uidOf(pid) })));
  return { holders, noProc: false, unreadable };
}

async function statusOf(candidate, live) {
  if (live.noProc) return { name: candidate.name, status: 'held', reason: 'liveness_unknown', pids: [] };
  const pids = [...live.holders.get(candidate.path)].sort((a, b) => a - b);
  if (pids.length > 0) return { name: candidate.name, status: 'held', reason: 'live_process', pids };
  const owner = (await lstat(candidate.path)).uid;
  const blocking = live.unreadable.filter((entry) => entry.uid === null || entry.uid === owner).map((entry) => entry.pid).sort((a, b) => a - b);
  if (blocking.length > 0) return { name: candidate.name, status: 'held', reason: 'liveness_unknown', pids: blocking };
  return { name: candidate.name, status: 'removable', reason: 'no_readable_holder', pids: [] };
}

const liveness = await liveHolders(candidates.map((c) => c.path));
const candidateStatus = [];
for (const candidate of candidates) candidateStatus.push(await statusOf(candidate, liveness));
const removable = candidates.filter((_, i) => candidateStatus[i].status === 'removable');
const held = candidateStatus.filter((entry) => entry.status === 'held');

const removed = [];
const skippedAtApply = [];
if (apply) {
  for (const { name, path } of removable) {
    if (!(await isStale(path)) || !(await inRootReal(path))) continue;
    const status = await statusOf({ name, path }, await liveHolders([path]));
    if (status.status === 'held') {
      skippedAtApply.push(status);
      continue;
    }
    await rm(path, { recursive: true, force: true });
    removed.push(name);
  }
}

const byPrefix = Object.fromEntries([...OWNED_PREFIXES, ...explicitPrefixes].map((prefix) => [prefix, removable.filter((c) => matchesPrefix(c.name, prefix)).length]));
const unownedSorted = Object.fromEntries(Object.entries(unownedByPrefix).sort(([a], [b]) => a.localeCompare(b)));
const unownedTotal = Object.values(unownedSorted).reduce((sum, n) => sum + n, 0);

console.log(JSON.stringify({ root: resolvedRoot, cap_hours: capHours, apply, by_prefix: byPrefix, explicit_prefixes: explicitPrefixes, unowned_stale_total: unownedTotal, unowned_by_prefix: unownedSorted, candidates: removable.map((c) => c.name), held, candidate_status: candidateStatus, unreadable_pids: liveness.unreadable, refused: refusedNames, removed, skipped_at_apply: skippedAtApply }, null, 2));
