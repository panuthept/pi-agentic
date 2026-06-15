/**
 * Shared runtime types for the subagent tool.
 */

export interface ToolCallEntry {
  id: string;
  name: string;
  argSummary: string;
  result?: string;
  isError?: boolean;
  durMs?: number;
}

export type ExecutionEvent =
  | { type: "tool_start"; toolCallId: string; toolName: string; argSummary: string; timestamp: number }
  | { type: "text_delta"; text: string; timestamp: number }
  | { type: "tool_end"; toolCallId: string; result: string; isError: boolean; durMs: number; timestamp: number };

export interface RunResult {
  output: string;
  exitCode: number;
  error?: string;
  model?: string;
  toolCalls: ToolCallEntry[];
  executionEvents?: ExecutionEvent[];
  usage: { input: number; output: number; cost: number; turns: number };
}

export interface AgentRowStatus {
  name: string;
  taskSummary: string;
  status: "pending" | "running" | "done" | "error";
  durMs?: number;
  startOffsetMs?: number;
  batchStartTime?: number;
  usage?: { input: number; output: number; cost: number; turns: number };
  toolCalls?: ToolCallEntry[];
  responseText?: string;
}

export interface SubagentDetails {
  mode?: "single" | "parallel";
  agentName?: string;
  task?: string;
  parallelAgents?: AgentRowStatus[];
  usage: RunResult["usage"];
  running: boolean;
  elapsedMs?: number;
  model?: string;
  backgroundJobId?: string;
  toolCalls: ToolCallEntry[];
  executionEvents?: ExecutionEvent[];
}

export type OnUpdate = (partial: {
  content: [{ type: "text"; text: string }];
  details: unknown;
}) => void;

export interface TimelineEntry {
  /** Unique entry ID (e.g. "tl-1") */
  id: string;
  /** Agent name (e.g. "worker", "scout") */
  agent: string;
  /** Task description that was delegated */
  task: string;
  /** Timestamp (Date.now()) when execution started */
  startTime: number;
  /** Timestamp when execution finished (only if status != running) */
  endTime?: number;
  /** Duration in milliseconds */
  duration?: number;
  /** Current execution status */
  status: "running" | "success" | "error";
  /** Execution mode */
  mode: "single" | "parallel";
  /** Number of tool calls made */
  toolCount: number;
  /** Token usage stats */
  usage?: { input: number; output: number; cost: number; turns: number };
}
