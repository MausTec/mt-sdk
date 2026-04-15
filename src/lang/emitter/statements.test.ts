import { describe, it, expect } from "vitest";
import { emitStatements } from "./statements.js";
import { EmitContext } from "./context.js";

describe("emitStatements", () => {
  it("returns empty actions (not yet implemented)", () => {
    const ctx = new EmitContext();
    const result = emitStatements([], ctx);
    expect(result).toEqual([]);
  });

  // TODO: Phase 3 — simple statements
  // - LocalDeclStmt with init → {set: {$name: value}}
  // - AssignLocalStmt → {set: {$name: value}} or arithmetic chain with "to"
  // - AssignGlobalStmt → {set: {$name: value}} or arithmetic chain with "to"
  // - ReturnStmt → {return: value}

  // TODO: Phase 6 — control flow
  // - IfStmt → {if: {condition, then: [...], else?: [...]}}
  // - ConditionalStmt (postfix if/unless) → {if: {condition, then: [wrapped]}}
  // - unless → {if: {none: [condition], then: [...]}}
});
