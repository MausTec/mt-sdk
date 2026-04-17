import { describe, it, expect } from "vitest";
import { exprToValue, exprToActions, isSimpleExpr } from "./expressions.js";
import { BlockEmitContext } from "./context.js";
import type { Span } from "../diagnostics.js";
import type { Expr } from "../ast.js";

const SPAN: Span = { line: 1, col: 1, endLine: 1, endCol: 1 };

// --- isSimpleExpr -------------------------------------------------------------

describe("isSimpleExpr", () => {
  it.each([
    { kind: "Literal", varType: "int", value: 1, span: SPAN },
    { kind: "GlobalVar", name: "x", span: SPAN },
    { kind: "Accumulator", span: SPAN },
    { kind: "ErrorCode", span: SPAN },
    { kind: "Identifier", name: "x", span: SPAN },
  ] satisfies Expr[])("returns true for $kind", (expr) => {
    expect(isSimpleExpr(expr)).toBe(true);
  });

  it.each([
    { kind: "ConfigRef", name: "x", span: SPAN },
    { kind: "Binary", op: "+", left: { kind: "Literal", varType: "int", value: 1, span: SPAN }, right: { kind: "Literal", varType: "int", value: 2, span: SPAN }, span: SPAN },
    { kind: "Unary", op: "-", operand: { kind: "Literal", varType: "int", value: 1, span: SPAN }, span: SPAN },
    { kind: "Call", name: "foo", args: [], span: SPAN },
    { kind: "Pipe", head: { kind: "Literal", varType: "int", value: 1, span: SPAN }, steps: [], span: SPAN },
    { kind: "Index", target: { kind: "Identifier", name: "buf", span: SPAN }, index: { kind: "Literal", varType: "int", value: 0, span: SPAN }, span: SPAN },
  ] satisfies Expr[])("returns false for $kind", (expr) => {
    expect(isSimpleExpr(expr)).toBe(false);
  });
});

// --- exprToValue (leaf expressions) -------------------------------------------

describe("exprToValue", () => {
  const ctx = new BlockEmitContext();

  it("Literal number → raw value", () => {
    expect(exprToValue({ kind: "Literal", varType: "int", value: 42, span: SPAN }, ctx)).toBe(42);
  });

  it("Literal string → raw value", () => {
    expect(exprToValue({ kind: "Literal", varType: "string", value: "hello", span: SPAN }, ctx)).toBe("hello");
  });

  it("Literal boolean → raw value", () => {
    expect(exprToValue({ kind: "Literal", varType: "bool", value: true, span: SPAN }, ctx)).toBe(true);
  });

  it("GlobalVar → $name", () => {
    expect(exprToValue({ kind: "GlobalVar", name: "counter", span: SPAN }, ctx)).toBe("$counter");
  });

  it("Accumulator → $_", () => {
    expect(exprToValue({ kind: "Accumulator", span: SPAN }, ctx)).toBe("$_");
  });

  it("ErrorCode → $!", () => {
    expect(exprToValue({ kind: "ErrorCode", span: SPAN }, ctx)).toBe("$!");
  });

  it("Identifier (local var) → $name", () => {
    expect(exprToValue({ kind: "Identifier", name: "x", span: SPAN }, ctx)).toBe("$x");
  });

  it("ConfigRef → null (requires action emission)", () => {
    expect(exprToValue({ kind: "ConfigRef", name: "maxLevel", span: SPAN }, ctx)).toBeNull();
  });

  it("Binary → null (complex expression)", () => {
    const expr: Expr = {
      kind: "Binary", op: "+",
      left: { kind: "Literal", varType: "int", value: 1, span: SPAN },
      right: { kind: "Literal", varType: "int", value: 2, span: SPAN },
      span: SPAN,
    };
    expect(exprToValue(expr, ctx)).toBeNull();
  });

  it("Call → null (complex expression)", () => {
    expect(exprToValue({ kind: "Call", name: "foo", args: [], span: SPAN }, ctx)).toBeNull();
  });
});

