/**
 * Render function for the `subagent` tool's result panel.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir, Theme, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

import { formatDuration, formatUsage } from "./format.js";
import type { ExecutionEvent, SubagentDetails } from "./types.js";

const DEFAULT_PREVIEW_LINES = 12;
const DEFAULT_PROMPT_PREVIEW_LINES = 12;

let _settingsCache: { previewLines: number; promptPreviewLines: number; readAt: number } | null = null;
const SETTINGS_TTL_MS = 2000;

function readPreviewSettings(): { previewLines: number; promptPreviewLines: number } {
  const now = Date.now();
  if (_settingsCache && now - _settingsCache.readAt < SETTINGS_TTL_MS) return _settingsCache;
  let previewLines = DEFAULT_PREVIEW_LINES;
  let promptPreviewLines = DEFAULT_PROMPT_PREVIEW_LINES;
  try {
    const path = join(getAgentDir(), "settings.json");
    if (existsSync(path)) {
      const settings = JSON.parse(readFileSync(path, "utf-8")) as {
        fastSubagent?: { previewLines?: number; promptPreviewLines?: number };
      };
      const fs = settings.fastSubagent;
      if (fs && typeof fs.previewLines === "number" && fs.previewLines > 0) {
        previewLines = Math.floor(fs.previewLines);
      }
      if (fs && typeof fs.promptPreviewLines === "number" && fs.promptPreviewLines > 0) {
        promptPreviewLines = Math.floor(fs.promptPreviewLines);
      }
    }
  } catch {
    // fall through to defaults
  }
  _settingsCache = { previewLines, promptPreviewLines, readAt: now };
  return _settingsCache;
}

interface SubagentCallArgs {
  agent?: unknown;
  task?: unknown;
  tasks?: unknown;
  action?: unknown;
  background?: unknown;
}

interface SubagentRenderCallContext {
  state: Record<string, unknown>;
  executionStarted: boolean;
  argsComplete: boolean;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function taskPreviewLines(task: string, width: number, maxLines: number): { lines: string[]; skipped: number } {
  const innerWidth = Math.max(1, width - 2);
  const visual: string[] = [];
  for (const raw of task.split("\n")) {
    try {
      for (const w of wrapTextWithAnsi(raw, innerWidth)) visual.push(w);
    } catch {
      visual.push(truncateToWidth(raw, innerWidth, "..."));
    }
  }
  const lines = visual.slice(0, maxLines).map((line) => truncateToWidth(`  ${line}`, width, "..."));
  return { lines, skipped: Math.max(0, visual.length - lines.length) };
}

/**
 * Render tool-call args while provider is still streaming them. This makes long
 * subagent prompt generation visible before execute() can start.
 */
export function renderSubagentCall(
  args: SubagentCallArgs,
  theme: Theme,
  context: SubagentRenderCallContext,
): Component {
  const cache = context.state as {
    callWidth?: number;
    callLines?: string[];
    callKey?: string;
  };

  return {
    invalidate() {
      cache.callWidth = undefined;
      cache.callLines = undefined;
      cache.callKey = undefined;
    },
    render(width: number): string[] {
      let key: string;
      try {
        key = JSON.stringify({ args, executionStarted: context.executionStarted, argsComplete: context.argsComplete, width });
      } catch {
        // args may contain non-serializable values (circular refs, BigInt, etc.)
        // Fall back to a simple key based on what we can safely extract
        key = `w${width}_e${context.executionStarted}_c${context.argsComplete}_a${typeof args}`;
      }
      if (cache.callWidth === width && cache.callKey === key && cache.callLines) return cache.callLines;

      const out: string[] = [];
      const agent = asString(args.agent);
      const action = asString(args.action);
      const task = asString(args.task);
      const tasks = Array.isArray(args.tasks) ? args.tasks as Array<Record<string, unknown>> : undefined;
      const isParallel = !!tasks?.length;
      const status = context.executionStarted
        ? "running"
        : context.argsComplete
          ? "starting"
          : task || isParallel
            ? "writing prompt"
            : "waiting for prompt";
      const mode = isParallel ? `Parallel (${tasks!.length})` : "Subagent";
      const bg = args.background === true ? " · background" : "";
      const target = agent ? ` ${agent}` : action ? ` ${action}` : "";
      out.push(truncateToWidth(`${theme.fg("toolTitle", mode)}${target}${bg} · ${theme.fg("dim", status)}`, width, "..."));

      // Once execution starts, result renderer owns prompt display. Keep call row compact.
      if (context.executionStarted) {
        cache.callWidth = width;
        cache.callKey = key;
        cache.callLines = out;
        return out;
      }

      const maxLines = readPreviewSettings().promptPreviewLines;
      if (task) {
        out.push(truncateToWidth("Prompt:", width, "..."));
        const preview = taskPreviewLines(task, width, maxLines);
        out.push(...preview.lines);
        if (preview.skipped > 0) out.push(truncateToWidth(theme.fg("muted", `  … (${preview.skipped} more lines)`), width, "..."));
      } else if (tasks?.length) {
        const maxRows = Math.max(1, Math.min(maxLines, tasks.length));
        for (let i = 0; i < maxRows; i++) {
          const t = tasks[i]!;
          const rowAgent = asString(t.agent) ?? "?";
          const rowTask = asString(t.task) ?? "";
          out.push(truncateToWidth(`  [${rowAgent}] ${rowTask || theme.fg("dim", "writing prompt...")}`, width, "..."));
        }
        if (tasks.length > maxRows) out.push(truncateToWidth(theme.fg("muted", `  … (${tasks.length - maxRows} more task${tasks.length - maxRows === 1 ? "" : "s"})`), width, "..."));
      } else if (action) {
        out.push(truncateToWidth(theme.fg("dim", `  action: ${action}`), width, "..."));
      } else {
        out.push(truncateToWidth(theme.fg("dim", "  waiting for streamed tool arguments..."), width, "..."));
      }

      cache.callWidth = width;
      cache.callKey = key;
      cache.callLines = out;
      return out;
    },
  };
}

