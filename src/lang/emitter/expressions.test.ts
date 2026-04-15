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
  it("returns empty actions (not yet implemented)", () => {
    const ctx = new BlockEmitContext();
    const expr = { kind: "Literal" as const, varType: "int" as const, value: 42, span: SPAN };
    expect(exprToActions(expr, ctx)).toEqual([]);
  });

  // TODO: Phase 4 — expression actions
  // - Binary(+) → {add: [l, r], to?: target}
  // - Binary(-) → {sub: [l, r], to?: target}
  // - Binary(*) → {mul: [l, r], to?: target}
  // - Binary(/) → {div: [l, r], to?: target}
  // - Binary(<>) → {concat: [l, r], to?: target}
  // - Call → {funcName: [args]} or bare "funcName" string
  // - Pipe → action sequence with $_ carry-through
  // - Index → {getbyte: [target, index], to?: target}
  // - Unary(-) → {sub: [0, operand], to?: target}

  // TODO: Phase 7 — nested expression flattening
  // - a + b * c → [{mul: [b, c]}, {add: [a, "$_"], to: target}]
  // - Compound pipe chains
});
