/**
 * fast-subagent — In-process subagent delegation.
 *
 * Uses createAgentSession() to run subagents in the same process as pi —
 * no subprocess spawn, no cold-start overhead.
 *
 * Supports: single, parallel, background.
 * Agent .md files are compatible with pi-subagents frontmatter format.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionCommandContext, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Theme } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import { type AgentConfig, discoverAgents } from "./agents.js";
import { BackgroundJobManager } from "./background-job-manager.js";
import type { BackgroundHandleLike, BackgroundJobResult, BackgroundSubagentJob } from "./background-types.js";
import {
  formatBgJobDetails,
  formatBgJobSummary,
  formatDuration,
  formatTools,
  getFinalText,
  summarizeTask,
} from "./format.js";
import { defaultLoaderPool } from "./loader-pool.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import { mapConcurrent, runAgent } from "./runner.js";
import { SubagentParams } from "./schemas.js";
import type { AgentRowStatus, OnUpdate, RunResult, SubagentDetails, ToolCallEntry } from "./types.js";
import { pushWidgetUpdate, finalizeWidget, reinstallWidget } from "./widget.js";
import {
  recordStart as tlRecordStart,
  recordUpdate as tlRecordUpdate,
  recordEnd as tlRecordEnd,
  recordParallelStart as tlRecordParallelStart,
  recordParallelUpdate as tlRecordParallelUpdate,
  finalizeAllRunning as tlFinalizeAllRunning,
  clearTimelineHistory,
  setMaxVisible,
  getMaxVisible,
  setRollingWindow,
  reinstallTimelineWidget,
  setTimeMode,
  getTimeMode,
  toggleTimeMode,
  loadTimelineSettings,
} from "./execution-timeline-widget.js";
import { timelineHandler, getTimelineCompletions } from "./timeline-handler.js";

// ─── Module-level state ─────────────────────────────────────────────────────

let _bgManager: BackgroundJobManager | null = null;
let _onBgJobComplete: ((job: BackgroundSubagentJob) => void) | null = null;
let _setBgStatus: ((text: string | undefined) => void) | null = null;

function getBgManager(): BackgroundJobManager {
  if (!_bgManager) _bgManager = new BackgroundJobManager({
    onJobComplete: (job) => _onBgJobComplete?.(job),
  });
  return _bgManager;
}

function refreshBgStatus(): void {
  const running = getBgManager().getRunningJobs();
  _setBgStatus?.(running.length > 0 ? `⧗ ${running.length} bg agent${running.length > 1 ? "s" : ""}` : undefined);
}


// ─── Foreground detach registry ─────────────────────────────────────────────

interface ForegroundDetachEntry {
  agentName: string;
  task: string;
  detach: () => string;
}
const _fgJobs = new Map<string, ForegroundDetachEntry>();
// --- Agentic: main-agent state ---
const AGENT_STATE_FILE = join(homedir(), ".pi", "agent", "main-agent-state.json");
let _currentAgent;
let _agentCatalog;
let _baselineTools = [];
let _agentCtx;

function persistAgent() {
  if (!_currentAgent) return;
  try { writeFileSync(AGENT_STATE_FILE, JSON.stringify({ agent: _currentAgent }), "utf-8"); } catch {}
}

function restoreAgent() {
  try {
    if (existsSync(AGENT_STATE_FILE)) {
      const data = JSON.parse(readFileSync(AGENT_STATE_FILE, "utf-8"));
      if (data?.agent && typeof data.agent === "string") return data.agent;
    }
  } catch {}
  return undefined;
}

function loadAgentCatalog(dir) {
  if (!existsSync(dir)) return new Map();
  const catalog = new Map();
  const files = readdirSync(dir).filter(f => f.endsWith(".md"));
  for (const f of files) {
    try {
      const content = readFileSync(join(dir, f), "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);
      if (frontmatter.name && frontmatter.description) {
        catalog.set(frontmatter.name, {
          name: frontmatter.name,
          description: frontmatter.description,
          tools: frontmatter.tools,
          instructions: body,
        });
      }
    } catch {}
  }
  return catalog;
}

function applyAgent(name, pi) {
  _currentAgent = name;
  const def = _agentCatalog ? _agentCatalog.get(name) : undefined;
  const allTools = pi.getAllTools().map(t => t.name);
  const agentTools = def?.tools?.split(",").map(t => t.trim()).filter(Boolean);
  if (agentTools && agentTools.length > 0) {
    const available = new Set(allTools);
    pi.setActiveTools(agentTools.filter(t => available.has(t)));
  } else {
    pi.setActiveTools(allTools);
  }
  updateAgentWidget();
  updateAgentStatus();
}

function updateAgentWidget() {
  if (!_agentCtx || !_currentAgent || !_agentCatalog) return;
  const def = _agentCatalog.get(_currentAgent);
  const tools = def?.tools || "";
  const lines = [
    _agentCtx.ui.theme.fg("accent", _agentCtx.ui.theme.bold("  " + _currentAgent.toUpperCase() + "  ")) +
      (def?.description ? _agentCtx.ui.theme.fg("dim", " " + def.description) : ""),
  ];
  if (tools) lines.push(_agentCtx.ui.theme.fg("muted", "  Tools: " + tools));
  _agentCtx.ui.setWidget("agentic", lines);
}

function clearAgentWidget() { if (_agentCtx) _agentCtx.ui.setWidget("agentic", undefined); }

function updateAgentStatus() {
  if (!_agentCtx || !_currentAgent) return;
  _agentCtx.ui.setStatus("agent", _agentCtx.ui.theme.fg("accent", _currentAgent.toUpperCase()));
}

function injectAgentInstructions(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (!_currentAgent || !_agentCatalog) return payload;
  const def = _agentCatalog.get(_currentAgent);
  if (!def?.instructions) return payload;
  const injection = "\n\n[AGENT: " + _currentAgent.toUpperCase() + "]" + def.instructions;
  const obj = payload;
  if (typeof obj.system === "string") {
    obj.system += injection;
  } else if (Array.isArray(obj.system)) {
    obj.system.push({ type: "text", text: injection });
  } else if (Array.isArray(obj.messages)) {
    const sysMsg = obj.messages.find(m => m.role === "system");
    if (sysMsg) {
      if (typeof sysMsg.content === "string") sysMsg.content += injection;
      else if (Array.isArray(sysMsg.content)) sysMsg.content.push({ type: "text", text: injection });
    } else obj.messages.unshift({ role: "system", content: injection });
  }
  return obj;
}

/** Case-insensitive agent name lookup in the catalog. */
function findAgentInCatalog(name: string): string | undefined {
  if (!_agentCatalog) return undefined;
  if (_agentCatalog.has(name)) return name;
  const lower = name.toLowerCase();
  for (const key of _agentCatalog.keys()) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}