describe("exprToActions", () => {
  it("returns empty actions for simple expressions", () => {
    const ctx = new BlockEmitContext();
    const expr = { kind: "Literal" as const, varType: "int" as const, value: 42, span: SPAN };
    expect(exprToActions(expr, ctx)).toEqual([]);
  });

  // --- Case 1: ConfigRef with target ---
  it("ConfigRef with target -> getPluginConfig + to", () => {
    const ctx = new BlockEmitContext();
    const expr: Expr = { kind: "ConfigRef", name: "maxLevel", span: SPAN };
    expect(exprToActions(expr, ctx, "$x")).toEqual([
      { getPluginConfig: "maxLevel", to: "$x" },
    ]);
  });

  // --- Case 2: ConfigRef without target (flows to $_) ---
  it("ConfigRef without target -> getPluginConfig (no to)", () => {
    const ctx = new BlockEmitContext();
    const expr: Expr = { kind: "ConfigRef", name: "maxLevel", span: SPAN };
    expect(exprToActions(expr, ctx)).toEqual([
      { getPluginConfig: "maxLevel" },
    ]);
  });

  // --- Case 3: Binary arithmetic, simple operands, with target ---
  it("Binary + with simple operands and target", () => {
    const ctx = new BlockEmitContext();
    const expr: Expr = {
      kind: "Binary", op: "+",
      left: { kind: "Literal", varType: "int", value: 1, span: SPAN },
      right: { kind: "Literal", varType: "int", value: 2, span: SPAN },
      span: SPAN,
    };
    expect(exprToActions(expr, ctx, "$x")).toEqual([
      { add: [1, 2], to: "$x" },
    ]);
  });

  // --- Case 4: Binary arithmetic, no target ---
  it("Binary + with no target (accumulator)", () => {
    const ctx = new BlockEmitContext();
    const expr: Expr = {
      kind: "Binary", op: "+",
      left: { kind: "Literal", varType: "int", value: 1, span: SPAN },
      right: { kind: "Literal", varType: "int", value: 2, span: SPAN },
      span: SPAN,
    };
    const actions = exprToActions(expr, ctx);
    expect(actions).toEqual([{ add: [1, 2] }]);
    // Verify no "to" key at all
    expect(actions[0]).not.toHaveProperty("to");
  });

  // --- Case 5: Unary negation ---
  it("Unary - emits sub [0, operand]", () => {
    const ctx = new BlockEmitContext();
    const expr: Expr = {
      kind: "Unary", op: "-",
      operand: { kind: "Identifier", name: "x", span: SPAN },
      span: SPAN,
    };
    expect(exprToActions(expr, ctx, "$y")).toEqual([
      { sub: [0, "$x"], to: "$y" },
    ]);
  });

  // --- Case 6: String concatenation ---
  it("Binary <> emits concat", () => {
    const ctx = new BlockEmitContext();
    const expr: Expr = {
      kind: "Binary", op: "<>",
      left: { kind: "Literal", varType: "string", value: "hello", span: SPAN },
      right: { kind: "GlobalVar", name: "name", span: SPAN },
      span: SPAN,
    };
    expect(exprToActions(expr, ctx)).toEqual([
      { concat: ["hello", "$name"] },
    ]);
  });

  // --- Case 7: Nested binary, right complex, $_ free ---
  it("a + (b * c) flattens inner to $_ when accumulator is free", () => {
    const ctx = new BlockEmitContext();
    const expr: Expr = {
      kind: "Binary", op: "+",
      left: { kind: "Identifier", name: "a", span: SPAN },
      right: {
        kind: "Binary", op: "*",
        left: { kind: "Identifier", name: "b", span: SPAN },
        right: { kind: "Identifier", name: "c", span: SPAN },
        span: SPAN,
      },
      span: SPAN,
    };
    expect(exprToActions(expr, ctx, "$result")).toEqual([
      { mul: ["$b", "$c"] },
      { add: ["$a", "$_"], to: "$result" },
    ]);
  });

  // --- Case 8: Both operands complex, $_ free ---
  it("(a + b) * (c + d) flattens first to temp, second to $_", () => {
    const ctx = new BlockEmitContext();
    const expr: Expr = {
      kind: "Binary", op: "*",
      left: {
        kind: "Binary", op: "+",
        left: { kind: "Identifier", name: "a", span: SPAN },
        right: { kind: "Identifier", name: "b", span: SPAN },
        span: SPAN,
      },
      right: {
        kind: "Binary", op: "+",
        left: { kind: "Identifier", name: "c", span: SPAN },
        right: { kind: "Identifier", name: "d", span: SPAN },
        span: SPAN,
      },
      span: SPAN,
    };
    expect(exprToActions(expr, ctx, "$result")).toEqual([
      { add: ["$a", "$b"], to: "$__t0" },
      { add: ["$c", "$d"] },
      { mul: ["$__t0", "$_"], to: "$result" },
    ]);
    expect(ctx.getTempVars()).toEqual(["__t0"]);
  });

  // --- Case 9: ConfigRef as operand, $_ free ---
  it("@maxLevel * $speed flattens ConfigRef to $_ when free", () => {
    const ctx = new BlockEmitContext();
    const expr: Expr = {
      kind: "Binary", op: "*",
      left: { kind: "ConfigRef", name: "maxLevel", span: SPAN },
      right: { kind: "GlobalVar", name: "speed", span: SPAN },
      span: SPAN,
    };
    expect(exprToActions(expr, ctx, "$result")).toEqual([
      { getPluginConfig: "maxLevel" },
      { mul: ["$_", "$speed"], to: "$result" },
    ]);
  });

  // --- Case 10: ConfigRef as operand, $_ reserved (in pipe) ---
  it("@maxLevel * $speed uses temp when accumulator is reserved", () => {
    const ctx = new BlockEmitContext();
    ctx.accumulatorReserved = true;
    const expr: Expr = {
      kind: "Binary", op: "*",
      left: { kind: "ConfigRef", name: "maxLevel", span: SPAN },
      right: { kind: "GlobalVar", name: "speed", span: SPAN },
      span: SPAN,
    };
    expect(exprToActions(expr, ctx, "$result")).toEqual([
      { getPluginConfig: "maxLevel", to: "$__t0" },
      { mul: ["$__t0", "$speed"], to: "$result" },
    ]);
    expect(ctx.getTempVars()).toEqual(["__t0"]);
  });

  // --- Call: host/builtin functions ---

  describe("Call (host/builtin)", () => {
    it("emits zero-arg call as empty array", () => {
      const ctx = new BlockEmitContext();
      const expr: Expr = { kind: "Call", name: "millis", args: [], span: SPAN };
      expect(exprToActions(expr, ctx, "$t")).toEqual([
        { millis: [], to: "$t" },
      ]);
    });

    it("emits single-arg call as bare value", () => {
      const ctx = new BlockEmitContext();
      const expr: Expr = {
        kind: "Call", name: "bleWrite", args: [
          { kind: "GlobalVar", name: "cmd", span: SPAN },
        ], span: SPAN,
      };
      expect(exprToActions(expr, ctx)).toEqual([
        { bleWrite: "$cmd" },
      ]);
    });

    it("emits multi-arg call as array", () => {
      const ctx = new BlockEmitContext();
      const expr: Expr = {
        kind: "Call", name: "random", args: [
          { kind: "Literal", varType: "int", value: 0, span: SPAN },
          { kind: "Literal", varType: "int", value: 255, span: SPAN },
        ], span: SPAN,
      };
      expect(exprToActions(expr, ctx, "$r")).toEqual([
        { random: [0, 255], to: "$r" },
      ]);
    });

    it("resolves complex args with last-arg-gets-accumulator", () => {
      const ctx = new BlockEmitContext();
      const expr: Expr = {
        kind: "Call", name: "someHost", args: [
          { kind: "ConfigRef", name: "a", span: SPAN },
          { kind: "ConfigRef", name: "b", span: SPAN },
        ], span: SPAN,
      };
      expect(exprToActions(expr, ctx)).toEqual([
        { getPluginConfig: "a", to: "$__t0" },
        { getPluginConfig: "b" },
        { someHost: ["$__t0", "$_"] },
      ]);
    });
  });

  // --- Call: plugin-local functions ---

  describe("Call (plugin-local)", () => {
    it("emits @-prefixed call with positional arg", () => {
      const localFns = new Map([["mapSpeed", ["arg"]]]);
      const ctx = new BlockEmitContext(localFns);
      const expr: Expr = {
        kind: "Call", name: "mapSpeed", args: [
          { kind: "GlobalVar", name: "speed", span: SPAN },
        ], span: SPAN,
      };
      expect(exprToActions(expr, ctx)).toEqual([
        { "@mapSpeed": "$speed" },
      ]);
    });

    it("emits @-prefixed call with target", () => {
      const localFns = new Map([["mapSpeed", ["arg"]]]);
      const ctx = new BlockEmitContext(localFns);
      const expr: Expr = {
        kind: "Call", name: "mapSpeed", args: [
          { kind: "Literal", varType: "int", value: 128, span: SPAN },
        ], span: SPAN,
      };
      expect(exprToActions(expr, ctx, "$level")).toEqual([
        { "@mapSpeed": 128, to: "$level" },
      ]);
    });

    it("emits @-prefixed call with multiple positional args", () => {
      const localFns = new Map([["forward", ["from", "cmdlen"]]]);
      const ctx = new BlockEmitContext(localFns);
      const expr: Expr = {
        kind: "Call", name: "forward", args: [
          { kind: "GlobalVar", name: "i", span: SPAN },
          { kind: "GlobalVar", name: "len", span: SPAN },
        ], span: SPAN,
      };
      expect(exprToActions(expr, ctx, "$i")).toEqual([
        { "@forward": ["$i", "$len"], to: "$i" },
      ]);
    });

    it("resolves complex args into prereqs for local calls", () => {
      const localFns = new Map([["scale", ["val"]]]);
      const ctx = new BlockEmitContext(localFns);
      const expr: Expr = {
        kind: "Call", name: "scale", args: [
          { kind: "Binary", op: "+", left: { kind: "Literal", varType: "int", value: 1, span: SPAN }, right: { kind: "Literal", varType: "int", value: 2, span: SPAN }, span: SPAN },
        ], span: SPAN,
      };
      expect(exprToActions(expr, ctx)).toEqual([
        { add: [1, 2] },
        { "@scale": "$_" },
      ]);
    });

    it("emits zero-arg local call with empty array", () => {
      const localFns = new Map([["reset", []]]);
      const ctx = new BlockEmitContext(localFns);
      const expr: Expr = { kind: "Call", name: "reset", args: [], span: SPAN };
      expect(exprToActions(expr, ctx)).toEqual([
        { "@reset": [] },
      ]);
    });

    it("reports error for too many args", () => {
      const localFns = new Map([["bump", ["val"]]]);
      const ctx = new BlockEmitContext(localFns);
      const expr: Expr = {
        kind: "Call", name: "bump", args: [
          { kind: "Literal", varType: "int", value: 1, span: SPAN },
          { kind: "Literal", varType: "int", value: 2, span: SPAN },
        ], span: SPAN,
      };
      exprToActions(expr, ctx);
      expect(ctx.diagnostics).toContainEqual(
        expect.objectContaining({ level: "error", message: expect.stringContaining("expects 1 argument") }),
      );
    });

    it("uses last-arg-gets-accumulator for local calls too", () => {
      const localFns = new Map([["blend", ["a", "b"]]]);
      const ctx = new BlockEmitContext(localFns);
      const expr: Expr = {
        kind: "Call", name: "blend", args: [
          { kind: "ConfigRef", name: "x", span: SPAN },
          { kind: "ConfigRef", name: "y", span: SPAN },
        ], span: SPAN,
      };
      expect(exprToActions(expr, ctx)).toEqual([
        { getPluginConfig: "x", to: "$__t0" },
        { getPluginConfig: "y" },
        { "@blend": ["$__t0", "$_"] },
      ]);
    });
  });

  // --- Pipe -------------------------------------------------------------------

  describe("Pipe", () => {
    it("emits head → $_ then steps in chain, final step to target", () => {
      const ctx = new BlockEmitContext();
      const expr: Expr = {
        kind: "Pipe",
        head: { kind: "Literal", varType: "int", value: 5, span: SPAN },
        steps: [
          {
            call: { kind: "Call", name: "to_string", args: [], span: SPAN },
            carriedType: "unknown",
          },
          {
            call: { kind: "Call", name: "concat", args: [
              { kind: "Literal", varType: "string", value: "prefix:", span: SPAN },
              { kind: "Accumulator", span: SPAN },
            ], span: SPAN },
            carriedType: "unknown",
          },
        ],
        span: SPAN,
      };
      expect(exprToActions(expr, ctx, "$result")).toEqual<any>([
        { set: 5 },                                   // head → $_
        { to_string: [] },                              // step 1 → $_
        { concat: ["prefix:", "$_"], to: "$result" },  // step 2 → target
      ]);
    });

    it("single-step pipe sends head to $_, step to target", () => {
      const ctx = new BlockEmitContext();
      const expr: Expr = {
        kind: "Pipe",
        head: { kind: "GlobalVar", name: "val", span: SPAN },
        steps: [
          {
            call: { kind: "Call", name: "round", args: [], span: SPAN },
            carriedType: "unknown",
          },
        ],
        span: SPAN,
      };
      expect(exprToActions(expr, ctx, "$out")).toEqual([
        { set: "$val" },       // head → $_
        { round: [], to: "$out" },  // step → target
      ]);
    });
  });

  // --- Index (getbyte) --------------------------------------------------------

  describe("Index", () => {
    it("emits getbyte for simple index access", () => {
      const ctx = new BlockEmitContext();
      const expr: Expr = {
        kind: "Index",
        target: { kind: "Identifier", name: "tape", span: SPAN },
        index: { kind: "Literal", varType: "int", value: 3, span: SPAN },
        span: SPAN,
      };
      expect(exprToActions(expr, ctx, "$out")).toEqual([
        { getbyte: ["$tape", 3], to: "$out" },
      ]);
    });

    it("pre-evaluates complex index to temp", () => {
      const ctx = new BlockEmitContext();
      const expr: Expr = {
        kind: "Index",
        target: { kind: "Identifier", name: "arr", span: SPAN },
        index: {
          kind: "Binary",
          op: "+",
          left: { kind: "Identifier", name: "i", span: SPAN },
          right: { kind: "Literal", varType: "int", value: 1, span: SPAN },
          span: SPAN,
        },
        span: SPAN,
      };
      expect(exprToActions(expr, ctx, "$val")).toEqual([
        { add: ["$i", 1], to: "$__t0" },
        { getbyte: ["$arr", "$__t0"], to: "$val" },
      ]);
    });

    it("getbyte with global array and global index", () => {
      const ctx = new BlockEmitContext();
      const expr: Expr = {
        kind: "Index",
        target: { kind: "GlobalVar", name: "buffer", span: SPAN },
        index: { kind: "GlobalVar", name: "ptr", span: SPAN },
        span: SPAN,
      };
      expect(exprToActions(expr, ctx)).toEqual([
        { getbyte: ["$buffer", "$ptr"] },
      ]);
    });
  });
});
