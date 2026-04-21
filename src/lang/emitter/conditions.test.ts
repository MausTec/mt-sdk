import { describe, it, expect } from "vitest";
import { exprToCondition, invertCondition } from "./conditions.js";
import type { ConditionResult } from "./conditions.js";
import { BlockEmitContext } from "./context.js";
import type { Span } from "../diagnostics.js";
import type { Expr, BinaryExpr, UnaryExpr } from "../ast.js";

const SPAN: Span = { line: 1, col: 1, endLine: 1, endCol: 1 };

// --- AST helpers --------------------------------------------------------------

function ident(name: string): Expr {
  return { kind: "Identifier", name, span: SPAN };
}

function lit(value: number | boolean | string): Expr {
  const varType = typeof value === "number" ? "int" as const
    : typeof value === "boolean" ? "bool" as const
    : "string" as const;
  return { kind: "Literal", varType, value, span: SPAN };
}

function global$(name: string): Expr {
  return { kind: "GlobalVar", name, span: SPAN };
}

function accum(): Expr {
  return { kind: "Accumulator", span: SPAN };
}

function errorCode(): Expr {
  return { kind: "ErrorCode", span: SPAN };
}

function configRef(name: string): Expr {
  return { kind: "ConfigRef", name, span: SPAN };
}

function binary(op: BinaryExpr["op"], left: Expr, right: Expr): BinaryExpr {
  return { kind: "Binary", op, left, right, span: SPAN };
}

function unary(op: UnaryExpr["op"], operand: Expr): UnaryExpr {
  return { kind: "Unary", op, operand, span: SPAN };
}

function call(name: string, args: Expr[] = []): Expr {
  return { kind: "Call", name, args, span: SPAN };
}

// --- Tests --------------------------------------------------------------------

