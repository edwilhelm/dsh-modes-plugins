// Host-half listPatches/readPatch test against a mock `ctx.fs` over a temp
// tree mirroring $DSH_HOME/sessions/<project>/session-<id>/auto-diff.patch.
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep, basename } from 'node:path';
import vm from 'node:vm';

const here = new URL('.', import.meta.url).pathname;
const hostSrc = readFileSync(new URL('host.js', import.meta.url), 'utf8');

// ---- build a temp $DSH_HOME/sessions mirror ----
const root = mkdtempSync(join(tmpdir(), 'adr-host-test-'));
const sessions = join(root, 'sessions');
const p1 = join(sessions, '--Proj-A--');
mkdirSync(join(p1, 'session-aaa'), { recursive: true });
mkdirSync(join(p1, 'session-bbb'), { recursive: true });
const p2 = join(sessions, '--Proj-B--');
mkdirSync(join(p2, 'session-ccc'), { recursive: true });
mkdirSync(join(p2, 'other-ignored'), { recursive: true }); // dir without patch

writeFileSync(join(p1, 'session-aaa', 'auto-diff.patch'), '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n');
writeFileSync(join(p1, 'session-bbb', 'auto-diff.patch'), '+++ b/y\n@@ -0,0 +1 @@\n+hello\n');
writeFileSync(join(p2, 'session-ccc', 'auto-diff.patch'), '--- a/z\n+++ /dev/null\n@@ -1 +0,0 @@\n-zz\n');
// content markers for readPatch
writeFileSync(join(p2, 'session-ccc', '.sentinel'), 'readme-target'); // unused

// ---- mock fs with same shapes the sandbox ctx.fs exposes ----
function mockResolve(abs) {
  return { targetKey: 'k:' + abs, displayPath: abs, processPath: () => abs };
}
const fsMock = {
  async resolve(path) {
    // resolve relative against... treat as absolute already
    return mockResolve(path);
  },
  async stat(target) {
    // determine type via on-disk stat
    const { statSync } = await import('node:fs');
    try {
      const s = statSync(target.processPath());
      return { version: String(s.mtimeMs), type: s.isDirectory() ? 'directory' : 'file', size: s.size };
    } catch { return undefined; }
  },
  async listDir(target) {
    const { readdirSync, statSync } = await import('node:fs');
    const { join: j } = await import('node:path');
    const base = target.processPath();
    let names;
    try { names = readdirSync(base); } catch { return []; }
    return names.map((name) => {
      const p = j(base, name);
      const s = statSync(p);
      return { name, type: s.isDirectory() ? 'directory' : 'file', size: s.size, target: mockResolve(p) };
    });
  },
  async readText(target) {
    const { readFileSync } = await import('node:fs');
    return readFileSync(target.processPath(), 'utf8');
  },
};

// ---- load host.js in a vm with `harness` provided; capture plastic "handle" ----
// The real runner evaluates the host half as `(async()=>{ code })()` so its
// top-level `return` is valid there; mirror that wrapper here.
function evalHost(sandbox, src) {
  vm.createContext(sandbox);
  const code = `(async () => {\n${src}\n})()`;
  return vm.runInContext(code, sandbox); // returns a promise
}

// ---- invoke apply() with a fake sandbox ctx providing fs + shellEnv ----
const fakeCtx = {
  get(name) {
    if (name === 'fs') return fsMock;
    if (name === 'shellEnv') return { collect: () => ({ DSH_HOME: root }) };
    return undefined;
  },
  on() {},
};

// The top-level `const handle = harness.handle` captures the registrar at
// eval time, so give harness.handle the real registrar BEFORE evaluation:
const handlers = new Map();
const sandbox2 = {
  harness: {
    handle: (method, fn) => { handlers.set(method, fn); return () => handlers.delete(method); },
    defineTool: () => {},
    registerTool: () => {},
  },
};
const plugin2 = await evalHost(sandbox2, hostSrc);
if (typeof plugin2?.apply !== 'function') { console.error('host.js did not return a plugin with apply()'); process.exit(1); }
plugin2.apply(fakeCtx);

if (!handlers.has('listPatches') || !handlers.has('readPatch')) {
  console.error('expected listPatches and readPatch handlers, got', [...handlers.keys()]);
  process.exit(1);
}

const listRes = await handlers.get('listPatches')();
if (!listRes.ok) { console.error('listPatches failed:', listRes.error); process.exit(1); }
console.log('listPatches found', listRes.patches.length, 'patches:');
for (const p of listRes.patches) console.log('  ', p.project, p.sessionId, p.patchPath, p.size + 'B');

// expect exactly 3 patches
if (listRes.patches.length !== 3) { console.error('expected 3 patches'); process.exit(1); }

// readPatch should return the raw text of the selected patch (compare to disk)
const target = listRes.patches[0];
const readRes = await handlers.get('readPatch')({ path: target.patchPath });
if (!readRes.ok) { console.error('readPatch failed:', readRes.error); process.exit(1); }
const expectText = readFileSync(target.patchPath, 'utf8');
console.log('\nreadPatch returned', readRes.text.split('\n').length, 'lines for', target.sessionId);
if (readRes.text !== expectText) { console.error('readPatch content mismatch'); process.exit(1); }
console.log('readPatch content matches file on disk.');

// error path: missing file
const badRes = await handlers.get('readPatch')({ path: join(sessions, 'nope.patch') });
console.log('readPatch missing-file -> ok:', badRes.ok, 'error:', badRes.error);

console.log('\nHOST HALF OK: listPatches + readPatch behave correctly against the sessions layout.');