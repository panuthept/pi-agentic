/**
 * Render a Gantt-style timeline summary of subagent execution.
 * Appended after the Process Tree when execution completes.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentRowStatus } from "./types.js";

// ── Agent color cycling ──
// All agents get colors from this pool in round-robin order.
const AGENT_COLORS = [
  "\x1b[38;5;75m",   // soft blue
  "\x1b[38;5;114m",  // soft green
  "\x1b[38;5;222m",  // soft yellow
  "\x1b[38;5;183m",  // soft purple
  "\x1b[38;5;181m",  // soft rose
  "\x1b[38;5;116m",  // soft cyan
  "\x1b[38;5;250m",  // light gray
  "\x1b[38;5;210m",  // soft red
  "\x1b[38;5;146m",  // lavender
  "\x1b[38;5;79m",   // seafoam
  "\x1b[38;5;215m",  // peach
  "\x1b[38;5;218m",  // pink
  "\x1b[38;5;66m",   // teal-gray
  "\x1b[38;5;95m",   // brown-gray
  "\x1b[38;5;103m",  // slate blue
  "\x1b[38;5;107m",  // olive
  "\x1b[38;5;131m",  // brick red
  "\x1b[38;5;136m",  // tan
  "\x1b[38;5;139m",  // mauve
  "\x1b[38;5;144m",  // sage
  "\x1b[38;5;152m",  // steel blue
  "\x1b[38;5;175m",  // rose
  "\x1b[38;5;180m",  // peach
  "\x1b[38;5;187m",  // cream
  "\x1b[38;5;194m",  // mint
  "\x1b[38;5;223m",  // warm yellow
];

const RESET_FG = "\x1b[39m";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatAbsoluteTime(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

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

/**
 * Render a horizontal Gantt chart showing when each agent ran.
 * Only called when all agents are done.
 */
