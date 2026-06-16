/**
 * Shared agent color assignment.
 *
 * Agents are assigned a deterministic color from a fixed palette,
 * cycled round-robin on first call. Colors persist for the lifetime
 * of the extension process unless resetAgentColors() is called.
 */

// ── Agent color palette (26 colors) ──

const AGENT_COLORS = [
  "\x1b[38;5;75m",   "\x1b[38;5;114m",  "\x1b[38;5;222m",  "\x1b[38;5;183m",
  "\x1b[38;5;181m",  "\x1b[38;5;116m",  "\x1b[38;5;250m",  "\x1b[38;5;210m",
  "\x1b[38;5;146m",  "\x1b[38;5;79m",   "\x1b[38;5;215m",  "\x1b[38;5;218m",
  "\x1b[38;5;66m",   "\x1b[38;5;95m",   "\x1b[38;5;103m",  "\x1b[38;5;107m",
  "\x1b[38;5;131m",  "\x1b[38;5;136m",  "\x1b[38;5;139m",  "\x1b[38;5;144m",
  "\x1b[38;5;152m",  "\x1b[38;5;175m",  "\x1b[38;5;180m",  "\x1b[38;5;187m",
  "\x1b[38;5;194m",  "\x1b[38;5;223m",
];

export const RESET_FG = "\x1b[39m";

const _assignedColors = new Map<string, string>();
let _colorIndex = 0;

/**
 * Get a deterministic color for the given agent name.
 * Colors are assigned round-robin from the palette on first call.
 */
export function getAgentColor(name: string): string {
  let color = _assignedColors.get(name);
  if (!color) {
    color = AGENT_COLORS[_colorIndex % AGENT_COLORS.length]!;
    _colorIndex++;
    _assignedColors.set(name, color);
  }
  return color;
}

/**
 * Reset all color assignments. Call this on session_shutdown to
 * prevent color state from accumulating across sessions.
 */
export function resetAgentColors(): void {
  _assignedColors.clear();
  _colorIndex = 0;
}
