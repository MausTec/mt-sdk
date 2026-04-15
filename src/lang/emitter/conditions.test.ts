import { describe, it, expect } from "vitest";
import { exprToCondition } from "./conditions.js";
import { EmitContext } from "./context.js";
import type { Span } from "../diagnostics.js";

const SPAN: Span = { line: 1, col: 1, endLine: 1, endCol: 1 };

describe("exprToCondition", () => {
  it("returns null (not yet implemented)", () => {
    const ctx = new EmitContext();
    const expr = {
      kind: "Binary" as const,
      op: "==" as const,
      left: { kind: "Identifier" as const, name: "x", span: SPAN },
      right: { kind: "Literal" as const, varType: "int" as const, value: 0, span: SPAN },
      span: SPAN,
    };
    expect(exprToCondition(expr, ctx)).toBeNull();
  });

  // TODO: Phase 5 — condition compilation
  // - Binary(==) → {eq: [l, r]}
  // - Binary(!=) → {neq: [l, r]}
  // - Binary(<)  → {lt: [l, r]}
  // - Binary(>)  → {gt: [l, r]}
  // - Binary(<=) → {lte: [l, r]}
  // - Binary(>=) → {gte: [l, r]}
  // - Binary(and) → {all: [left_cond, right_cond]}
  // - Binary(or) → {any: [left_cond, right_cond]}
  // - Unary(not) → {none: [inner_cond]}
  // - Nested: not (a == b and c > 0) → {none: [{all: [{eq: ...}, {gt: ...}]}]}
  // - Non-condition expr → diagnostic error
});
