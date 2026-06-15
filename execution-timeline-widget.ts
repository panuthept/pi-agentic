/**
 * Persistent execution timeline widget.
 *
 * Shows a Gantt-style timeline of all subagent executions,
 * accumulated across runs. Always visible.
 *
 * Widget key: "execution-timeline"
 * Placement: belowEditor (stacks below the live status bar)
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TimelineEntry, SubagentDetails } from "./types.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Internal state ──

interface TimelineState {
  entries: TimelineEntry[];
  nextId: number;
}

let _state: TimelineState = {
  entries: [],
  nextId: 1,
};

// ── Agent color cycling ──
// Same palette as timeline.ts for visual consistency

const AGENT_COLORS = [
  "\x1b[38;5;75m",   "\x1b[38;5;114m",  "\x1b[38;5;222m",  "\x1b[38;5;183m",
  "\x1b[38;5;181m",  "\x1b[38;5;116m",  "\x1b[38;5;250m",  "\x1b[38;5;210m",
  "\x1b[38;5;146m",  "\x1b[38;5;79m",   "\x1b[38;5;215m",  "\x1b[38;5;218m",
  "\x1b[38;5;66m",   "\x1b[38;5;95m",   "\x1b[38;5;103m",  "\x1b[38;5;107m",
  "\x1b[38;5;131m",  "\x1b[38;5;136m",  "\x1b[38;5;139m",  "\x1b[38;5;144m",
  "\x1b[38;5;152m",  "\x1b[38;5;175m",  "\x1b[38;5;180m",  "\x1b[38;5;187m",
  "\x1b[38;5;194m",  "\x1b[38;5;223m",
];
const RESET_FG = "\x1b[39m";

type TimeMode = 'real' | 'turn';

const _assignedColors = new Map<string, string>();
let _colorIndex = 0;

function getAgentColor(name: string): string {
  let color = _assignedColors.get(name);
  if (!color) {
    color = AGENT_COLORS[_colorIndex % AGENT_COLORS.length]!;
    _colorIndex++;
    _assignedColors.set(name, color);
  }
  return color;
}

// ── Helpers ──

function nextId(): string {
  return `tl-${_state.nextId++}`;
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return "   -  ";
  if (ms < 1000) return `${ms}ms`.padStart(5);
  return `${(ms / 1000).toFixed(1)}s`.padStart(5);
}

function formatAbsoluteTime(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatWindowDuration(ms: number | undefined): string {
  if (ms === undefined) return "off";
  if (ms >= 3600000) return `${(ms / 3600000).toFixed(0)}h`;
  if (ms >= 60000) return `${(ms / 60000).toFixed(0)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

// ── Public API ──

export function clearTimelineHistory(): void {
  _state.entries = [];
  _state.nextId = 1;
  clearCached();
}

/**
 * Set the maximum number of timeline entries visible in the widget.
 * Clamped between 1 and 50. Use 0 to show all (may take significant space).
 */
export function setMaxVisible(n: number): void {
  _maxVisibleBars = Math.max(1, Math.min(50, n));
  clearCached();
  saveTimelineSettings();
}

/** Get the current max visible entries setting. */
export function getMaxVisible(): number {
  return _maxVisibleBars;
}

export function setBarWidthRatio(pct: number): void {
  _barWidthRatio = Math.max(0.1, Math.min(1, pct));
  clearCached();
  saveTimelineSettings();
}

export function getBarWidthRatio(): number {
  return _barWidthRatio;
}

/** Set the rolling time window (ms). Undefined = show all. */
export function setRollingWindow(ms: number | undefined): void {
  _rollingWindowMs = ms;
  clearCached();
  saveTimelineSettings();
}

/** Get the current rolling window in ms (undefined = disabled). */
export function getRollingWindow(): number | undefined {
  return _rollingWindowMs;
}

export function setTimeMode(mode: TimeMode): void {
  if (_timeMode !== mode) {
    _timeMode = mode;
    clearCached();
    saveTimelineSettings();
  }
}

