import type { Diagnostic, ApiDescriptor } from "./types.js";
import { collectHostFunctionCalls, collectEventSubscriptions } from "./action-walker.js";

/**
 * Tier 3 validation: cross-reference plugin against a firmware API descriptor.
 * Checks that events and host functions actually exist, and that required
 * permissions are declared.
 */
export function apiCheck(
  plugin: Record<string, unknown>,
  manifest: ApiDescriptor,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Build lookup maps from manifest
  const knownEvents = new Map(manifest.events.map((e) => [e.name, e]));
  const knownFunctions = new Map(manifest.functions.map((f) => [f.name, f]));
  const declaredPermissions = new Set(
    Array.isArray(plugin["permissions"]) ? (plugin["permissions"] as string[]) : [],
  );

  // Check event subscriptions
  const usedEvents = collectEventSubscriptions(plugin);
  for (const evName of usedEvents) {
    const descriptor = knownEvents.get(evName);
    if (!descriptor) {
      diagnostics.push({
        tier: "api",
        level: "warning",
        path: `events.${evName}`,
        message: `Event "${evName}" is not defined in ${manifest.product} v${manifest.version}`,
      });
      continue;
    }

    if (descriptor.permission && !hasPermission(declaredPermissions, descriptor.permission)) {
      diagnostics.push({
        tier: "api",
        level: "error",
        path: `events.${evName}`,
        message: `Event "${evName}" requires permission "${descriptor.permission}" which is not declared`,
      });
    }
  }

  // Check host function calls
  const usedFunctions = collectHostFunctionCalls(plugin);
  for (const fnName of usedFunctions) {
    const descriptor = knownFunctions.get(fnName);
    if (!descriptor) {
      diagnostics.push({
        tier: "api",
        level: "warning",
        message: `Host function "${fnName}" is not defined in ${manifest.product} v${manifest.version}`,
      });
      continue;
    }

    if (descriptor.permission && !hasPermission(declaredPermissions, descriptor.permission)) {
      diagnostics.push({
        tier: "api",
        level: "error",
        message: `Host function "${fnName}" requires permission "${descriptor.permission}" which is not declared`,
      });
    }
  }

  return diagnostics;
}

/**
 * Check if the declared set includes the required permission (supports wildcards).
 * @param declared The set of declared permissions.
 * @param required The required permission to check.
 * @returns True if the required permission is included in the declared set, false otherwise.
 */
function hasPermission(declared: Set<string>, required: string): boolean {
  if (declared.has(required)) return true;

  // Check wildcard: "ble:*" matches "ble:write"
  const colonIndex = required.indexOf(":");
  if (colonIndex >= 0) {
    const resource = required.substring(0, colonIndex);
    if (declared.has(`${resource}:*`)) return true;
  }

  return false;
}
