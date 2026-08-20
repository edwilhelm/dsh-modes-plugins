# Auto-Diff Review — durable static client plugin — accurate status

## Verified findings (this session)

1. **The node half is now build-free.** `lib/index.js` was rewritten to be
   **decorator-free**: the `@Remote("listPatches")` / `@Remote("readPatch")`
   annotations are pre-lowered to the same `__esDecorate`/`__runInitializers`
   machinery the shipped bundles embed. It loads in plain Node/ESM and typert
   correctly discovers both methods (`test-nodehalf.mjs` passes against the real
   installed `@deepseek-ai/dsh-typert-protocol`). **No tsdown/tsc needed.**

2. **`lib/client.js` is already in final loader form**
   (`window.__ModuleLoader__.load({ id, factory })`) and passes `node --check`;
   `react` + `react/jsx-runtime` resolve in the profile node_modules.

3. **The remaining blocker is codegen, not building this package.** The web app
   wires a Remote namespace to the browser through **generated, curated
   contributions**:
   - Host: `dsh-typert-loader` only routes a namespace into the gateway when a
     package registers a generated `TypertRemoteContribution` via a `./typert`
     host artifact.
   - Browser: `dsh-api-remotes` hard-imports a fixed list of generated
     `@deepseek-ai/*/remote` contributions and `$mount`s them. A namespace named
     `autoDiffReview` is not in that list.
   `dsh-typert-generator` is **not shipped** in the profile (dev-only, lives in
   the source repo), so neither artifact is produced by `pnpm install`.

## Recommendation

A fully-native durable static plugin therefore requires working from the
**deepseek-harness source checkout** (available at `deepseek-harness-master\`):
run `dsh-typert-generator` to emit the `./typert` host manifest + a client
contribution, add it to the `dsh-api-remotes` client assembly, rebuild
`apps/web`, add the Loader row, and restart. That is a codegen + fork-build
task, not an install-and-restart task.

## Immediate alternative (recommended for use now)

The **dynamic** version (`../host.js` + `../client.js`) produces the same panel
with **no build at all** — load it once via `cordis_define`/`cordis_run` from a
`cordis`-preset session. Trade-off: re-run `cordis_run` after a DSH restart.
Use this while deciding on the fork path.

## Files

| file | role |
|---|---|
| `package.json` | `dsh.client.platform=web`, `inject`, `exports["./client"]` |
| `lib/index.js` | node half: decorator-free `TypertRemoteService` (verified), reads `$DSH_HOME/sessions` via `ctx.fs` |
| `lib/client.js` | browser half: loader-factory bundle, `settings.section` id `auto-diff-review` |
| `test-nodehalf.mjs` | verification harness (passes) |

## Verification done

- `test-nodehalf.mjs` PASS against real installed `dsh-typert-protocol`:
  `remoteMethods(service)` returns both direct methods.
- `lib/client.js` passes `node --check`; `package.json` valid.
- listPatches/readPatch logic is the same code unit-tested in `../test-host.mjs`.

## Not done here

- Generating the `./typert` host manifest + client remote contribution
  (`dsh-typert-generator` is not shipped) and adding the contribution to
  `dsh-api-remotes`'s client assembly.
- Writing to `$DSH_HOME` (sandbox) and rebuilding/restarting the web app.
  Both require the DSH source checkout / your `$DSH_HOME` environment.
