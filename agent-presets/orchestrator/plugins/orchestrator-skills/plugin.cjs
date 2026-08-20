'use strict';
// schema v2: object output (no oneOf / property-level required)

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUBAGENT_SECTION_ORDER = 116.5;

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

function outputValueText(values) {
  if (!Array.isArray(values)) return '';
  return values
    .filter((value) => value && typeof value === 'object' && value.type === 'text' && typeof value.text === 'string')
    .map((value) => value.text)
    .join('');
}

function stopReasonError(result) {
  switch (result && result.stopReason) {
    case 'completed': return undefined;
    case 'aborted': return 'subagent run was cancelled';
    case 'error': return 'subagent run failed';
    case 'max-tokens': return 'subagent run hit its token limit before finishing';
    case 'refusal': return 'subagent declined the task';
    default: return 'subagent run ended abnormally (' + String(result && result.stopReason) + ')';
  }
}

function withPartialText(error, output) {
  const text = outputValueText(output);
  return text.length === 0 ? error : error + '\nPartial output before the run ended:\n' + text;
}

async function settleRun(run) {
  try {
    const result = await run.result;
    const output = Array.isArray(result && result.output) ? result.output : [];
    const error = stopReasonError(result);
    if (error) throw new Error(withPartialText(error, output));
    return output;
  } finally {
    if (run && typeof run.dispose === 'function') await run.dispose();
  }
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderSkillManual(skill) {
  const name = escapeAttr(skill.name);
  const body = typeof skill.content === 'string' ? skill.content : '';
  return [
    'The orchestrator handed you this skill manual. Read it now and follow it for this task. Do not call the `skill` tool again for this skill.',
    '',
    '<skill_content name="' + name + '">',
    body,
    '</skill_content>',
  ].join('\n');
}

async function loadSkillManual(ctx, name, agent, signal) {
  if (typeof name !== 'string' || !SKILL_NAME.test(name)) {
    throw new Error('invalid skill name "' + String(name) + '"');
  }
  const skills = ctx.get('skills');
  if (!skills) throw new Error('skills registry unavailable');
  const header = headerOf(agent);
  const lookup = {
    cwd: header && typeof header.cwd === 'string' ? header.cwd : undefined,
    signal: signal,
    scope: agent,
  };
  const listed = await skills.list(lookup);
  const summary = Array.isArray(listed) ? listed.find(function (entry) { return entry && entry.name === name; }) : undefined;
  if (!summary) throw new Error('skill "' + name + '" is unknown or no longer available');
  const skill = await skills.get(name, lookup);
  if (!skill || typeof skill.content !== 'string') {
    throw new Error('skill "' + name + '" is unknown or no longer available');
  }
  return skill;
}

function registerDelegationTool(ctx, spec) {
  const tools = ctx.get('tools');
  const subagents = ctx.get('subagents');
  if (!tools || !subagents) return;

  const toolName = spec.toolName;
  const providerName = spec.provider;
  const inheritDesc = spec.inheritsConversation
    ? 'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn). Use this when the subtask builds on this conversation context. You receive its result, not its intermediate steps.'
    : 'Delegate a self-contained task to a subagent (a separate agent that works in its own context). The subagent returns its result, not its intermediate steps. Give it a complete, standalone prompt: it does not see this conversation.';
  const promptDesc = spec.inheritsConversation
    ? 'The task for the subagent. It already sees this conversation completed turns, so build on them freely and state only what is new.'
    : 'The complete, self-contained task for the subagent. It does not share this conversation context, so include everything it needs.';

  const definition = {
    name: toolName,
    description: inheritDesc + ' Optionally pass `skill` with an exact catalog skill name. You must not load that skill yourself. The child receives the full SKILL.md immediately after your hand-off prompt. This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. Set `run_in_background: false` only when your next action depends on receiving the result.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: promptDesc,
      },
      skill: {
        type: 'string',
        description: 'Exact skill name from the session catalog. The orchestrator must not load this skill. The child receives the full SKILL.md right after the hand-off prompt.',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          kind: { type: 'string' },
          jobId: { type: 'string' },
          subagentId: { type: 'string' },
          runId: { type: 'string' },
          output: { type: 'array', items: { type: 'object' } },
        },
      },
      render: function (_args, value) {
        var text = value.kind === 'background'
          ? 'started background subagent job ' + value.jobId
          : value.kind === 'continuable'
            ? 'started subagent ' + value.subagentId
            : outputValueText(value.output);
        return [{ type: 'text', text: text }];
      },
    },
    isConcurrencySafe: function () { return true; },
    presentCall: function (args) {
      var skill = args && typeof args.skill === 'string' ? args.skill : undefined;
      var label = args && args.description ? args.description : toolName;
      return {
        card: 'generic',
        title: skill ? 'Delegate ' + label + ' [' + skill + ']' : 'Delegate ' + label,
        kind: 'read',
        rawInput: skill ? label + ' skill=' + skill : label,
      };
    },
    execute: async function (args, exec) {
      var parent = exec.agent;
      if (!parent) throw new Error('subagent tool requires a calling agent (exec.agent was undefined)');
      var promptBlocks = [{ type: 'text', text: args.prompt }];
      if (typeof args.skill === 'string' && args.skill.trim().length > 0) {
        var skill = await loadSkillManual(ctx, args.skill.trim(), parent, exec.signal);
        promptBlocks.push({ type: 'text', text: renderSkillManual(skill) });
      }
      var request = { label: args.description, prompt: promptBlocks, parent: parent };
      if (args.run_in_background !== false) {
        var started = await subagents.startContinuable({
          provider: providerName,
          label: args.description,
          request: request,
          signal: exec.signal,
        });
        return { kind: 'continuable', subagentId: started.childId };
      }
      var run = await subagents.start(providerName, Object.assign({}, request, { signal: exec.signal }));
      var output = await settleRun(run);
      return { kind: 'foreground', runId: run.id, output: output };
    },
  };

  var disposeTool;
  function mount(provider) {
    if (disposeTool !== undefined || !provider) return;
    disposeTool = tools.register(definition);
  }
  ctx.on('subagent/provider-added', function (provider) {
    if (provider && provider.name === providerName) mount(provider);
  });
  ctx.on('subagent/provider-removed', function (name) {
    if (name !== providerName || disposeTool === undefined) return;
    disposeTool();
    disposeTool = undefined;
  });
  var present = subagents.getProvider(providerName);
  if (present !== undefined) mount(present);

  var systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    systemPrompt.section({
      name: 'tool:' + toolName,
      order: SUBAGENT_SECTION_ORDER,
      text: function (context) {
        if (disposeTool === undefined) return '';
        if (tools.get(toolName, context && context.scope) === undefined) return '';
        return 'Use ' + toolName + ' in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set `run_in_background: false` only when your next action depends on that subagent result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.';
      },
    });
  }
}