describe("exprToCondition", () => {
  // --- Comparison operators (simple operands) ---------------------------------

  describe("comparison operators (simple operands)", () => {
    it("== with identifier and literal", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(binary("==", ident("x"), lit(0)), ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({ eq: ["$x", 0] });
    });

    it("!= with global and boolean", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(binary("!=", global$("flag"), lit(true)), ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({ neq: ["$flag", true] });
    });

    it("< with accumulator and literal", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(binary("<", accum(), lit(100)), ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({ lt: ["$_", 100] });
    });

    it("> with two identifiers", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(binary(">", ident("a"), ident("b")), ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({ gt: ["$a", "$b"] });
    });

    it("<= with identifier and literal", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(binary("<=", ident("count"), lit(10)), ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({ lte: ["$count", 10] });
    });

    it(">= with error code and literal", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(binary(">=", errorCode(), lit(0)), ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({ gte: ["$!", 0] });
    });
  });

  // --- Comparison operators (complex operands) --------------------------------

  describe("comparison operators (complex operands)", () => {
    it("call() == literal pre-evaluates to temp", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(binary("==", call("foo"), lit(0)), ctx)!;
      expect(result.prereqs).toEqual([{ "foo": [], "to": "$__t0" }]);
      expect(result.condition).toEqual({ eq: ["$__t0", 0] });
    });

    it("@config == literal pre-evaluates config to temp", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(binary("==", configRef("enabled"), lit(true)), ctx)!;
      expect(result.prereqs).toEqual([{ "getPluginConfig": "enabled", "to": "$__t0" }]);
      expect(result.condition).toEqual({ eq: ["$__t0", true] });
    });

    it("arithmetic operand pre-evaluates to temp", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(
        binary(">", binary("+", ident("x"), lit(1)), ident("y")),
        ctx,
      )!;
      expect(result.prereqs).toEqual([{ "add": ["$x", 1], "to": "$__t0" }]);
      expect(result.condition).toEqual({ gt: ["$__t0", "$y"] });
    });

    it("both sides complex allocates two temps", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(
        binary("==", call("foo"), call("bar")),
        ctx,
      )!;
      expect(result.prereqs).toEqual([
        { "foo": [], "to": "$__t0" },
        { "bar": [], "to": "$__t1" },
      ]);
      expect(result.condition).toEqual({ eq: ["$__t0", "$__t1"] });
    });
  });

  // --- Logical combinators ----------------------------------------------------

  describe("logical combinators", () => {
    it("and produces all", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(
        binary("and", binary("==", ident("a"), lit(1)), binary("==", ident("b"), lit(2))),
        ctx,
      )!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({
        all: [{ eq: ["$a", 1] }, { eq: ["$b", 2] }],
      });
    });

    it("or produces any", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(
        binary("or", binary("==", ident("a"), lit(1)), binary("==", ident("b"), lit(2))),
        ctx,
      )!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({
        any: [{ eq: ["$a", 1] }, { eq: ["$b", 2] }],
      });
    });

    it("chained and flattens to single all", () => {
      const ctx = new BlockEmitContext();
      // (a == 1 and b == 2) and c == 3  — left-associative parse
      const inner = binary("and", binary("==", ident("a"), lit(1)), binary("==", ident("b"), lit(2)));
      const outer = binary("and", inner, binary("==", ident("c"), lit(3)));
      const result = exprToCondition(outer, ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({
        all: [{ eq: ["$a", 1] }, { eq: ["$b", 2] }, { eq: ["$c", 3] }],
      });
    });

    it("chained or flattens to single any", () => {
      const ctx = new BlockEmitContext();
      const inner = binary("or", binary("==", ident("a"), lit(1)), binary("==", ident("b"), lit(2)));
      const outer = binary("or", inner, binary("==", ident("c"), lit(3)));
      const result = exprToCondition(outer, ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({
        any: [{ eq: ["$a", 1] }, { eq: ["$b", 2] }, { eq: ["$c", 3] }],
      });
    });

    it("mixed and/or does not flatten across operators", () => {
      const ctx = new BlockEmitContext();
      // (a == 1 and b == 2) or c == 3
      const inner = binary("and", binary("==", ident("a"), lit(1)), binary("==", ident("b"), lit(2)));
      const outer = binary("or", inner, binary("==", ident("c"), lit(3)));
      const result = exprToCondition(outer, ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({
        any: [
          { all: [{ eq: ["$a", 1] }, { eq: ["$b", 2] }] },
          { eq: ["$c", 3] },
        ],
      });
    });

    it("complex operand inside combinator produces prereqs", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(
        binary("and", binary("==", call("foo"), lit(0)), binary("==", ident("b"), lit(2))),
        ctx,
      )!;
      expect(result.prereqs).toEqual([{ "foo": [], "to": "$__t0" }]);
      expect(result.condition).toEqual({
        all: [{ eq: ["$__t0", 0] }, { eq: ["$b", 2] }],
      });
    });
  });

  // --- Unary not --------------------------------------------------------------

  describe("unary not", () => {
    it("not (a == 1) wraps in none", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(unary("not", binary("==", ident("a"), lit(1))), ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({ none: [{ eq: ["$a", 1] }] });
    });

    it("not (a == 1 and b > 0) wraps all in none", () => {
      const ctx = new BlockEmitContext();
      const inner = binary("and", binary("==", ident("a"), lit(1)), binary(">", ident("b"), lit(0)));
      const result = exprToCondition(unary("not", inner), ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({
        none: [{ all: [{ eq: ["$a", 1] }, { gt: ["$b", 0] }] }],
      });
    });

    it("not (bare identifier) desugars to none(neq truthy)", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(unary("not", ident("x")), ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({ none: [{ neq: ["$x", 0] }] });
    });
  });

  // --- Bare truthy ------------------------------------------------------------

  describe("bare truthy", () => {
    it("identifier desugars to neq 0", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(ident("flag"), ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({ neq: ["$flag", 0] });
    });

    it("global var desugars to neq 0", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(global$("running"), ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({ neq: ["$running", 0] });
    });

    it("accumulator desugars to neq 0", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(accum(), ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({ neq: ["$_", 0] });
    });

    it("literal desugars to neq 0", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(lit(42), ctx)!;
      expect(result.prereqs).toEqual([]);
      expect(result.condition).toEqual({ neq: [42, 0] });
    });

    it("call() pre-evaluates to temp then checks neq 0", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(call("foo"), ctx)!;
      expect(result.prereqs).toEqual([{ "foo": [], "to": "$__t0" }]);
      expect(result.condition).toEqual({ neq: ["$__t0", 0] });
    });

    it("@config pre-evaluates to temp then checks neq 0", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(configRef("enabled"), ctx)!;
      expect(result.prereqs).toEqual([{ "getPluginConfig": "enabled", "to": "$__t0" }]);
      expect(result.condition).toEqual({ neq: ["$__t0", 0] });
    });

    it("arithmetic expression desugars to truthy after pre-eval", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(binary("+", ident("x"), lit(1)), ctx)!;
      expect(result.prereqs).toEqual([{ "add": ["$x", 1], "to": "$__t0" }]);
      expect(result.condition).toEqual({ neq: ["$__t0", 0] });
    });

    it("unary minus desugars to truthy after pre-eval", () => {
      const ctx = new BlockEmitContext();
      const result = exprToCondition(unary("-", ident("x")), ctx)!;
      expect(result.prereqs).toEqual([{ "sub": [0, "$x"], "to": "$__t0" }]);
      expect(result.condition).toEqual({ neq: ["$__t0", 0] });
    });
  });
});

