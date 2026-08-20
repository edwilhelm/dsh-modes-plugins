// ============================================================================
// auto-diff review panel — HOST HALF  (pass as the `code` arg to cordis_define)
// ============================================================================
// Runs in the DSH process under a `node:vm` sandbox. Node globals are absent
// or redirected to Cordis services, so filesystem access goes through
// `ctx.fs` (injected). It resolves $DSH_HOME, walks
//   $DSH_HOME/sessions/<project>/session-<id>/auto-diff.patch
// and exposes two RPC methods to the browser half via `harness.handle`:
//   listPatches()          -> [{ project, sessionId, patchPath, displayPath }]
//   readPatch({ path })    -> the raw unified-diff text
//
// The body runs as the body of an async function, so `harness` is in scope at
// evaluation time; we capture it so the returned plugin's `apply` (which only
// sees the sandbox context) can register the handlers.
// ============================================================================

// Capture the sandbox-provided verb for registering invoke handlers.
const handle = harness.handle;

// ---- tiny path helpers (no Node `path` module in the sandbox) ----
function joinPath(root, name) {
  const sep = root.includes('\\') ? '\\' : '/';
  return String(root).replace(/[\\/]+$/, '') + sep + String(name);
}
function dirname(p) {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return idx > 0 ? p.slice(0, idx) : p;
}
function basename(p) {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}
function normalizeSlashes(p) {
  return String(p).split('\\').join('/');
}

async function resolveDshHome(ctx) {
  try {
    const shellEnv = ctx.get('shellEnv');
    if (shellEnv && typeof shellEnv.collect === 'function') {
      const env = shellEnv.collect({});
      if (env && typeof env['DSH_HOME'] === 'string' && env['DSH_HOME'].length > 0) {
        return env['DSH_HOME'].replace(/[\\/]+$/, '');
      }
    }
  } catch (e) { /* fall through */ }
  // Fallback: ~/.dsh
  try {
    const shell = ctx.get('shell');
    if (shell && typeof shell.run === 'function') {
      const spec = shell.resolve
        ? shell.resolve({ command: 'echo $HOME' })
        : { command: 'echo $HOME' };
      const res = await shell.run(spec);
      const text = (res && res.stdout && res.stdout.text != null ? res.stdout.text : '').trim();
      if (typeof text === 'string' && text.length > 0) return joinPath(text, '.dsh');
    }
  } catch (e) { /* fall through */ }
  return undefined;
}

// Walk $DSH_HOME/sessions recursively for auto-diff.patch files.
async function walkPatches(ctx, fs, baseTarget, baseDisplay, depth, out) {
  if (depth > 3) return; // sessions/<project>/session-<id>/auto-diff.patch
  let entries;
  try {
    entries = await fs.listDir(baseTarget);
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (entry.type === 'directory') {
      await walkPatches(ctx, fs, entry.target, joinPath(baseDisplay, entry.name), depth + 1, out);
    } else if (entry.type === 'file' && entry.name === 'auto-diff.patch') {
      const fullPath = joinPath(baseDisplay, entry.name);
      const parent = dirname(fullPath);
      out.push({
        project: basename(dirname(parent)), // sessions/<project>/...
        sessionId: basename(parent),
        patchPath: fullPath,
        displayPath: fullPath,
        size: typeof entry.size === 'number' ? entry.size : undefined,
      });
    }
  }
}

// The plugin the sandbox builds. `apply(ctx)` receives the guarded sandbox
// context; the services we read (fs, shellEnv, shell) come via ctx.get().
return {
  name: 'auto-diff-review',
  inject: ['fs'],
  apply(ctx) {
    const disposers = [];

    // listPatches -> [{ project, sessionId, patchPath, size }]
    disposers.push(handle('listPatches', async () => {
      const fs = ctx.get('fs');
      if (!fs) return { ok: false, error: 'fs service unavailable' };
      const dshHome = await resolveDshHome(ctx);
      if (!dshHome) return { ok: false, error: 'could not resolve DSH_HOME' };
      const sessionsRoot = joinPath(dshHome, 'sessions');
      let baseTarget;
      try {
        baseTarget = await fs.resolve(sessionsRoot);
      } catch (e) {
        return { ok: false, error: 'cannot resolve ' + sessionsRoot + ': ' + String((e && e.message) || e) };
      }
      const out = [];
      await walkPatches(ctx, fs, baseTarget, sessionsRoot, 0, out);
      // newest-first by path (session dirs embed a sortable id only weakly); keep
      // stable lexicographic reverse so recent-ish sessions surface first.
      out.sort((a, b) => (a.patchPath < b.patchPath ? 1 : a.patchPath > b.patchPath ? -1 : 0));
      return { ok: true, patches: out };
    }));

    // readPatch({ path }) -> { ok, text }
    disposers.push(handle('readPatch', async (args) => {
      const fs = ctx.get('fs');
      if (!fs) return { ok: false, error: 'fs service unavailable' };
      const p = args && typeof args.path === 'string' ? args.path : '';
      if (!p) return { ok: false, error: 'no path supplied' };
      let target;
      try {
        target = await fs.resolve(p);
        const info = await fs.stat(target);
        if (!info || info.type !== 'file') return { ok: false, error: 'not a file or missing: ' + p };
        const text = await fs.readText(target);
        return { ok: true, text };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }));

    ctx.on('dispose', () => { for (const d of disposers) { try { d && d(); } catch (e) {} } });
  },
};