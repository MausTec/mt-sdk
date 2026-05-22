/**
 * Trace collector.
 *
 * Accumulates TraceEvents emitted by the WASM engine's trace observer.
 * Host call/return events are emitted by the engine's hostDispatch path
 * via the same observer, so this collector is the single sink.
 */

import type { TraceEvent, TraceObserver } from "./types.js";

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
