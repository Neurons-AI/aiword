#!/usr/bin/env node
// AI Word engine tool: the editor is the Rust app WordCraft (public fork Neurons-AI/aiword, branch
// main) compiled to WebAssembly. This script is how an agent repairs and ships it — on ANY machine
// the app is installed on (a Store buyer too): it installs its own Rust tools and fetches the source.
//
//   node scripts/engine.mjs status            where things are, what build is shipped, what is missing
//   node scripts/engine.mjs toolchain         install Rust + wasm32 + trunk into the app's data dir (once, ~1 GB, 3–10 min)
//   node scripts/engine.mjs ensure            fetch the engine source + translations if missing (git, else a tarball)
//   node scripts/engine.mjs check             cargo check of the web build (fast, catches compile errors)
//   node scripts/engine.mjs build [--bg]      trunk release build → .engine-staging/<hash>  (5–10 min)
//   node scripts/engine.mjs build-status      result of the last build (for --bg)
//   node scripts/engine.mjs ship              swap the staged build in (backup kept) — after the owner said yes
//   node scripts/engine.mjs rollback          put the previous build back
//   node scripts/engine.mjs push "<message>"  commit the engine source change and push branch main
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
// The maintainer's machine may point at its own checkout (engine.local.json, never packed).
try { Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(APP, 'engine.local.json'), 'utf8'))); } catch {}
const DATA = process.env.AIWORD_DATA || path.join(APP, 'data', 'engine');
const where = (p) => (/^~(\/|$)/.test(p) ? p.replace(/^~/, os.homedir()) : path.isAbsolute(p) ? p : path.join(DATA, p));
const SRC = where(cfg.checkout);
const I18N = where(cfg.i18nCheckout);
// aicw:installs cargo rustc trunk — the engine tool downloads its own pinned Rust into the app's data folder (never the machine's)
const TOOLS = where(cfg.toolchainDir || 'toolchain');
const RUSTUP_HOME = path.join(TOOLS, 'rustup');
const CARGO_HOME = path.join(TOOLS, 'cargo');
const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';
const localBin = path.join(CARGO_HOME, 'bin');
// Our own tools come first; a machine that already has Rust still works (system PATH after ours).
const ENV = { ...process.env, RUSTUP_HOME: fs.existsSync(RUSTUP_HOME) ? RUSTUP_HOME : (process.env.RUSTUP_HOME || ''), CARGO_HOME: fs.existsSync(CARGO_HOME) ? CARGO_HOME : (process.env.CARGO_HOME || ''),
  PATH: [localBin, path.join(TOOLS, 'bin'), process.env.PATH || ''].join(path.delimiter) };
for (const k of ['RUSTUP_HOME', 'CARGO_HOME']) if (!ENV[k]) delete ENV[k];
const WEB = path.join(SRC, cfg.webApp);
const DIST = path.join(SRC, cfg.dist);
const ASSETS = path.join(APP, cfg.assets);
const STAGING = path.join(APP, '.engine-staging');
const BACKUPS = path.join(APP, '.engine-backups');
const STATE = path.join(APP, '.engine-state.json');
const PAGE = path.join(APP, 'assets', 'app.html');

const out = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts, env: { ...ENV, ...(opts.env || {}) }, shell: WIN && !/\.exe$/i.test(cmd) && cmd !== 'git' });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || ''), error: r.error && String(r.error) };
};
const git = (...a) => sh('git', ['-C', SRC, ...a]);
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
// aicw:shared — the engine's build state of THIS machine (one engine per install, nobody's data)
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify({ ...readState(), ...s }, null, 2));
const wasmHash = (dir) => { try { const f = fs.readdirSync(dir).find((n) => /_bg\.wasm$/.test(n)); return f ? f.replace(/^wordcraft-web-|_bg\.wasm$/g, '') : null; } catch { return null; } };
const shippedBuild = () => (/const BUILD = '([a-f0-9]+)'/.exec(fs.readFileSync(PAGE, 'utf8')) || [])[1] || null;
const tail = (s, n = 4000) => (s.length > n ? s.slice(-n) : s);
const copyDir = (a, b) => { fs.rmSync(b, { recursive: true, force: true }); fs.cpSync(a, b, { recursive: true }); };
const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) out({ ok: false, error: `download failed ${res.status}`, url });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // aicw:shared — a download of the engine's build tools / source, the same for every person
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

