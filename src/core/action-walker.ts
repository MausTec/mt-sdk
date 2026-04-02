/**
 * Static analysis: walk the mt-actions DSL to discover host function calls
 * and event subscriptions without executing anything.
 *
 * Ported from obsolete eom-sdk validation/actions.py
 * 
 * Given that the Typescript implementation of this library is set to use the compiled
 * WASM module for runtime validation, this static analysis is only used for linting and 
 * editor feedback. It is not an execution layer, and does not need to be perfectly 
 * accurate — just good enough to catch common mistakes and provide helpful warnings.
 * 
 */

// DSL control-flow keys — not host function calls
const CONTROL_FLOW_KEYS = new Set([
  "if", "while", "then", "else", "all", "any",
  "eq", "neq", "gt", "lt", "gte", "lte",
  "not", "and", "or",
]);

// DSL built-in functions — not host function calls
const BUILTIN_KEYS = new Set([
  "set", "add", "sub", "mul", "div", "mod",
  "inc", "dec", "concat", "substr", "strlen",
  "charat", "getbyte", "setbyte", "strcmp",
  "vars", "actions",
]);

const HOST_FN_RE = /^[a-zA-Z_]\w*$/;

/**
 * Recursively scan an object for host function calls, adding them to the output set.
 * Skips control flow keys, built-in functions, variable references ($var), and
 * user function calls (@fn).
 */
function scanActions(obj: unknown, out: Set<string>): void {
  if (obj == null) return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      scanActions(item, out);
    }
    return;
  }

  if (typeof obj !== "object") return;

  const record = obj as Record<string, unknown>;

  for (const [key, value] of Object.entries(record)) {
    // Skip control flow and builtins
    if (CONTROL_FLOW_KEYS.has(key) || BUILTIN_KEYS.has(key)) {
      scanActions(value, out);
      continue;
    }

    // Skip variable references ($var) and user function calls (@fn)
    if (key.startsWith("$") || key.startsWith("@")) {
      scanActions(value, out);
      continue;
    }

    // Skip structural keys used inside "set" and "vars"
    // These are handled by their parent context
    if (key === "set" || key === "vars") {
      // Don't descend into value keys — they're variable names, not functions
      if (value != null && typeof value === "object" && !Array.isArray(value)) {
        for (const v of Object.values(value as Record<string, unknown>)) {
          scanActions(v, out);
        }
      }
      continue;
    }

    // If key looks like a function name, it's a host function call
    if (HOST_FN_RE.test(key)) {
      out.add(key);
    }

    // Recurse into the value
    scanActions(value, out);
  }
}

/**
 * Collect all host function calls used in a plugin's actions.
 * @param plugin The plugin object to scan.
 * @returns A set of host function call names.
 */
export function collectHostFunctionCalls(
  plugin: Record<string, unknown>,
): Set<string> {
  const calls = new Set<string>();

  // Scan functions
  if (plugin["functions"] != null && typeof plugin["functions"] === "object") {
    for (const fnDef of Object.values(plugin["functions"] as Record<string, unknown>)) {
      if (fnDef != null && typeof fnDef === "object") {
        const def = fnDef as Record<string, unknown>;
        scanActions(def["actions"], calls);
      }
    }
  }

  // Scan events
  if (plugin["events"] != null && typeof plugin["events"] === "object") {
    for (const evDef of Object.values(plugin["events"] as Record<string, unknown>)) {
      if (evDef != null && typeof evDef === "object") {
        const def = evDef as Record<string, unknown>;
        scanActions(def["actions"], calls);
      }
    }
  }

  return calls;
}

/**
 * Collect all event names a plugin subscribes to.
 * @param plugin The plugin object to scan.
 * @returns A set of event names.
 */
export function collectEventSubscriptions(
  plugin: Record<string, unknown>,
): Set<string> {
  const events = new Set<string>();

  if (plugin["events"] != null && typeof plugin["events"] === "object") {
    for (const evName of Object.keys(plugin["events"] as Record<string, unknown>)) {
      events.add(evName);
    }
  }

  return events;
}
