import { describe, it, expect } from "vitest";
import { collectHostFunctionCalls, collectEventSubscriptions } from "./action-walker.js";

describe("collectHostFunctionCalls", () => {
  it("finds host function calls in event actions", () => {
    const plugin = {
      events: {
        tick: {
          actions: [{ log: "hello" }],
        },
      },
    };
    const calls = collectHostFunctionCalls(plugin);
    expect(calls.has("log")).toBe(true);
  });

  it("excludes DSL builtins", () => {
    const plugin = {
      events: {
        tick: {
          actions: [{ set: { "$speed": { add: ["$speed", 1] } } }],
        },
      },
    };
    const calls = collectHostFunctionCalls(plugin);
    expect(calls.has("set")).toBe(false);
    expect(calls.has("add")).toBe(false);
  });

  it("excludes control flow keys", () => {
    const plugin = {
      events: {
        tick: {
          actions: [
            {
              if: { eq: ["$mode", 1] },
              then: [{ log: "mode is 1" }],
              else: [{ log: "mode is not 1" }],
            },
          ],
        },
      },
    };
    const calls = collectHostFunctionCalls(plugin);
    expect(calls.has("if")).toBe(false);
    expect(calls.has("eq")).toBe(false);
    expect(calls.has("then")).toBe(false);
    expect(calls.has("else")).toBe(false);
    expect(calls.has("log")).toBe(true);
  });

  it("excludes variable references", () => {
    const plugin = {
      functions: {
        myFunc: {
          actions: [{ set: { "$count": 0 } }, { log: "$count" }],
        },
      },
    };
    const calls = collectHostFunctionCalls(plugin);
    expect(calls.has("$count")).toBe(false);
    expect(calls.has("log")).toBe(true);
  });
});

describe("collectEventSubscriptions", () => {
  it("returns event names", () => {
    const plugin = {
      events: {
        tick: { actions: [] },
        modeSet: { actions: [] },
      },
    };
    const events = collectEventSubscriptions(plugin);
    expect(events).toEqual(new Set(["tick", "modeSet"]));
  });
});
