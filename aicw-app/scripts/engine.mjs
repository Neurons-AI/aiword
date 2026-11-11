#!/usr/bin/env node
// AI Word engine tool: the editor is the Rust app WordCraft (fork Neurons-AI/wordcraft, branch
// aiword) compiled to WebAssembly. This script is how an agent (or a person) repairs and ships it.
//
//   node scripts/engine.mjs status            where things are, what build is shipped, git state
//   node scripts/engine.mjs ensure            clone the fork + translations if missing
//   node scripts/engine.mjs check             cargo check of the web build (fast, catches compile errors)
//   node scripts/engine.mjs build [--bg]      trunk release build → .engine-staging/<hash>  (5–10 min)
//   node scripts/engine.mjs build-status      result of the last build (for --bg)
//   node scripts/engine.mjs ship              swap the staged build in (backup kept) — after the owner said yes
//   node scripts/engine.mjs rollback          put the previous build back
//   node scripts/engine.mjs push "<message>"  commit the engine source change and push branch aiword
//   node scripts/engine.mjs sync-app          mirror this app's source into the fork (aicw-app/) and push
//
// Every command prints one JSON line on stdout ({ok, …}); exit code 0 = ok.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(APP, 'engine.json'), 'utf8'));
const home = (p) => p.replace(/^~(?=\/|$)/, os.homedir());
const SRC = home(cfg.checkout);
const I18N = home(cfg.i18nCheckout);
const WEB = path.join(SRC, cfg.webApp);
const DIST = path.join(SRC, cfg.dist);
const ASSETS = path.join(APP, cfg.assets);
const STAGING = path.join(APP, '.engine-staging');
const BACKUPS = path.join(APP, '.engine-backups');
const STATE = path.join(APP, '.engine-state.json');
const PAGE = path.join(APP, 'assets', 'app.html');

const out = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || ''), error: r.error && String(r.error) };
};
const git = (...a) => sh('git', ['-C', SRC, ...a]);
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify({ ...readState(), ...s }, null, 2));
const wasmHash = (dir) => { try { const f = fs.readdirSync(dir).find((n) => /_bg\.wasm$/.test(n)); return f ? f.replace(/^wordcraft-web-|_bg\.wasm$/g, '') : null; } catch { return null; } };
const shippedBuild = () => (/const BUILD = '([a-f0-9]+)'/.exec(fs.readFileSync(PAGE, 'utf8')) || [])[1] || null;
const tail = (s, n = 4000) => (s.length > n ? s.slice(-n) : s);
const copyDir = (a, b) => { fs.rmSync(b, { recursive: true, force: true }); fs.cpSync(a, b, { recursive: true }); };

