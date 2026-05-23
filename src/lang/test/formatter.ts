/**
 * Source-form rendering of expressions and runtime values for test failure
 * reporting. Walks `EvalTrace` trees to produce per-operand breakdowns that
 * sit alongside the failing assert line in CLI output.
 */

import type { Expr } from "../ast.js";
import type { RuntimeValue } from "../../runtime/types.js";
import type { EvalTrace } from "./eval.js";

/**
 * Render an expression in canonical MTP source form. Sub-expressions inside
 * Binary/Unary are parenthesised when needed to preserve operator grouping
 * for the reader (we conservatively parenthesise any composite operand).
 */
export function formatExpr(expr: Expr): string {
  switch (expr.kind) {
    case "Literal":
      if (expr.varType === "string") return JSON.stringify(expr.value);
      if (expr.varType === "bool")   return expr.value ? "true" : "false";
      return String(expr.value);

    case "Identifier":  return expr.name;
    case "GlobalVar":   return `$${expr.name}`;
    case "Accumulator": return "$_";
    case "ErrorCode":   return "$!";
    case "ConfigRef":   return `config.${expr.name}`;
    case "MetaRef":     return `meta.${expr.name}`;

    case "Index":
      return `${formatExpr(expr.target)}[${formatExpr(expr.index)}]`;

    case "Binary":
      return `${parenIfComposite(expr.left)} ${expr.op} ${parenIfComposite(expr.right)}`;

    case "Unary":
      return expr.op === "not"
        ? `not ${parenIfComposite(expr.operand)}`
        : `-${parenIfComposite(expr.operand)}`;

    case "Call":
      return `${expr.name}(${expr.args.map(formatExpr).join(", ")})`;

    case "Pipe":
      return [
        formatExpr(expr.head),
        ...expr.steps.map((s) => formatExpr(s.call)),
      ].join(" |> ");
  }
}

function parenIfComposite(e: Expr): string {
  if (e.kind === "Binary" || e.kind === "Unary" || e.kind === "Pipe") {
    return `(${formatExpr(e)})`;
  }
  return formatExpr(e);
}

/**
 * Render a `RuntimeValue` in a form suitable for inline display.
 * Strings are JSON-quoted; bytes are summarised by length.
 */
export function formatRuntimeValue(v: RuntimeValue): string {
  switch (v.type) {
    case "bool":   return v.value ? "true" : "false";
    case "string": return JSON.stringify(v.value);
    case "int":
    case "float":  return String(v.value);
    case "bytes": {
      const bytes = v.value as unknown as Uint8Array | number[] | undefined;
      const len = bytes ? (bytes as { length: number }).length : 0;
      return `<bytes len=${len}>`;
    }
    default:       return String((v as { value: unknown }).value);
  }
}

/**
 * Walk an `EvalTrace` and return aligned "expr = value" lines for every
 * non-trivial sub-expression. The root is skipped (it's already shown in the
 * source snippet), as are literal nodes (their value is obvious from source).
 * Duplicate sub-expressions (same canonical text) are emitted once.
 */
export function formatTraceOperands(trace: EvalTrace): string[] {
  interface Row { label: string; value: string }
  const rows: Row[] = [];
  const seen = new Set<string>();

  function walk(t: EvalTrace, isRoot: boolean): void {
    // Visit children first so leaves print before composites.
    for (const c of t.children) walk(c, false);

    if (isRoot) return;
    if (t.expr.kind === "Literal") return;

    const label = formatExpr(t.expr);
    if (seen.has(label)) return;
    seen.add(label);

    rows.push({ label, value: formatRuntimeValue(t.value) });
  }

  walk(trace, true);

  if (rows.length === 0) return [];

  const width = Math.max(...rows.map((r) => r.label.length));
  return rows.map((r) => `${r.label.padEnd(width)} = ${r.value}`);
}

/**
 * For a comparison-binary assert (one side a literal), derive a human-friendly
 * `expected` / `received` pair. Returns `undefined` for asserts that aren't a
 * literal-vs-expression comparison — the caller should fall back to printing
 * the trace value directly in that case.
 *
 * Examples:
 *   `result == 2000` (result=800)      -> { expected: "== 2000", received: "800" }
 *   `5 < $count`    ($count=3)         -> { expected: "> 5",     received: "3" }
 *   `$x >= config.max_level`           -> undefined (neither side literal)
 */
export function deriveExpectedReceived(
  trace: EvalTrace,
): { expected: string; received: string } | undefined {
  if (trace.expr.kind !== "Binary") return undefined;

  const op = trace.expr.op;
  if (op !== "==" && op !== "!=" && op !== "<" && op !== "<=" && op !== ">" && op !== ">=") {
    return undefined;
  }

  const [lt, rt] = trace.children;
  if (!lt || !rt) return undefined;

  const leftIsLit  = lt.expr.kind === "Literal";
  const rightIsLit = rt.expr.kind === "Literal";

  // Need exactly one literal side; both or neither is uninformative here.
  if (leftIsLit === rightIsLit) return undefined;

  if (rightIsLit) {
    return {
      expected: `${op} ${formatRuntimeValue(rt.value)}`,
      received: formatRuntimeValue(lt.value),
    };
  }

  // Literal on the left: flip the operator so the phrasing still reads as
  // "<expr> <op> <literal>".
  return {
    expected: `${flipComparisonOp(op)} ${formatRuntimeValue(lt.value)}`,
    received: formatRuntimeValue(rt.value),
  };
}

function flipComparisonOp(op: "==" | "!=" | "<" | "<=" | ">" | ">="): string {
  switch (op) {
    case "<":  return ">";
    case "<=": return ">=";
    case ">":  return "<";
    case ">=": return "<=";
    case "==":
    case "!=": return op;
  }
}

/**
 * Extract the source text covered by `span` (1-based, inclusive) from `source`.
 * Returns trimmed-right multi-line text, or `undefined` if the span is out of
 * range or the source is unavailable.
 */
export function extractSourceSnippet(
  source: string | undefined,
  span: { line: number; col: number; endLine?: number; endCol?: number },
): string | undefined {
  if (source === undefined) return undefined;
  if (!Number.isFinite(span.line) || span.line < 1) return undefined;

  const lines = source.split(/\r?\n/);
  const startIdx = span.line - 1;
  if (startIdx >= lines.length) return undefined;

  const endLine = span.endLine && span.endLine >= span.line ? span.endLine : span.line;
  const endIdx = Math.min(endLine - 1, lines.length - 1);

  if (startIdx === endIdx) {
    const line = lines[startIdx]!;
    const startCol = Math.max(0, (span.col ?? 1) - 1);
    const endCol = span.endCol && span.endCol > (span.col ?? 1)
      ? Math.min(line.length, span.endCol - 1)
      : line.length;
    return line.slice(startCol, endCol).trimEnd();
  }

  const out: string[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    out.push(lines[i] ?? "");
  }
  return out.join("\n").trimEnd();
}