export function getTimeMode(): TimeMode {
  return _timeMode;
}

export function toggleTimeMode(): TimeMode {
  if (_timeMode === 'real') _timeMode = 'turn';
  else _timeMode = 'real';
  clearCached();
  saveTimelineSettings();
  return _timeMode;
}

export function getTimelineEntries(): TimelineEntry[] {
  return [..._state.entries];
}

/**
 * Record the start of a single subagent execution.
 * Returns the entry ID for later updates/end.
 */
export function recordStart(
  agent: string,
  task: string,
  mode: "single" | "parallel",
): string {
  const id = nextId();
  _state.entries.push({
    id,
    agent,
    task: task || "",
    startTime: Date.now(),
    status: "running",
    mode,
    toolCount: 0,
  });
  clearCached();
  return id;
}

/**
 * Record the start of parallel agent batch.
 * Returns array of entry IDs matching the tasks array.
 */
export function recordParallelStart(
  tasks: Array<{ agent: string; task: string }>,
): string[] {
  const ids: string[] = [];
  const now = Date.now();
  for (const t of tasks) {
    const id = nextId();
    _state.entries.push({
      id,
      agent: t.agent,
      task: t.task || "",
      startTime: now,
      status: "running",
      mode: "parallel",
      toolCount: 0,
    });
    ids.push(id);
  }
  clearCached();
  return ids;
}

/**
 * Update a running entry's details (tool count, duration, usage).
 */
export function recordUpdate(
  id: string,
  updates: {
    toolCount?: number;
    duration?: number;
    usage?: { input: number; output: number; cost: number; turns: number };
  },
): void {
  const entry = _state.entries.find((e) => e.id === id);
  if (!entry) return;
  if (updates.toolCount !== undefined) entry.toolCount = updates.toolCount;
  if (updates.duration !== undefined) entry.duration = updates.duration;
  if (updates.usage !== undefined) entry.usage = updates.usage;
}

/**
 * Update all running parallel entries from SubagentDetails.
 */
export function recordParallelUpdate(details: SubagentDetails): void {
  if (!details.parallelAgents) return;
  for (const agent of details.parallelAgents) {
    const entry = _state.entries.find(
      (e) =>
        e.agent === agent.name &&
        e.status === "running" &&
        e.mode === "parallel",
    );
    if (!entry) continue;
    if (agent.toolCalls) entry.toolCount = agent.toolCalls.length;
    if (agent.durMs) entry.duration = agent.durMs;
    if (agent.usage) entry.usage = agent.usage;
  }
  clearCached();
}

/**
 * Mark a specific entry as complete.
 */
export function recordEnd(
  id: string,
  status: "success" | "error",
  duration?: number,
): void {
  const entry = _state.entries.find((e) => e.id === id);
  if (!entry) return;
  entry.endTime = Date.now();
  entry.duration = duration ?? (entry.endTime - entry.startTime);
  entry.status = status;
  clearCached();
}

/**
 * Mark all running entries as complete (bulk cleanup).
 */
export function finalizeAllRunning(status: "success" | "error" = "success"): void {
  const now = Date.now();
  for (const entry of _state.entries) {
    if (entry.status === "running") {
      entry.endTime = now;
      entry.duration = now - entry.startTime;
      entry.status = status;
    }
  }
  clearCached();
}

// ── Caching ──

let _cachedWidth: number | undefined;
let _cachedLines: string[] = [];

function clearCached(): void {
  _cachedWidth = undefined;
  _cachedLines = [];
}

// ── Rendering constants ──

let _maxVisibleBars = 6;
let _rollingWindowMs: number | undefined = 300000;
let _timeMode: TimeMode = 'real';
let _barWidthRatio = 0.75;

// ── Settings persistence ──

interface TimelineSettings {
  maxVisible: number;
  rollingWindowMs: number | undefined;
  timeMode: TimeMode;
  barWidthRatio: number;
}

