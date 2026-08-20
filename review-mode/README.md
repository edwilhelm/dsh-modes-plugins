# Auto-Diff Review — native Web panel

A client-side **review mode** for the DeepSeek Harness Web GUI that lists every
session's `auto-diff.patch` under `$DSH_HOME/sessions` and renders each selected
patch as **per-file colored hunks**.

It is shipped as a **dynamic dual-half Cordis package** (two halves pasted into
`cordis_define`), which is the harness's documented, **no-rebuild, no-restart**
way to inject native Web UI at runtime:

- **host half** (`host.js`) — runs in the DSH process, resolves `$DSH_HOME`,
  walks `sessions/**/auto-diff.patch` with `ctx.fs`, and exposes
  `listPatches` / `readPatch` via `harness.handle`.
- **browser half** (`client.js`) — runs in every open Web page, returns a
  plugin that registers a **`settings.section`** named **Auto-Diff Review**
  (renders the session list + per-file diff viewer), and calls the host half
  through `host.call`.

Prerequisites — see [Environment / load path](#environment--load-path).

---

## Loading it (no rebuild, no restart)

Run these from a session on the **shipped `cordis` preset**, which mounts the
cordis toolset (`@deepseek-ai/dsh-tool-cordis`). The `autodiff` preset does not
and must not add it — its composition deliberately removed the row because the
toolset's host inspect providers collide with the shipped `cordis` preset. The
host Runner (`cordis-host-runner`) and browser Runner (`cordis-client-runner`)
are already enabled in the Web profile.

The exposed tool names in this build (`rc.6`) are:
`cordis_inspect_list`, `cordis_inspect_query`, `cordis_inspect_self`,
`cordis_define`, `cordis_run`, `cordis_stop`, `cordis_undefine`.

### Step 1 — (optional) inspect the client slot surface
Before defining, poke the slot you'll register into:
`cordis_inspect_list` (list providers) → `cordis_inspect_query` with
`platform: "client"`, `provider: "Slots"` (exact name from the list),
`method: "listSubTree"` / `"findEntry"` to confirm `settings.section` and its
`id`/`order`/`label` options. Skip this if you trust the catalog below.

### Step 2 — define the package (`cordis_define`)
Exact parameters (`@deepseek-ai/dsh-tool-cordis` rc.6):

- `plugin`: `{ "kind": "new", "idPrefix": "adif" }`
  (a 3–6 lowercase-letter prefix; the Host returns the real `pluginId`)
- `name`: `auto-diff-review`
- `purpose`: `Native Auto-Diff review panel listing session patches and per-file diff`
- `code`: an object with at most `host` / `client`:
  - `code.host` = the **plain JS body** of `host.js`
  - `code.client` = the **plain JS body** of `client.js`

Each of `host`/`client` is a **function body** (no `function` wrapper, no
TypeScript, no JSX, no `import`): evaluated as the body of an `async` function.
Your `host.js`/`client.js` already end in `return { ... }`, so paste them
verbatim as the string values.

The tool **syntax-checks both halves and records the source; nothing runs**.
It returns `{ pluginId, packageId, name, purpose, hasHostHalf, hasClientHalf }`
— note both `pluginId` and `packageId`.

### Step 3 — run it (`cordis_run`)
Exact parameters: `{ pluginId, packageId, mode: "run" }`, using the IDs returned
by `cordis_define`.

Because the package has a browser half, `cordis_run` is an **answerable round
trip**: the tool returns `status: "awaiting-approval"` and a Web page shows an
**approve** affordance for the ask (package + purpose). **Click approve on the
page you want the panel to load into.** The host half runs first (starts),
then the browser half is delivered and mounted. On success the tool reports
`status: "running"` with `pluginId`/`packageId`/`pluginRunId`. A rejected or
"suspended because no page is connected" ask can surface as
`awaiting-approval` until cancelled — approve from an open page.

### Step 4 — open the panel
In the Web GUI open **Settings** → the sidebar nav shows an **Auto-Diff Review**
section. It scans `$DSH_HOME/sessions`, lists patches grouped by project, and
selecting a session renders its per-file diff.

### Step 5 — reload / teardown
- Reload: re-run the already-active package (`cordis_run` mode `"run"` with the
  same `packageId`) re-delivers the live browser half to a refreshed page (it
  does not re-ask if still authorized). Dynamic packages **do not** survive a
  DSH process restart.
- Teardown: `cordis_stop` with `{ pluginId }` (dispose, definition survives),
  then `cordis_undefine` with `{ pluginId }` to forget it.

Use `cordis_inspect_self` (omit args to list current Plugins, or pass
`pluginId`/`packageId`) for source + diagnostics if a run fails at either half.

Dynamic packages live only in the DSH process **memory**: they disappear on
`cordis_stop`/toolset unload/DSH **restart**, and no page keeps a half unless
someone runs/approves it.

---

## Environment / load path (what was verified and what is required)

Verified against your installed `@deepseek-ai` packages (v0.1.0-rc.6):

- `$DSH_HOME = C:\Users\Ed\.dsh`; your autodiff preset writes
  `$DSH_HOME/sessions/<--encoded-cwd-->/session-<uuid>/auto-diff.patch`
  (confirmed a live patch at `...\session-109e92d6…\auto-diff.patch`).
- `@deepseek-ai/dsh-cordis-host-runner` **and**
  `@deepseek-ai/dsh-cordis-client-runner` are **already enabled** in the Web
  profile composition (`@deepseek-ai/dsh-web-app/cordis.patch.yml`, rows at
  `cordis-host-runner` / `cordis-client-runner`).
- The browser-half slot catalog is served to the model via
  `cordis_inspect_query` (the `Slots` provider); `settings.section` is a
  root-scope **list** slot rendered inside the Settings panel
  (`id`/`order`/`label` options) — a safe additive seat.
- Host-half sandbox exposes `harness.{defineTool,registerTool,handle}` and
  `ctx.fs` (`resolve`/`listDir`/`stat`/`readText`/`writeText`/`editText`).
  Browser-half symbol surface is `(React, console, styles, host)`, with
  `host.call(method, args)` routing to the host half's `harness.handle` methods.
- Both `host.js` and `client.js` pass `node --check`.

**Key load requirement:** the session that runs `cordis_define`/`cordis_run`
must mount **`@deepseek-ai/dsh-tool-cordis`**. The shipped **`cordis` preset**
does — use it for the load session. Do **not** add `tool-cordis` to the
`autodiff` preset: its `agent.cordis.yml` deliberately removed that row because
the toolset's host inspect providers are process singletons already registered
by the shipped `cordis` preset, so an `autodiff` session and a `cordis` session
cannot coexist with a second copy.

> This session could not write `$DSH_HOME` (sandbox confines writes to the
> workspace) and does not mount `dsh-tool-cordis` (that row lives only in the
> `cordis` preset), so it could not itself execute the define/run round trip.
> The exact step is performed from a `cordis`-preset session as described.

---

## Alternative: durable static client plugin

Dynamic packages don't survive a DSH restart. For a panel that loads on every
boot, use the ready-made static client plugin in **`durable/`** — a complete
`@user/dsh-client-auto-diff-review` package (node half exposing a `listPatches`
/ `readPatch` Remote; browser half in the loader‑factory bundle format
`window.__ModuleLoader__.load({ id, factory })`; `dsh.client` metadata;
`exports["./client"]`).

It loads through the standard client-modules path (scan an enabled Loader entry
for a web `dsh.client` package → serve `exports["./client"]` under
`/plugins/<id>/client.js` → browser mounts it). Installing it needs the
deployment's build toolchain + a `$DSH_HOME/profiles/web` change + a Web-app
restart — see `durable/README.md` for the exact steps and its verification
notes. `lib/client.js` in `durable/` is the same UI logic as the dynamic
version; only the loader wrapper and the node data bridge differ.

> This session could not install into `$DSH_HOME` or rebuild/restart the Web
> app, so the durable package is built and `node --check`‑clean but its Remote
> type manifests and final build must be completed in the deployment's
> toolchain.

---

## What was verified (static, against installed packages)

- `host.js` and `client.js` pass `node --check`.
- Host-half RPC logic unit-tested (`test-host.mjs`): `host.js` is evaluated in a
  `vm` exactly as the real runner does (`(async()=>{ code })()` with
  `harness.handle` in scope), against a mock `ctx.fs` over a temp tree mirroring
  `$DSH_HOME/sessions/<project>/session-<id>/`. `listPatches` discovers every
  `auto-diff.patch` (3/3 across projects and ignored non-patch dirs),
  `readPatch` returns the exact file content, and the missing-file error path
  returns `{ok:false,error}`.
- Unified-diff parser unit-tested against your real patch
  (`...\session-109e92d6…\auto-diff.patch`: created file → 1 block, 3 headers, 1
  added line) and a synthetic 2-file modified+deleted diff (2 blocks; modified
  file keeps context/+/- across two hunks; deleted file is all `-`).
- Host-half wiring confirmed against `dsh-cordis-host-runner/lib/index.js`:
  `createSandbox(id, { handle })` injects `harness.handle` into the sandbox
  scope **at evaluation time**; the host half captures it and calls it inside
  `apply(ctx)`, where `startHostHalf` runs the returned plugin against the
  guarded `sandboxContext` (so `ctx.get('fs')` is valid). The browser half's
  `host.call(name, args)` routes to `dynamicCordisRunner.invoke` →
  `run.handlers.get(name)` (the handler `harness.handle` registered).
- Browser-half slot usage matches the served slot catalog examples
  (`ctx.slots.inject(SLOT, () => ctx.slots.register({ name, id, order, label },
  () => React.createElement(...)))`) and targets `settings.section`, an
  additive root-scope seat.

**Still requires a live run to confirm rendering**: the define/run round trip
needs a `cordis`-preset session and a page-approval step, which are outside this
session's means (no `dsh-tool-cordis` here; `$DSH_HOME` writes are sandboxed).

---

## Files

- `host.js` — host half (`code` arg to `cordis_define`)
- `client.js` — browser half (`client` arg to `cordis_define`)
- `README.md` — this runbook