import { describe, it, expect } from "vitest";
import { EmitContext, BlockEmitContext } from "./context.js";

describe("EmitContext", () => {
  it("starts with an empty diagnostics list", () => {
    const ctx = new EmitContext();
    expect(ctx.diagnostics).toEqual([]);
  });

  it("collects errors", () => {
    const ctx = new EmitContext();
    ctx.error("something broke");
    expect(ctx.diagnostics).toHaveLength(1);
    expect(ctx.diagnostics[0]).toMatchObject({
      level: "error",
      message: "something broke",
    });
  });

  it("collects warnings", () => {
    const ctx = new EmitContext();
    ctx.warning("heads up");
    expect(ctx.diagnostics).toHaveLength(1);
    expect(ctx.diagnostics[0]).toMatchObject({
      level: "warning",
      message: "heads up",
    });
  });

  it("preserves span information", () => {
    const ctx = new EmitContext();
    const span = { line: 3, col: 5, endLine: 3, endCol: 10 };
    ctx.error("bad thing", span);
    expect(ctx.diagnostics[0]!.span).toEqual(span);
  });

  it("accumulates multiple diagnostics in order", () => {
    const ctx = new EmitContext();
    ctx.error("first");
    ctx.warning("second");
    ctx.error("third");
    expect(ctx.diagnostics.map((d) => d.message)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

// --- BlockEmitContext ----------------------------------------------------------

describe("BlockEmitContext", () => {
  it("inherits EmitContext diagnostics", () => {
    const ctx = new BlockEmitContext();
    ctx.error("bad");
    ctx.warning("meh");
    expect(ctx.diagnostics).toHaveLength(2);
  });

  describe("temp allocation", () => {
    it("allocates sequential $__tN references", () => {
      const ctx = new BlockEmitContext();
      expect(ctx.allocTemp()).toBe("$__t0");
      expect(ctx.allocTemp()).toBe("$__t1");
      expect(ctx.allocTemp()).toBe("$__t2");
    });

    it("resets counter but preserves high-water mark", () => {
      const ctx = new BlockEmitContext();
      ctx.allocTemp(); // __t0
      ctx.allocTemp(); // __t1
      ctx.resetTemps();
      expect(ctx.allocTemp()).toBe("$__t0"); // recycled
      expect(ctx.getTempVars()).toEqual(["__t0", "__t1"]); // high water = 2
    });

    it("returns empty vars when no temps allocated", () => {
      const ctx = new BlockEmitContext();
      expect(ctx.getTempVars()).toEqual([]);
    });

    it("tracks high-water across multiple reset cycles", () => {
      const ctx = new BlockEmitContext();
      // Statement 1: needs 2 temps
      ctx.allocTemp();
      ctx.allocTemp();
      ctx.resetTemps();
      // Statement 2: needs 3 temps
      ctx.allocTemp();
      ctx.allocTemp();
      ctx.allocTemp();
      ctx.resetTemps();
      // Statement 3: needs 1 temp
      ctx.allocTemp();
      ctx.resetTemps();

      expect(ctx.getTempVars()).toEqual(["__t0", "__t1", "__t2"]);
    });

    it("getTempVars returns names without $ prefix", () => {
      const ctx = new BlockEmitContext();
      ctx.allocTemp();
      const vars = ctx.getTempVars();
      expect(vars[0]).toBe("__t0");
      expect(vars[0]!.startsWith("$")).toBe(false);
    });
  });

  describe("accumulatorReserved", () => {
    it("defaults to false", () => {
      const ctx = new BlockEmitContext();
      expect(ctx.accumulatorReserved).toBe(false);
    });

    // this feels silly but it's a placeholder for a future reserveAccumulator() freeAccumulator() call
    it("can be toggled", () => {
      const ctx = new BlockEmitContext();
      ctx.accumulatorReserved = true;
      expect(ctx.accumulatorReserved).toBe(true);
      ctx.accumulatorReserved = false;
      expect(ctx.accumulatorReserved).toBe(false);
    });
  });
});
