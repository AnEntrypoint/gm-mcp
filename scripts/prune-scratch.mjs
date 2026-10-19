#!/usr/bin/env node
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const OWNED_PREFIXES = ['gm-agentplug-home-'];
const DEFAULT_CAP_HOURS = 24;

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const root = option('--root');
const capHours = Number(option('--cap-hours') ?? DEFAULT_CAP_HOURS);
const apply = args.includes('--apply');

if (!root || !Number.isFinite(capHours) || capHours < 0) {
  console.error('usage: prune-scratch.mjs --root <dir> [--cap-hours <n>=24] [--apply]');
  process.exit(2);
}

const cutoff = Date.now() - capHours * 3_600_000;
const isStale = (st) => st.isDirectory() && st.mtimeMs <= cutoff;

const candidates = [];
for (const name of await readdir(root)) {
  if (!OWNED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
  const path = join(root, name);
  if (isStale(await lstat(path))) candidates.push({ name, path });
}

const removed = [];
if (apply) {
  for (const { name, path } of candidates) {
    if (!isStale(await lstat(path))) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(name);
  }
}

console.log(JSON.stringify({ root, cap_hours: capHours, apply, candidates: candidates.map((c) => c.name), removed }, null, 2));