// ─── Extension entry point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Load persisted timeline settings
  loadTimelineSettings();

  pi.on("session_start", () => {
    loadTimelineSettings();
  });

  const BG_STATUS_KEY = "fast-subagent-bg";
  const FG_STATUS_KEY = "fast-subagent-fg";

_onBgJobComplete = (job) => {
    refreshBgStatus();
    const elapsed = job.completedAt ? ((job.completedAt - job.startedAt) / 1000).toFixed(1) : "?";
    const statusEmoji = job.status === "completed" ? "✓" : "✗";
    const taskPreview = job.task.length > 80 ? `${job.task.slice(0, 80)}…` : job.task;
    const output = job.status === "completed"
      ? (job.resultSummary ?? "(no output)")
      : `Error: ${job.error ?? "unknown"}`;
    const modelInfo = job.model ? ` · ${job.model}` : "";
    pi.sendUserMessage(
      [
        `**Background subagent ${statusEmoji}: ${job.id}** (${job.agentName}, ${elapsed}s${modelInfo})`,
        `> ${taskPreview}`,
        ``,
        output,
      ].join("\n"),
      { deliverAs: "followUp" },
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    _agentCtx = ctx;
    _baselineTools = pi.getAllTools().map(t => t.name);
    const agentDir = join(homedir(), ".pi", "agent", "agents");
    _agentCatalog = loadAgentCatalog(agentDir);
    const persisted = restoreAgent();
    if (persisted && _agentCatalog.has(persisted)) {
      applyAgent(persisted, pi);
    } else if (_agentCatalog.size > 0) {
      applyAgent(_agentCatalog.keys().next().value, pi);
    }
    _setBgStatus = (text) => ctx.ui.setStatus(BG_STATUS_KEY, text);

    // Warm one extension-capable loader after startup so first `tools: all`
    // subagent call reuses loaded extensions instead of blocking.
    if (process.env.PI_FAST_SUBAGENT_WARM !== "0") {
      const warmCwd = ctx.cwd;
      const warmAgentDir = getAgentDir();
      setTimeout(() => defaultLoaderPool.warm(warmCwd, warmAgentDir, false), 1000);
    }

    // Register the subagent bar widget below the editor
    reinstallWidget(ctx);

    // Register the execution timeline widget below the editor
    reinstallTimelineWidget(ctx);
  });

  pi.on("tool_call", async (event) => {
    if (!_currentAgent || !_agentCatalog) return;
    const def = _agentCatalog.get(_currentAgent);
    const tools = def?.tools?.split(",").map(t => t.trim()).filter(Boolean);
    if (tools && tools.length > 0 && !tools.includes(event.toolName)) {
      return { block: true, reason: "Agent '" + _currentAgent + "' blocks tool: " + event.toolName + ". Allowed: " + tools.join(", ") };
    }
  });

  pi.on("before_provider_request", async (event) => {
    injectAgentInstructions(event.payload);
  });

  pi.on("turn_end", async () => {
    persistAgent();
  });



  pi.on("session_shutdown", async () => {
    clearAgentWidget();
    getBgManager().shutdown();
    _bgManager = null;
    _setBgStatus = null;
    defaultLoaderPool.clear();
  });

  // ─── Ctrl+Shift+B — detach foreground subagent ────────────────────────────
  pi.registerShortcut(Key.ctrlShift("b"), {
    description: "Move foreground subagent to background",
    handler: async (ctx) => {
      const entry = [..._fgJobs.values()][0];
      if (!entry) {
        ctx.ui.notify("No foreground subagent running.", "info");
        return;
      }
      try {
        const bgJobId = entry.detach();
        ctx.ui.notify(
          `Moved ${entry.agentName} to background as ${bgJobId}. Completion will be announced automatically.`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  // ─── /agent (main-agent selection) ─────────────────────────────────────────
  pi.registerCommand("agent", {
    description: "Switch main agent (defined in ~/.pi/agent/agents/)",
    handler: async (args, ui) => {
      if (!_agentCatalog || _agentCatalog.size === 0) {
        ui.ui.notify("No agents found. Check ~/.pi/agent/agents/", "error");
        return;
      }
      const input = args?.trim().toLowerCase();
      if (input === "reload") {
        _agentCatalog = loadAgentCatalog(join(homedir(), ".pi", "agent", "agents"));
        if (_currentAgent && _agentCatalog.has(_currentAgent)) {
          applyAgent(_currentAgent, pi);
        } else if (_agentCatalog.size > 0) {
          applyAgent(_agentCatalog.keys().next().value, pi);
        }
        ui.ui.notify("Agents reloaded", "info");
        return;
      }
      if (input && _agentCatalog.has(input)) {
        applyAgent(input, pi);
        persistAgent();
        ui.ui.notify("Agent: " + input.toUpperCase(), "info");
        return;
      }
      if (input) {
        ui.ui.notify("Unknown agent: " + input, "error");
        return;
      }
      const agents = [..._agentCatalog.keys()];
      const items = agents.map(a => {
        const def = _agentCatalog.get(a);
        return def?.description ? a.toUpperCase() + " — " + def.description : a.toUpperCase();
      });
      const choice = await ui.ui.select("Select agent:", items);
      if (!choice) return;
      const picked = choice.split(" — ")[0];
      const matchedKey = findAgentInCatalog(picked);
      if (matchedKey) {
        applyAgent(matchedKey, pi);
        persistAgent();
        ui.ui.notify("Agent: " + matchedKey.toUpperCase(), "info");
      } else {
        ui.ui.notify("Could not find agent: " + picked, "error");
      }
    },
  });


  // ─── /subagent:bg ────────────────────────────────────────────────────────
  pi.registerCommand("subagent:bg", {
    description: "Move a running foreground subagent to background. Shortcut: Ctrl+Shift+B. Usage: /subagent:bg [fg-job-id] — omit ID to list active foreground jobs.",
    getArgumentCompletions(_prefix: string) {
      return [..._fgJobs.keys()].map((id) => ({ value: id, label: id }));
    },
    async handler(args: string, ctx) {
      const id = args.trim();
      if (!id) {
        if (_fgJobs.size === 0) {
          ctx.ui.notify("No active foreground subagent jobs.", "info");
          return;
        }
        const lines = ["Active foreground jobs (use /subagent:bg <id> to detach):"];
        for (const [fgId, entry] of _fgJobs) {
          lines.push(`  ${fgId}  ${entry.agentName}: ${summarizeTask(entry.task)}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      const entry = _fgJobs.get(id);
      if (!entry) {
        ctx.ui.notify(`Foreground job "${id}" not found (already done or invalid).`, "warning");
        return;
      }
      const bgJobId = entry.detach();
      ctx.ui.notify(`Moved to background: ${bgJobId}\nTo check status, ask me to poll job ${bgJobId}.`, "info");
    },
  });

  // ─── /subagent:bg-status ─────────────────────────────────────────────────
  pi.registerCommand("subagent:bg-status", {
    description: "Show active background subagents. Usage: /subagent:bg-status [sa-job-id] — omit ID to open selector.",
    getArgumentCompletions(prefix: string) {
      return getBgManager().getAllJobs()
        .filter((job) => job.id.startsWith(prefix))
        .map((job) => ({ value: job.id, label: formatBgJobSummary(job) }));
    },
    async handler(args: string, ctx) {
      const id = args.trim();
      if (id) {
        const job = getBgManager().getJob(id);
        if (!job) {
          ctx.ui.notify(`Background job "${id}" not found.`, "warning");
          return;
        }
        ctx.ui.notify(formatBgJobDetails(job), "info");
        return;
      }

      const jobs = getBgManager().getRunningJobs().sort((a, b) => b.startedAt - a.startedAt);
      if (jobs.length === 0) {
        ctx.ui.notify("No active background subagent jobs.", "info");
        return;
      }

      const options = jobs.map((job) => formatBgJobSummary(job));
      const selected = await ctx.ui.select("Active background subagents", options);
      if (!selected) return;

      const jobId = selected.split(" ")[0] ?? "";
      const job = getBgManager().getJob(jobId);
      if (!job) {
        ctx.ui.notify(`Background job "${jobId}" not found.`, "warning");
        return;
      }
      ctx.ui.notify(formatBgJobDetails(job), "info");
    },
  });

  // ─── /subagent:bg-cancel ───────────────────────────────────────────────
  pi.registerCommand("subagent:bg-cancel", {
    description: "Cancel running background subagent. Usage: /subagent:bg-cancel [sa-job-id] — omit ID to choose with arrow keys.",
    getArgumentCompletions(prefix: string) {
      return getBgManager().getRunningJobs()
        .filter((job) => job.id.startsWith(prefix))
        .map((job) => ({ value: job.id, label: formatBgJobSummary(job) }));
    },
    async handler(args: string, ctx) {
      let jobId = args.trim();

      if (!jobId) {
        const jobs = getBgManager().getRunningJobs().sort((a, b) => b.startedAt - a.startedAt);
        if (jobs.length === 0) {
          ctx.ui.notify("No running background subagent jobs to cancel.", "info");
          return;
        }

        const options = jobs.map((job) => formatBgJobSummary(job));
        const selected = await ctx.ui.select("Cancel background subagent", options);
        if (!selected) return;
        jobId = selected.split(" ")[0] ?? "";
      }

      const job = getBgManager().getJob(jobId);
      if (!job) {
        ctx.ui.notify(`Background job "${jobId}" not found.`, "warning");
        return;
      }
      if (job.status !== "running") {
        ctx.ui.notify(`Background job "${jobId}" already ${job.status}.`, "info");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Cancel background subagent?",
        `${formatBgJobSummary(job)}\n\nTask:\n${job.task}`,
      );
      if (!confirmed) return;

      const result = getBgManager().cancel(jobId);
      const msg = result === "cancelled" ? `Background job "${jobId}" cancelled.`
        : result === "already_done" ? `Background job "${jobId}" already completed.`
        : `Background job "${jobId}" not found.`;
      ctx.ui.notify(msg, result === "cancelled" ? "info" : "warning");
    },
  });

  // ─── `/timeline` command (handler + completions in timeline-handler.ts) ───
  pi.registerCommand("timeline", {
    description: "Toggle execution timeline widget. See /timeline help for subcommands.",
    getArgumentCompletions: (prefix: string) => getTimelineCompletions(prefix),
    handler: timelineHandler,
  });

  pi.registerCommand("tl", {
    description: "Short alias for /timeline. See /timeline help for subcommands.",
    getArgumentCompletions: (prefix: string) => getTimelineCompletions(prefix),
    handler: timelineHandler,
  });

  // ─── `subagent` tool ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents. Runs IN-PROCESS — no subprocess cold-start overhead.",
      "Modes: single ({ agent, task }), parallel ({ tasks: [...] }).",
      "Agents defined as .md files in ~/.pi/agent/agents/ (user) or .pi/agents/ (project).",
      "Use { action: 'list' } to discover available agents.",
    ].join(" "),
    parameters: SubagentParams,

    renderCall(args, theme, context) {
      return renderSubagentCall(args, theme, context);
    },

    renderResult(result: AgentToolResult<unknown>, opts: ToolRenderResultOptions, theme: Theme) {
      return renderSubagentResult(result, opts, theme);
    },

    async execute(_id: string, params: Record<string, any>, signal: AbortSignal | undefined, onUpdate, ctx: ExtensionContext): Promise<any> {
      const cwd = params.cwd ?? ctx.cwd;
      const agents = discoverAgents(cwd);

      const findAgent = (name: string): { agent?: AgentConfig; error?: string } => {
        const found = agents.find((a) => a.name === name);
        if (!found) {
          const list = agents.map((a) => `"${a.name}"`).join(", ") || "none";
          return { error: `Unknown agent: "${name}". Available: ${list}` };
        }
        return { agent: found };
      };

      // ── Management: list ────────────────────────────────────────────────
      if (params.action === "list" || (!params.action && !params.agent && !params.tasks)) {
        if (agents.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No agents found. Add .md files to ~/.pi/agent/agents/ or .pi/agents/.",
            }],
          };
        }
        const lines = agents.map(
          (a) => `${a.name} [${a.source}]${a.model ? ` · ${a.model}` : ""}: ${a.description}`,
        );
        return { content: [{ type: "text", text: `Agents (${agents.length}):\n${lines.join("\n")}` }] };
      }

      // ── Management: get ─────────────────────────────────────────────────
      if (params.action === "get" && params.agent) {
        const { agent, error } = findAgent(params.agent);
        if (error || !agent) return { content: [{ type: "text", text: error ?? "Not found" }] };
        const info = [
          `## ${agent.name} [${agent.source}]`,
          `**Description:** ${agent.description}`,
          agent.model ? `**Model:** ${agent.model}` : null,
          `**Tools:** ${formatTools(agent.tools)}`,
          `**Max subagent depth:** ${agent.maxDepth}`,
          agent.systemPrompt ? `\n**System prompt:**\n${agent.systemPrompt}` : null,
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text: info }] };
      }

      // ── Background status ───────────────────────────────────────────────
      if (params.action === "status") {
        const jobs = getBgManager().getAllJobs();
        if (jobs.length === 0) return { content: [{ type: "text", text: "No background jobs." }] };
        const lines = jobs.map((j) => {
          const dur = j.completedAt ? formatDuration(j.completedAt - j.startedAt) : formatDuration(Date.now() - j.startedAt);
          return `${j.id} [${j.status}] ${j.agentName} · ${dur} · ${j.task.length > 50 ? j.task.slice(0, 47) + "..." : j.task}`;
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ── Background poll ─────────────────────────────────────────────────
      if (params.action === "poll") {
        if (!params.jobId) return { content: [{ type: "text", text: "Provide jobId to poll." }] };
        const job = getBgManager().getJob(params.jobId);
        if (!job) return { content: [{ type: "text", text: `Job ${params.jobId} not found (completed and evicted, or invalid).` }] };
        const dur = job.completedAt ? formatDuration(job.completedAt - job.startedAt) : formatDuration(Date.now() - job.startedAt);
        const parts = [`${job.id} [${job.status}] ${job.agentName} · ${dur}`, `Task: ${job.task}`];
        if (job.status === "completed") parts.push(`\nResult:\n${job.resultSummary ?? "(no output)"}`);
        if (job.status === "failed") parts.push(`\nError: ${job.error ?? "(unknown)"}`);
        if (job.status === "running") parts.push("Still running — poll again later.");
        return { content: [{ type: "text", text: parts.join("\n") }] };
      }

      // ── Background cancel ───────────────────────────────────────────────
      if (params.action === "cancel") {
        if (!params.jobId) return { content: [{ type: "text", text: "Provide jobId to cancel." }] };
        const result = getBgManager().cancel(params.jobId);
        const msg = result === "cancelled" ? `Job ${params.jobId} cancelled.`
          : result === "already_done" ? `Job ${params.jobId} already completed.`
          : `Job ${params.jobId} not found.`;
        return { content: [{ type: "text", text: msg }] };
      }

      // ── Foreground → background detach ──────────────────────────────────
      if (params.action === "detach") {
        if (!params.jobId) return { content: [{ type: "text", text: "Provide jobId (fg_xxxxx) to detach." }] };
        const fgEntry = _fgJobs.get(params.jobId);
        if (!fgEntry) return { content: [{ type: "text", text: `Foreground job "${params.jobId}" not found (already completed or invalid).` }] };
        const bgJobId = fgEntry.detach();
        return { content: [{ type: "text", text: `Moved to background: ${bgJobId}\nTo check status, ask me to poll job ${bgJobId}.` }] };
      }

      // ── Single mode ─────────────────────────────────────────────────────
      if (params.agent && params.task) {
        const { agent, error } = findAgent(params.agent);
        if (error || !agent) return { content: [{ type: "text", text: error ?? "Not found" }] };

        const effectiveModel = params.model;

        if (params.background) {
          const bgAbort = new AbortController();
          const handle: BackgroundHandleLike = { abort: () => bgAbort.abort() };
          const resultPromise: Promise<BackgroundJobResult> = runAgent(
            agent, params.task, cwd, effectiveModel, bgAbort.signal, undefined,
          ).then((r) => ({ summary: r.output, exitCode: r.exitCode, error: r.error, model: r.model }));
          const jobId = getBgManager().adoptHandle(agent.name, params.task, cwd, handle, resultPromise);
          return { content: [{ type: "text", text: `Background job started: ${jobId}\nTo check status, ask me to poll job ${jobId}.` }] };
        }

        const fgId = `fg_${randomUUID().slice(0, 8)}`;
        const tlEntryId = tlRecordStart(agent.name, params.task ?? "", "single");
        const agentAbort = new AbortController();
        const forwardAbort = () => agentAbort.abort();
        signal?.addEventListener("abort", forwardAbort, { once: true });

        let detachResolveFn: ((bgJobId: string) => void) | null = null;
        const detachPromise = new Promise<string>((resolve) => { detachResolveFn = resolve; });

        let forwardUpdates = true;
        const wrappedOnUpdate: OnUpdate | undefined = onUpdate
          ? (partial) => {
              if (forwardUpdates) (onUpdate as unknown as OnUpdate)(partial);
              // Always push to widget regardless of forwardUpdates
              if (partial.details) {
                const d = partial.details as SubagentDetails;
                pushWidgetUpdate(d);
                reinstallWidget(ctx);
                // Update timeline entry
                tlRecordUpdate(tlEntryId, {
                  toolCount: d.toolCalls?.length ?? 0,
                  duration: d.elapsedMs,
                  usage: d.usage,
                });
                reinstallTimelineWidget(ctx);
              }
            }
          : undefined;

        const agentRunPromise: Promise<RunResult> = runAgent(
          agent, params.task, cwd, effectiveModel, agentAbort.signal, wrappedOnUpdate,
        );

        const bgResultPromise: Promise<BackgroundJobResult> = agentRunPromise
          .then((r) => ({ summary: r.output, exitCode: r.exitCode, error: r.error, model: r.model }));

        _fgJobs.set(fgId, {
          agentName: agent.name,
          task: params.task,
          detach: () => {
            forwardUpdates = false;
            signal?.removeEventListener("abort", forwardAbort);
            const bgHandle: BackgroundHandleLike = { abort: () => agentAbort.abort() };
            const bgJobId = getBgManager().adoptHandle(agent.name, params.task, cwd, bgHandle, bgResultPromise);
            refreshBgStatus();
            detachResolveFn?.(bgJobId);
            return bgJobId;
          },
        });

        ctx.ui.setStatus(FG_STATUS_KEY, `${agent.name} running · Ctrl+Shift+B to move to background`);

        let runResult: RunResult | null = null;
        const outcome = await Promise.race([
          agentRunPromise.then((r) => { runResult = r; return "done" as const; }),
          detachPromise.then(() => "detached" as const),
        ]).finally(() => {
          _fgJobs.delete(fgId);
          signal?.removeEventListener("abort", forwardAbort);
          ctx.ui.setStatus(FG_STATUS_KEY, undefined);
          finalizeWidget();
          reinstallWidget(ctx);
          // Finalize timeline entry
          const tlStatus = runResult && runResult.exitCode !== 0 ? "error" as const : "success" as const;
          tlRecordEnd(tlEntryId, tlStatus);
          reinstallTimelineWidget(ctx);
        });

        if (outcome === "detached") {
          const bgJobId = await detachPromise;
          return {
            content: [{ type: "text", text: `Moved to background: ${bgJobId}. Completion will be announced automatically.` }],
            details: {
              agentName: params.agent,
              task: params.task,
              usage: { input: 0, output: 0, cost: 0, turns: 0 },
              running: false,
              backgroundJobId: bgJobId,
              toolCalls: [],
            } satisfies SubagentDetails,
          };
        }

        const result = runResult!;
        return {
          content: [{ type: "text", text: getFinalText(result) }],
          details: {
            agentName: params.agent,
            task: params.task,
            usage: result.usage,
            running: false,
            elapsedMs: undefined,
            model: result.model,
            toolCalls: result.toolCalls,
            executionEvents: result.executionEvents,
          } satisfies SubagentDetails,
          isError: result.exitCode !== 0,
        };
      }

      // ── Parallel mode ───────────────────────────────────────────────────
      if (params.tasks && params.tasks.length > 0) {
        const expanded: Array<{ agent: string; task: string; model?: string; cwd?: string }> = [];
        for (const t of params.tasks) {
          const n = t.count ?? 1;
          for (let i = 0; i < n; i++) expanded.push({ agent: t.agent, task: t.task, model: t.model, cwd: t.cwd });
        }

        const concurrency = params.concurrency ?? 4;
        const emptyUsage = { input: 0, output: 0, cost: 0, turns: 0 };
        const parallelStartTime = Date.now();

        let runningUsage = { ...emptyUsage };
        const parallelAgents: AgentRowStatus[] = expanded.map((t) => ({
          name: t.agent,
          taskSummary: t.task,
          status: "pending" as const,
          batchStartTime: parallelStartTime,
        }));

        const emitParallel = (running: boolean) => {
          const details: SubagentDetails = {
            mode: "parallel",
            parallelAgents: [...parallelAgents],
            usage: { ...runningUsage },
            running,
            elapsedMs: Date.now() - parallelStartTime,
            toolCalls: [],
          };
          (onUpdate as unknown as OnUpdate | undefined)?.({
            content: [{ type: "text", text: "" }],
            details,
          });
          pushWidgetUpdate(details);
          reinstallWidget(ctx);
          tlRecordParallelUpdate(details);
          reinstallTimelineWidget(ctx);
        };

        emitParallel(true);
        const tlParallelIds = tlRecordParallelStart(expanded);

        const allResults = await mapConcurrent(expanded, concurrency, async (t, i) => {
          parallelAgents[i]!.status = "running";
          parallelAgents[i]!.startOffsetMs = Date.now() - parallelStartTime;
          emitParallel(true);
          const { agent, error } = findAgent(t.agent);
          if (error || !agent) {
            parallelAgents[i]!.status = "error";
            emitParallel(true);
            if (tlParallelIds[i]) tlRecordEnd(tlParallelIds[i], "error");
            return { agentName: t.agent, output: "", exitCode: 1, error, model: undefined, toolCalls: [] as ToolCallEntry[], usage: emptyUsage };
          }
          const agentStart = Date.now();
          const agentOnUpdate: OnUpdate = (partial) => {
            const d = partial.details as SubagentDetails | undefined;
            parallelAgents[i]!.toolCalls = d?.toolCalls ? [...d.toolCalls] : parallelAgents[i]!.toolCalls;
            parallelAgents[i]!.responseText = (partial.content?.[0] as any)?.text || parallelAgents[i]!.responseText;
            if (d?.usage) {
              parallelAgents[i]!.usage = { ...d.usage };
            }
            emitParallel(true);
          };
          const result = await runAgent(
            agent,
            t.task,
            t.cwd ?? cwd,
            t.model,
            signal,
            agentOnUpdate,
          );
          parallelAgents[i]!.status = result.exitCode === 0 ? "done" : "error";
          parallelAgents[i]!.durMs = Date.now() - agentStart;
          parallelAgents[i]!.usage = result.usage;
          parallelAgents[i]!.toolCalls = result.toolCalls;
          parallelAgents[i]!.responseText = result.output;
          runningUsage = { input: runningUsage.input + result.usage.input, output: runningUsage.output + result.usage.output, cost: runningUsage.cost + result.usage.cost, turns: runningUsage.turns + result.usage.turns };
          if (tlParallelIds[i]) {
            tlRecordUpdate(tlParallelIds[i], {
              toolCount: result.toolCalls?.length ?? 0,
              duration: parallelAgents[i]!.durMs,
              usage: result.usage,
            });
            tlRecordEnd(tlParallelIds[i], result.exitCode === 0 ? "success" : "error", parallelAgents[i]!.durMs);
          }
          emitParallel(true);
          return { ...result, agentName: t.agent, toolCalls: result.toolCalls ?? [] };
        });

        const totalUsage = allResults.reduce(
          (acc, r) => ({ input: acc.input + r.usage.input, output: acc.output + r.usage.output, cost: acc.cost + r.usage.cost, turns: acc.turns + r.usage.turns }),
          emptyUsage,
        );
        const outputs = allResults.map((r) => `[${r.agentName}] ${r.exitCode === 0 ? "✓" : "✗"}\n${getFinalText(r)}`).join("\n\n");

        finalizeWidget();
        reinstallWidget(ctx);
        // Finalize any lingering timeline entries
        tlFinalizeAllRunning();
        reinstallTimelineWidget(ctx);
        return {
          content: [{ type: "text", text: outputs }],
          details: { mode: "parallel", parallelAgents, usage: totalUsage, running: false, toolCalls: [] } satisfies SubagentDetails,
        };
      }

      return { content: [{ type: "text", text: "Provide agent+task or tasks array." }] };
    },
  });
}