const cmds = {
  status() {
    const exists = fs.existsSync(path.join(SRC, '.git'));
    const st = exists ? git('status', '--porcelain').out.trim().split('\n').filter(Boolean) : [];
    out({
      ok: true, app: APP, source: SRC, sourceExists: exists, branch: exists ? git('rev-parse', '--abbrev-ref', 'HEAD').out.trim() : null,
      head: exists ? git('rev-parse', '--short', 'HEAD').out.trim() : null, uncommitted: st.slice(0, 30),
      shippedBuild: shippedBuild(), assetsBuild: wasmHash(ASSETS), staged: fs.existsSync(STAGING) ? fs.readdirSync(STAGING) : [],
      backups: fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).sort().slice(-5) : [], lastBuild: readState().build || null,
      tools: { cargo: sh('cargo', ['--version']).code === 0, trunk: sh('trunk', ['--version']).code === 0, wasmTarget: /wasm32-unknown-unknown/.test(sh('rustup', ['target', 'list', '--installed']).out) },
    });
  },

  ensure() {
    if (!fs.existsSync(path.join(SRC, '.git'))) {
      const r = sh('git', ['clone', '--branch', cfg.branch, cfg.repo, SRC]);
      if (r.code) out({ ok: false, error: 'clone failed', detail: tail(r.out, 1500) });
      git('remote', 'add', 'upstream', cfg.upstream);
    }
    if (!fs.existsSync(path.join(I18N, '.git'))) {
      const r = sh('git', ['clone', cfg.i18nRepo, I18N]);
      if (r.code) out({ ok: false, error: 'i18n clone failed', detail: tail(r.out, 1500) });
    }
    const br = git('rev-parse', '--abbrev-ref', 'HEAD').out.trim();
    if (br !== cfg.branch) out({ ok: false, error: `source is on branch ${br}, expected ${cfg.branch}`, fix: `git -C ${SRC} checkout ${cfg.branch}` });
    out({ ok: true, source: SRC, i18n: I18N, branch: br });
  },

  check() {
    const r = sh('cargo', ['check', '-p', 'wordcraft-web', '--target', 'wasm32-unknown-unknown', '--message-format', 'short'], { cwd: SRC, env: { ...process.env, CRAFT_I18N_DIR: I18N } });
    const errors = r.out.split('\n').filter((l) => /\berror(\[E\d+\])?:/.test(l)).slice(0, 40);
    out({ ok: r.code === 0, errors, tail: r.code ? tail(r.out, 3000) : undefined });
  },

  build() {
    if (process.argv.includes('--bg')) {
      // Detached: survives the agent turn; result in .engine-state.json (build-status).
      const log = path.join(APP, '.engine-build.log');
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'build'], { detached: true, stdio: ['ignore', fs.openSync(log, 'w'), fs.openSync(log, 'a')] });
      child.unref();
      writeState({ build: { state: 'running', pid: child.pid, startedAt: new Date().toISOString(), log } });
      out({ ok: true, started: true, pid: child.pid, log, next: 'node scripts/engine.mjs build-status' });
    }
    const t0 = Date.now();
    writeState({ build: { state: 'running', pid: process.pid, startedAt: new Date().toISOString() } });
    const r = sh('trunk', ['build', '--release'], { cwd: WEB, env: { ...process.env, CRAFT_I18N_DIR: I18N } });
    if (r.code) {
      const errors = r.out.split('\n').filter((l) => /\berror(\[E\d+\])?[:\s]/.test(l)).slice(0, 40);
      writeState({ build: { state: 'failed', at: new Date().toISOString(), errors, tail: tail(r.out, 3000) } });
      out({ ok: false, error: 'build failed', errors, tail: tail(r.out, 3000) });
    }
    const hash = wasmHash(DIST);
    const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
    // Smoke checks of what the page relies on.
    const problems = [];
    if (!hash) problems.push('no .wasm in the build');
    if (!/__aiword/.test(html)) problems.push('index.html lost the AI Word postMessage bridge (apps/wordcraft-web/index.html)');
    if (problems.length) { writeState({ build: { state: 'failed', at: new Date().toISOString(), errors: problems } }); out({ ok: false, error: 'build is not shippable', problems }); }
    const dest = path.join(STAGING, hash);
    fs.mkdirSync(STAGING, { recursive: true });
    copyDir(DIST, dest);
    fs.rmSync(path.join(dest, '.trunk-lock'), { force: true });
    for (const f of ['LICENSE-MIT', 'NOTICE']) if (fs.existsSync(path.join(SRC, f))) fs.copyFileSync(path.join(SRC, f), path.join(dest, f));
    const head = git('rev-parse', '--short', 'HEAD').out.trim();
    const dirty = git('status', '--porcelain').out.trim().length > 0;
    writeState({ build: { state: 'done', at: new Date().toISOString(), hash, head, dirty, staged: dest, seconds: Math.round((Date.now() - t0) / 1000) } });
    out({ ok: true, hash, staged: dest, head, dirty, seconds: Math.round((Date.now() - t0) / 1000), next: 'ask the owner, then: node scripts/engine.mjs ship' });
  },

  'build-status'() {
    const b = readState().build;
    if (!b) out({ ok: false, error: 'no build has run' });
    if (b.state === 'running' && b.pid) { try { process.kill(b.pid, 0); } catch { out({ ok: false, state: 'died', ...b, log: b.log && fs.existsSync(b.log) ? tail(fs.readFileSync(b.log, 'utf8'), 3000) : undefined }); } }
    out({ ok: b.state !== 'failed', ...b });
  },

  ship() {
    const b = readState().build;
    if (!b || b.state !== 'done' || !fs.existsSync(b.staged)) out({ ok: false, error: 'nothing staged — run build first' });
    const prev = shippedBuild();
    if (fs.existsSync(ASSETS)) {
      fs.mkdirSync(BACKUPS, { recursive: true });
      const bdir = path.join(BACKUPS, `${new Date().toISOString().replace(/[:.]/g, '-')}-${prev || 'unknown'}`);
      fs.renameSync(ASSETS, bdir);
      // Keep the 3 newest backups (each ~60 MB).
      const all = fs.readdirSync(BACKUPS).sort();
      for (const old of all.slice(0, Math.max(0, all.length - 3))) fs.rmSync(path.join(BACKUPS, old), { recursive: true, force: true });
    }
    copyDir(b.staged, ASSETS);
    const page = fs.readFileSync(PAGE, 'utf8').replace(/const BUILD = '[a-f0-9]*'/, `const BUILD = '${b.hash}'`);
    fs.writeFileSync(PAGE, page);
    fs.rmSync(STAGING, { recursive: true, force: true });
    writeState({ shipped: { hash: b.hash, previous: prev, at: new Date().toISOString(), head: b.head } });
    out({ ok: true, shipped: b.hash, previous: prev, next: 'reload the AI Word window (artifact update codePath skill:ai-word/assets/app.html) and check it opens' });
  },

  rollback() {
    const all = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).sort() : [];
    const last = all.pop();
    if (!last) out({ ok: false, error: 'no backup to roll back to' });
    fs.rmSync(ASSETS, { recursive: true, force: true });
    fs.renameSync(path.join(BACKUPS, last), ASSETS);
    const hash = wasmHash(ASSETS);
    fs.writeFileSync(PAGE, fs.readFileSync(PAGE, 'utf8').replace(/const BUILD = '[a-f0-9]*'/, `const BUILD = '${hash}'`));
    writeState({ shipped: { hash, rolledBackFrom: last, at: new Date().toISOString() } });
    out({ ok: true, restored: hash });
  },

  push() {
    const msg = process.argv.slice(3).join(' ').trim();
    if (!msg) out({ ok: false, error: 'give a commit message: engine.mjs push "AI Word: fix …"' });
    const br = git('rev-parse', '--abbrev-ref', 'HEAD').out.trim();
    if (br !== cfg.branch) out({ ok: false, error: `on branch ${br}, expected ${cfg.branch}` });
    git('add', '-A');
    const c = git('commit', '-q', '-m', msg);
    if (c.code && !/nothing to commit/.test(c.out)) out({ ok: false, error: 'commit failed', detail: tail(c.out, 1500) });
    const p = git('push', '-q', 'origin', cfg.branch);
    if (p.code) out({ ok: false, error: 'push failed (committed locally)', detail: tail(p.out, 1500) });
    out({ ok: true, head: git('rev-parse', '--short', 'HEAD').out.trim(), branch: cfg.branch });
  },

  'sync-app'() {
    // The AI App itself (page, backend, scripts, docs) — not the 57 MB build, not data.
    const dest = path.join(SRC, cfg.appMirror);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const skip = /^(node_modules|wordcraft|data|logs|\.engine-[a-z]+|\.engine-[a-z]+\.json|\.engine-build\.log|\.aicw-fix|\.aicw-dev|\.DS_Store|tests\/preview\.html)$/;
    const walk = (rel = '') => {
      for (const e of fs.readdirSync(path.join(APP, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (skip.test(e.name) || skip.test(r)) continue;
        if (e.isDirectory()) { fs.mkdirSync(path.join(dest, r), { recursive: true }); walk(r); } else fs.copyFileSync(path.join(APP, r), path.join(dest, r));
      }
    };
    walk();
    fs.writeFileSync(path.join(dest, 'README.md'), `# AI Word — AICoworker AI App\n\nThis folder is a mirror of the installed AI App (\`skills/ai-word\`), kept next to the engine it runs.\nThe engine (\`apps/wordcraft-web\`, the crates) builds to \`assets/wordcraft/\` with \`scripts/engine.mjs build\` — that\nbuild is not committed here. Update this mirror with \`node scripts/engine.mjs sync-app\` from the installed app.\n`);
    git('add', cfg.appMirror);
    const c = git('commit', '-q', '-m', 'AI Word app: sync aicw-app/ from the installed AI App');
    const p = /nothing to commit/.test(c.out) ? { code: 0 } : git('push', '-q', 'origin', cfg.branch);
    out({ ok: p.code === 0, mirror: dest, committed: !/nothing to commit/.test(c.out), detail: p.code ? tail(p.out, 1500) : undefined });
  },
};

const name = process.argv[2];
if (!cmds[name]) out({ ok: false, error: `unknown command ${name || ''}`, commands: Object.keys(cmds) });
cmds[name]();
