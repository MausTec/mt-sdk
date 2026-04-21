/**
 * Trace collector.
 *
 * Accumulates TraceEvents emitted by the WASM engine's trace observer and
 * host function dispatch. Provides the data backing for Runtime.getTrace().
 *
 * The collector serves as both the TraceObserver callback and a queryable
 * store of events for the current session.
 */

import type { TraceEvent, TraceObserver, RuntimeValue, HostCallContext } from "./types.js";

export class TraceCollector {
  private events: TraceEvent[] = [];
  private startMs = 0;

  /**
   * Returns a TraceObserver callback that feeds into this collector.
   * Wire this into WasmEngine.setTraceObserver().
   */
  observer(): TraceObserver {
    return (event: TraceEvent) => {
      this.events.push(event);
    };
  }

  /**
   * Record a host function call from the JS dispatch side.
   * This captures calls that pass through the HostRegistry, complementing
   * the WASM-side trace events.
   */
  recordHostCall(
    pluginId: number,
    name: string,
    args: RuntimeValue[],
    result: RuntimeValue | void,
    context: HostCallContext,
  ): void {
    this.events.push({
      kind: "host_call",
      pluginId,
      name,
      detail: { args, result },
      timestamp: context.simulatedMs,
    });
  }

  /**
   * Record a host function return.
   */
  recordHostReturn(
    pluginId: number,
    name: string,
    result: RuntimeValue | void,
    context: HostCallContext,
  ): void {
    this.events.push({
      kind: "host_return",
      pluginId,
      name,
      detail: { result },
      timestamp: context.simulatedMs,
    });
  }

  /**
   * Get all collected events (read-only snapshot).
   */
  getEvents(): readonly TraceEvent[] {
    return this.events;
  }

  /**
   * Get events filtered by plugin.
   */
  getEventsForPlugin(pluginId: number): TraceEvent[] {
    return this.events.filter((e) => e.pluginId === pluginId);
  }

  /**
   * Get events filtered by kind.
   */
  getEventsByKind(kind: TraceEvent["kind"]): TraceEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }

  /**
   * Clear all collected events.
   */
  clear(): void {
    this.events = [];
    this.startMs = 0;
  }

  /**
   * Number of collected events.
   */
  get length(): number {
    return this.events.length;
  }
}
