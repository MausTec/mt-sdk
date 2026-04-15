import { describe, it, expect } from "vitest";
import {
  exprToJson,
  extractLocals,
  emitDef,
  emitFn,
  emitOnNode,
  emitHandlers,
} from "./functions.js";
import { EmitContext } from "./context.js";
import type {
  LiteralExpr,
  IdentifierExpr,
  GlobalVarExpr,
  DefNode,
  FnNode,
  OnNode,
  LocalDeclStmt,
} from "../ast.js";
import type { Span } from "../diagnostics.js";

// --- Helpers ------------------------------------------------------------------

const SPAN: Span = { line: 1, col: 1, endLine: 1, endCol: 1 };

function lit(value: number | string | boolean): LiteralExpr {
  const varType = typeof value === "number"
    ? "int" as const
    : typeof value === "boolean"
      ? "bool" as const
      : "string" as const;
  return { kind: "Literal", varType, value, span: SPAN };
}

function ident(name: string): IdentifierExpr {
  return { kind: "Identifier", name, span: SPAN };
}

// --- exprToJson ---------------------------------------------------------------

describe("exprToJson", () => {
  it("converts a numeric literal", () => {
    expect(exprToJson(lit(42))).toBe(42);
  });

  it("converts a string literal", () => {
    expect(exprToJson(lit("hello"))).toBe("hello");
  });

  it("converts a boolean literal", () => {
    expect(exprToJson(lit(true))).toBe(true);
  });

  it("converts an identifier to its name", () => {
    expect(exprToJson(ident("speed"))).toBe("speed");
  });

  it("returns null for unsupported expression kinds", () => {
    const globalVar: GlobalVarExpr = { kind: "GlobalVar", name: "counter", span: SPAN };
    expect(exprToJson(globalVar)).toBeNull();
  });
});

// --- extractLocals ------------------------------------------------------------

describe("extractLocals", () => {
  it("collects scalar variable names and init actions", () => {
    const body: LocalDeclStmt[] = [
      {
        kind: "LocalDecl", varType: "int", name: "x",
        nameSpan: SPAN, docs: [], arraySize: null, isConst: false,
        init: lit(10), span: SPAN,
      },
      {
        kind: "LocalDecl", varType: "string", name: "msg",
        nameSpan: SPAN, docs: [], arraySize: null, isConst: false,
        init: lit("hello"), span: SPAN,
      },
    ];
    const { vars, initActions } = extractLocals(body);
    expect(vars).toEqual(["x", "msg"]);
    expect(initActions).toEqual([
      { set: { $x: 10 } },
      { set: { $msg: "hello" } },
    ]);
  });

  it("collects array declarations with size syntax", () => {
    const body: LocalDeclStmt[] = [
      {
        kind: "LocalDecl", varType: "int", name: "buf",
        nameSpan: SPAN, docs: [], arraySize: 8, isConst: false,
        init: null, span: SPAN,
      },
    ];
    const { vars, initActions } = extractLocals(body);
    expect(vars).toEqual(["buf[8]"]);
    expect(initActions).toEqual([]);
  });

  it("skips non-LocalDecl statements", () => {
    const body = [
      {
        kind: "LocalDecl" as const, varType: "int" as const, name: "x",
        nameSpan: SPAN, docs: [], arraySize: null, isConst: false,
        init: lit(1), span: SPAN,
      },
      {
        kind: "Return" as const, value: null, span: SPAN,
      },
    ];
    const { vars } = extractLocals(body);
    expect(vars).toEqual(["x"]);
  });

  it("registers scalar var without init when init is null", () => {
    const body: LocalDeclStmt[] = [
      {
        kind: "LocalDecl", varType: "int", name: "y",
        nameSpan: SPAN, docs: [], arraySize: null, isConst: false,
        init: null, span: SPAN,
      },
    ];
    const { vars, initActions } = extractLocals(body);
    expect(vars).toEqual(["y"]);
    expect(initActions).toEqual([]);
  });
});

// --- emitDef ------------------------------------------------------------------

describe("emitDef", () => {
  it("emits args and extracts local vars", () => {
    const ctx = new EmitContext();
    const def: DefNode = {
      kind: "Def",
      name: "process",
      nameSpan: SPAN,
      docs: [],
      params: [
        { varType: "int", name: "val", span: SPAN },
        { varType: "string", name: "msg", span: SPAN },
      ],
      returnType: null,
      body: [
        {
          kind: "LocalDecl", varType: "int", name: "result",
          nameSpan: SPAN, docs: [], arraySize: null, isConst: false,
          init: lit(0), span: SPAN,
        } as LocalDeclStmt,
      ],
      span: SPAN,
    };
    const result = emitDef(ctx, def);
    expect(result.args).toEqual(["val", "msg"]);
    expect(result.vars).toEqual(["result"]);
    expect(result.actions).toEqual([{ set: { $result: 0 } }]);
  });

  it("emits returnType when present", () => {
    const ctx = new EmitContext();
    const def: DefNode = {
      kind: "Def", name: "calc", nameSpan: SPAN, docs: [],
      params: [], returnType: "int", body: [], span: SPAN,
    };
    const result = emitDef(ctx, def);
    expect(result.returnType).toBe("int");
  });

  it("omits returnType when null", () => {
    const ctx = new EmitContext();
    const def: DefNode = {
      kind: "Def", name: "calc", nameSpan: SPAN, docs: [],
      params: [], returnType: null, body: [], span: SPAN,
    };
    const result = emitDef(ctx, def);
    expect(result).not.toHaveProperty("returnType");
  });
});

// --- emitFn -------------------------------------------------------------------

describe("emitFn", () => {
  it("emits args and empty actions (body compilation not yet implemented)", () => {
    const ctx = new EmitContext();
    const fn: FnNode = {
      kind: "Fn", name: "square", nameSpan: SPAN, docs: [],
      params: [{ varType: "int", name: "x", span: SPAN }],
      returnType: "int",
      body: { kind: "Binary", op: "*", left: ident("x"), right: ident("x"), span: SPAN },
      span: SPAN,
    };
    const result = emitFn(ctx, fn);
    expect(result.args).toEqual(["x"]);
    expect(result.actions).toEqual([]);
    expect(result.returnType).toBe("int");
  });
});

// --- emitHandlers -------------------------------------------------------------

describe("emitHandlers", () => {
  it("emits event handlers keyed by event name", () => {
    const ctx = new EmitContext();
    const handlers: OnNode[] = [
      { kind: "On", event: "speedChange", body: [], span: SPAN },
    ];
    const result = emitHandlers(ctx, handlers);
    expect(result).toHaveProperty("speedChange");
  });

  it("reports error for duplicate event handlers", () => {
    const ctx = new EmitContext();
    const handlers: OnNode[] = [
      { kind: "On", event: "speedChange", body: [], span: SPAN },
      { kind: "On", event: "speedChange", body: [], span: SPAN },
    ];
    emitHandlers(ctx, handlers);
    expect(ctx.diagnostics).toContainEqual(
      expect.objectContaining({ level: "error", message: expect.stringContaining("Multiple handlers") }),
    );
  });
});
