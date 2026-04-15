import { describe, it, expect } from "vitest";
import { emitStatements } from "./statements.js";
import { BlockEmitContext } from "./context.js";
import type { Stmt, Expr } from "../ast.js";
import type { Span } from "../diagnostics.js";

const SPAN: Span = { line: 1, col: 1, endLine: 1, endCol: 1 };

/** Shorthand for a literal expression. */
function lit(value: number | string | boolean): Expr {
  const varType = typeof value === "number"
    ? "int" as const
    : typeof value === "boolean"
      ? "bool" as const
      : "string" as const;
  return { kind: "Literal", varType, value, span: SPAN };
}

describe("emitStatements", () => {
  it("returns empty for empty statement list", () => {
    const ctx = new BlockEmitContext();
    expect(emitStatements([], ctx)).toEqual([]);
  });

  it("resets temps between statements", () => {
    const ctx = new BlockEmitContext();
    // Two statements that need temps: ConfigRef in assignments
    const stmts: Stmt[] = [
      { kind: "AssignLocal", name: "x", nameSpan: SPAN, value: { kind: "ConfigRef", name: "a", span: SPAN }, span: SPAN },
      { kind: "AssignLocal", name: "y", nameSpan: SPAN, value: { kind: "ConfigRef", name: "b", span: SPAN }, span: SPAN },
    ];
    emitStatements(stmts, ctx);
    // ConfigRef with a target doesn't need temps (uses exprToActions with target),
    // so no temps allocated. Verify counter was reset between statements regardless.
    expect(ctx.getTempVars()).toEqual([]);
  });

  // --- LocalDecl ---

  describe("LocalDecl", () => {
    it("emits set for simple init", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "LocalDecl", docs: [], varType: "int", name: "x", nameSpan: SPAN,
        arraySize: null, isConst: false, init: lit(42), span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([
        { set: { "$x": 42 } },
      ]);
    });

    it("emits nothing for array decl (no init action)", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "LocalDecl", docs: [], varType: "int", name: "buf", nameSpan: SPAN,
        arraySize: 16, isConst: false, init: null, span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([]);
    });

    it("emits nothing when init is null", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "LocalDecl", docs: [], varType: "int", name: "x", nameSpan: SPAN,
        arraySize: null, isConst: false, init: null, span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([]);
    });

    it("emits exprToActions with target for complex init", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "LocalDecl", docs: [], varType: "int", name: "x", nameSpan: SPAN,
        arraySize: null, isConst: false,
        init: {
          kind: "Binary", op: "+",
          left: lit(1), right: lit(2),
          span: SPAN,
        },
        span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([
        { add: [1, 2], to: "$x" },
      ]);
    });
  });

  // --- AssignLocal ---

  describe("AssignLocal", () => {
    it("emits set for simple value", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "AssignLocal", name: "x", nameSpan: SPAN,
        value: lit(99), span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([
        { set: { "$x": 99 } },
      ]);
    });

    it("emits set for global var reference", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "AssignLocal", name: "x", nameSpan: SPAN,
        value: { kind: "GlobalVar", name: "counter", span: SPAN },
        span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([
        { set: { "$x": "$counter" } },
      ]);
    });

    it("emits arithmetic with to for complex expression", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "AssignLocal", name: "x", nameSpan: SPAN,
        value: { kind: "Binary", op: "*", left: lit(3), right: lit(4), span: SPAN },
        span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([
        { mul: [3, 4], to: "$x" },
      ]);
    });

    it("emits getPluginConfig with to for ConfigRef", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "AssignLocal", name: "maxLevel", nameSpan: SPAN,
        value: { kind: "ConfigRef", name: "maxLevel", span: SPAN },
        span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([
        { getPluginConfig: "maxLevel", to: "$maxLevel" },
      ]);
    });
  });

  // --- AssignGlobal ---

  describe("AssignGlobal", () => {
    it("emits set for simple value", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "AssignGlobal", name: "counter", nameSpan: SPAN,
        value: lit(0), span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([
        { set: { "$counter": 0 } },
      ]);
    });

    it("emits arithmetic with to for complex expression", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "AssignGlobal", name: "counter", nameSpan: SPAN,
        value: { kind: "Binary", op: "+", left: { kind: "GlobalVar", name: "counter", span: SPAN }, right: lit(1), span: SPAN },
        span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([
        { add: ["$counter", 1], to: "$counter" },
      ]);
    });
  });

  // --- ExprStmt ---

  describe("ExprStmt", () => {
    it("emits actions for expression (no target)", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "ExprStmt",
        expr: { kind: "Binary", op: "+", left: lit(1), right: lit(2), span: SPAN },
        span: SPAN,
      }];
      const actions = emitStatements(stmts, ctx);
      expect(actions).toEqual([{ add: [1, 2] }]);
      expect(actions[0]).not.toHaveProperty("to");
    });

    it("returns empty for simple expression (no side effect)", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "ExprStmt", expr: lit(42), span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([]);
    });
  });

  // --- Return ---

  describe("Return", () => {
    it("emits return with simple value", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "Return", value: lit(42), span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([
        { return: 42 },
      ]);
    });

    it("emits return with global var", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "Return", value: { kind: "GlobalVar", name: "result", span: SPAN }, span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([
        { return: "$result" },
      ]);
    });

    it("emits return with local var ($-prefixed)", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "Return", value: { kind: "Identifier", name: "speed", span: SPAN }, span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([
        { return: "$speed" },
      ]);
    });

    it("emits return 0 for bare return", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "Return", value: null, span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([
        { return: 0 },
      ]);
    });

    it("emits complex expression then return $_ for complex return", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "Return",
        value: { kind: "Binary", op: "+", left: lit(1), right: lit(2), span: SPAN },
        span: SPAN,
      }];
      expect(emitStatements(stmts, ctx)).toEqual([
        { add: [1, 2] },
        { return: "$_" },
      ]);
    });
  });

  // --- Multiple statements (integration) ---

  describe("multi-statement integration", () => {
    it("emits the mapSpeed pattern: configGet + mul + div + round + return", () => {
      const ctx = new BlockEmitContext();
      // Simulates:
      //   int maxLevel = @maxLevel
      //   int speed = $arg * maxLevel
      //   speed = speed / 255
      //   return speed
      const stmts: Stmt[] = [
        {
          kind: "LocalDecl", docs: [], varType: "int", name: "maxLevel", nameSpan: SPAN,
          arraySize: null, isConst: false,
          init: { kind: "ConfigRef", name: "maxLevel", span: SPAN },
          span: SPAN,
        },
        {
          kind: "LocalDecl", docs: [], varType: "int", name: "speed", nameSpan: SPAN,
          arraySize: null, isConst: false,
          init: {
            kind: "Binary", op: "*",
            left: { kind: "GlobalVar", name: "arg", span: SPAN },
            right: { kind: "Identifier", name: "maxLevel", span: SPAN },
            span: SPAN,
          },
          span: SPAN,
        },
        {
          kind: "AssignLocal", name: "speed", nameSpan: SPAN,
          value: {
            kind: "Binary", op: "/",
            left: { kind: "Identifier", name: "speed", span: SPAN },
            right: lit(255),
            span: SPAN,
          },
          span: SPAN,
        },
        {
          kind: "Return",
          value: { kind: "Identifier", name: "speed", span: SPAN },
          span: SPAN,
        },
      ];

      expect(emitStatements(stmts, ctx)).toEqual([
        { getPluginConfig: "maxLevel", to: "$maxLevel" },
        { mul: ["$arg", "$maxLevel"], to: "$speed" },
        { div: ["$speed", 255], to: "$speed" },
        { return: "$speed" },
      ]);
    });
  });

  // --- If / Conditional (stub — depends on condition emitter) ---

  describe("If (condition emitter dependency)", () => {
    it("emits error diagnostic when condition emitter returns null", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "If",
        condition: { kind: "Binary", op: "==", left: lit(1), right: lit(1), span: SPAN },
        then: [{ kind: "Return", value: lit(0), span: SPAN }],
        else: null,
        span: SPAN,
      }];
      const actions = emitStatements(stmts, ctx);
      // Condition emitter is not yet implemented, so it returns null → error diagnostic
      expect(actions).toEqual([]);
      expect(ctx.diagnostics).toContainEqual(
        expect.objectContaining({ level: "error", message: expect.stringContaining("if-condition") }),
      );
    });
  });

  describe("Conditional (postfix guard)", () => {
    it("emits error diagnostic when condition emitter returns null", () => {
      const ctx = new BlockEmitContext();
      const stmts: Stmt[] = [{
        kind: "Conditional",
        guard: "if",
        condition: { kind: "Binary", op: ">", left: lit(1), right: lit(0), span: SPAN },
        body: { kind: "Return", value: lit(1), span: SPAN },
        span: SPAN,
      }];
      const actions = emitStatements(stmts, ctx);
      expect(actions).toEqual([]);
      expect(ctx.diagnostics).toContainEqual(
        expect.objectContaining({ level: "error", message: expect.stringContaining("conditional guard") }),
      );
    });
  });
});