// --- invertCondition ----------------------------------------------------------

describe("invertCondition", () => {
  it("eq -> neq", () => {
    expect(invertCondition({ eq: ["$x", 0] })).toEqual({ neq: ["$x", 0] });
  });

  it("neq -> eq", () => {
    expect(invertCondition({ neq: ["$x", 0] })).toEqual({ eq: ["$x", 0] });
  });

  it("lt -> gte", () => {
    expect(invertCondition({ lt: ["$a", 10] })).toEqual({ gte: ["$a", 10] });
  });

  it("gte -> lt", () => {
    expect(invertCondition({ gte: ["$a", 10] })).toEqual({ lt: ["$a", 10] });
  });

  it("gt -> lte", () => {
    expect(invertCondition({ gt: ["$a", "$b"] })).toEqual({ lte: ["$a", "$b"] });
  });

  it("lte -> gt", () => {
    expect(invertCondition({ lte: ["$a", "$b"] })).toEqual({ gt: ["$a", "$b"] });
  });

  it("all -> any with inverted children (De Morgan's)", () => {
    expect(invertCondition({
      all: [{ eq: ["$a", 1] }, { gt: ["$b", 0] }],
    })).toEqual({
      any: [{ neq: ["$a", 1] }, { lte: ["$b", 0] }],
    });
  });

  it("any -> all with inverted children (De Morgan's)", () => {
    expect(invertCondition({
      any: [{ eq: ["$a", 1] }, { lt: ["$b", 5] }],
    })).toEqual({
      all: [{ neq: ["$a", 1] }, { gte: ["$b", 5] }],
    });
  });

  it("none with single child -> double negation elimination", () => {
    expect(invertCondition({ none: [{ eq: ["$x", 0] }] })).toEqual({ eq: ["$x", 0] });
  });

  it("none with multiple children -> any (unwrap negation)", () => {
    expect(invertCondition({
      none: [{ eq: ["$x", 0] }, { gt: ["$y", 1] }],
    })).toEqual({
      any: [{ eq: ["$x", 0] }, { gt: ["$y", 1] }],
    });
  });

  it("nested: inverts all containing comparisons and combinators", () => {
    // not (a == 1 and (b > 0 or c < 10))
    // → any [neq a 1, all [lte b 0, gte c 10]]
    expect(invertCondition({
      all: [
        { eq: ["$a", 1] },
        { any: [{ gt: ["$b", 0] }, { lt: ["$c", 10] }] },
      ],
    })).toEqual({
      any: [
        { neq: ["$a", 1] },
        { all: [{ lte: ["$b", 0] }, { gte: ["$c", 10] }] },
      ],
    });
  });

  it("bare truthy neq inverts to eq (the unless pattern)", () => {
    // This is the exact case: unless @oscEnabled → truthy gives { neq: [val, 0] }
    // invertCondition should produce { eq: [val, 0] }
    expect(invertCondition({ neq: ["$__t0", 0] })).toEqual({ eq: ["$__t0", 0] });
  });
});
