# DeepSeek Harness — Custom Modes & Plugins

Custom agent presets (modes), plugins, and skills for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Repository Structure

```
.
├── agent-presets/              # Custom agent modes (mirrors $DSH_HOME/.agent-presets)
│   ├── acp/                    # ACP mode — delegate execution to ACP v1 servers
│   ├── autodiff/               # AutoDiff mode — session auto-diff snapshot plugins
│   └── orchestrator/           # Orchestrator mode — dual-model orchestrator setup
├── web-profile/                # Custom web profile patches (mirrors $DSH_HOME/profiles/web)
│   └── plugins/subagent-acp/   # ACP client provider for the host plane
├── review-mode/                # Auto-Diff Review — dynamic Cordis panel for the Web GUI
│   ├── host.js / client.js     # Dynamic dual-half Cordis package
│   ├── durable/                # Static client plugin (for restart-persistent install)
│   └── fork-scaffold/          # Scaffold for building new Cordis plugins
├── docs/acp/                   # ACP protocol documentation and reference
├── examples/                   # Example configuration snippets
├── README.md
└── LICENSE
```

---

## Modes (Agent Presets)

### ACP (`agent-presets/acp/`)

Runs the agent session through an **ACP v1 server** (Agent Client Protocol over stdio, e.g. `opencode acp`). Every turn executes on the remote harness instead of the local API model.

**Plugin:** `plugins/acp-model-pin/` — Pins every agent session on this preset to the ACP LLM route (`acp`), so the main agent connects to the remote harness from the first turn. The host-side adapter lives in the `subagent-acp` web profile plugin.

**Prerequisites:**
- `opencode acp` (or another ACP v1 server) installed and available
- The `subagent-acp` plugin configured in `$DSH_HOME/profiles/web/cordis.patch.yml`

### AutoDiff (`agent-presets/autodiff/`)

Standard coding agent (cordis base) plus persisted auto-diff session snapshot plugins. Each session's accumulated file changes are written as a unified diff to `$DSH_HOME/sessions/<project>/<session>/auto-diff.patch` at every turn end.

**Plugins:**
- `plugins/auto-diff-v1/` — Captures files before write/edit tool calls. Basic write/edit tracking.
- `plugins/auto-diff-v2/` — Enhanced version with pwsh rename/move/delete tracking in addition to write/edit capture.

**Skills:**
- `skills/cordis-plugin-development/SKILL.md` — Guides the agent in developing Cordis plugins.
- `skills/editing-cordis-compositions/SKILL.md` — Guides the agent in editing Cordis composition files.

### Orchestrator (`agent-presets/orchestrator/`)

Full coding agent that runs as an **orchestrator**. The user independently chooses two model routes:
- **Orchestrator route** — the model the orchestrator runs on
- **Sub-agent route** — the model every spawned sub-agent uses

Neither choice is exposed as a model-facing tool. The orchestrator sees skill descriptions only and hands the full SKILL.md to spawned sub-agents.

**Configuration:** Add an `orchestrator:` block to your `$DSH_HOME/settings.yaml` (see `examples/settings.orchestrator.example.yaml`).

**Plugins:**
- `plugins/orchestrator-models/` — Reads `$DSH_HOME/settings.yaml` namespace `orchestrator` for the dual-model routes. Never exposes a model-facing write tool.
- `plugins/orchestrator-skills/` — Orchestrator sees skill catalog descriptions only; spawned sub-agents receive the full SKILL.md.

---

## Web Profile

`web-profile/` mirrors the structure of `$DSH_HOME/profiles/web/` with custom additions:

- **`cordis.yml`** — Profile root (empty entry list; composition happens through patches).
- **`cordis.patch.yml`** — Your patch layer adding:
  - `auto-diff-host` + `auto-diff-ui` — Auto-Diff Review Remote and panel services
  - `subagent-acp` — ACP client provider for delegating to ACP v1 servers
- **`plugins/subagent-acp/index.mjs`** — The ACP client provider plugin that registers an `LlmAdapter` for the `acp` provider name.

> **Before using `cordis.patch.yml`**, edit the `command` path under `subagent-acp` to point to your own ACP v1 server executable.

---

## Review Mode (Auto-Diff Review)

`review-mode/` is a client-side **review panel** for the DeepSeek Harness Web GUI. It lists every session's `auto-diff.patch` and renders each selected patch as per-file colored hunks.

Two delivery mechanisms:

| Mechanism | Persistence | Setup |
|-----------|-------------|-------|
| **Dynamic Cordis package** (`host.js` + `client.js`) | In-memory only — lost on restart | Load via `cordis_define`/`cordis_run` from a `cordis`-preset session |
| **Static client plugin** (`durable/`) | Survives restart | Install into the web profile's package tree and rebuild |

See `review-mode/README.md` for the full runbook.

---

## Installation

### Prerequisites

- DeepSeek Harness (v0.1.0-rc.6 or later)
- `$DSH_HOME` set to `~/.dsh` (default)

### Option A: install script (recommended)

**Windows:**
```powershell
.\install.ps1
```

**macOS / Linux:**
```bash
chmod +x install.sh
./install.sh
```

The script will:
1. Detect your `$DSH_HOME` (defaults to `~/.dsh`, respects the `$DSH_HOME` env var)
2. **Back up** any existing files it's about to overwrite into a timestamped folder (`$DSH_HOME/.dsh-modes-plugins-backup-<timestamp>`)
3. Copy all agent presets, plugins, skills, and web-profile configuration
4. Auto-detect your `opencode` path and update `cordis.patch.yml` (if `opencode` is installed)
5. Print next steps

**Flags:**
- `-DryRun` / `--dry-run` — preview without changing anything
- `-Yes` / `--yes` — skip prompts (keeps the placeholder opencode path)

### Option B: manual copy

```bash
# All presets
cp -r agent-presets/* $DSH_HOME/.agent-presets/

# Or individually:
cp -r agent-presets/acp $DSH_HOME/.agent-presets/
cp -r agent-presets/autodiff $DSH_HOME/.agent-presets/
cp -r agent-presets/orchestrator $DSH_HOME/.agent-presets/

# Web profile
cp -r web-profile/* $DSH_HOME/profiles/web/
```

Then edit `$DSH_HOME/profiles/web/cordis.patch.yml` to fix the `command` path for your ACP server.

### 3. Configure orchestrator routes (optional)

If using the Orchestrator preset, add an `orchestrator:` block to `$DSH_HOME/settings.yaml`:

```yaml
orchestrator:
  orchestrator:
    provider: grok
    model: grok-4.6
  subagent:
    provider: clinepass
    model: cline-pass/deepseek-v4-flash
```

### 4. Restart the harness

```bash
dsh web restart
```

---

## Usage

Once installed, select a preset from the mode picker in the Web GUI or CLI:

| Preset | ID | Description |
|--------|----|-------------|
| ACP | `acp` | Delegates to an ACP v1 server |
| AutoDiff | `autodiff` | Coding agent with auto-diff session snapshots |
| Orchestrator | `orchestrator` | Dual-model orchestrator setup |

---

## Development

The `autodiff` preset includes two skills (`cordis-plugin-development` and `editing-cordis-compositions`) that teach the agent how to author new Cordis composition files and plugins. The `review-mode/fork-scaffold/` directory contains a scaffold for building new Cordis plugins.

---

## License

MIT