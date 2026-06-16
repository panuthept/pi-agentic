/**
 * Legacy widget module — migrated to execution-timeline-widget.
 *
 * The subagent bar widget has been replaced by the execution-timeline-widget
 * (execution-timeline-widget.ts). This file exists solely for backward
 * compatibility: any external import of `reinstallWidget` from this module
 * will resolve to a no-op.
 */
export function reinstallWidget(_ctx: { ui: { setWidget: (key: string, content: any, options?: any) => void } }): void {
  // Widget removed — subagent execution status is now rendered by the
  // execution-timeline-widget module. This export is kept so that any external
  // code importing from "./widget.js" does not break at compile time.
}
