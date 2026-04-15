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

  // --- Remaining expression kinds (stubs) ---
  // TODO: Call -> {funcName: [args]} or bare "funcName" string
  // TODO: Pipe -> action sequence with $_ carry-through
  // TODO: Index -> {getbyte: [target, index], to?: target}
});
