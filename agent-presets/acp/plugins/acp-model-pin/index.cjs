// ============================================================================
// acp-model-pin  (package dsh-acp-model-pin)
// ============================================================================
// Binds every agent session started on the `acp` preset to the ACP LLM route:
//
//   provider: acp
//   model:    acp
//
// These names match the `LlmAdapter` registered host-side by the
// `subagent-acp` plugin (config llmProviderName / llmModelName). Binding is
// applied on the `agent/request` waterfall (the provider/model of the actual
// LLM call) and on `system-prompt/assemble` ({{model}} / {{provider}}), so the
// main agent runs on the ACP server from the very first turn instead of the
// configured API model.
//
// This is the agent-plane half of ACP mode. The host half (spawning the ACP
// server, the session, the stream mapping) lives in the `subagent-acp` plugin
// row of the web profile patch.
// ============================================================================
'use strict';

const ROUTE = { provider: 'acp', model: 'acp' };

module.exports = {
  name: 'acp-model-pin',
  apply(ctx) {
    ctx.on('agent/request', (payload, next) => {
      return Promise.resolve(next()).then((resolved) => ({
        ...resolved,
        provider: ROUTE.provider,
        model: ROUTE.model,
      }));
    });

    ctx.on('system-prompt/assemble', (assembly, _context, next) => {
      return Promise.resolve(next()).then((assembled) => ({
        ...assembled,
        variables: {
          ...(assembled && assembled.variables ? assembled.variables : {}),
          provider: ROUTE.provider,
          model: ROUTE.model,
        },
      }));
    });
  },
};
