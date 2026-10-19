#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const BRANCH = 'main';
const FILE_MODE = '100644';
const PUSH_WAIT_MS = 60_000;
const POLL_MS = 5_000;
const MAX_ATTEMPTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function gh(method, path, body) {
  return new Promise((resolve, reject) => {
    const args = ['api', '-X', method, path];
    if (body !== undefined) args.push('--input', '-');
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${method} ${path}: ${err.trim() || `exit ${code}`}`));
      resolve(out.trim() ? JSON.parse(out) : null);
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function listRuns(api, sha) {
  const { workflow_runs } = await gh('GET', `${api}/actions/runs?head_sha=${sha}&per_page=100`);
  return workflow_runs.map((r) => ({ id: r.id, name: r.name, event: r.event, status: r.status, conclusion: r.conclusion }));
}

async function publish(slug, message, specs) {
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) throw new Error('first argument must be <owner>/<repo>');
  const api = `repos/${owner}/${repo}`;

  const files = await Promise.all(
    specs.map(async (spec) => {
      const eq = spec.indexOf('=');
      if (eq < 1) throw new Error(`bad file spec "${spec}": want <repoPath>=<localFile>`);
      return { path: spec.slice(0, eq), content: await readFile(spec.slice(eq + 1)) };
    }),
  );
  const blobs = [];
  for (const f of files) {
    const blob = await gh('POST', `${api}/git/blobs`, { content: f.content.toString('base64'), encoding: 'base64' });
    blobs.push({ path: f.path, mode: FILE_MODE, type: 'blob', sha: blob.sha });
  }

  let commitSha = null;
  let attempts = 0;
  for (; attempts < MAX_ATTEMPTS && !commitSha; ) {
    attempts++;
    const tip = (await gh('GET', `${api}/git/refs/heads/${BRANCH}`)).object.sha;
    const base = await gh('GET', `${api}/git/commits/${tip}`);
    const tree = await gh('POST', `${api}/git/trees`, { base_tree: base.tree.sha, tree: blobs });
    const commit = await gh('POST', `${api}/git/commits`, { message, tree: tree.sha, parents: [tip] });
    try {
      await gh('PATCH', `${api}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
      commitSha = commit.sha;
    } catch (e) {
      if (!/HTTP 422/.test(e.message) || attempts >= MAX_ATTEMPTS) throw e;
    }
  }

  for (const f of files) {
    const got = await gh('GET', `${api}/contents/${f.path}?ref=${commitSha}`);
    if (!Buffer.from(got.content, 'base64').equals(f.content)) throw new Error(`verify failed: ${f.path} differs at ${commitSha}`);
  }

  let runs = await listRuns(api, commitSha);
  for (let waited = 0; !runs.some((r) => r.event === 'push') && waited < PUSH_WAIT_MS; waited += POLL_MS) {
    await sleep(POLL_MS);
    runs = await listRuns(api, commitSha);
  }
  const dispatched = [];
  if (!runs.some((r) => r.event === 'push')) {
    const { workflows } = await gh('GET', `${api}/actions/workflows?per_page=100`);
    for (const wf of workflows.filter((w) => w.state === 'active')) {
      const file = await gh('GET', `${api}/contents/${wf.path}?ref=${commitSha}`);
      if (!/^\s*workflow_dispatch\b/m.test(Buffer.from(file.content, 'base64').toString('utf8'))) continue;
      await gh('POST', `${api}/actions/workflows/${wf.id}/dispatches`, { ref: BRANCH });
      dispatched.push(wf.path);
    }
    for (let waited = 0; dispatched.length && waited < PUSH_WAIT_MS; waited += POLL_MS) {
      await sleep(POLL_MS);
      runs = await listRuns(api, commitSha);
      if (runs.filter((r) => r.event === 'workflow_dispatch').length >= dispatched.length) break;
    }
  }

  const mainTip = (await gh('GET', `${api}/git/refs/heads/${BRANCH}`)).object.sha;
  return { repo: slug, branch: BRANCH, commit: commitSha, main_tip: mainTip, attempts, verified: files.map((f) => f.path), dispatched, runs };
}

const [slug, message, ...specs] = process.argv.slice(2);
if (!slug || !message || !specs.length) {
  console.error('usage: publish-api.mjs <owner>/<repo> <message> <repoPath>=<localFile> [...]');
  process.exit(2);
}
const result = await publish(slug, message, specs);
console.log(JSON.stringify(result, null, 2));
if (!result.runs.length) {
  console.error('no CI run for the landed sha: residual, not success');
  process.exitCode = 1;
}
