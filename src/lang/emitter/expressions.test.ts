import { describe, it, expect } from "vitest";
import { exprToValue, exprToActions } from "./expressions.js";
import { EmitContext } from "./context.js";
import type { Span } from "../diagnostics.js";

const SPAN: Span = { line: 1, col: 1, endLine: 1, endCol: 1 };

describe("exprToValue", () => {
  it("returns null (not yet implemented)", () => {
    const ctx = new EmitContext();
    const expr = { kind: "Literal" as const, varType: "int" as const, value: 42, span: SPAN };
    expect(exprToValue(expr, ctx)).toBeNull();
  });

  // TODO: Phase 2 — value expressions
  // - Literal → raw value
  // - Identifier → "name"
  // - GlobalVar → "$name"
  // - Accumulator → "$_"
  // - ErrorCode → "$!"
  // - ConfigRef → "@name"
  // - Complex expressions → null (caller falls back to actions)
});

describe("exprToActions", () => {
  it("returns empty actions (not yet implemented)", () => {
    const ctx = new EmitContext();
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
