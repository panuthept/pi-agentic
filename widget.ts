/**
 * Persistent widget showing live subagent execution status.
 * Renders a compact bar below the editor while subagents are running.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SubagentDetails, AgentRowStatus } from "./types.js";
import { formatUsage } from "./format.js";

// ── Public types ──

export interface AgentWidgetEntry {
  name: string;
  status: "pending" | "running" | "done" | "error";
  durMs?: number;
  usage?: { input: number; output: number; cost: number; turns: number };
  toolCount: number;
}

// ── Internal state ──

interface WidgetData {
  agents: AgentWidgetEntry[];
  mode: "single" | "parallel";
  elapsedMs?: number;
  running: boolean;
  hasData: boolean;
  usage?: { input: number; output: number; cost: number; turns: number };
  model?: string;
}

let _data: WidgetData = {
  agents: [],
  mode: "single",
  running: false,
  hasData: false,
};

// ── Public API ──

/**
 * Push updated subagent details to the widget.
 * Extracts agent info for both single and parallel mode.
 */
export function pushWidgetUpdate(details: SubagentDetails): void {
  // Widget removed — no-op
}

/**
 * Mark the widget state as finalized (no longer running).
 * Keeps the final agent states visible.
 */
export function finalizeWidget(): void {
  // Widget removed — no-op
}

/**
 * Clear the widget state (hide it).
 */
export function clearWidget(): void {
  _data = { agents: [], mode: "single", running: false, hasData: false };
}

// ── Helpers ──

function compactDur(ms: number | undefined): string {
  if (ms == null) return "   -  ";
  if (ms < 1000) return `${ms}ms`.padStart(5);
  return `${(ms / 1000).toFixed(1)}s`.padStart(5);
}

// ── Widget component factory ──

/**
 * Create a widget component that renders the subagent compact bar.
 * The component reads from module-level _data, so it always has the latest state.
 */
export function createSubagentWidget(tui: { requestRender: () => void }, theme: Theme): Component {
  return {
    invalidate(): void { /* no-op */ },
    render(_width: number): string[] { return []; },
    dispose(): void { /* no-op */ },
  };
}

/**
 * Re-register the widget to force a re-render via setWidget() lifecycle.
 * Call this every time widget data changes.
 * ctx is the ExtensionContext from the tool's execute method.
 */
export function reinstallWidget(ctx: { ui: { setWidget: (key: string, content: any, options?: any) => void } }): void {
  ctx.ui.setWidget("subagent-bar", (_tui: any, theme: Theme) => {
    return createSubagentWidget(_tui, theme);
  }, { placement: "belowEditor" });
}