export function renderTimeline(
  agents: AgentRowStatus[],
  width: number,
  theme: Theme,
  options?: { rollingWindowMs?: number; nowOffset?: number; timeMode?: 'real' | 'turn'; batchStartTime?: number },
): string[] {
  const timeMode = options?.timeMode ?? 'real';
  const batchStartTime = options?.batchStartTime;
  const lines: string[] = [];

  // Skip if no agents or still running
  if (agents.length === 0) return lines;

  // Find total timespan
  let minStartMs = Infinity;
  let maxEndMs = 0;
  for (const a of agents) {
    const startMs = a.startOffsetMs ?? 0;
    const endMs = startMs + (a.durMs ?? 0);
    if (startMs < minStartMs) minStartMs = startMs;
    if (endMs > maxEndMs) maxEndMs = endMs;
  }
  if (maxEndMs <= 0 || !isFinite(minStartMs)) return lines;

  // Apply rolling window filter
  if (options?.rollingWindowMs) {
    const nowRef = options?.nowOffset ?? maxEndMs;
    const windowStart = nowRef - options.rollingWindowMs;
    const filteredAgents = agents.filter((a) => {
      const start = a.startOffsetMs ?? 0;
      const end = start + (a.durMs ?? 0);
      return end > windowStart && start < nowRef;
    });
    if (filteredAgents.length === 0) return [];
    agents = filteredAgents;
    // Recompute span for filtered list
    minStartMs = Infinity;
    maxEndMs = 0;
    for (const a of agents) {
      const startMs = a.startOffsetMs ?? 0;
      const endMs = startMs + (a.durMs ?? 0);
      if (startMs < minStartMs) minStartMs = startMs;
      if (endMs > maxEndMs) maxEndMs = endMs;
    }
  }

  const sumTurns = agents.reduce((sum, a) => sum + (a.usage?.turns ?? 0), 0);
  const totalSpan = timeMode === 'turn'
    ? Math.max(1, sumTurns)
    : Math.max(1, maxEndMs - minStartMs);

  const totalSec = totalSpan / 1000;
  const contentWidth = width - 2; // borders

  // ── Top border ──
  const headerStr = timeMode === 'real' && batchStartTime != null
    ? `╭─ Execution Timeline (${formatAbsoluteTime(batchStartTime + minStartMs)} → ${formatAbsoluteTime(batchStartTime + maxEndMs)})`
    : timeMode === 'turn'
    ? `╭─ Execution Timeline (0 → ${sumTurns} turn${sumTurns !== 1 ? 's' : ''})`
    : `╭─ Execution Timeline (${formatDuration(minStartMs)} → ${formatDuration(maxEndMs)})`;
  const fillLen = Math.max(0, width - headerStr.length - 2);
  lines.push(theme.fg("accent", `${headerStr} ${"─".repeat(fillLen)}╮`));

  // ── Time axis ──
  const axisTicks = 5;
  const labelWidth = Math.max(8, ...agents.map((a) => a.name.length)) + 1;
  const barWidth = Math.max(10, contentWidth - labelWidth - 2);

  // Tick marks
  const tickLabels: string[] = [];
  for (let t = 0; t <= axisTicks; t++) {
    const val = (totalSpan / axisTicks) * t;
    if (timeMode === 'real' && batchStartTime != null) {
      tickLabels.push(formatAbsoluteTime(batchStartTime + minStartMs + val));
    } else {
      tickLabels.push(`turn ${Math.round(val)}`);
    }
  }
  // Position labels at tick positions
  const tickChars: string[] = [];
  for (let t = 0; t <= axisTicks; t++) {
    const pos = Math.round((t / axisTicks) * barWidth);
    // Place label at this position
    const label = tickLabels[t]!;
    if (tickChars.length <= pos) {
      while (tickChars.length < pos) tickChars.push(" ");
      tickChars.push(...label.split(""));
    }
  }
  // Pad tickChars to at least barWidth so it fills the chart area
  while (tickChars.length < barWidth) tickChars.push(" ");
  lines.push(theme.fg("dim", "│ " + " ".repeat(labelWidth) + " " + tickChars.join("")));

  // Tick separator line
  let sepLine = " ".repeat(labelWidth) + " ";
  for (let i = 0; i < barWidth; i++) {
    const isTick =
      (axisTicks > 0 && Math.abs(i - Math.round((1 / axisTicks) * barWidth)) < 1) ||
      (axisTicks > 0 && Math.abs(i - Math.round((2 / axisTicks) * barWidth)) < 1) ||
      (axisTicks > 0 && Math.abs(i - Math.round((3 / axisTicks) * barWidth)) < 1) ||
      (axisTicks > 0 && Math.abs(i - Math.round((4 / axisTicks) * barWidth)) < 1);
    sepLine += isTick ? "┼" : "─";
  }
  lines.push(theme.fg("muted", "│ " + sepLine));

  // ── Agent bars ──
  let cumTurnOffset = 0;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!;
    const namePadded = a.name.padEnd(labelWidth);
    const start = a.startOffsetMs ?? 0;
    const end = start + (a.durMs ?? 0);

    // Build the bar — active █ colored by agent identity, idle ░ always gray
    let barStr = "";
    for (let x = 0; x < barWidth; x++) {
      const pos = (x / barWidth) * totalSpan;
      let active: boolean;
      if (timeMode === 'turn') {
        const agentTurns = a.usage?.turns ?? 0;
        active = pos >= cumTurnOffset && pos < cumTurnOffset + agentTurns;
      } else {
        active = (minStartMs + pos) >= start && (minStartMs + pos) < end;
      }
      if (active) {
        // Active portion — colored by agent identity, not status
        const agentColor = getAgentColor(a.name);
        barStr += theme.bold(`${agentColor}█${RESET_FG}`);
      } else {
        // Idle portion — always dim gray
        barStr += theme.fg("dim", "░");
      }
    }

    if (timeMode === 'turn') {
      cumTurnOffset += a.usage?.turns ?? 0;
    }

    lines.push("│ " + theme.fg("text", namePadded) + " " + barStr);
  }

  // ── Summary stats ──
  const doneAgents = agents.filter((a) => a.status === "done" || a.status === "error");
  const durations = doneAgents.map((a) => a.durMs ?? 0).filter((d) => d > 0);
  const fastest = durations.length > 0 ? Math.min(...durations) : 0;
  const slowest = durations.length > 0 ? Math.max(...durations) : 0;
  const slowestAgent = durations.length > 0
    ? doneAgents.find((a) => a.durMs === slowest)?.name ?? ""
    : "";

  let statsLine: string;
  if (timeMode === 'turn') {
    const totalTurns = agents.reduce((sum, a) => sum + (a.usage?.turns ?? 0), 0);
    const avgTurns = agents.length > 0 ? (totalTurns / agents.length) : 0;
      const maxTurnsStat = Math.max(...agents.map((a) => a.usage?.turns ?? 0));
      statsLine = `  Total: ${totalTurns} turn${totalTurns !== 1 ? 's' : ''}  │  Max: ${maxTurnsStat} turn${maxTurnsStat !== 1 ? 's' : ''}  │  Avg: ${avgTurns.toFixed(1)} turns`;
  } else {
    // Peak parallelism: max number of agents running at any point
    let peakParallel = 0;
    for (let x = 0; x <= 100; x++) {
      const msPos = minStartMs + (x / 100) * totalSpan;
      let runningCount = 0;
      for (const a of agents) {
        const aStart = a.startOffsetMs ?? 0;
        const aEnd = aStart + (a.durMs ?? 0);
        if (msPos >= aStart && msPos < aEnd) runningCount++;
      }
      if (runningCount > peakParallel) peakParallel = runningCount;
    }
    statsLine = `  Peak: ${peakParallel} parallel  │  Fastest: ${(fastest / 1000).toFixed(1)}s  │  Slowest: ${(slowest / 1000).toFixed(1)}s${slowestAgent ? `  (${slowestAgent})` : ""}`;
  }
  lines.push(theme.fg("text", statsLine));

  // ── Bottom border ──
  lines.push(theme.fg("accent", "╰" + "─".repeat(Math.max(1, width - 2)) + "╯"));

  // Truncate every line to fit terminal width (matches widget behavior)
  return lines.map(line => truncateToWidth(line, width, "..."));
}
