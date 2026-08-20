// ============================================================================
// auto-diff review — DURABLE static client plugin — NODE HALF
// ============================================================================
// Loads as a normal Cordis plugin row. Host-plane: exposes listPatches/readPatch
// as a typert Remote service reading $DSH_HOME/sessions with the host fs service.
//
// DELIBERATELY decorator-free: the `@Remote("name")` annotations used by the
// shipped packages have ALREADY been lowered here to the equivalent runtime
// registration (the same __esDecorate/__runInitializers machinery that tsdown
// emits), so this file loads in plain Node/ESM without any build / tsdown step.
// ============================================================================
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

// ---- transpiler-lowered decorator helpers (same as the shipped bundles) ----
var __runInitializers = function (thisArg, initializers, value) {
  var useValue = arguments.length > 2;
  for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
  return useValue ? value : void 0;
};
var __esDecorate = function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
  function accept(f) { if (f !== void 0 && typeof f !== 'function') throw new TypeError('Function expected'); return f; }
  var kind = contextIn.kind, key = kind === 'getter' ? 'get' : kind === 'setter' ? 'set' : 'value';
  var target = !descriptorIn && ctor ? contextIn['static'] ? ctor : ctor.prototype : null;
  var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
  var _ = void 0, done = false;
  for (var i = decorators.length - 1; i >= 0; i--) {
    var context = {};
    for (var p in contextIn) context[p] = p === 'access' ? {} : contextIn[p];
    for (var p in contextIn.access) context.access[p] = contextIn.access[p];
    context.addInitializer = function (f) {
      if (done) throw new TypeError('Cannot add initializers after decoration has completed');
      extraInitializers.push(accept(f || null));
    };
    var result = (0, decorators[i])(kind === 'accessor' ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
    if (kind === 'accessor') {
      if (result === void 0) continue;
      if (result === null || typeof result !== 'object') throw new TypeError('Object expected');
      if (_ = accept(result.get)) descriptor.get = _;
      if (_ = accept(result.set)) descriptor.set = _;
      if (_ = accept(result.init)) initializers.unshift(_);
    } else if (_ = accept(result)) if (kind === 'field') initializers.unshift(_);
    else descriptor[key] = _;
  }
  if (target) Object.defineProperty(target, contextIn.name, descriptor);
  done = true;
};

const PAD2 = (n) => String(n).padStart(2, '0');
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

async function resolveDshHome(ctx) {
  try {
    const shellEnv = ctx.get('shellEnv');
    if (shellEnv && typeof shellEnv.collect === 'function') {
      const env = shellEnv.collect({});
      if (env && typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0) return env.DSH_HOME.replace(/[\\/]+$/, '');
    }
  } catch { /* fall through */ }
  try {
    const shell = ctx.get('shell');
    if (shell && typeof shell.run === 'function') {
      const spec = shell.resolve ? shell.resolve({ command: 'echo $HOME' }) : { command: 'echo $HOME' };
      const res = await shell.run(spec);
      const text = (res?.stdout?.text ?? '').trim();
      if (typeof text === 'string' && text.length > 0) return joinPath(text, '.dsh');
    }
  } catch { /* fall through */ }
  return undefined;
}

async function walkPatches(fs, baseTarget, baseDisplay, depth, out) {
  if (depth > 3) return;
  let entries;
  try { entries = await fs.listDir(baseTarget); } catch { return; }
  for (const entry of entries) {
    if (entry.type === 'directory') {
      await walkPatches(fs, entry.target, joinPath(baseDisplay, entry.name), depth + 1, out);
    } else if (entry.type === 'file' && entry.name === 'auto-diff.patch') {
      const fullPath = joinPath(baseDisplay, entry.name);
      const parent = dirname(fullPath);
      out.push({
        project: basename(dirname(parent)),
        sessionId: basename(parent),
        patchPath: fullPath,
        size: typeof entry.size === 'number' ? entry.size : undefined,
      });
    }
  }
}

/** Remote surface the browser half calls. Decorator-lowered registration below. */
var _instanceExtraInitializers = [];
let AutoDiffReviewRemote = (() => {
  let _classSuper = TypertRemoteService;
  let _listPatches_decorators, _readPatch_decorators;
  return class AutoDiffReviewRemote extends _classSuper {
    static {
      const _metadata = typeof Symbol === 'function' && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
      _listPatches_decorators = [Remote('listPatches')];
      _readPatch_decorators = [Remote('readPatch')];
      __esDecorate(this, null, _listPatches_decorators, { kind: 'method', name: 'listPatches', static: false, private: false, access: { has: (o) => 'listPatches' in o, get: (o) => o.listPatches }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _readPatch_decorators, { kind: 'method', name: 'readPatch', static: false, private: false, access: { has: (o) => 'readPatch' in o, get: (o) => o.readPatch }, metadata: _metadata }, null, _instanceExtraInitializers);
    }
    constructor(ctx) {
      super(ctx, 'autoDiffReview');
      __runInitializers(this, _instanceExtraInitializers);
    }
    /** List every session's auto-diff.patch. */
    async listPatches() {
      const fs = this.ctx.get('fs');
      if (!fs) return { ok: false, error: 'fs service unavailable' };
      const dshHome = await resolveDshHome(this.ctx);
      if (!dshHome) return { ok: false, error: 'could not resolve DSH_HOME' };
      const sessionsRoot = joinPath(dshHome, 'sessions');
      let baseTarget;
      try { baseTarget = await fs.resolve(sessionsRoot); }
      catch (e) { return { ok: false, error: `cannot resolve ${sessionsRoot}: ${String(e?.message ?? e)}` }; }
      const out = [];
      await walkPatches(fs, baseTarget, sessionsRoot, 0, out);
      out.sort((a, b) => (a.patchPath < b.patchPath ? 1 : a.patchPath > b.patchPath ? -1 : 0));
      return { ok: true, patches: out };
    }
    /** Return the raw unified diff for one patch path. */
    async readPatch(args) {
      const fs = this.ctx.get('fs');
      if (!fs) return { ok: false, error: 'fs service unavailable' };
      const p = args && typeof args.path === 'string' ? args.path : '';
      if (!p) return { ok: false, error: 'no path supplied' };
      try {
        const target = await fs.resolve(p);
        const info = await fs.stat(target);
        if (!info || info.type !== 'file') return { ok: false, error: `not a file or missing: ${p}` };
        const text = await fs.readText(target);
        return { ok: true, text };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    }
  };
})();

/** The node-half Cordis plugin: expose the Remote namespace. */
export const name = 'auto-diff-review';
export const inject = ['fs'];
export function apply(ctx) {
  const service = new AutoDiffReviewRemote(ctx);
  ctx.provide('autoDiffReview', service);
}
/** Exported only for verification; the plugin exposes it via ctx.provide. */
export { AutoDiffReviewRemote };