const cmds = {
  status() {
    const exists = fs.existsSync(path.join(SRC, '.git'));
    const srcOk = exists || fs.existsSync(path.join(SRC, 'Cargo.toml'));
    const st = exists ? git('status', '--porcelain').out.trim().split('\n').filter(Boolean) : [];
    out({
      ok: true, app: APP, source: SRC, sourceExists: srcOk, git: exists, branch: exists ? git('rev-parse', '--abbrev-ref', 'HEAD').out.trim() : null,
      head: exists ? git('rev-parse', '--short', 'HEAD').out.trim() : null, uncommitted: st.slice(0, 30),
      shippedBuild: shippedBuild(), assetsBuild: wasmHash(ASSETS), staged: fs.existsSync(STAGING) ? fs.readdirSync(STAGING) : [],
      backups: fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).sort().slice(-5) : [], lastBuild: readState().build || null,
      data: DATA, canPush: exists && git('push', '--dry-run', '-q', 'origin', cfg.branch).code === 0, missing: [!exists && !fs.existsSync(path.join(SRC, 'Cargo.toml')) && 'source (engine.mjs ensure)', sh('cargo', ['--version']).code && 'rust (engine.mjs toolchain)', sh('trunk', ['--version']).code && 'trunk (engine.mjs toolchain)'].filter(Boolean),
      tools: { cargo: sh('cargo', ['--version']).code === 0, trunk: sh('trunk', ['--version']).code === 0, wasmTarget: /wasm32-unknown-unknown/.test(sh('rustup', ['target', 'list', '--installed']).out) },
    });
  },

  async toolchain() {
    // Installs what the build needs, inside the app's data dir (nothing system-wide, no admin rights):
    // rustup (minimal profile) + the toolchain from Cargo.toml's rust-version or newer + wasm32 target + trunk.
    fs.mkdirSync(TOOLS, { recursive: true });
    const have = (c, a) => sh(c, a).code === 0;
    const steps = [];
    if (!(have('cargo', ['--version']) && have('rustup', ['--version']))) {
      const triple = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
        'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc' }[`${process.platform}-${process.arch}`];
      if (!triple) out({ ok: false, error: `no Rust installer for ${process.platform}-${process.arch}` });
      const init = path.join(TOOLS, `rustup-init${EXE}`);
      await download(`https://static.rust-lang.org/rustup/dist/${triple}/rustup-init${EXE}`, init);
      if (!WIN) fs.chmodSync(init, 0o755);
      // wasm32 builds link with rust-lld, so Windows needs no Visual Studio: the gnu host avoids its linker check.
      const host = WIN ? triple.replace('msvc', 'gnu') : triple;
      const r = sh(init, ['-y', '--no-modify-path', '--profile', 'minimal', '--default-toolchain', 'stable', '--default-host', host, '--target', 'wasm32-unknown-unknown'],
        { env: { RUSTUP_HOME, CARGO_HOME, RUSTUP_INIT_SKIP_PATH_CHECK: 'yes' } });
      if (r.code) out({ ok: false, error: 'Rust install failed', detail: tail(r.out, 2000) });
      ENV.RUSTUP_HOME = RUSTUP_HOME; ENV.CARGO_HOME = CARGO_HOME;
      steps.push('rust');
    }
    if (!/wasm32-unknown-unknown/.test(sh('rustup', ['target', 'list', '--installed']).out)) {
      const r = sh('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
      if (r.code) out({ ok: false, error: 'could not add the wasm32 target', detail: tail(r.out, 1500) });
      steps.push('wasm32');
    }
    const need = (/rust-version\s*=\s*"([\d.]+)"/.exec(fs.existsSync(path.join(SRC, 'Cargo.toml')) ? fs.readFileSync(path.join(SRC, 'Cargo.toml'), 'utf8') : '') || [])[1];
    const cur = (/rustc (\d+\.\d+)/.exec(sh('rustc', ['--version']).out) || [])[1];
    if (need && cur && cmpVer(cur, need) < 0) { const r = sh('rustup', ['update', 'stable']); if (r.code) out({ ok: false, error: `Rust ${cur} is older than ${need} and could not update`, detail: tail(r.out, 1500) }); steps.push('rust-update'); }
    if (!have('trunk', ['--version'])) {
      const v = cfg.trunkVersion || '0.22.1';
      const t = { 'darwin-arm64': 'aarch64-apple-darwin.tar.gz', 'darwin-x64': 'x86_64-apple-darwin.tar.gz', 'linux-x64': 'x86_64-unknown-linux-gnu.tar.gz', 'linux-arm64': 'aarch64-unknown-linux-gnu.tar.gz',
        'win32-x64': 'x86_64-pc-windows-msvc.zip', 'win32-arm64': 'x86_64-pc-windows-msvc.zip' }[`${process.platform}-${process.arch}`];
      const bin = path.join(TOOLS, 'bin'); fs.mkdirSync(bin, { recursive: true });
      const arc = path.join(TOOLS, `trunk-${t}`);
      await download(`https://github.com/trunk-rs/trunk/releases/download/v${v}/trunk-${t}`, arc);
      // tar reads .tar.gz everywhere and .zip on Windows 10+ (bsdtar).
      const r = sh('tar', ['-xf', arc, '-C', bin]);
      if (r.code) out({ ok: false, error: 'could not unpack trunk', detail: tail(r.out, 1000) });
      if (!WIN) fs.chmodSync(path.join(bin, 'trunk'), 0o755);
      fs.rmSync(arc, { force: true });
      steps.push('trunk');
    }
    const v = { rustc: sh('rustc', ['--version']).out.trim(), trunk: sh('trunk', ['--version']).out.trim() };
    out({ ok: !!v.rustc && !!v.trunk, installed: steps, ...v, dir: TOOLS });
  },

  async ensure() {
    // git when present (keeps history: push works for the maintainer); otherwise a tarball, no git needed.
    const hasGit = sh('git', ['--version']).code === 0;
    const fetchSrc = async (repo, branch, tarball, dest, label) => {
      if (fs.existsSync(path.join(dest, 'Cargo.toml')) || fs.existsSync(path.join(dest, 'locales'))) return 'present';
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (hasGit) {
        const r = sh('git', ['clone', '--depth', '1', '--branch', branch, repo, dest]);
        if (!r.code) return 'git';
      }
      fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(dest, { recursive: true });
      const arc = dest + '.tar.gz';
      await download(tarball, arc);
      const r = sh('tar', ['-xzf', arc, '-C', dest, '--strip-components', '1']);
      fs.rmSync(arc, { force: true });
      if (r.code) out({ ok: false, error: `${label}: could not unpack the source`, detail: tail(r.out, 1500) });
      return 'tarball';
    };
    const a = await fetchSrc(cfg.repo, cfg.branch, cfg.tarball, SRC, 'engine');
    const b = await fetchSrc(cfg.i18nRepo, 'main', cfg.i18nTarball, I18N, 'translations');
    if (fs.existsSync(path.join(SRC, '.git'))) {
      if (!/upstream/.test(git('remote').out)) git('remote', 'add', 'upstream', cfg.upstream);
      const br = git('rev-parse', '--abbrev-ref', 'HEAD').out.trim();
      if (br !== cfg.branch) out({ ok: false, error: `source is on branch ${br}, expected ${cfg.branch}`, fix: `git -C ${SRC} checkout ${cfg.branch}` });
    }
    out({ ok: true, source: SRC, i18n: I18N, engine: a, translations: b, data: DATA });
  },

  check() {
    const r = sh('cargo', ['check', '-p', 'wordcraft-web', '--target', 'wasm32-unknown-unknown', '--message-format', 'short'], { cwd: SRC, env: { CRAFT_I18N_DIR: I18N } });
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
    const r = sh('trunk', ['build', '--release'], { cwd: WEB, env: { CRAFT_I18N_DIR: I18N } });
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
    // aicw:shared — the page now loads the newly shipped engine build (the app itself, not anyone's data)
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
    // aicw:shared — the page loads the build that was put back
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
    // aicw:shared — the maintainer's mirror of the app in the engine repository
    fs.writeFileSync(path.join(dest, 'README.md'), `# AI Word — AICoworker AI App\n\nThis folder is a mirror of the installed AI App (\`skills/ai-word\`), kept next to the engine it runs.\nThe engine (\`apps/wordcraft-web\`, the crates) builds to \`assets/wordcraft/\` with \`scripts/engine.mjs build\` — that\nbuild is not committed here. Update this mirror with \`node scripts/engine.mjs sync-app\` from the installed app.\n`);
    git('add', cfg.appMirror);
    const c = git('commit', '-q', '-m', 'AI Word app: sync aicw-app/ from the installed AI App');
    const p = /nothing to commit/.test(c.out) ? { code: 0 } : git('push', '-q', 'origin', cfg.branch);
    out({ ok: p.code === 0, mirror: dest, committed: !/nothing to commit/.test(c.out), detail: p.code ? tail(p.out, 1500) : undefined });
  },
};

const name = process.argv[2];
if (!cmds[name]) out({ ok: false, error: `unknown command ${name || ''}`, commands: Object.keys(cmds) });
await cmds[name]();