const SETTINGS_PATH = join(getAgentDir(), "settings.json");
const DEFAULT_TIMELINE_SETTINGS: TimelineSettings = {
  maxVisible: 6,
  rollingWindowMs: 300000,
  timeMode: 'real',
  barWidthRatio: 0.75,
};

export function loadTimelineSettings(): void {
  try {
    if (!existsSync(SETTINGS_PATH)) return;
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    const saved = raw?.timeline as Partial<TimelineSettings> | undefined;
    if (!saved) return;
    const merged = { ...DEFAULT_TIMELINE_SETTINGS, ...saved };
    _maxVisibleBars = Math.max(1, Math.min(50, merged.maxVisible));
    _rollingWindowMs = merged.rollingWindowMs;
    _timeMode = merged.timeMode;
    if (!['real', 'turn'].includes(_timeMode)) {
      _timeMode = 'real';
    }
    _barWidthRatio = Math.max(0.1, Math.min(1, merged.barWidthRatio));
  } catch {
    // ignore corrupt settings
  }
}

export function saveTimelineSettings(): void {
  try {
    let full: Record<string, unknown> = {};
    if (existsSync(SETTINGS_PATH)) {
      try { full = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")); } catch { /* ignore */ }
    }
    full.timeline = {
      maxVisible: _maxVisibleBars,
      rollingWindowMs: _rollingWindowMs,
      timeMode: _timeMode,
      barWidthRatio: _barWidthRatio,
    };
    writeFileSync(SETTINGS_PATH, JSON.stringify(full, null, 2), "utf-8");
  } catch {
    // ignore write errors
  }
}

// ── Widget component factory ──

/**
 * Create the persistent execution timeline TUI component.
 * The component reads from module-level _state, so it always has the latest data.
 */
export function createTimelineWidget(
  tui: { requestRender: () => void },
  theme: Theme,
): Component {
  let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const hasRunning = () => _state.entries.some((e) => e.status === "running");

  function ensureHeartbeat() {
    if (hasRunning() && !_heartbeatTimer) {
      _heartbeatTimer = setInterval(() => {
        if (!hasRunning()) {
          clearInterval(_heartbeatTimer!);
          _heartbeatTimer = null;
          return;
        }
        clearCached();
        tui.requestRender();
      }, 1000);
    } else if (!hasRunning() && _heartbeatTimer) {
      clearInterval(_heartbeatTimer);
      _heartbeatTimer = null;
    }
  }

  return {
    invalidate(): void {
      clearCached();
    },

    render(width: number): string[] {
      ensureHeartbeat();
      if (width === _cachedWidth && _cachedLines.length > 0)
        return _cachedLines;
      _cachedWidth = width;

      const entries = _state.entries;

      // ── Empty: nothing shown ──
      if (entries.length === 0) {
        _cachedLines = [];
        return _cachedLines;
      }

      // ── Rolling window filter ──
      let displayEntries = entries;
      if (_rollingWindowMs) {
        const now = Date.now();
        const windowStart = now - _rollingWindowMs;
        displayEntries = entries.filter((e) => {
          const endTime = e.endTime ?? now;
          return endTime > windowStart && e.startTime < now;
        });
        if (displayEntries.length === 0) {
          _cachedLines = [theme.fg("dim", "  (no activity in the current time window)")];
          return _cachedLines;
        }
      }

      // ── Expanded: Gantt chart ──
      const now = Date.now();

      // ── Agent bars (most recent _maxVisibleBars) ──
      const visibleEntries = displayEntries.slice(-_maxVisibleBars).reverse();

      const minStart = Math.min(...visibleEntries.map((e) => e.startTime));
      const maxEnd = Math.max(...visibleEntries.map((e) => e.endTime ?? now));
      // Precompute cumulative turn offsets for stacking (chronological order)
      // Parallel entries (same startTime) share the same offset
      const cumTurnOffsets: number[] = [];
      let turnTotalSpan = 0;
      if (_timeMode === 'turn') {
        let cum = 0;
        // visibleEntries is newest-first (reversed). Walk oldest-first.
        let i = visibleEntries.length - 1;
        while (i >= 0) {
          const currentStart = visibleEntries[i]!.startTime;
          // Find entries with the same startTime (parallel batch)
          let j = i;
          while (j >= 0 && visibleEntries[j]!.startTime === currentStart) {
            j--;
          }
          // Batch is from j+1 to i (inclusive) — these share a startTime
          let batchMax = 0;
          for (let k = j + 1; k <= i; k++) {
            const turns = visibleEntries[k]!.usage?.turns ?? 0;
            if (turns > batchMax) batchMax = turns;
          }
          // All entries in this batch get the same offset
          for (let k = j + 1; k <= i; k++) {
            cumTurnOffsets[k] = cum;
          }
          cum += batchMax; // batch contributes max turns, not sum
          i = j;
        }
        turnTotalSpan = Math.max(1, cum);
      }
      const totalSpan = _timeMode === 'turn'
        ? turnTotalSpan
        : Math.max(1, maxEnd - minStart);

      const contentWidth = width - 2;
      const labelWidth = Math.min(
        20,
        Math.max(4, ...displayEntries.map((e) => e.agent.length)) + 1,
      );

      // ── Pre-calculate max raw usage suffix width across all entries ──
      // This ensures the bar leaves enough room for every entry's suffix.
      let maxRawUsageWidth = 0;
      for (const e of visibleEntries) {
        const parts: string[] = [];
        if (e.toolCount > 0) parts.push(`${e.toolCount} tool${e.toolCount > 1 ? "s" : ""}`);
        if (e.usage?.turns) parts.push(`${e.usage.turns} turn${e.usage.turns > 1 ? "s" : ""}`);
        if (e.usage?.input) parts.push(`↑${e.usage.input >= 1000 ? `${(e.usage.input / 1000).toFixed(1)}k` : e.usage.input}`);
        if (e.usage?.output) parts.push(`↓${e.usage.output >= 1000 ? `${(e.usage.output / 1000).toFixed(1)}k` : e.usage.output}`);
        if (e.usage?.cost) parts.push(`$${e.usage.cost.toFixed(4)}`);
        const raw = parts.join("  ");
        if (raw.length > maxRawUsageWidth) maxRawUsageWidth = raw.length;
      }
      // Add a small buffer and clamp to reasonable bounds
      const minUsageWidth = Math.max(5, Math.min(55, maxRawUsageWidth + 3));

      // Fixed overhead AFTER the bar on each agent line (visible chars):
      //   " " (1) + statusIcon (1) + " " (1) + durStr (~6) + "  " (2) = 11
      // Plus right border "│" (1) added during padding phase
      const overheadAfterBar = 11;
      const rightBorderWidth = 1;

      const barWidth = Math.max(
        10,
        Math.min(
          Math.floor((contentWidth - labelWidth) * _barWidthRatio),
          contentWidth - labelWidth - overheadAfterBar - rightBorderWidth - minUsageWidth,
        ),
      );

      const lines: string[] = [];

      // ── Header ──
      const runningCount = visibleEntries.filter((e) => e.status === "running").length;
      const totalStr = `${visibleEntries.length} run${visibleEntries.length !== 1 ? "s" : ""}`;
      const statusTag =
        runningCount > 0 ? theme.fg("warning", ` (${runningCount} running)`) : "";
      const moreHint =
        displayEntries.length > _maxVisibleBars
          ? theme.fg("dim", ` — showing last ${_maxVisibleBars}`)
          : "";
      const headerContent = `╭─ Execution Timeline  ${totalStr}${statusTag}${moreHint}`;
      const contentVisWidth = visibleWidth(headerContent);
      const fillLen = Math.max(0, width - contentVisWidth - 2); // 2 for space + ╮
      const header = headerContent + theme.fg("accent", " " + "─".repeat(fillLen) + "╮");
      lines.push(header);

      // ── Settings line ──
      const windowStr = formatWindowDuration(_rollingWindowMs);
      const barPct = Math.round(_barWidthRatio * 100);
      lines.push(`│ ${theme.fg("dim", `max:${_maxVisibleBars}  window:${windowStr}  bar:${barPct}%  time:${_timeMode}`)}`);

      // ── Time axis ──
      if (totalSpan > 0 && barWidth > 5) {
        const axisTicks = 4;

        // Tick labels
        let tickLine = "│ " + " ".repeat(labelWidth + 1);
        for (let t = 0; t <= axisTicks; t++) {
          const val = (t / axisTicks) * totalSpan;
          let label: string;
          if (_timeMode === 'real') {
            label = formatAbsoluteTime(minStart + val);
          } else {
            label = `turn ${Math.round(val)}`;
          }
          const pos = Math.round((t / axisTicks) * barWidth);
          // Calculate padding to reach position within the bar area
          const currentLen = visibleWidth(tickLine);
          const targetLen = 2 + labelWidth + 1 + pos;
          const pad = Math.max(0, targetLen - currentLen);
          tickLine += " ".repeat(pad) + theme.fg("dim", label);
        }
        lines.push(tickLine);

        // Tick separator
        let sepLine = "│ " + " ".repeat(labelWidth) + " ";
        for (let i = 0; i < barWidth; i++) {
          const isTick = [0.25, 0.5, 0.75].some(
            (frac) => Math.abs(i - Math.round(frac * barWidth)) < 1,
          );
          sepLine += isTick
            ? theme.fg("muted", "┼")
            : theme.fg("dim", "─");
        }
        lines.push(sepLine);
      }

      // ── Agent bars (most recent _maxVisibleBars) ──

      // cumTurnOffsets is now computed above alongside turnTotalSpan

      for (let ei = 0; ei < visibleEntries.length; ei++) {
        const e = visibleEntries[ei]!;
        const namePadded =
          e.agent.length > labelWidth
            ? e.agent.slice(0, labelWidth - 1) + "…"
            : e.agent.padEnd(labelWidth);
        const color = getAgentColor(e.agent);

        // Build the Gantt bar
        let barStr = "";
        if (totalSpan > 0) {
          for (let x = 0; x < barWidth; x++) {
            const pos = (x / barWidth) * totalSpan;
            let active: boolean;
            if (_timeMode === 'turn') {
              const agentTurns = e.usage?.turns ?? 0;
              active = pos >= cumTurnOffsets[ei] && pos < cumTurnOffsets[ei] + agentTurns;
            } else {
              const startOffset = e.startTime - minStart;
              const endOffset = (e.endTime ?? now) - minStart;
              active = pos >= startOffset && pos < endOffset;
            }
            barStr += active
              ? theme.bold(`${color}█${RESET_FG}`)
              : theme.fg("dim", "░");
          }
        }

        // Status icon
        let statusIcon: string;
        if (e.status === "running") statusIcon = theme.fg("warning", "→");
        else if (e.status === "success") statusIcon = `\x1b[38;5;46m${theme.bold("✓")}\x1b[39m`;
        else statusIcon = theme.fg("error", "✗");

        const durStr = formatDuration(e.duration ?? (e.endTime ? e.endTime - e.startTime : now - e.startTime));

        // Tool usage info (tools, turns, tokens, cost)
        // usageWidth is the remaining space after bar + fixed overhead
        const usageWidth = Math.max(5, contentWidth - labelWidth - barWidth - overheadAfterBar - rightBorderWidth);
        let usageStr = "";
        if (e.usage) {
          const parts: string[] = [];
          if (e.toolCount > 0) parts.push(`${e.toolCount} tool${e.toolCount > 1 ? "s" : ""}`);
          if (e.usage.turns) parts.push(`${e.usage.turns} turn${e.usage.turns > 1 ? "s" : ""}`);
          if (e.usage.input) parts.push(`↑${e.usage.input >= 1000 ? `${(e.usage.input / 1000).toFixed(1)}k` : e.usage.input}`);
          if (e.usage.output) parts.push(`↓${e.usage.output >= 1000 ? `${(e.usage.output / 1000).toFixed(1)}k` : e.usage.output}`);
          if (e.usage.cost) parts.push(`$${e.usage.cost.toFixed(4)}`);
          usageStr = truncateToWidth(parts.join("  "), usageWidth, "…");
        } else if (e.toolCount > 0) {
          usageStr = `${e.toolCount} tool${e.toolCount > 1 ? "s" : ""}`;
        }

        lines.push(
          `│ ${theme.fg("text", namePadded)} ${barStr} ${statusIcon} ${durStr}  ${theme.fg("dim", usageStr)}`,
        );
      }

      // ── Summary stats ──
      const doneEntries = visibleEntries.filter((e) => e.status !== "running");
      const durations = doneEntries
        .map((e) => e.duration ?? 0)
        .filter((d) => d > 0);
      const avg =
        durations.length > 0
          ? durations.reduce((a, b) => a + b, 0) / durations.length
          : 0;

      let statsParts: string[];
      if (_timeMode === 'turn') {
        const totalTurns = visibleEntries.reduce((sum, e) => sum + (e.usage?.turns ?? 0), 0);
        const maxTurnsStat = Math.max(...visibleEntries.map(e => e.usage?.turns ?? 0));
        const avgTurns = visibleEntries.length > 0 ? (totalTurns / visibleEntries.length) : 0;
        statsParts = [
          `Total: ${totalTurns} turns`,
          `Max: ${maxTurnsStat} turns`,
          `Avg: ${avgTurns.toFixed(1)} turns`,
        ];
      } else {
        // Peak parallelism (sample 100 points across total span)
        let peakParallel = 0;
        for (let x = 0; x <= 100; x++) {
          const msPos = (x / 100) * totalSpan + minStart;
          let runningCount = 0;
          for (const e of visibleEntries) {
            const eStart = e.startTime;
            const eEnd = e.endTime ?? now;
            if (msPos >= eStart && msPos < eEnd) runningCount++;
          }
          if (runningCount > peakParallel) peakParallel = runningCount;
        }
        statsParts = [
          `Peak: ${peakParallel} parallel`,
          `Total: ${visibleEntries.length} runs`,
          `Avg: ${(avg / 1000).toFixed(1)}s`,
        ];
      }
      lines.push(theme.fg("dim", `│ ${statsParts.join("  │  ")}`));

      // ── Right border for content rows ──
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!;
        const padLen = Math.max(0, width - visibleWidth(line) - 1);
        lines[i] = line + " ".repeat(padLen) + theme.fg("muted", "│");
      }

      // ── Bottom border ──
      lines.push(
        theme.fg("accent", "╰" + "─".repeat(Math.max(1, width - 2)) + "╯"),
      );

      // Guarantee every line fits terminal width to avoid TUI crash
      _cachedLines = lines.map(line => truncateToWidth(line, width, "..."));
      return _cachedLines;
    },

    dispose(): void {
      if (_heartbeatTimer) clearInterval(_heartbeatTimer);
      _heartbeatTimer = null;
      clearCached();
    },
  };
}

/**
 * Register (or re-register) the timeline widget in the TUI.
 * Call this after any state change to force a re-render.
 */
export function reinstallTimelineWidget(
  ctx: {
    ui: {
      setWidget: (
        key: string,
        content: any,
        options?: { placement?: string },
      ) => void;
    };
  },
): void {
  ctx.ui.setWidget(
    "execution-timeline",
    (_tui: any, theme: Theme) => createTimelineWidget(_tui, theme),
    { placement: "belowEditor" },
  );
}
