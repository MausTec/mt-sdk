import { describe, it, expect } from "vitest";
import { EmitContext } from "./context.js";

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
