/**
 * timeline-handler.ts — /timeline command handler + autocomplete + help guide.
 *
 * Extracted from index.ts for maintainability.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import {
  clearTimelineHistory,
  setMaxVisible,
  getMaxVisible,
  getRollingWindow,
  getTimeMode,
  setRollingWindow,
  setTimeMode,
  toggleTimeMode,
  reinstallTimelineWidget,
  setBarWidthRatio,
  getBarWidthRatio,
} from "./execution-timeline-widget.js";

// ── Duration parser (extracted from index.ts) ──

function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)\s*(s|sec|m|min|h|hr)?$/);
  if (!match) return null;
  const val = parseInt(match[1]!, 10);
  const unit = match[2] || "s";
  switch (unit) {
    case "s": case "sec": return val * 1000;
    case "m": case "min": return val * 60_000;
    case "h": case "hr": return val * 3_600_000;
    default: return null;
  }
}

// ── Help / Usage guide ──

const HELP_TEXT = `
Usage:  /timeline [subcommand] [options]

Configure the execution timeline Gantt chart widget.

Subcommands:
  (no args)             Show timeline settings (status)
  clear                 Clear all timeline history
  max <N>               Set max visible entries (1–50, default 6)
  bar <PCT>             Set bar width percentage (10–100, default 75)
  window <duration>     Set rolling time window (e.g. "30s", "5m", "1h", default 5m)
  window off            Disable rolling window (show all)
  time                  Cycle time mode: real → turn
  time real             Show absolute timestamps (HH:MM:SS)
  time turn             Show turn counts
  status                Show current timeline settings
  help                  Show this help message

Alias:
  /tl                   Same as /timeline

Examples:
  /timeline             Show timeline settings (status)
  /timeline max 10      Show up to 10 entries
  /timeline window 5m   Only show entries from the last 5 minutes
  /timeline time real   Switch to absolute timestamp mode
  /timeline clear       Reset all history
`;

function showTimelineHelp(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(HELP_TEXT.trim(), "info");
}

// ── Subcommand definitions for autocomplete ──

interface SubcommandDef {
  value: string;       // Inserted value (e.g. "max")
  label: string;       // Display label
  description: string; // Description shown in autocomplete
}

const SUBCOMMANDS: SubcommandDef[] = [
  { value: "clear",  label: "clear",  description: "Clear all timeline history" },
  { value: "max",    label: "max",    description: "Set max visible entries (1–50), e.g. max 10" },
  { value: "bar",    label: "bar",    description: "Set bar width percentage (10–100), e.g. bar 75" },
  { value: "window", label: "window", description: "Set rolling time window, e.g. window 5m" },
  { value: "time",   label: "time",   description: "Set time mode: real or turn" },
  { value: "status", label: "status", description: "Show current timeline settings (max, window, bar, time)" },
  { value: "help",   label: "help",   description: "Show detailed usage guide" },
];

const WINDOW_VALUES: SubcommandDef[] = [
  { value: "30s",  label: "30s",  description: "Last 30 seconds" },
  { value: "5m",   label: "5m",   description: "Last 5 minutes" },
  { value: "1h",   label: "1h",   description: "Last hour" },
  { value: "off",  label: "off",  description: "Disable rolling window (show all)" },
];

const MAX_VALUES: SubcommandDef[] = [
  { value: "5",   label: "5",   description: "Show 5 entries" },
  { value: "6",   label: "6",   description: "Show 6 entries (default)" },
  { value: "10",  label: "10",  description: "Show 10 entries" },
  { value: "20",  label: "20",  description: "Show 20 entries" },
  { value: "50",  label: "50",  description: "Show 50 entries (max)" },
];

const BAR_VALUES: SubcommandDef[] = [
  { value: "25",  label: "25%",  description: "Bar gets 25% of available width" },
  { value: "50",  label: "50%",  description: "Bar gets 50% of available width" },
  { value: "60",  label: "60%",  description: "Bar gets 60% of available width" },
  { value: "75",  label: "75%",  description: "Bar gets 75% of available width (default)" },
  { value: "90",  label: "90%",  description: "Bar gets 90% of available width" },
];

const TIME_VALUES: SubcommandDef[] = [
  { value: "real",     label: "real",     description: "Absolute timestamps (HH:MM:SS)" },
  { value: "turn",     label: "turn",     description: "Turn counts" },
];

// ── Autocomplete ──

/**
 * Provides autocomplete suggestions for /timeline [subcommand] [options].
 *
 * Completion stages:
 *   1st token → subcommand (clear, max, bar, window, time, status, help)
 *   2nd token (max) → number suggestions
 *   2nd token (window) → duration suggestions (30s, 5m, 1h, off)
 *   2nd token (time) → mode suggestions (real, turn)
 */
