/**
 * Default host function stubs.
 *
 * Trace-capturing implementations of common host functions. Each stub
 * records the call (name + args) and returns a sensible default value.
 *
 * These exist because the runtime needs *something* to call so execution 
 * can proceed. These are used when a manifest declares host functions but the caller
 * doesn't provide explicit implementations.
 */

import type { HostFunction, RuntimeValue, HostCallContext } from "../types.js";

/**
 * Create a stub that logs calls and returns a typed default.
 * The returned value type matches what the real function would return.
 */
function makeStub(
  defaultReturn: RuntimeValue = { type: "int", value: 0 },
): HostFunction {
  return (_args: RuntimeValue[], _context: HostCallContext) => {
    return defaultReturn;
  };
}

/**
 * Built-in stubs for host functions commonly found across products.
 * 
 * More stubs can be added here as needed, or product runtimes can start shipping
 * with their own sets of stubs. In every language. For every platform. This is dumb.
 * 
 * WHAT IF ! We bundled the stubs in a WASM module specific to each product?! Overkill.
 */
export const defaultStubs: Record<string, HostFunction> = {
  // System
  log: makeStub({ type: "int", value: 0 }),
  delay: makeStub({ type: "int", value: 0 }),
  random: (_args, _ctx) => ({
    type: "int",
    value: Math.floor(Math.random() * 256),
  }),
  millis: (_args, ctx) => ({
    type: "int",
    value: ctx.simulatedMs,
  }),

  // BLE
  ble_write: makeStub({ type: "bool", value: true }),
  ble_write_no_response: makeStub({ type: "bool", value: true }),
};
