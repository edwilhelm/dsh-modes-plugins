# Fork/Codegen Path — Durable "Auto-Diff Review" Web panel

Goal: a boot-persistent review panel (Settings → "Auto-Diff Review") that lists
every session's `auto-diff.patch` under `$DSH_HOME/sessions` and renders per-file
colored hunks. This route builds it as a **first-party, generated** extension of
`deepseek-harness` instead of an ephemeral dynamic cordis plugin.

This doc is grounded in the actual vendored `deepseek-harness-master` (here
`REPO = C:\Users\Ed\Downloads\deepseek-harness-master`) and the real shipped
profile (`C:\Users\Ed\.dsh\profiles`). It was NOT executed end-to-end from the
sandbox (the sandbox can't write `$DSH_HOME` or run the monorepo build), but
every mechanism and every file to touch is verified against the source.

---

## Architecture (verified)

A Remote namespace reaches the browser through two generated, curated surfaces:

1. **Host Remote service** — a package exporting `./typert` (generated
   `lib/typert.host.js` manifest) and `./remote` (generated
   `lib/typert.remote-client.js` client projection). `dsh-typert-loader` serves
   the host manifest; `dsh-api-remotes` (browser) `$mount`s the client projection.
2. **Browser panel** — a `dsh-client-ui-*`-style package with `dsh.client`
   metadata + `exports["./client"]` (the loader-factory bundle). The
   `dsh-client-modules` node half scans enabled Loader rows for web `dsh.client`
   packages and serves `/plugins/<id>/client.js`.

Both faces are composed by **Loader rows in `cordis.patch.yml`** (the shipped
`dsh-web-app/cordis.patch.yml` I inspected, lines 47-172). The `dsh-typert-generator`
runs during `pnpm build:lib:host` (root `tsdown.config.ts`:
`typertPlugin({ mode: 'workspace', faces: ['host'] })`) and auto-generates the
`.js`/`.d.ts` typert artifacts for any package whose `exports` declares
`./typert`, `./client/typert`, or `./remote` (`tsdown-plugin.ts` `hasTypertExport`,
lines 133-138). It also lowers the `@Remote` decorators.

So the fork is **self-contained**: author the two package faces + wire the Loader
rows + add one contribution to `api-remotes`, run the workspace build, and the
generator emits everything the runtime needs.

---

## The two new packages

### A. `packages/review/auto-diff-host/` — the host Remote service

Minimal model: `packages/feedback/message-feedback/` (a read-only `@Remote`
service). Its shape:
- `package.json` declares `exports` with `./typert` → `lib/typert.host.js` and
  `./remote` → `lib/typert.remote-client.js`; `peerDependencies` include
  `@deepseek-ai/dsh-typert-protocol` and `@deepseek-ai/cordis`; `files` lists the
  generated `lib/typert.*`.
- `src/index.ts` defines `export class AutoDiffReviewRemote extends TypertRemoteService`
  with `super(ctx, 'autoDiffReview')` and `declare module '@deepseek-ai/cordis'`
  augmenting `interface Context { autoDiffReview: AutoDiffReviewRemote }`; Remote
  methods are `@Remote('listPatches') async listPatches(): Promise<...>` and
  `@Remote('readPatch') async readPatch(request): Promise<...>`; `export default
  AutoDiffReviewRemote`.
- The read implementation uses `ctx.fs` (`resolve`, `listDir`, `stat`,
  `readText`) exactly as the dynamic `host.js` already does; resolve `DSH_HOME`
  via `ctx.get('shellEnv').collect({})`.

The browse-side payload types are plain JSON (`{ ok, patches|text|error }`), so
the generator can emit their zod schemas without cross-package references.

### B. `packages/review/auto-diff-ui/` — the browser panel

Model: a `dsh.client` package like `dsh-client-ui-*`:
- `package.json`: `exports["./client"]` → `lib/client.js` (the built loader
  factory `window.__ModuleLoader__.load({ id, factory })`), `dsh.client = {
  platform: "web", inject: [...] }`, `peerDependencies` on `react`,
  `@deepseek-ai/dsh-client-runtime`, `@deepseek-ai/dsh-client-ui-slots`,
  `@deepseek-ai/dsh-api-remotes`.
- `src/client.ts`: registers `settings.section` id `auto-diff-review`
  (additive `ctx.slots.inject('settings.section', ...)`, order 900, label
  "Auto-Diff Review") and calls `ctx.remote.autoDiffReview.listPatches()` /
  `readPatch({ path })` — reusing the exact `parseUnifiedDiff` + `DiffViewer`
  UI already written and unit-tested in `autodiff-review/client.js`.

---

## Wiring (3 edits)

1. **`packages/api/remotes/src/client/index.ts`** — add
   `import autoDiffRemote from '@deepseek-ai/dsh-auto-diff-host/remote'`,
   `export type {} from '@deepseek-ai/dsh-auto-diff-host/remote'`, and add
   `autoDiffRemote` to the `ctx.remote.$mount(...)` list (lines 5-8, 108-110).
   This is the browser roster that makes `ctx.remote.autoDiffReview` exist.
2. **`dsh-web-app` composition** — in the shipped `cordis.patch.yml` `insert`
   block (line 47), add two rows:
   ```yaml
   - id: auto-diff-host
     name: '@deepseek-ai/dsh-auto-diff-host'
   - id: auto-diff-ui
     name: '@deepseek-ai/dsh-auto-diff-ui'
   ```
   The host row makes the gateway serve `autoDiffReview/*`; the ui row makes
   `client-modules` serve the panel bundle. In the installed profile this block
   lives in `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml`,
   or better as the profile's own `web/cordis.patch.yml` overlay.
3. **Dependencies** — add `@deepseek-ai/dsh-auto-diff-host` and
   `@deepseek-ai/dsh-auto-diff-ui` where the plan consumes them (workspace
   deps; the `api-remotes` package needs the host pkg).

---

## Build (the actual fork/codegen step)

```sh
cd REPO
pnpm install          # link the two new workspace packages
pnpm build:lib:host   # tsc + tsdown; typertPlugin runs and emits
                      #   lib/typert.host.js / lib/typert.remote-client.js
                      #   for any package with a ./typert or ./remote export
pnpm build:cli        # or the profile's packaging step; then
pnpm run dev:web      # dev web HMR (optional) OR production build
```

Then point a profile at the freshly built packages (the fork's own
`apps/cli`/profile instead of the npm-installed `dsh-web-app`) and restart
`dsh web`. On boot the loader scans the new rows, `client-modules` serves the
panel bundle, `api-remotes` mounts the namespace, and Settings → "Auto-Diff
Review" appears. See `autodiff-review/durable/` for the already-authored,
syntax-clean package sources (`package.json`, decorator-free node half, loader
factory browser half) that fill in A and B.

---

## Why it couldn't finish from the sandbox (honest constraints)

- Writes to `$DSH_HOME` are sandbox-denied; the running :3080 web app can't be
  built/restarted here.
- `dsh-typert-generator` is **not shipped** in the installed profile — it's the
  repo build-time tool. The typert artifacts must be generated from the source
  checkout, then the rebuilt packages installed, which is exactly what the steps
  above do.

## Verification already done

- `autodiff-review/durable/lib/client.js` passes `node --check` (loader-factory
  form) and its UI/parser logic is unit-tested (`test-parser.mjs`,
  `test-multifile.mjs`).
- `autodiff-review/durable/lib/index.js` is decorator-free and verified to
  register `listPatches`/`readPatch` (`test-nodehalf.mjs` passes against the real
  installed `dsh-typert-protocol`).
- The `message-feedback` package proves the read-only `@Remote` shape; the
  `api-remotes` source shows the exact mount list; the shipped `dsh-web-app`
  `cordis.patch.yml` shows the exact host/ui row composition.
