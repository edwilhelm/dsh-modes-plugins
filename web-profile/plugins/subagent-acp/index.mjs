// ============================================================================
// subagent-acp  — ACP client subagent provider (host plane)
// ============================================================================
// Registers a `SubagentProvider` named `acp` on the host `ctx.subagents`
// registry. Each `start(request)` spawns a configured ACP **server** process
// (e.g. `opencode acp`), speaks the Agent Client Protocol v1 over stdio
// (newline-delimited JSON-RPC 2.0), creates a session in the child cwd, sends
// the delegated prompt, streams `session/update` text chunks into the seam's
// AssistantOutputFold, maps the ACP stop reason, and settles a remote one-shot
// run through settleRunResult / subprocessRunHandle.
//
// This plugin is HOST plane: it registers into the process-global `subagents`
// registry. An agent preset only exposes the model-facing tool row
// (`tool-subagent` with `provider: acp`). Out-of-process children advertise
// NO start capabilities and are one-shot.
// ============================================================================
'use strict';

import z from '@deepseek-ai/schemastery';
import {
  AssistantOutputFold,
  NO_START_CAPABILITIES,
  SubagentRunId,
  assertPositiveFinite,
  resolveChildCwd,
  settleRunResult,
  subprocessRunHandle,
  validateConfiguredCwd,
} from '@deepseek-ai/dsh-subagent';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const Config = z.object({
  /** Registry name of this provider (default `acp`). */
  providerName: z.string().default('acp'),
  /** ACP server executable (e.g. `opencode`). */
  command: z.string().required(),
  /** Arguments that start the ACP server (e.g. `['acp']`). */
  args: z.array(z.string()).default([]),
  /** Explicit environment entries merged after the scrubbed parent base. */
  env: z.dict(z.string()).default({}),
  /**
   * Optional child working-directory override (absolute path).
   * Omit to inherit the delegating parent session's workspace cwd.
   */
  cwd: z.string(),
  /** ACP protocol version offered on `initialize` (1 = stable v1). */
  protocolVersion: z.number().default(1),
  /**
   * Provider route this plugin serves on the LLM model registry
   * (`ctx.llm`) so the MAIN agent can run on the ACP server instead of the
   * configured API model. The ACP preset pins `agent/request` to this route.
   */
  llmProviderName: z.string().default('acp'),
  /** Advisory model id advertised for the ACP route (any non-empty string). */
  llmModelName: z.string().default('acp'),
  /** Client name/version advertised on `initialize`. */
  clientName: z.string().default('deepseek-harness'),
  clientVersion: z.string().default('0.1.0'),
  /** Bound on the initialize and session/new handshake, in milliseconds. */
  initializeTimeoutMs: z.number().default(30000),
  /** Bound on the prompt turn; 0 disables (the agent may run long). */
  promptTimeoutMs: z.number().default(0),
  /** SIGTERM -> SIGKILL grace for the ACP server process, in milliseconds. */
  shutdownGraceMs: z.number().default(5000),
  /** Retained stderr tail (bytes) for diagnostics on failure. */
  stderrTailBytes: z.number().default(16384),
  /**
   * How `session/request_permission` is answered:
   *   deny   (default) — select a reject option if offered, else cancel;
   *   allow            — select an allow option if offered, else cancel;
   *   cancel           — always respond with the `cancelled` outcome.
   */
  permissionMode: z.union(['deny', 'allow', 'cancel']).default('deny'),
  /**
   * Whether the LLM adapter forwards the harness-assembled system prompt as a
   * lead text block on the FIRST turn of each harness session. The remote ACP
   * agent brings its own persona, so this is off by default.
   */
  llmForwardSystem: z.boolean().default(false),
  /**
   * Grace period (ms) the LLM adapter waits after sending `session/cancel`
   * before hard-terminating the ACP server process on an aborted turn.
   */
  cancelGraceMs: z.number().default(2000),
});

// ---------------------------------------------------------------------------
// ACP stop-reason mapping
// ---------------------------------------------------------------------------

function mapStopReason(reason) {
  switch (reason) {
    case 'end_turn':     return 'completed';
    case 'max_tokens':   return 'max-tokens';
    case 'max_turn_requests': return 'max-tokens';
    case 'refusal':      return 'refusal';
    case 'cancelled':    return 'aborted';
    default:             return 'error';
  }
}

