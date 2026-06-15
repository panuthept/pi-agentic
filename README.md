# ⚡ pi-agentic

**In-process subagent delegation for Pi coding agents.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.9.4-blue)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)]()
[![Pi](https://img.shields.io/badge/pi--coding--agent-%5E0.79.3-blueviolet)]()

`pi-agentic` is a **Pi extension** that lets your main agent delegate tasks to specialized subagents — in-process, with no subprocess cold-start overhead. Think of it as a team-lead layer: you (or your orchestrator agent) dispatch work to a roster of specialists (scout, planner, worker, researcher, …), and each runs as a full agent session inside the same process.

---

## Features

- **🔁 In-process execution** — subagents run via `createAgentSession()`, no subprocess spawn, no cold-start
- **🎯 Three delegation modes** — single, parallel batch (configurable concurrency), and background (fire-and-forget)
- **⛔ Depth-gated delegation** — `maxDepth` frontmatter prevents runaway agent chains
- **🧠 Main agent system** — persist an active "main agent" whose system prompt is injected into every provider request, with tool allowlist enforcement
- **📊 Execution timeline** — persistent Gantt chart showing all subagent runs with agent coloring (`/timeline`)
- **📡 Live streaming UI** — real-time tool call progress, text deltas, and execution events in the terminal
- **🔀 Foreground→background detach** — Ctrl+Shift+B or `/subagent:bg` to move a running subagent to the background
- **📦 13 pre-bundled specialist agents** — ready to use out of the box
- **🔎 Multi-source agent discovery** — agents loaded from bundled dir, `~/.pi/agent/agents/`, and `.pi/agents/`
- **⚡ Resource loader pooling** — extension/resource graph cached and reused across runs for low-latency subagent startup

---

## Quick Start

### Installation

```
git clone https://github.com/panuthept/pi-agentic.git ~/.pi/agent/extensions/pi-agentic
```

### Basic Usage

The extension registers the `subagent` tool. Use it from any agent prompt or tool call.

**Single subagent:**
```
subagent({ agent: "scout", task: "Explore the codebase structure" })
```

**Parallel batch:**
```
subagent({
  tasks: [
    { agent: "researcher", task: "Research the problem domain" },
    { agent: "analyzer", task: "Analyze the existing code for issues" }
  ],
  concurrency: 4
})
```

**Background (fire-and-forget):**
```
subagent({
  agent: "worker",
  task: "Implement the login feature",
  background: true
})
```

> **Note:** Depth-gating is enforced automatically. Agents with `maxDepth: 0` (e.g. scout, reviewer, researcher) cannot spawn subagents of their own.

---

## Agent Roster

| Agent | Tools | `maxDepth` | Role |
|---|---|---|---|
| **orchestrator** | `subagent`, `todo`, `ask_user` | 2 | Task decomposition, delegation, synthesis |
| **planner** | _(all default)_ | 1 | Goal breakdown into actionable steps |
| **worker** | _(all default)_ | 1 | Code implementation from specs |
| **tester** | _(all default)_ | 1 | Test writing & execution |
| **specifier** | _(all default)_ | 1 | Requirements clarification, writes `SPEC.md` |
| **documenter** | _(all default)_ | 1 | READMEs, API docs, changelogs |
| **analyzer** | _(all default)_ | 1 | Code/data/log analysis, root cause |
| **hr** | _(all default)_ | 1 | Workforce analyst, creates new agent `.md` files |
| **scout** | `read`, `grep`, `find`, `ls`, `bash` | 0 | Fast codebase exploration |
| **reviewer** | `read`, `grep`, `find`, `ls`, `bash` | 0 | Code/doc quality review |
| **researcher** | `web_search`, `fetch_content` | 0 | Web search & content fetching |
| **supervisor** | `read`, `grep`, `find`, `ls` | 0 | Discussion, brainstorming, oversight |
| **git-assistant** | `bash`, `read`, `grep`, `find`, `ls` | 0 | Git workflow management |

All default-tool agents have access to `read`, `grep`, `find`, `ls`, `bash`, `web_search`, `fetch_content`, `todo`, `edit`, `write`, `code_search`, `ask_user`, and `subagent` (if depth allows).

---

## Commands

| Command | Description |
|---|---|
| `/agent <name>` | Switch the active main agent |
| `/subagent:bg` | List background jobs |
| `/subagent:bg-detach <id>` | Move a running subagent to background |
| `/subagent:bg-status <id>` | Show details of a background job |
| `/subagent:bg-cancel <id>` | Cancel a background job |
| `/timeline` or `/tl` | Toggle the execution timeline |

**Keyboard shortcut:** `Ctrl+Shift+B` — detach the current foreground subagent to the background.

---

## How It Works

When the `subagent` tool is called, the extension:

1. **Discovers** the target agent `.md` file from the bundled agents dir, `~/.pi/agent/agents/`, or `.pi/agents/`
2. **Parses** YAML frontmatter for system prompt, tool allowlist, and `maxDepth`
3. **Gates** the request — if the calling agent is at `maxDepth`, delegation is rejected
4. **Executes** the subagent in-process via `createAgentSession()` with pooled resource loaders
5. **Streams** progress (tool calls, text deltas) back to the calling agent in real time
6. **Returns** structured results (text output, tool call results) to the caller

For background jobs, the subagent runs asynchronously and the caller receives a handle to check status or cancel.

---

## Project Structure

```
├── index.ts                       # Extension entry point
├── runner.ts                      # In-process agent execution engine
├── agents.ts                      # Agent discovery (3 dirs)
├── schemas.ts                     # Typebox parameter schemas
├── render.ts                      # TUI rendering
├── format.ts                      # Formatting helpers
├── background-job-manager.ts      # Background job lifecycle
├── background-types.ts            # Background job types
├── loader-pool.ts                 # Pooled ResourceLoader cache
├── execution-timeline-widget.ts   # Gantt-style timeline widget
├── timeline.ts                    # Timeline data model
├── timeline-handler.ts            # /timeline command handler
├── types.ts                       # Shared TypeScript types
├── widget.ts                      # Legacy live status widget
└── agents/                        # 13 bundled agent .md files
```

All source files are plain TypeScript (ESM) with no build step — consumed directly by the Pi runtime.

---

## Adding Custom Agents

Drop a markdown file with YAML frontmatter into one of:

- `~/.pi/agent/agents/` — user-wide agents
- `.pi/agents/` — project-scoped agents

**Example** (`~/.pi/agent/agents/my-agent.md`):
```markdown
---
name: my-agent
description: Does a specific thing
tools: read, grep, bash
maxDepth: 1
---

You are an agent that does a specific thing. Be thorough.
```

The agent will be automatically discovered and available via the `subagent` tool.

---

## License

MIT © 2026 [Earendil Works](https://github.com/earendil-works)

See [LICENSE](./LICENSE) for details.
