// ============================================================================
// auto-diff v1  (internal version 1.0.0, package dsh-auto-diff-v1)
// ============================================================================
// First-generation port of the opencode plugin auto-diff.ts, adapted to DSH.
//
// Scope: captures each file's original content in memory BEFORE the write/edit
// tool mutates it, and at every agent-idle (end of turn / session) writes a
// unified diff of all touched files to the session's own record directory:
//     $DSH_HOME/sessions/--<encoded project path>--/session-<id>/auto-diff.patch
// That directory (next to session.jsonl.zstd) is the ONLY canonical location;
// there is deliberately no ~/.deepsessions copy.
//
// This version watches ONLY the `write` and `edit` tools (parity with the
// reference plugin). pwsh-driven file changes are NOT tracked.
//
// PERSISTED as the disabled preset row `auto-diff-v1` in the `autodiff`
// agent preset: present but dormant unless explicitly enabled.
//
// MULTI-SESSION SAFETY: the preset's standing composition is SHARED by every
// session that mounts it, so all mutable state is keyed by agent id — each
// session gets its own capture map, workspace, and session tag, and the flush
// runs only for the agent that went idle.
//
// Host-only. Self-contained diff engine (Myers array diff + difflib-style
// grouping) because no import/require is guaranteed in every host context.
// ============================================================================
'use strict';

