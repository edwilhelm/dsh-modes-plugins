# Auto-Diff Review — fork/codegen scaffold

Two new packages to copy into the DeepSeek Harness monorepo at
`packages/review/auto-diff-host/` and `packages/review/auto-diff-ui/`. They
implement the Settings → "Auto-Diff Review" panel that lists each session's
`auto-diff.patch` and renders per-file colored hunks.

This scaffold is **source-only**. The `@Remote` decorators and the UI files are
built by the repo's normal toolchain (`tsdown` + the typert generator run as a
tsdown plugin during `build:lib:host`).

- `auto-diff-host/` — a host Remote service (`AutoDiffReviewRemote`), the
  server half that walks `$DSH_HOME/sessions/**/auto-diff.patch`.
- `auto-diff-ui/` — a browser-only `dsh.client` package that registers a root
  `settings.section` entry and calls the `autoDiffReview` Remote namespace.

---

## 1. Copy into the repo

```
packages/review/auto-diff-host/
  package.json
  tsconfig.json
  src/index.ts
  src/invariant.ts
  src/types.ts
packages/review/auto-diff-ui/
  package.json
  tsconfig.json
  tsdown.config.ts
  src/index.ts
  src/invariant.ts
  src/client/index.ts
  src/client/AutoDiffReview.tsx
  src/client/parseUnifiedDiff.ts
```

`packages/review/` is a new group; creating it is fine (the workspace glob is
`packages/*/*`).

---

## 2. Wire the new Remote into the browser assembly

`packages/api/remotes/src/client/index.ts` hard-mounts the generated Remote
contributions. Add the auto-diff contribution alongside the existing five:

1. Add an import (near the existing `messageFeedbackRemote` import):
   ```ts
   import autoDiffRemote from '@deepseek-ai/dsh-auto-diff-host/remote'
   ```
2. Add it to the `$mount` loop:
   ```ts
   for (const contribution of [
     commandsRemote, goalsRemote, dynamicRemote,
     pluginInventoryRemote, messageFeedbackRemote, autoDiffRemote,
   ]) ctx.remote.$mount(contribution)
   ```
3. Re-export its types (near the other `export type { }` lines):
   ```ts
   export type {} from '@deepseek-ai/dsh-auto-diff-host/remote'
   ```

---

## 3. Enable the two packages on the Web profile

`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml`
(line ~47 insertion point) — add two loader rows:

```yaml
- id: auto-diff-host
  name: '@deepseek-ai/dsh-auto-diff-host'
- id: auto-diff-ui
  name: '@deepseek-ai/dsh-client-auto-diff-review'
```

Only the UI package is browser-facing (`dsh.client.platform: "web"`); the host
package is required so the `autoDiffReview` Remote service is provided on the
host side.

---

## 4. Build

From the repo root (this is the human-executed step; the repo build cannot run
in the sandbox):

```sh
pnpm install          # resolves the two new workspace packages
pnpm build:lib:host   # tsdown → emits lib/ for both; typert generator emits
                      #   auto-diff-host/lib/typert.host.js + typert.remote-client.js
                      #   (the ./remote contribution api-remotes mounts)
pnpm run dev:web      # rebuild the web shell and reload http://127.0.0.1:3080
```

or a prod build (`pnpm build`/`pnpm run build:web`) then restart.

---

## 5. Verify

In practice `build:lib:host` must succeed first (the `AutoDiffReviewRemote`
`@Remote('listPatches')`/`@Remote('readPatch')` decorators are lowered by the
generator into `__esDecorate`/`__runInitializers`, exactly like `dsh-goal`).
After a reload the Settings page shows an **Auto-Diff Review** section; picking
a listed patch renders its per-file colored hunks.

Notes / caveats:
- The host `src/index.ts` reads the fs service via `ctx.fs` (`resolve` /
  `listDir` / `stat` / `readText`) — the same surface the dynamic
  `auto-diff-review/host.js` verified. DSH_HOME is resolved first from
  `ctx.shellEnv.collect({})['DSH_HOME']`, falling back to `$HOME/.dsh`.
- `src/client/AutoDiffReview.tsx` uses plain class names (no `.module.css`) so
  the panel ships styling-neutral; add a module stylesheet if desired.
- `src/client/invariant.ts` registers a no-op invariant companion so the
  package matches the repo's invariant conventions without owning any durable
  writes.