export function renderSubagentResult(
  result: AgentToolResult<unknown>,
  { isPartial, expanded }: ToolRenderResultOptions,
  theme: Theme,
) {
  const agentText = result.content?.[0]?.type === "text" ? (result.content[0] as any).text as string : "";
  const details = (result.details ?? {}) as SubagentDetails;
  const toolCalls = details.toolCalls ?? [];

  // ── Parallel mode render ──────────────────────────────────────
  if (details.mode === "parallel" && details.parallelAgents) {
    const agents = details.parallelAgents;
    const doneCount = agents.filter((a) => a.status === "done" || a.status === "error").length;



    const cache: { width?: number } = {};
    return {
      invalidate() { cache.width = undefined; },
      render(width: number): string[] {
        const out: string[] = [];

        // ── Process Tree header ──
        const elapsedStr = details.elapsedMs != null
          ? (details.elapsedMs < 1000 ? `${details.elapsedMs}ms` : `${(details.elapsedMs / 1000).toFixed(1)}s`)
          : "";
        const header = `Parallel Task ── ${doneCount}/${agents.length} done${elapsedStr ? ` ── ${elapsedStr}` : ""}`;
        out.push(truncateToWidth(header, width, "..."));

        for (const [i, a] of agents.entries()) {
          const dur = a.durMs != null ? (a.durMs < 1000 ? ` ${a.durMs}ms` : ` ${(a.durMs / 1000).toFixed(1)}s`) : "";
          const toolCount = a.toolCalls?.length ?? 0;
          const toolStr = toolCount > 0 ? theme.fg("dim", ` (${toolCount} tool${toolCount > 1 ? "s" : ""})`) : "";
          const mark = a.status === "pending" ? theme.fg("dim", "⋅")
            : a.status === "running" ? theme.fg("dim", `→${toolStr}`)
            : a.status === "done" ? `✓${dur}${toolStr}` : `✗${dur}${toolStr}`;

          // ── Process Tree: agent branch ──
          const isLastAgent = i === agents.length - 1;
          const agentConn = isLastAgent ? "└── " : "├── ";
          const agentPref = isLastAgent ? "    " : "│   ";

          out.push(truncateToWidth(agentConn + theme.fg("accent", a.name) + " " + mark, width, "..."));

          // Show the task/prompt (input prompt) instead of tool calls and response text
          if (a.taskSummary) {
            const preview = truncateToVisualLines(a.taskSummary, 3, width - agentPref.length - 2);
            for (const l of preview.visualLines) {
              out.push(truncateToWidth(agentPref + theme.fg("dim", "  " + l), width, "..."));
            }
            if (preview.skippedCount > 0) {
              out.push(truncateToWidth(theme.fg("dim", agentPref + `  … ${preview.skippedCount} more lines`), width, "..."));
            }
          } else if (a.status === "running") {
            out.push(truncateToWidth(theme.fg("dim", agentPref + "  running..."), width, "..."));
          }
        }

        // After the agent loop
        const status = details.running
          ? ["running", details.usage?.turns ? `${details.usage.turns} turn${details.usage.turns > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ")
          : formatUsage(details.usage ?? { input: 0, output: 0, cost: 0, turns: 0 }, details.model);

        out.push("");
        out.push(truncateToWidth(status, width, "..."));



        return out;
      },
    };
  }

  // ── Single mode render ────────────────────────────────────────

  function statusLine(): string {
    if (details.backgroundJobId) return `moved to background · ${details.backgroundJobId}`;
    if (details.running) {
      const parts: string[] = ["running"];
      if (details.usage?.turns) parts.push(`${details.usage.turns} turn${details.usage.turns > 1 ? "s" : ""}`);
      if (details.elapsedMs != null) parts.push(formatDuration(details.elapsedMs));
      if (details.model) parts.push(details.model);
      return parts.join(" · ");
    }
    return formatUsage(details.usage ?? { input: 0, output: 0, cost: 0, turns: 0 }, details.model);
  }

  const cache: {
    width?: number;
    promptLines?: string[];
    promptSkipped?: number;
    responseLines?: string[];
    skipped?: number;
    expandedWidth?: number;
    expandedEventsLen?: number;
    expandedLastEventTs?: number;
    expandedTask?: string;
    expandedAgentName?: string;
    expandedToolCallsLen?: number;
    expandedAgentTextLen?: number;
    expandedBodyLines?: string[];
    expandedFooterKey?: string;
    expandedOutputLines?: string[];
  } = {};

  function renderExpandedTree(width: number): string[] {
    const out: string[] = [];


    // Build agent mark like parallel mode: → (N tools) while running, ✓ 5.2s (N tools) when done
    const agentLabel = theme.fg("accent", details.agentName ?? "Subagent");
    const toolCount = toolCalls.length;
    const toolStr = toolCount > 0 ? theme.fg("dim", ` (${toolCount} tool${toolCount > 1 ? "s" : ""})`) : "";
    let mark: string;
    if (details.running) {
      mark = theme.fg("dim", `→${toolStr}`);
    } else if (details.backgroundJobId) {
      mark = `moved to background · ${details.backgroundJobId}`;
    } else {
      const dur = details.elapsedMs != null
        ? (details.elapsedMs < 1000 ? ` ${details.elapsedMs}ms` : ` ${(details.elapsedMs / 1000).toFixed(1)}s`)
        : "";
      mark = `✓${dur}${toolStr}`;
    }

    // Agent branch line (using └── like parallel mode)
    out.push(truncateToWidth(`└── ${agentLabel} ${mark}`, width, "..."));

    // Task/prompt as child (no "Prompt:" label, 6-space indent like parallel mode)
    if (details.task) {
      const preview = truncateToVisualLines(details.task, 3, width - 6);
      for (const l of preview.visualLines) {
        out.push(truncateToWidth(`      ${theme.fg("dim", l)}`, width, "..."));
      }
      if (preview.skippedCount > 0) {
        out.push(truncateToWidth(theme.fg("dim", `      … ${preview.skippedCount} more lines`), width, "..."));
      }
    }

    return out;
  }

  return {
    invalidate() {
      cache.width = undefined;
      cache.expandedWidth = undefined;
      cache.expandedEventsLen = undefined;
      cache.expandedLastEventTs = undefined;
      cache.expandedTask = undefined;
      cache.expandedAgentName = undefined;
      cache.expandedToolCallsLen = undefined;
      cache.expandedAgentTextLen = undefined;
      cache.expandedBodyLines = undefined;
      cache.expandedFooterKey = undefined;
      cache.expandedOutputLines = undefined;
    },
    render(width: number): string[] {
      const out: string[] = [];

      // For management actions (list, get, status, etc.) with no agent context,
      // just show the raw text content without tree structure or usage footer.
      if (!details.agentName && !details.task) {
        const text = agentText || "(no output)";
        const preview = truncateToVisualLines(text, 12, width - 2);
        for (const l of preview.visualLines) {
          out.push(truncateToWidth(l, width, "..."));
        }
        if (preview.skippedCount > 0) {
          out.push(truncateToWidth(theme.fg("dim", `… ${preview.skippedCount} more lines`), width, "..."));
        }
        return out;
      }

      const bodyLines = renderExpandedTree(width);
      out.push(...bodyLines);

      const status = statusLine();
      const bgHint = details.running && !details.backgroundJobId
        ? truncateToWidth(theme.fg("dim", "Ctrl+Shift+B: move to background"), width, "...")
        : "";
      if (status) out.push(truncateToWidth(status, width, "..."));
      if (bgHint) out.push(bgHint);

      return out;
    },
  };
}