module.exports = {
  name: 'orchestrator-skills',
  apply: function (ctx) {
    var tools = ctx.get('tools');
    if (tools && typeof tools.guard === 'function') {
      tools.guard(function (exec) {
        if (!exec || exec.name !== 'skill') return undefined;
        if (isSubagent(exec.agent)) return undefined;
        return 'The orchestrator cannot load a skill body. Pass `skill` on subagent / subagent_fork with the exact catalog name; the child receives the full SKILL.md immediately after your hand-off prompt.';
      });
    }

    registerDelegationTool(ctx, { provider: 'spawn', toolName: 'subagent', inheritsConversation: false });
    registerDelegationTool(ctx, { provider: 'fork', toolName: 'subagent_fork', inheritsConversation: true });

    var systemPrompt = ctx.get('systemPrompt');
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      systemPrompt.section({
        name: 'orchestrator:skills',
        order: 16,
        text: 'Skills live in the usual skill directories. You see only the catalog (name + description). Do not call the `skill` tool. Do not read a SKILL.md yourself. When a task matches a catalog skill, spawn a sub-agent with `skill` set to that exact name and put the task in `prompt`. The child receives your hand-off prompt first, then the full skill manual. You may spawn without `skill` for tasks that need no manual.',
      });
    }
  },
};