module.exports = {
  name: 'auto-diff-v1',
  inject: ['fs'],
  apply(ctx) {
    const fs = ctx.fs;

    // ---------------- shared constants / stateless helpers ----------------
    const BINARY = { binary: true };
    const MAX_BYTES = 64 * 1024 * 1024;
    const MYERS_MAX_EDIT = 512;

    const pad2 = (n) => String(n).padStart(2, '0');
    function sessionTimestamp(d) {
      d = d || new Date();
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
    }
    function sanitizeName(s) {
      return String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    }
    function joinPath(root, name) {
      const sep = root.includes('\\') ? '\\' : '/';
      return root.replace(/[\\/]+$/, '') + sep + name;
    }
    function dirname(p) {
      const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
      return idx > 0 ? p.slice(0, idx) : p;
    }
    function basename(p) {
      const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
      return idx >= 0 ? p.slice(idx + 1) : p;
    }
    const lower = (s) => String(s).toLowerCase();

    // ---------------- session-store target (mirrors dsh-session-persistence-jsonl) ----------------
    // `$DSH_HOME/sessions/<--encoded-cwd-->/<session segment>/` is where the harness
    // keeps each session's own record (session.jsonl.zstd). The patch lands in the
    // SAME directory so it travels with its session. The encoding rules below
    // replicate the backend's projectKey/encodeSegment exactly, so the derived
    // path always matches the real session record directory.
    function encodeSegment(raw) {
      if (raw.length === 0) return '~002E';
      if (raw === '.') return '~002E';
      if (raw === '..') return '~002E~002E';
      let out = '';
      for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        const ch = String.fromCharCode(code);
        if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
        else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      }
      return out;
    }
    function projectKey(cwd) {
      if (cwd.length === 0) return '--root--';
      let readable = '';
      let separatorRun = false;
      for (let i = 0; i < cwd.length; i++) {
        const code = cwd.charCodeAt(i);
        const ch = String.fromCharCode(code);
        if (ch === '/' || ch === '\\' || ch === ':') {
          if (!separatorRun) readable += '-';
          separatorRun = true;
        } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
          readable += ch;
          separatorRun = false;
        } else {
          readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
          separatorRun = false;
        }
      }
      return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
    }
    function sessionPatchTarget(b, sessionsRoot) {
      const project = (b.workspace && b.workspace.length > 0) ? projectKey(b.workspace) : '_no-cwd';
      const rawId = (b.sessionId && b.sessionId.length > 0) ? String(b.sessionId) : 'unknown';
      const segment = encodeSegment(rawId.startsWith('session-') ? rawId : 'session-' + rawId);
      return joinPath(joinPath(joinPath(sessionsRoot, project), segment), 'auto-diff.patch');
    }
    async function resolveDshHome() {
      try {
        const shellEnv = ctx.get('shellEnv');
        if (shellEnv && typeof shellEnv.collect === 'function') {
          const env = shellEnv.collect({});
          const dshHome = (env && typeof env === 'object') ? env.DSH_HOME : undefined;
          if (typeof dshHome === 'string' && dshHome.length > 0) return dshHome.replace(/[\\/]+$/, '');
        }
      } catch (e) { console.error('[autodiff] DSH_HOME lookup failed:', e && e.message ? e.message : String(e)); }
      try {
        const home = await resolveHomeDir();
        if (home) return joinPath(home, '.dsh');
      } catch (e) { /* fall through */ }
      return undefined;
    }

    // ---------------- per-session (agent-keyed) state ----------------
    // Because one standing mount instance serves every session on this preset,
    // every mutable field lives in a per-agent bucket.
    const stateByAgent = new Map(); // agentId -> bucket
    function agentIdOf(agent) {
      if (!agent || typeof agent !== 'object') return undefined;
      try {
        const header = (agent.session && agent.session.header) ? agent.session.header : agent.header;
        return (header && typeof header.id === 'string' && header.id.length > 0) ? header.id : undefined;
      } catch (e) { return undefined; }
    }
    function bucketFor(agent, create) {
      const id = agentIdOf(agent);
      if (id === undefined) return undefined;
      const existing = stateByAgent.get(id);
      if (existing) {
        if (agent) recordAgentInto(existing, agent);
        return existing;
      }
      if (!create) return undefined;
      const b = {
        originals: new Map(), // abs path -> string | null | BINARY
        workspace: null,
        sessionTag: sessionTimestamp(),
        sessionId: id,
        dshHomePromise: null,
      };
      stateByAgent.set(id, b);
      if (agent) recordAgentInto(b, agent);
      return b;
    }
    function recordAgentInto(b, agent) {
      try {
        if (!agent || typeof agent !== 'object') return;
        const header = (agent.session && agent.session.header) ? agent.session.header : agent.header;
        if (!header || typeof header !== 'object') return;
        if (typeof header.cwd === 'string' && header.cwd.length > 0) b.workspace = header.cwd;
        if (typeof header.id === 'string' && header.id.length > 0) b.sessionId = header.id;
      } catch (e) { /* ignored */ }
    }
    function ensureWorkspace(b) {
      if (b.workspace) return;
      try {
        const sp = ctx.get('sandboxPolicy');
        if (sp && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot.length > 0) b.workspace = sp.workspaceRoot;
      } catch (e) { /* ignored */ }
    }

    // ---------------- home directory discovery ----------------
    async function resolveHomeDir() {
      try {
        const shellEnv = ctx.get('shellEnv');
        if (shellEnv && typeof shellEnv.collect === 'function') {
          const env = shellEnv.collect({});
          const dshHome = (env && typeof env === 'object') ? env.DSH_HOME : undefined;
          if (typeof dshHome === 'string' && dshHome.length > 0 && basename(dshHome) === '.dsh') {
            return dirname(dshHome);
          }
        }
      } catch (e) {
        console.error('[autodiff] DSH_HOME lookup failed:', e && e.message ? e.message : String(e));
      }
      try {
        const shell = ctx.get('shell');
        if (shell && typeof shell.resolve === 'function' && typeof shell.run === 'function') {
          const spec = shell.resolve({ command: 'Write-Output $HOME', timeoutMs: 15000 });
          const result = await shell.run(spec);
          const text = (result && result.stdout && result.stdout.text ? result.stdout.text : '').trim();
          if (text.length > 0) return text;
        }
      } catch (e) {
        console.error('[autodiff] $HOME lookup failed:', e && e.message ? e.message : String(e));
      }
      return undefined;
    }

    // ---------------- capture (before mutation) ----------------
    async function capturePath(b, filePath, agent) {
      if (typeof filePath !== 'string' || filePath.trim().length === 0) return;
      try {
        if (agent) recordAgentInto(b, agent);
        ensureWorkspace(b);
        const target = await fs.resolve(filePath, b.workspace ? { cwd: b.workspace } : undefined);
        const abs = target.displayPath;
        if (b.originals.has(abs)) return;
        try {
          const text = await fs.readText(target);
          b.originals.set(abs, text);
        } catch (readError) {
          const code = readError && readError.code;
          b.originals.set(abs, code === 'FS_NOT_TEXT' ? BINARY : null);
        }
      } catch (e) {
        console.error('[autodiff] capture failed for', filePath, ':', e && e.message ? e.message : String(e));
      }
    }
    async function captureFromExec(exec) {
      try {
        if (!exec || typeof exec !== 'object') return;
        const name = exec.name;
        const args = exec.arguments;
        if (!args || typeof args !== 'object') return;
        if (name === 'write' || name === 'edit') {
          const targetPath = args.file_path;
          if (typeof targetPath === 'string' && targetPath.length > 0) {
            const b = bucketFor(exec.agent, true);
            if (b) await capturePath(b, targetPath, exec.agent);
          }
        }
      } catch (e) {
        console.error('[autodiff] pre-execute capture failed:', e && e.message ? e.message : String(e));
      }
    }

    // ---------------- diff-time read ----------------
    async function readNewState(abs) {
      try {
        const target = await fs.resolve(abs);
        try {
          const bytes = await fs.readBytes(target, undefined, MAX_BYTES);
          return { kind: 'bytes', bytes };
        } catch (e) {
          if (e && e.code === 'FS_TOO_LARGE') {
            const text = await fs.readText(target);
            return { kind: 'text', content: text };
          }
          throw e;
        }
      } catch (e) {
        const code = e && e.code;
        if (code === 'FS_NOT_FOUND') return { kind: 'absent' };
        return { kind: 'error' };
      }
    }

    // ---------------- diff output assembly ----------------
    function buildTextEntry(rel, old, newContent) {
      if (old === BINARY) return { rel, status: 'binary', diffText: 'Binary file differs: ' + rel };
      if (old === null) return { rel, status: 'created', diffText: createdDiffText(rel, newContent) };
      if (old === newContent) return null;
      if (old === '' && newContent !== '') return { rel, status: 'created', diffText: createdDiffText(rel, newContent) };
      return { rel, status: 'modified', diffText: unifiedDiffText(rel, old, newContent) };
    }
    function buildEntry(rel, old, state) {
      if (state.kind === 'absent') {
        if (old === BINARY) return { rel, status: 'deleted', diffText: 'Binary file deleted: ' + rel };
        if (typeof old === 'string') return { rel, status: 'deleted', diffText: deletedDiffText(rel, old) };
        return null;
      }
      if (state.kind === 'error') {
        return { rel, status: 'binary', diffText: old === null ? 'Binary file created: ' + rel : 'Binary file differs: ' + rel };
      }
      if (state.kind === 'bytes') {
        if (isBinary(state.bytes)) {
          return { rel, status: 'binary', diffText: old === null ? 'Binary file created: ' + rel : 'Binary file differs: ' + rel };
        }
        return buildTextEntry(rel, old, new TextDecoder().decode(state.bytes));
      }
      return buildTextEntry(rel, old, state.content);
    }
    function toRel(b, abs) {
      if (b.workspace) {
        const root = b.workspace.replace(/[\\/]+$/, '');
        const la = lower(abs);
        const lr = lower(root);
        if (la === lr) return basename(abs) || abs;
        if (la.startsWith(lr + '\\') || la.startsWith(lr + '/')) {
          return abs.slice(root.length + 1).split('\\').join('/');
        }
      }
      return abs.split('\\').join('/');
    }
    function buildDiffOutput(entries) {
      let out = '';
      for (const e of entries) {
        if (!e.diffText) continue;
        out += e.diffText;
        if (!e.diffText.endsWith('\n')) out += '\n';
      }
      return out;
    }

    // ---------------- flush (end of turn / session) ----------------
    async function flushDiff(b) {
      if (!b || b.originals.size === 0) return;
      try {
        ensureWorkspace(b);
        if (!b.dshHomePromise) b.dshHomePromise = resolveDshHome();
        const dshHome = await b.dshHomePromise;
        if (!dshHome) {
          console.error('[autodiff] cannot locate DSH_HOME; skipping session diff');
          return;
        }
        const items = Array.from(b.originals.entries())
          .map(([abs, old]) => ({ abs, old, rel: toRel(b, abs) }))
          .sort((a, b2) => (a.rel < b2.rel ? -1 : a.rel > b2.rel ? 1 : 0));
        const entries = [];
        for (const item of items) {
          const state = await readNewState(item.abs);
          const entry = buildEntry(item.rel, item.old, state);
          if (entry) entries.push(entry);
        }
        const patchText = buildDiffOutput(entries);
        if (patchText.trim().length === 0) return;
        // The session's own record directory (next to session.jsonl.zstd) is
        // the single canonical location for the accumulated patch.
        const patchTarget = await fs.resolve(sessionPatchTarget(b, joinPath(dshHome, 'sessions')));
        // User-approved plugin host code writing into the user's own harness
        // home: the per-call policy is declared explicitly as full access.
        await fs.writeText(patchTarget, patchText, undefined, undefined, { mode: 'danger-full-access', workspaceRoot: dshHome });
      } catch (e) {
        console.error('[autodiff] failed to write session diff:', e && e.message ? e.message : String(e));
      }
    }

    // ---------------- event wiring ----------------
    ctx.on('session/created', (session) => {
      try {
        const b = bucketFor(session, true);
        if (b) {
          b.originals.clear();
          b.sessionTag = sessionTimestamp();
        }
      } catch (e) { /* contained */ }
    });
    ctx.on('tools/pre-execute', async (exec, next) => {
      await captureFromExec(exec);
      return next();
    });
    ctx.on('agent/status', (payload) => {
      try {
        if (payload && payload.status === 'idle') {
          const b = bucketFor(payload.agent, true);
          if (b) flushDiff(b).catch((e) => console.error('[autodiff] flush failed:', e && e.message ? e.message : String(e)));
        }
      } catch (e) { /* contained */ }
    });

    // ---------------- diff engine (self-contained Myers + unified text) ----------------
    function splitLines(s) {
      if (s === '') return [];
      const lines = [];
      let start = 0;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '\n') { lines.push(s.slice(start, i + 1)); start = i + 1; }
      }
      if (start < s.length) lines.push(s.slice(start));
      return lines;
    }
    function isBinary(data) {
      if (data.length === 0) return false;
      if (data.includes(0)) return true;
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(data);
        return false;
      } catch (e) { return true; }
    }
    function addToPath(path, added, removed, oldPosInc) {
      const last = path.lastComponent;
      if (last && last.added === added && last.removed === removed) {
        return { oldPos: path.oldPos + oldPosInc, lastComponent: { count: last.count + 1, added, removed, previousComponent: last.previousComponent } };
      }
      return { oldPos: path.oldPos + oldPosInc, lastComponent: { count: 1, added, removed, previousComponent: last } };
    }
    function extractCommon(basePath, newTokens, oldTokens, diagonalPath) {
      const newLen = newTokens.length, oldLen = oldTokens.length;
      let oldPos = basePath.oldPos, newPos = oldPos - diagonalPath, commonCount = 0;
      while (newPos + 1 < newLen && oldPos + 1 < oldLen && oldTokens[oldPos + 1] === newTokens[newPos + 1]) {
        newPos++; oldPos++; commonCount++;
      }
      if (commonCount) {
        basePath.lastComponent = { count: commonCount, previousComponent: basePath.lastComponent, added: false, removed: false };
      }
      basePath.oldPos = oldPos;
      return newPos;
    }
    function buildValues(lastComponent, newTokens, oldTokens) {
      const components = [];
      let nextComponent;
      while (lastComponent) {
        components.push(lastComponent);
        nextComponent = lastComponent.previousComponent;
        delete lastComponent.previousComponent;
        lastComponent = nextComponent;
      }
      components.reverse();
      let newPos = 0, oldPos = 0;
      for (const component of components) {
        if (!component.removed) {
          component.value = newTokens.slice(newPos, newPos + component.count);
          newPos += component.count;
          if (!component.added) oldPos += component.count;
        } else {
          component.value = oldTokens.slice(oldPos, oldPos + component.count);
          oldPos += component.count;
        }
      }
      return components;
    }
    function diffArrays(a, b) {
      const newLen = b.length, oldLen = a.length;
      let editLength = 1;
      const maxEditLength = Math.min(newLen + oldLen, MYERS_MAX_EDIT);
      const bestPath = [{ oldPos: -1, lastComponent: undefined }];
      let newPos = extractCommon(bestPath[0], b, a, 0);
      if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
        return buildValues(bestPath[0].lastComponent, b, a);
      }
      let minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;
      while (editLength <= maxEditLength) {
        for (let diagonalPath = Math.max(minDiagonalToConsider, -editLength); diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
          let basePath;
          const removePath = bestPath[diagonalPath - 1], addPath = bestPath[diagonalPath + 1];
          if (removePath) bestPath[diagonalPath - 1] = undefined;
          let canAdd = false;
          if (addPath) {
            const addPathNewPos = addPath.oldPos - diagonalPath;
            canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
          }
          const canRemove = removePath && removePath.oldPos + 1 < oldLen;
          if (!canAdd && !canRemove) {
            bestPath[diagonalPath] = undefined;
            continue;
          }
          if (!canRemove || (canAdd && removePath.oldPos < addPath.oldPos)) {
            basePath = addToPath(addPath, true, false, 0);
          } else {
            basePath = addToPath(removePath, false, true, 1);
          }
          newPos = extractCommon(basePath, b, a, diagonalPath);
          if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
            return buildValues(basePath.lastComponent, b, a);
          }
          bestPath[diagonalPath] = basePath;
          if (basePath.oldPos + 1 >= oldLen) maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
          if (newPos + 1 >= newLen) minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
        }
        editLength++;
      }
      if (oldLen > 0 && newLen > 0) return [{ value: a.slice(), removed: true }, { value: b.slice(), added: true }];
      if (oldLen > 0) return [{ value: a.slice(), removed: true }];
      return [{ value: b.slice(), added: true }];
    }
    function getOpCodes(oldLines, newLines) {
      const parts = diffArrays(oldLines, newLines);
      const ops = [];
      let i = 0, j = 0, k = 0;
      const countOf = (p) => p.count ?? (Array.isArray(p.value) ? p.value.length : 0);
      while (k < parts.length) {
        const p = parts[k];
        const n = countOf(p);
        if (!p.added && !p.removed) {
          ops.push({ tag: 'e', i1: i, i2: i + n, j1: j, j2: j + n });
          i += n; j += n;
        } else if (p.removed) {
          const q = parts[k + 1];
          if (q && q.added) {
            const m = countOf(q);
            ops.push({ tag: 'r', i1: i, i2: i + n, j1: j, j2: j + m });
            i += n; j += m; k++;
          } else {
            ops.push({ tag: 'd', i1: i, i2: i + n, j1: j, j2: j });
            i += n;
          }
        } else {
          const q = parts[k + 1];
          if (q && q.removed) {
            const m = countOf(q);
            ops.push({ tag: 'r', i1: i, i2: i + m, j1: j, j2: j + n });
            i += m; j += n; k++;
          } else {
            ops.push({ tag: 'i', i1: i, i2: i, j1: j, j2: j + n });
            j += n;
          }
        }
        k++;
      }
      return ops;
    }
    function getGroupedOpCodes(opcodes, n = 3) {
      const codes = opcodes.map((op) => ({ ...op }));
      if (codes.length === 0) codes.push({ tag: 'e', i1: 0, i2: 1, j1: 0, j2: 1 });
      if (codes[0].tag === 'e') {
        const c = codes[0];
        codes[0] = { tag: c.tag, i1: Math.max(c.i1, c.i2 - n), i2: c.i2, j1: Math.max(c.j1, c.j2 - n), j2: c.j2 };
      }
      if (codes[codes.length - 1].tag === 'e') {
        const c = codes[codes.length - 1];
        codes[codes.length - 1] = { tag: c.tag, i1: c.i1, i2: Math.min(c.i2, c.i1 + n), j1: c.j1, j2: Math.min(c.j2, c.j1 + n) };
      }
      const nn = n + n;
      const groups = [];
      let group = [];
      for (const op of codes) {
        let { tag, i1, i2, j1, j2 } = op;
        if (tag === 'e' && i2 - i1 > nn) {
          group.push({ tag, i1, i2: Math.min(i2, i1 + n), j1, j2: Math.min(j2, j1 + n) });
          groups.push(group);
          group = [];
          i1 = Math.max(i1, i2 - n);
          j1 = Math.max(j1, j2 - n);
        }
        group.push({ tag, i1, i2, j1, j2 });
      }
      if (group.length > 0 && !(group.length === 1 && group[0].tag === 'e')) {
        groups.push(group);
      }
      return groups;
    }
    function formatRange(start, end) {
      const count = end - start;
      if (count === 0) return `${start},0`;
      return `${start + 1},${count}`;
    }
    function trimLineEnd(s) {
      let out = s;
      if (out.endsWith('\n')) out = out.slice(0, -1);
      if (out.endsWith('\r')) out = out.slice(0, -1);
      return out;
    }
    function unifiedDiffText(rel, oldText, newText) {
      const oldLines = splitLines(oldText);
      const newLines = splitLines(newText);
      const groups = getGroupedOpCodes(getOpCodes(oldLines, newLines), 3);
      if (groups.length === 0) return '';
      const b = [];
      b.push('--- a/' + rel + '\n');
      b.push('+++ b/' + rel + '\n');
      for (const group of groups) {
        const first = group[0];
        const last = group[group.length - 1];
        b.push('@@ -' + formatRange(first.i1, last.i2) + ' +' + formatRange(first.j1, last.j2) + ' @@\n');
        for (const op of group) {
          if (op.tag === 'e') {
            for (const line of oldLines.slice(op.i1, op.i2)) b.push(' ' + trimLineEnd(line) + '\n');
          } else if (op.tag === 'r') {
            for (const line of oldLines.slice(op.i1, op.i2)) b.push('-' + trimLineEnd(line) + '\n');
            for (const line of newLines.slice(op.j1, op.j2)) b.push('+' + trimLineEnd(line) + '\n');
          } else if (op.tag === 'd') {
            for (const line of oldLines.slice(op.i1, op.i2)) b.push('-' + trimLineEnd(line) + '\n');
          } else if (op.tag === 'i') {
            for (const line of newLines.slice(op.j1, op.j2)) b.push('+' + trimLineEnd(line) + '\n');
          }
        }
      }
      return b.join('');
    }
    function createdDiffText(rel, newContent) {
      const lines = splitLines(newContent);
      const b = [];
      b.push('--- /dev/null\n');
      b.push('+++ b/' + rel + '\n');
      if (lines.length > 0) {
        b.push('@@ -0,0 +1,' + lines.length + ' @@\n');
        for (const line of lines) b.push('+' + trimLineEnd(line) + '\n');
      }
      return b.join('');
    }
    function deletedDiffText(rel, oldContent) {
      const lines = splitLines(oldContent);
      const b = [];
      b.push('--- a/' + rel + '\n');
      b.push('+++ /dev/null\n');
      if (lines.length > 0) {
        b.push('@@ -1,' + lines.length + ' +0,0 @@\n');
        for (const line of lines) b.push('-' + trimLineEnd(line) + '\n');
      }
      return b.join('');
    }

    console.log('[auto-diff v1] active — session diff (create/modify) written to $DSH_HOME/sessions/<project>/session-<id>/auto-diff.patch');
  },
};
