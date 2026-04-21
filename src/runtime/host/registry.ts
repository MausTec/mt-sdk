/**
 * Host function registry.
 *
 * Maps function names to JS implementations. The WASM engine consults this
 * registry when dispatching host function calls from the C runtime.
 *
 * Two registration paths:
 * 1. Explicit: caller provides name -> HostFunction mapping
 * 2. Auto-stub: generated from an ApiDescriptor manifest (see auto-stub.ts)
 *
 * The registry also tracks permissions for validation. If a plugin doesn't
 * have the required permission, the call is rejected before reaching the stub.
 */

import type { HostFunction, RuntimeValue, HostCallContext } from "../types.js";

export interface RegisteredHostFunction {
  name: string;
  fn: HostFunction;
  permission: string | null;
}

export class HostRegistry {
  private functions = new Map<string, RegisteredHostFunction>();

  /**
   * Register a host function by name.
   */
  register(
    name: string,
    fn: HostFunction,
    permission?: string | null,
  ): void {
    this.functions.set(name, {
      name,
      fn,
      permission: permission ?? null,
    });
  }

  /**
   * Register multiple host functions at once.
   */
  registerAll(entries: Record<string, HostFunction>): void {
    for (const [name, fn] of Object.entries(entries)) {
      this.register(name, fn);
    }
  }

  /**
   * Look up a host function by name.
   */
  get(name: string): RegisteredHostFunction | undefined {
    return this.functions.get(name);
  }

  /**
   * Check if a function is registered.
   */
  has(name: string): boolean {
    return this.functions.has(name);
  }

  /**
   * Dispatch a host function call. Returns the function's return value,
   * or undefined if not found.
   */
  dispatch(
    name: string,
    args: RuntimeValue[],
    context: HostCallContext,
  ): { found: boolean; result: RuntimeValue | number | string | boolean | void } {
    const entry = this.functions.get(name);

    if (!entry) {
      return { found: false, result: undefined };
    }
    
    const result = entry.fn(args, context);
    return { found: true, result };
  }

  /**
   * Get all registered function names.
   */
  names(): string[] {
    return [...this.functions.keys()];
  }

  /**
   * Get all registered entries (for wiring into the WASM engine).
   */
  entries(): RegisteredHostFunction[] {
    return [...this.functions.values()];
  }

  /**
   * Remove all registered functions.
   */
  clear(): void {
    this.functions.clear();
  }
}
