// ============================================================================
// orchestrator-models  (package dsh-orchestrator-models)
// ============================================================================
// Binds two user-owned model routes for the `orchestrator` agent preset:
//
//   orchestrator  — the top-level session agent (delegationDepth 0 / absent)
//   subagent      — every child this orchestrator spawns (delegationDepth >= 1)
//
// Both live in $DSH_HOME/settings.yaml under the `orchestrator:` namespace.
// The user edits that document (or any settings surface that writes it).
// This plugin never registers a model-facing tool that can change them, so
// the orchestrator model cannot rewrite its own spawn target.
//
// Binding is applied on the `agent/request` waterfall (provider/model of the
// actual LLM call) and on `system-prompt/assemble` ({{model}} / {{provider}}).
// Subagents join this standing mount via composeFrom, so one listener covers
// both the orchestrator and every child it starts.
// ============================================================================
'use strict';

const NS = 'orchestrator';

const DEFAULTS = {
  orchestrator: {
    provider: 'grok',
    model: 'grok-4.6',
  },
  subagent: {
    provider: 'clinepass',
    model: 'cline-pass/deepseek-v4-flash',
  },
};

function asRoute(value, fallback) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const provider = typeof src.provider === 'string' ? src.provider.trim() : '';
  const model = typeof src.model === 'string' ? src.model.trim() : '';
  return {
    provider: provider || fallback.provider,
    model: model || fallback.model,
  };
}

function resolveValue(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    orchestrator: asRoute(src.orchestrator, DEFAULTS.orchestrator),
    subagent: asRoute(src.subagent, DEFAULTS.subagent),
  };
}

/** Callable schema object accepted by ctx.settings.register (no schemastery import). */
function makeSchema() {
  function schema(value) {
    return resolveValue(value);
  }
  schema.toJSON = function toJSON() {
    return {
      type: 'object',
      properties: {
        orchestrator: {
          type: 'object',
          description: 'Model the orchestrator itself runs on. User-owned; the agent cannot change it.',
          properties: {
            provider: { type: 'string', description: 'Registered provider route (e.g. clinepass, hetzner).' },
            model: { type: 'string', description: 'Provider-owned model id.' },
          },
        },
        subagent: {
          type: 'object',
          description: 'Model every spawned sub-agent runs on. The orchestrator is bound to this choice.',
          properties: {
            provider: { type: 'string', description: 'Registered provider route.' },
            model: { type: 'string', description: 'Provider-owned model id.' },
          },
        },
      },
    };
  };
  return schema;
}

function headerOf(agent) {
  try {
    if (!agent || typeof agent !== 'object') return undefined;
    if (agent.session && agent.session.header) return agent.session.header;
    return agent.header;
  } catch (_err) {
    return undefined;
  }
}

function isSubagent(agent) {
  const header = headerOf(agent);
  if (!header || typeof header !== 'object') return false;
  if (header.origin === 'subagent') return true;
  const depth = header.delegationDepth;
  return typeof depth === 'number' && depth >= 1;
}

function pickRoute(value, agent) {
  return isSubagent(agent) ? value.subagent : value.orchestrator;
}

function applyRoute(config, route) {
  if (!route || !route.provider || !route.model) return config;
  return {
    ...config,
    provider: route.provider,
    model: route.model,
  };
}

module.exports = {
  name: 'orchestrator-models',
  apply(ctx) {
    const schema = makeSchema();
    let current = resolveValue(undefined);

    const settings = ctx.get('settings');
    if (settings && typeof settings.register === 'function') {
      try {
        const scope = settings.register(NS, schema, { base: DEFAULTS });
        const read = () => {
          try {
            current = resolveValue(scope.get());
          } catch (_err) {
            current = resolveValue(undefined);
          }
        };
        read();
        if (typeof scope.watch === 'function') {
          ctx.effect(() => scope.watch(() => {
            read();
          }), 'orchestrator-models.watch');
        }
      } catch (error) {
        ctx.logger?.warn?.('orchestrator-models: settings namespace not registered (%s); using built-in defaults', error && error.message ? error.message : String(error));
      }
    }

    ctx.on('agent/request', (payload, next) => {
      return Promise.resolve(next()).then((resolved) => {
        const agent = payload && payload.agent;
        return applyRoute(resolved, pickRoute(current, agent));
      });
    });

    ctx.on('system-prompt/assemble', (assembly, _context, next) => {
      return Promise.resolve(next()).then((assembled) => {
        const agents = ctx.get('agents');
        const initiator = agents && typeof agents.currentInitiator === 'function'
          ? agents.currentInitiator()
          : undefined;
        const route = pickRoute(current, initiator);
        return {
          ...assembled,
          variables: {
            ...(assembled && assembled.variables ? assembled.variables : {}),
            provider: route.provider,
            model: route.model,
          },
        };
      });
    });

    const systemPrompt = ctx.get('systemPrompt');
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      systemPrompt.section({
        name: 'orchestrator:models',
        order: 15,
        text: () => {
          const orch = current.orchestrator;
          const child = current.subagent;
          return [
            'You are the orchestrator in this session.',
            `Your own model route is ${orch.provider}/${orch.model}.`,
            `Every sub-agent you spawn (subagent, subagent_fork, workflow agent(), ralph) is bound to ${child.provider}/${child.model}.`,
            'You cannot change either route. The user owns both choices in settings (`orchestrator.orchestrator` and `orchestrator.subagent`).',
            'Do not ask to switch models, do not invent a model override, and do not try to write those settings.',
          ].join(' ');
        },
      });
    }
  },
};
