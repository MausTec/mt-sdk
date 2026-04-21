/**
 * Auto-stub generation from ApiDescriptor manifests.
 *
 * Given a manifest (from mt-runtimes), generates a HostFunction stub for
 * every declared host function. Each stub:
 * - Returns a typed default based on the function's return type descriptor
 * - Can be overridden per-function by explicit entries
 *
 * This is the bridge between mt-runtimes' declarative manifests and the
 * runtime's executable host function registry.
 */

import type { ApiDescriptor, HostFunctionDescriptor } from "../../core/types.js";
import type { HostFunction, RuntimeValue, HostCallContext } from "../types.js";
import type { HostRegistry } from "./registry.js";
import { defaultStubs } from "./stubs.js";

/**
 * Return type string -> default RuntimeValue.
 * TODO: Array / bytes handling isn't currently supported
 */
function defaultForReturnType(
  returns: HostFunctionDescriptor["returns"],
): RuntimeValue {
  if (!returns) return { type: "int", value: 0 };

  switch (returns.type) {
    case "int":
      return { type: "int", value: 0 };
    case "float":
      return { type: "float", value: 0.0 };
    case "string":
      return { type: "string", value: "" };
    case "bool":
      return { type: "bool", value: false };
    case "bytes":
      return { type: "int", value: 0 };
    default:
      return { type: "int", value: 0 };
  }
}

/**
 * Generate a generic stub for a host function descriptor.
 */
function makeAutoStub(descriptor: HostFunctionDescriptor): HostFunction {
  const defaultReturn = defaultForReturnType(descriptor.returns);
  
  return (_args: RuntimeValue[], _context: HostCallContext) => {
    return defaultReturn;
  };
}

/**
 * Populate a HostRegistry from an ApiDescriptor manifest.
 *
 * For each function in the manifest:
 * 1. If an explicit override is provided, use that
 * 2. Else if a built-in default stub exists (stubs.ts), use that
 * 3. Else generate a generic auto-stub from the return type
 *
 * Returns the list of function names that were registered.
 */
export function registerFromManifest(
  registry: HostRegistry,
  manifest: ApiDescriptor,
  overrides?: Record<string, HostFunction>,
): string[] {
  const registered: string[] = [];

  for (const fn of manifest.functions) {
    const override = overrides?.[fn.name];
    const builtin = defaultStubs[fn.name];
    const stub = override ?? builtin ?? makeAutoStub(fn);

    registry.register(fn.name, stub, fn.permission);
    registered.push(fn.name);
  }

  return registered;
}
