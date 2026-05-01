/**
 * Trace formatting: convert raw TraceEvents into human-readable or
 * structured output for CLI display and JSON export.
 */

import type { TraceEvent } from "./types.js";

/**
 * Format a trace event as a single human-readable line.
 */
export function formatTraceEvent(event: TraceEvent): string {
  const ts = `[${String(event.timestamp).padStart(6)}ms]`;
  const plugin = `P${event.pluginId}`;

  switch (event.kind) {
    case "host_call": {
      const detail = event.detail as { args?: unknown[] } | undefined;
      const args = detail?.args ? formatArgs(detail.args) : "";
      return `${ts} ${plugin} CALL  ${event.name}(${args})`;
    }
    case "host_return": {
      const detail = event.detail as { result?: unknown } | undefined;
      const result = detail?.result !== undefined ? ` -> ${formatValue(detail.result)}` : "";
      return `${ts} ${plugin} RET   ${event.name}${result}`;
    }
    case "variable_set": {
      const detail = event.detail as { value?: unknown } | undefined;
      return `${ts} ${plugin} SET   $${event.name} = ${formatValue(detail?.value)}`;
    }
    case "variable_get":
      return `${ts} ${plugin} GET   $${event.name}`;
    case "condition_eval": {
      const detail = event.detail as { result?: boolean } | undefined;
      const result = detail?.result !== undefined ? ` -> ${detail.result}` : "";
      return `${ts} ${plugin} COND  ${event.name}${result}`;
    }
    case "scope_push":
      return `${ts} ${plugin} PUSH  ${event.name}`;
    case "scope_pop":
      return `${ts} ${plugin} POP   ${event.name}`;
    case "action_enter":
      return `${ts} ${plugin} >     ${event.name}`;
    case "action_exit":
      return `${ts} ${plugin} <     ${event.name}`;
    case "event_enter": {
      const detail = event.detail as { result?: number } | undefined;
      return `${ts} ${plugin} EVT>  ${event.name}(${detail?.result ?? 0})`;
    }
    case "event_exit": {
      const detail = event.detail as { result?: number } | undefined;
      return `${ts} ${plugin} EVT<  ${event.name} -> ${detail?.result ?? 0}`;
    }
    case "fn_enter": {
      const detail = event.detail as { result?: number } | undefined;
      return `${ts} ${plugin} FN>   @${event.name}/${detail?.result ?? 0}`;
    }
    case "fn_exit": {
      const detail = event.detail as { result?: number } | undefined;
      return `${ts} ${plugin} FN<   @${event.name} -> ${detail?.result ?? 0}`;
    }
    case "cond_eval": {
      const detail = event.detail as { result?: number } | undefined;
      return `${ts} ${plugin} COND  ${event.name} -> ${detail?.result ? "true" : "false"}`;
    }
    case "loop_iter": {
      const detail = event.detail as { result?: number } | undefined;
      return `${ts} ${plugin} ITER  ${event.name} #${detail?.result ?? 0}`;
    }
    case "note": {
      const detail = event.detail as { result?: number } | undefined;
      return `${ts} ${plugin} NOTE  ${event.name}${detail?.result ? ` (${detail.result})` : ""}`;
    }
    case "error": {
      // detail.errorKind carries the structured kebab-case kind ("var-not-set", etc.).
      // detail.result mirrors the raw enum ordinal for callers that need it.
      const detail = event.detail as { errorKind?: string; result?: number } | undefined;
      const kind = detail?.errorKind ?? "unknown";
      return `${ts} ${plugin} ERR!  [${kind}] ${event.name}`;
    }
    case "function_call":
      return `${ts} ${plugin} CALL  @${event.name}`;
    case "function_return":
      return `${ts} ${plugin} RET   @${event.name}`;
    default:
      return `${ts} ${plugin} ???   ${event.kind} ${event.name}`;
  }
}

/**
 * Format a full trace as a multiline human-readable string.
 */
export function formatTrace(events: readonly TraceEvent[]): string {
  return events.map(formatTraceEvent).join("\n");
}

/**
 * Format a full trace as a JSON-serializable array (for machine consumption).
 */
export function traceToJson(events: readonly TraceEvent[]): unknown[] {
  return events.map((e) => ({
    kind: e.kind,
    plugin: e.pluginId,
    name: e.name,
    detail: e.detail,
    timestamp: e.timestamp,
  }));
}

// --- Helpers -----------------------------------------------------------------

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "nil";
  
  if (typeof value === "string") return JSON.stringify(value);

  if (typeof value === "object" && value !== null && "value" in value) {
    return formatValue((value as { value: unknown }).value);
  }

  return String(value);
}

function formatArgs(args: unknown[]): string {
  return args.map(formatValue).join(", ");
}
