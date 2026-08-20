# Using the Auto-Diff Review panel — which session can load it
# =============================================================
# The panel is loaded with the cordis dynamic-package toolset
# (dsh-tool-cordis). Rule for THIS deployment:
#
#   * Do NOT add tool-cordis to the `autodiff` preset.
#     autodiff/agent.cordis.yml deliberately removed that row because its host
#     inspect providers are process singletons already registered by the
#     shipped `cordis` preset, so an `autodiff` session and a `cordis` session
#     cannot coexist with a second copy.
#
#   * Use the SHIPPED `cordis` preset for the load session.

# Exact tool names (rc.6): cordis_inspect_list / cordis_inspect_query /
# cordis_inspect_self, cordis_define, cordis_run, cordis_stop, cordis_undefine.

load_steps: |
  1. Start a NEW session on the shipped `cordis` preset.
  2. (Optional) Verify the slot: cordis_inspect_list, then
     cordis_inspect_query -> Slots client provider -> confirm settings.section.
  3. cordis_define:
       plugin:  { kind: "new", idPrefix: "adif" }
       name:    "auto-diff-review"
       purpose: "Native Auto-Diff review panel listing session patches and a per-file diff viewer"
       code:
         host:   <paste host.js>
         client: <paste client.js>
     → returns pluginId + packageId (both required next).
  4. cordis_run:
       pluginId:  <from step 3>
       packageId: <from step 3>
       mode:      "run"
     → returns status "awaiting-approval". Click APPROVE on the page you want
       the panel loaded into. It then reports "starting"/"running".
  5. Settings -> Auto-Diff Review.

why_this_works: |
  The web profile already enables cordis-host-runner + cordis-client-runner
  (@deepseek-ai/dsh-web-app/cordis.patch.yml). The `cordis` preset mounts the
  model-facing dsh-tool-cordis. The panel registers into settings.section
  (additive seat, id 'auto-diff-review').

reload / teardown: |
  - Reload a page: right-click the running package card / re-run cordis_run
    (same packageId, mode "run") to re-deliver the browser half to a refreshed
    page; it won't re-ask while still authorized.
  - cordis_stop ({ pluginId }) disposes the run; definition survives.
  - cordis_undefine ({ pluginId }) forgets the package.
  - Dynamic packages do NOT survive a DSH process restart.

persistence_note: |
  For a durable panel that survives restart, promote host.js/client.js to a
  static client-ui plugin (bundle + install into the web profile + rebuild and
  restart the Web app).