/** Map harness ContentBlocks to ACP prompt blocks (text + image). */
function toAcpPrompt(blocks, supportsImage) {
  return blocks.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'image') {
      if (!supportsImage) {
        throw new Error('acp: agent does not advertise image prompt support; cannot forward an image block');
      }
      return { type: 'image', data: block.data, mimeType: block.mimeType };
    }
    throw new Error(`acp: unsupported prompt block type "${block.type}"`);
  });
}

// ---------------------------------------------------------------------------
// Newline-delimited JSON-RPC 2.0 client
// ---------------------------------------------------------------------------

class AcpRpc {
  constructor(onMessage) {
    this.onMessage = onMessage; // mutable: the persistent LLM adapter swaps it per turn
    this.nextId = 1;
    this.pending = new Map();
    this.ended = false;
    this.writer = null; // set by attach()
  }

  /** Send one request and await its correlated response. */
  request(method, params, timeoutMs = 0) {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.pending.set(id, entry);
      let timer;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`acp: request "${method}" timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
        entry.timer = timer;
      }
      try {
        this.send(message);
      } catch (error) {
        this.pending.delete(id);
        if (timer !== undefined) clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** Send a one-way notification. */
  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Dispatch one decoded JSON-RPC message from the peer. */
  receive(message) {
    if (!message || typeof message !== 'object') return;
    // Response (has id, no method)
    if (message.id !== undefined && message.id !== null && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      if (message.error !== undefined) {
        const err = new Error(`acp: ${message.error.message ?? 'JSON-RPC error'} (code ${message.error.code ?? 'unknown'})`);
        err.code = message.error.code;
        entry.reject(err);
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    // Request or notification from the agent side (has method)
    if (typeof message.method === 'string') {
      this.onMessage(message);
    }
  }

  /** Signal that the transport ended; reject everything still pending. */
  end(cause) {
    if (this.ended) return;
    this.ended = true;
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(new Error(`acp: transport ended before a response (${cause})`));
    }
    this.pending.clear();
  }

  send(message) {
    if (this.ended) throw new Error('acp: transport already ended');
    if (this.writer === null) throw new Error('acp: transport not yet attached');
    this.writer(message);
  }

  /** Attach the actual line writer. */
  attach(writer) {
    this.writer = writer;
  }
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

class AcpProvider {
  constructor(config) {
    this.name = config.providerName;
    this.capabilities = NO_START_CAPABILITIES;
    this.inheritsParentContext = false;
    this.config = config;
  }

  start(request) {
    const prefix = 'subagent-acp';
    const config = this.config;
    const signal = request.signal;

    // Resolve the child cwd: configured override wins, else parent session cwd.
    // config.cwd was validated at load (in apply()); it is undefined when the
    // deployment did not pin one.
    const cwd = resolveChildCwd(prefix, config.cwd, request.parent.session.header.cwd);

    // Shared state
    let cancelled = false;
    const fold = new AssistantOutputFold();
    let processHandle = undefined;
    let currentSessionId = undefined;

    const rpc = new AcpRpc((message) => {
      void handleAgentMessage(config, fold, message, rpc);
    });

    // --- abort signal wiring ---
    const onAbort = () => {
      cancelled = true;
      // Best-effort wire cancel before terminating the process.
      if (currentSessionId !== undefined) {
        try { rpc.notify('session/cancel', { sessionId: currentSessionId }); } catch {}
      }
      processHandle?.terminate();
    };
    signal.addEventListener('abort', onAbort);

    // --- the actual ACP conversation ---
    const attempt = async () => {
      let handle;
      try {
        handle = await this.spawn(cwd, signal);
        processHandle = handle;

        // Wire the JSON-RPC writer.
        rpc.attach((message) => { handle.stdin?.write(JSON.stringify(message) + '\n'); });

        // Read stdout lines.
        let buffer = '';
        handle.stdout?.setEncoding('utf8');
        handle.stdout?.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line === '') continue;
            try { rpc.receive(JSON.parse(line)); } catch {}
          }
        });
        handle.stdout?.on('end', () => {
          if (buffer.trim() !== '') {
            try { rpc.receive(JSON.parse(buffer.trim())); } catch {}
          }
          rpc.end(cancelled ? 'cancelled' : 'process stdout closed');
        });

        // ---- handshake ----
        const init = await rpc.request(
          'initialize',
          {
            protocolVersion: config.protocolVersion,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: config.clientName, version: config.clientVersion },
          },
          config.initializeTimeoutMs,
        );

        const session = await rpc.request(
          'session/new',
          { cwd, mcpServers: [] },
          config.initializeTimeoutMs,
        );
        currentSessionId = session.sessionId;

        // ---- prompt ----
        const supportsImage = init?.agentCapabilities?.promptCapabilities?.image === true;
        const prompt = await rpc.request(
          'session/prompt',
          {
            sessionId: currentSessionId,
            prompt: toAcpPrompt(request.prompt, supportsImage),
          },
          config.promptTimeoutMs,
        );

        const stopReason = mapStopReason(prompt?.stopReason);

        // ---- closeout ----
        try { await rpc.request('session/close', { sessionId: currentSessionId }, config.initializeTimeoutMs); } catch {}
        await this.teardownProcess(handle);

        const output = fold.collect() ?? [];
        return { output, stopReason };
      } finally {
        // Guarantee the process tree is gone on every path, including
        // handshake failures and timeouts.
        await this.teardownProcess(handle);
      }
    };

    const parts = {
      id: SubagentRunId(`acp-${randomUUID()}`),
      signal,
      onAbort,
      requestCancel: () => {
        if (currentSessionId !== undefined) {
          try { rpc.notify('session/cancel', { sessionId: currentSessionId }); } catch {}
        }
        processHandle?.terminate();
      },
      teardown: async () => {
        try { await this.teardownProcess(processHandle); } catch {}
      },
      attempt,
      cancelled: () => cancelled,
      collectOutput: () => fold.collect() ?? [],
      onError: (error, kind) => {
        // Diagnostic sink — the tool layer already surfaces the error.
        this.ctx?.logger?.warn?.(`[subagent-acp] ${kind}: ${error?.message ?? error}`);
      },
    };
    parts.result = settleRunResult(parts);
    return subprocessRunHandle(parts);
  }

  async spawn(cwd, signal) {
    const config = this.config;
    return this.ctx.subprocess.spawn({
      argv: [config.command, ...config.args],
      cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: config.stderrTailBytes },
      },
      graceMs: config.shutdownGraceMs,
      signal,
      env: config.env,
    });
  }

  async teardownProcess(handle) {
    if (handle === undefined) return;
    handle.terminate(); // idempotent; no-op if already exited
    await handle.waitForExit();
  }
}

// ---------------------------------------------------------------------------
// ACP LLM adapter (main-agent model route)
// ---------------------------------------------------------------------------
// Registers an `LlmAdapter` for a provider route (default `acp`) so the MAIN
// agent of a session on the ACP preset runs on the ACP server instead of the
// configured API model. Each harness session owns one persistent ACP server
// process + session (opencode keeps its own conversation memory across turns).
// stream() forwards only the newest user message each turn, streams
// agent_message_chunk text as text-delta chunks, and finishes with the mapped
// stop reason. The remote agent executes with its OWN tools; the harness's own
// tools stay listed (request-cache stability) but are never called.

function mapLlmFinish(reason) {
  switch (reason) {
    case 'end_turn':         return { kind: 'stop' };
    case 'max_tokens':       return { kind: 'max-tokens' };
    case 'max_turn_requests': return { kind: 'max-tokens' };
    case 'refusal':          return { kind: 'stop' };
    case 'cancelled':        return { kind: 'aborted', failure: { message: 'cancelled', code: 'CANCELLED' } };
    default:                 return { kind: 'error', failure: { message: `acp: unknown stop reason "${reason}"`, code: 'ACP_UNKNOWN_STOP' } };
  }
}

/** Tiny async queue bridging rpc notifications into the stream() generator. */
class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.ended = false;
  }

  push(item) {
    if (this.ended) return;
    if (this.waiters.length > 0) this.waiters.shift()(item);
    else this.items.push(item);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()(undefined);
  }

  next() {
    if (this.items.length > 0) return Promise.resolve(this.items.shift());
    if (this.ended) return Promise.resolve(undefined);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/** Text (and optional image) blocks of one harness message, leniently mapped. */
function messagePromptBlocks(message, supportsImage) {
  const blocks = [];
  for (const block of message?.content ?? []) {
    if (block.type === 'text') blocks.push({ type: 'text', text: block.text });
    else if (block.type === 'image' && supportsImage) {
      blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    }
    // reasoning / tool-call / tool-result blocks carry no user-authored
    // content the ACP agent should re-read — skip them.
  }
  return blocks;
}

class AcpLlmAdapter extends LlmAdapter {
  constructor(config, ctx) {
    super();
    this.config = config;
    this.ctx = ctx;
    this.sessions = new Map(); // harness sessionId -> { handle, rpc, acpSessionId, alive, systemSent }
    this.supportsImageCache = new Map();
  }

  providerInfo(provider) {
    return { id: provider, name: 'ACP server' };
  }

  listModels(_provider) {
    const id = this.config.llmModelName;
    return Promise.resolve([{ provider: this.config.llmProviderName, id, name: id }]);
  }

  resolveModel(provider, model, _signal) {
    return Promise.resolve({ provider, id: model, name: model });
  }

  /** Resolve the child cwd: configured override, else the live session's header cwd. */
  resolveCwd(sessionId) {
    const configured = this.config.cwd;
    if (configured !== undefined) return configured;
    try {
      const sessionService = this.ctx.get('sessions');
      const session = sessionService?.get?.(sessionId);
      if (session?.header?.cwd) return session.header.cwd;
    } catch {}
    return process.cwd();
  }

  async spawn(cwd, signal) {
    const config = this.config;
    return this.ctx.subprocess.spawn({
      argv: [config.command, ...config.args],
      cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: config.stderrTailBytes },
      },
      graceMs: config.shutdownGraceMs,
      signal,
      env: config.env,
    });
  }

  /** Create one ACP process + session; used for persistent and throwaway entries. */
  async createSession(cwd, signal) {
    const config = this.config;
    let handle;
    try {
      handle = await this.spawn(cwd, signal);
    } catch (error) {
      throw new Error(`acp: failed to start "${config.command}" — ${error?.message ?? error}`);
    }
    const rpc = new AcpRpc(() => {});
    rpc.attach((message) => { handle.stdin?.write(JSON.stringify(message) + '\n'); });
    let buffer = '';
    handle.stdout?.setEncoding('utf8');
    handle.stdout?.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line === '') continue;
        try { rpc.receive(JSON.parse(line)); } catch {}
      }
    });
    handle.stdout?.on('end', () => {
      if (buffer.trim() !== '') {
        try { rpc.receive(JSON.parse(buffer.trim())); } catch {}
      }
      rpc.end('process stdout closed');
    });
    const init = await rpc.request(
      'initialize',
      {
        protocolVersion: config.protocolVersion,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: config.clientName, version: config.clientVersion },
      },
      config.initializeTimeoutMs,
    );
    const session = await rpc.request(
      'session/new',
      { cwd, mcpServers: [] },
      config.initializeTimeoutMs,
    );
    return {
      handle,
      rpc,
      acpSessionId: session.sessionId,
      supportsImage: init?.agentCapabilities?.promptCapabilities?.image === true,
    };
  }

  /** Get-or-create the persistent session for one harness sessionId. */
  async ensureSession(sessionId) {
    const key = String(sessionId ?? 'default');
    let entry = this.sessions.get(key);
    if (entry?.alive) return entry;
    if (entry) {
      // Previous process died or was disposed — clean up before respawn.
      try { await this.teardownProcess(entry.handle); } catch {}
      this.sessions.delete(key);
    }
    const cwd = this.resolveCwd(sessionId);
    const created = await this.createSession(cwd, undefined);
    const alive = { ...created, alive: true, systemSent: false };
    created.handle.done?.then(
      () => { alive.alive = false; },
      () => { alive.alive = false; },
    );
    this.sessions.set(key, alive);
    return alive;
  }

  /** Close a session entry and drop the process (retry starts clean). */
  async disposeEntry(sessionId) {
    const key = String(sessionId ?? 'default');
    const entry = this.sessions.get(key);
    if (!entry) return;
    this.sessions.delete(key);
    try { await entry.rpc.request('session/close', { sessionId: entry.acpSessionId }, this.config.initializeTimeoutMs); } catch {}
    try { await this.teardownProcess(entry.handle); } catch {}
  }

  async dispose() {
    for (const key of [...this.sessions.keys()]) {
      await this.disposeEntry(key === 'default' ? undefined : key);
    }
  }

  /**
   * The main-agent model call. options.messages is the full derived history;
   * the ACP session already remembers prior turns, so forward only the newest
   * user-authored message (plus the harness system prompt on the first turn
   * when llmForwardSystem is enabled).
   */
  async *stream(options) {
    const { signal, sessionId, purpose } = options;
    if (purpose !== undefined) {
      yield* this.auxiliaryStream(options);
      return;
    }
    const entry = await this.ensureSession(sessionId);
    const prompt = [];
    if (!entry.systemSent && this.config.llmForwardSystem && options.system) {
      prompt.push({ type: 'text', text: options.system });
    }
    entry.systemSent = true;
    const messages = options.messages ?? [];
    let lastUser = undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') { lastUser = messages[i]; break; }
    }
    const userBlocks = messagePromptBlocks(lastUser, entry.supportsImage);
    if (userBlocks.length > 0) prompt.push(...userBlocks);
    else {
      // Defensive fallback: no user message found — serialize the history.
      for (const message of messages) {
        prompt.push(...messagePromptBlocks(message, entry.supportsImage));
      }
    }
    if (prompt.length === 0) prompt.push({ type: 'text', text: '(continue)' });

    const queue = new AsyncQueue();
    let promptResult = undefined;
    let promptError = undefined;
    const handler = (message) => {
      if (message.method === 'session/update') {
        const update = message.params?.update;
        if (update?.sessionUpdate === 'agent_message_chunk') {
          const content = update.content;
          const text = content?.type === 'text' ? content.text : content?.type === 'text_delta' ? content.text : undefined;
          if (text) queue.push(text);
        }
      } else if (message.id !== undefined && message.id !== null) {
        // Agent→client request (permission, fs, ...) — answer per permissionMode.
        void respondToAgent(this.config, message).then(
          (result) => { entry.rpc.send({ jsonrpc: '2.0', id: message.id, result }); },
          (error) => {
            entry.rpc.send({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: error instanceof Error ? error.message : String(error) },
            });
          },
        );
      }
    };
    entry.rpc.onMessage = handler;

    let cancelTimer;
    const onAbort = () => {
      try { entry.rpc.notify('session/cancel', { sessionId: entry.acpSessionId }); } catch {}
      // Give the server a grace period to settle the turn, then hard-terminate
      // so the pending request rejects and the stream ends.
      cancelTimer = setTimeout(() => { entry.handle?.terminate(); }, this.config.cancelGraceMs);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const promptPromise = entry.rpc.request(
        'session/prompt',
        { sessionId: entry.acpSessionId, prompt },
        this.config.promptTimeoutMs,
      );
      promptPromise.then(
        (result) => { promptResult = result; queue.end(); },
        (error) => { promptError = error; queue.end(); },
      );

      let text = '';
      while (true) {
        const item = await queue.next();
        if (item === undefined) break;
        text += item;
        yield { type: 'text-delta', index: 0, text: item };
      }
      if (promptError !== undefined) throw promptError;
      const reason = mapLlmFinish(promptResult?.stopReason);
      if (text) yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (cancelTimer !== undefined) clearTimeout(cancelTimer);
      entry.rpc.onMessage = () => {};
    }
  }

  /**
   * Auxiliary calls (compaction / session-title) run on a throwaway ACP
   * session so they never pollute the persistent conversation.
   */
  async *auxiliaryStream(options) {
    const { signal, sessionId } = options;
    const cwd = this.resolveCwd(sessionId);
    let created;
    try {
      created = await this.createSession(cwd, signal);
    } catch (error) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: error?.message ?? String(error), code: 'ACP_SPAWN' } } };
      return;
    }
    const { rpc, acpSessionId } = created;
    const prompt = [];
    for (const message of options.messages ?? []) {
      prompt.push(...messagePromptBlocks(message, created.supportsImage));
    }
    if (prompt.length === 0) prompt.push({ type: 'text', text: '(summarize)' });
    const queue = new AsyncQueue();
    let promptResult = undefined;
    let promptError = undefined;
    const handler = (message) => {
      if (message.method === 'session/update') {
        const update = message.params?.update;
        if (update?.sessionUpdate === 'agent_message_chunk') {
          const content = update.content;
          const text = content?.type === 'text' ? content.text : content?.type === 'text_delta' ? content.text : undefined;
          if (text) queue.push(text);
        }
      }
    };
    rpc.onMessage = handler;
    try {
      const promptPromise = rpc.request('session/prompt', { sessionId: acpSessionId, prompt }, this.config.promptTimeoutMs);
      promptPromise.then(
        (result) => { promptResult = result; queue.end(); },
        (error) => { promptError = error; queue.end(); },
      );
      let text = '';
      while (true) {
        const item = await queue.next();
        if (item === undefined) break;
        text += item;
        yield { type: 'text-delta', index: 0, text: item };
      }
      if (promptError !== undefined) throw promptError;
      const reason = mapLlmFinish(promptResult?.stopReason);
      if (text) yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason };
    } finally {
      rpc.onMessage = () => {};
      try { await rpc.request('session/close', { sessionId: acpSessionId }, this.config.initializeTimeoutMs); } catch {}
      try { await this.teardownProcess(created.handle); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Agent→client request handling
// ---------------------------------------------------------------------------

/** Respond to an agent->client request or notification. */
async function handleAgentMessage(config, fold, message, rpc) {
  // Handle session/update notifications (no id) — fold text chunks.
  if (message.id === undefined || message.id === null) {
    if (message.method === 'session/update') {
      const update = message.params?.update;
      if (update?.sessionUpdate === 'agent_message_chunk') {
        const content = update.content;
        if (content?.type === 'text' && content.text?.length > 0) {
          fold.pushText(content.text);
        } else if (content?.type === 'text_delta' && content.text?.length > 0) {
          fold.pushText(content.text);
        }
      }
    }
    // Notifications that need no response — ignore the rest.
    return;
  }

  // This is a request from the agent (it has an id) — must respond.
  try {
    const result = await respondToAgent(config, message);
    rpc.send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    rpc.send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32601,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function respondToAgent(config, message) {
  switch (message.method) {
    case 'session/request_permission': {
      const options = Array.isArray(message.params?.options) ? message.params.options : [];
      if (config.permissionMode === 'cancel') {
        return { outcome: { outcome: 'cancelled' } };
      }
      const wantAllow = config.permissionMode === 'allow';
      const preferred = options.find((o) =>
        wantAllow
          ? (o.kind === 'allow_always' || o.kind === 'allow_once')
          : (o.kind === 'reject_always' || o.kind === 'reject_once'),
      );
      if (preferred?.optionId !== undefined) {
        return { outcome: { outcome: 'selected', optionId: preferred.optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    }

    case 'fs/read_text_file':
    case 'fs/write_text_file':
    case 'terminal/create':
    case 'terminal/output':
    case 'terminal/release':
    case 'terminal/wait_for_exit':
    case 'terminal/kill':
    case 'elicitation/create':
      throw new Error(`acp: client capability for "${message.method}" is not advertised`);

    default:
      throw new Error(`acp: unsupported agent->client method "${message.method}"`);
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  const provider = new AcpProvider(config);
  provider.ctx = ctx;

  // Load-time validation.
  assertPositiveFinite('subagent-acp', 'initializeTimeoutMs', config.initializeTimeoutMs);
  assertPositiveFinite('subagent-acp', 'shutdownGraceMs', config.shutdownGraceMs);
  assertPositiveFinite('subagent-acp', 'stderrTailBytes', config.stderrTailBytes);
  assertPositiveFinite('subagent-acp', 'cancelGraceMs', config.cancelGraceMs);
  if (config.command.trim() === '') {
    throw new Error('subagent-acp: config command must not be empty');
  }
  if (config.llmProviderName.trim() === '') {
    throw new Error('subagent-acp: config llmProviderName must not be empty');
  }
  if (config.llmModelName.trim() === '') {
    throw new Error('subagent-acp: config llmModelName must not be empty');
  }
  // cwd: validate at load if a static value was configured (skip on undefined).
  if (config.cwd !== undefined) {
    validateConfiguredCwd('subagent-acp', config.cwd);
  }

  ctx.subagents.registerProvider(provider);

  // Main-agent model route: register the ACP LLM adapter on its own provider
  // route. The ACP preset pins agent/request to this route via a preset row.
  const llmAdapter = new AcpLlmAdapter(config, ctx);
  const registration = ctx.llm.registerAdapter([config.llmProviderName], llmAdapter);
  // ctx.effect runs the callback immediately and collects the returned
  // function as the disposer (runs at fiber disposal).
  ctx.effect(() => {
    return () => {
      registration();
      void llmAdapter.dispose();
    };
  });
}

const name = 'subagent-acp';
const inject = ['subagents', 'subprocess', 'llm', 'sessions'];

export { Config, apply, inject, name };