export function getTimelineCompletions(prefix: string): AutocompleteItem[] | null {
  const trimmed = prefix.trimStart();
  const parts = trimmed.split(/\s+/);

  // First argument — suggest subcommands
  if (parts.length <= 1) {
    const partial = parts[0] ?? "";
    const suggestions = SUBCOMMANDS
      .filter((s) => s.value.startsWith(partial))
      .map((s) => ({ value: s.value, label: s.label, description: s.description }));
    return suggestions.length > 0 ? suggestions : null;
  }

  // Second argument — suggest subcommand-specific values
  const firstCmd = parts[0]!.toLowerCase();
  const partial = parts.slice(1).join(" ");

  if (firstCmd === "max") {
    const suggestions = MAX_VALUES
      .filter((s) => s.value.startsWith(partial))
      .map((s) => ({ value: `max ${s.value}`, label: s.label, description: s.description }));
    return suggestions.length > 0 ? suggestions : null;
  }

  if (firstCmd === "bar") {
    const suggestions = BAR_VALUES
      .filter((s) => s.value.startsWith(partial))
      .map((s) => ({ value: `bar ${s.value}`, label: s.label, description: s.description }));
    return suggestions.length > 0 ? suggestions : null;
  }

  if (firstCmd === "window") {
    const suggestions = WINDOW_VALUES
      .filter((s) => s.value.startsWith(partial))
      .map((s) => ({ value: `window ${s.value}`, label: s.label, description: s.description }));
    return suggestions.length > 0 ? suggestions : null;
  }

  if (firstCmd === "time") {
    const suggestions = TIME_VALUES
      .filter((s) => s.value.startsWith(partial))
      .map((s) => ({ value: `time ${s.value}`, label: s.label, description: s.description }));
    return suggestions.length > 0 ? suggestions : null;
  }

  return null;
}

// ── Handler ──

/**
 * Handle the /timeline command and its subcommands.
 * Extracted from index.ts for maintainability.
 */
export async function timelineHandler(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const cmd = args.trim().toLowerCase();

  // ── Help / usage guide ──
  if (cmd === "" || cmd === "help" || cmd === "--help" || cmd === "-h") {
    showTimelineHelp(ctx);
    return;
  }

  // ── window <duration> ──
  const windowMatch = cmd.match(/^window\s+(.+)$/);
  if (windowMatch) {
    const durationStr = windowMatch[1]!.trim();
    if (durationStr === "off" || durationStr === "0") {
      setRollingWindow(undefined);
      reinstallTimelineWidget(ctx);
      ctx.ui.notify("Timeline rolling window disabled (showing all activity).", "info");
    } else {
      const ms = parseDuration(durationStr);
      if (ms === null) {
        ctx.ui.notify(`Invalid duration: "${durationStr}". Use e.g. "30s", "5m", "1h".`, "error");
      } else {
        setRollingWindow(ms);
        reinstallTimelineWidget(ctx);
        const display = ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(0)}h` : ms >= 60_000 ? `${(ms / 60_000).toFixed(0)}m` : `${(ms / 1000).toFixed(0)}s`;
        ctx.ui.notify(`Timeline rolling window set to last ${display}.`, "info");
      }
    }
    return;
  }

  // ── time [real|turn] ──
  const timeMatch = cmd.match(/^time\s+(.+)$/);
  if (timeMatch) {
    const mode = timeMatch[1]!.trim();
    if (mode === "real") {
      setTimeMode("real");
      reinstallTimelineWidget(ctx);
      ctx.ui.notify("Timeline time mode set to real time (HH:MM:SS).", "info");
    } else if (mode === "turn") {
      setTimeMode("turn");
      reinstallTimelineWidget(ctx);
      ctx.ui.notify("Timeline time mode set to turn count.", "info");
    } else {
      ctx.ui.notify(`Unknown time mode: "${mode}". Use "real" or "turn".`, "error");
    }
    return;
  }

  if (cmd === "time") {
    const newMode = toggleTimeMode();
    reinstallTimelineWidget(ctx);
    const modeName = newMode === "real" ? "real time (HH:MM:SS)" : "turn count";
    ctx.ui.notify(`Timeline time mode toggled to ${modeName}.`, "info");
    return;
  }

  // ── max <N> ──
  const maxMatch = cmd.match(/^max\s+(\d+)$/);
  if (maxMatch) {
    const n = parseInt(maxMatch[1]!, 10);
    setMaxVisible(n);
    reinstallTimelineWidget(ctx);
    ctx.ui.notify(`Timeline max visible set to ${getMaxVisible()}.`, "info");
    return;
  }

  // ── bar <N> ──
  const barMatch = cmd.match(/^bar\s+(\d+)$/);
  if (barMatch) {
    const pct = parseInt(barMatch[1]!, 10);
    setBarWidthRatio(pct / 100);
    reinstallTimelineWidget(ctx);
    ctx.ui.notify(`Timeline bar width set to ${pct}%.`, "info");
    return;
  }

  // ── clear ──
  if (cmd === "clear") {
    clearTimelineHistory();
    reinstallTimelineWidget(ctx);
    ctx.ui.notify("Timeline history cleared.", "info");
    return;
  }

  // ── status ──
  if (cmd === "status") {
    const maxVal = getMaxVisible();
    const windowVal = getRollingWindow();
    const barPct = Math.round(getBarWidthRatio() * 100);
    const timeMode = getTimeMode();

    const windowStr = windowVal === undefined ? "off (show all)" : `${windowVal}ms`;

    ctx.ui.notify(
      `Timeline settings: max=${maxVal}, window=${windowStr}, bar=${barPct}%, time=${timeMode}`,
      "info",
    );
    return;
  }

  // ── Fallback: show status ──
  const maxVal = getMaxVisible();
  const windowVal = getRollingWindow();
  const barPct = Math.round(getBarWidthRatio() * 100);
  const timeMode = getTimeMode();
  const windowStr = windowVal === undefined ? "off (show all)" : `${windowVal}ms`;
  ctx.ui.notify(
    `Timeline settings: max=${maxVal}, window=${windowStr}, bar=${barPct}%, time=${timeMode} (always visible)`,
    "info",
  );
}
