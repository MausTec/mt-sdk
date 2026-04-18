import type { Hover, Range } from "vscode-languageserver/node.js";
import type { Span } from "../lang/diagnostics.js";
import type {
  ASTNode,
  PluginNode,
  FnNode,
  DefNode,
  OnNode,
  Stmt,
  BinaryOp,
  DefParam,
} from "../lang/ast.js";
import type { ASTPath } from "./find-node.js";
import { SymbolTable } from "./symbol-table.js";

// --- Operator descriptions ---------------------------------------------------

const BINARY_OP_DOCS: Record<BinaryOp, string> = {
  "+":   "Addition: `int + int -> int`",
  "-":   "Subtraction: `int - int -> int`",
  "*":   "Multiplication: `int * int -> int`",
  "/":   "Division: `int / int -> int`",
  "<>":  "Concatenation: `string <> string -> string`",
  "==":  "Equality: `a == a -> bool`",
  "!=":  "Inequality: `a != a -> bool`",
  ">":   "Greater than: `int > int -> bool`",
  "<":   "Less than: `int < int -> bool`",
  ">=":  "Greater than or equal: `int >= int -> bool`",
  "<=":  "Less than or equal: `int <= int -> bool`",
  "and": "Logical AND: `bool and bool -> bool`",
  "or":  "Logical OR: `bool or bool -> bool`",
};

const UNARY_OP_DOCS: Record<"not" | "-", string> = {
  "not": "Logical NOT: `not bool -> bool`",
  "-":   "Negation: `-int -> int`",
};

// --- Helpers -----------------------------------------------------------------

function spanToRange(span: Span): Range {
  return {
    start: { line: span.line - 1, character: span.col - 1 },
    end:   { line: span.endLine - 1, character: span.endCol - 1 },
  };
}

function formatParams(params: DefParam[]): string {
  return params.map(p => `${p.varType} ${p.name}`).join(", ");
}

function formatDocs(docs: string[]): string {
  if (docs.length === 0) return "";
  return "\n\n---\n\n" + docs.join("\n");
}

function mkHover(markdown: string, span: Span): Hover {
  return {
    contents: { kind: "markdown", value: markdown },
    range: spanToRange(span),
  };
}

// --- Scope helpers -----------------------------------------------------------

/**
 * Walk the ASTPath to find the enclosing DefNode, FnNode, or OnNode, which
 * gives us access to the local statement body and parameters for resolution.
 */
function findEnclosingBody(path: ASTPath): { stmts: Stmt[]; params: DefParam[]; kind: "Def" | "Fn" | "On" } | null {
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i]!;

    if (node.kind === "Def") return { stmts: (node as DefNode).body, params: (node as DefNode).params, kind: "Def" };
    if (node.kind === "Fn") return { stmts: [], params: (node as FnNode).params, kind: "Fn" };
    if (node.kind === "On") return { stmts: (node as OnNode).body, params: (node as OnNode).bindings.map((b) => ({ name: b.name, varType: "int" as const, span: b.span })), kind: "On" };
  }

  return null;
}

// --- Main hover entry point --------------------------------------------------

/**
 * Produce hover content for the deepest node in the AST path.
 *
 * `line` and `col` are 1-based (matching Span conventions) and are used to
 * suppress unhelpful hover on scope containers when the cursor is in a body
 * gap (e.g. on a comment or blank line inside `on :event do ... end`).
 *
 * Returns `null` when the node kind has no meaningful hover information.
 */
export function getHoverContent(ast: PluginNode, path: ASTPath, line: number, col: number): Hover | null {
  if (path.length === 0) return null;

  const symbols = SymbolTable.fromAST(ast);
  const node = path[path.length - 1]!;

  switch (node.kind) {
    // --- Expressions ---------------------------------------------------------

    case "ConfigRef": {
      const resolved = symbols.resolveConfig(node.name);

      if (resolved === undefined) {
        return mkHover(`\`\`\`mtp\n(config) config.${node.name}\n\`\`\`\n\n*Unresolved config variable*`, node.span);
      }

      return mkHover(
        `\`\`\`mtp\n(config) ${resolved.varType} config.${resolved.name}\n\`\`\`` + formatDocs(resolved.docs),
        node.span,
      );
    }

    case "MetaRef": {
      return mkHover(
        `\`\`\`mtp\n(meta) meta.${node.name}\n\`\`\`\n\n*Plugin metadata (read-only, not yet supported at runtime)*`,
        node.span,
      );
    }

    case "GlobalVar": {
      const resolved = symbols.resolveGlobal(node.name);

      if (resolved === undefined) {
        return mkHover(`\`\`\`mtp\n(global) $${node.name}\n\`\`\`\n\n*Unresolved global variable*`, node.span);
      }

      const typeLabel = resolved.arraySize != null
        ? `${resolved.varType}[${resolved.arraySize}]`
        : resolved.varType;

      return mkHover(
        `\`\`\`mtp\n(global) ${typeLabel} $${resolved.name}\n\`\`\`` + formatDocs(resolved.docs),
        node.span,
      );
    }

    case "Accumulator": {
      const carriedType = resolvePipeCarriedType(path);
      const typeHint = carriedType !== null ? carriedType : "unknown";

      return mkHover(
        `\`\`\`mtp\n(pipe accumulator) ${typeHint} $_\n\`\`\`\n\n` +
        "The result carried from the previous pipe step. The next function call receives this as arg 0 or wherever `$_` appears.",
        node.span,
      );
    }

    case "ErrorCode":
      return mkHover(
        "```mtp\n(error code) int $!\n```\n\n" +
        "The last error code set by a builtin or host function. `0` indicates success.",
        node.span,
      );

    case "Identifier": {
      // An identifier could be a local variable read or a function name used
      // without parentheses. Try locals first, then functions.
      const body = findEnclosingBody(path);

      if (body !== null) {
        const local = symbols.resolveLocal(node.name, body.stmts, node.span.line, body.params);

        if (local !== undefined) {
          const label = local.source === "parameter" ? "parameter" : "local";

          return mkHover(
            `\`\`\`mtp\n(${label}) ${local.varType} ${local.name}\n\`\`\`` + formatDocs(local.docs),
            node.span,
          );
        }
      }

      const fn = symbols.resolveFunction(node.name);
      if (fn !== undefined) {
        return mkHover(formatFunctionHover(fn), node.span);
      }

      return null;
    }

    case "Call": {
      const fn = symbols.resolveFunction(node.name);
      if (fn !== undefined) {
        return mkHover(formatFunctionHover(fn), node.span);
      }

      // Unresolved — may be a builtin or runtime function not yet registered.
      return mkHover(
        `\`\`\`mtp\n${node.name}(${node.args.length > 0 ? "..." : ""})\n\`\`\`\n\n*Unresolved function*`,
        node.span,
      );
    }

    case "Literal":
      return mkHover(`\`\`\`mtp\n(${node.varType}) ${JSON.stringify(node.value)}\n\`\`\``, node.span);

    case "Binary": {
      const desc = BINARY_OP_DOCS[node.op];
      return mkHover(`**\`${node.op}\`** — ${desc}`, node.span);
    }

    case "Unary": {
      const desc = UNARY_OP_DOCS[node.op];
      return mkHover(`**\`${node.op}\`** — ${desc}`, node.span);
    }

    case "Pipe":
      return formatPipeStepHover(node, symbols, line, col);

    // --- Declarations --------------------------------------------------------

    case "ConfigDecl":
      return mkHover(
        `\`\`\`mtp\n(config) ${node.varType} @${node.name}\n\`\`\`` +
        formatDocs(node.label !== null ? [node.label] : []),
        node.span,
      );

    case "GlobalDecl": {
      const typeLabel = node.arraySize !== null
        ? `${node.varType}[${node.arraySize}]`
        : node.varType;
      return mkHover(
        `\`\`\`mtp\n(global) ${typeLabel} $${node.name}\n\`\`\`` +
        formatDocs(node.label !== null ? [node.label] : []),
        node.span,
      );
    }

    case "LocalDecl":
      return mkHover(
        `\`\`\`mtp\n(local) ${node.varType} ${node.name}\n\`\`\`` + formatDocs(node.docs),
        node.span,
      );

    case "Fn": {
      // Only show hover on the header line, not on body gaps (comments, blanks).
      if (line > node.span.line) return null;

      const resolved = symbols.resolveFunction(node.name);

      if (resolved !== undefined) {
        return mkHover(formatFunctionHover(resolved), node.span);
      }

      return null;
    }

    case "Def": {
      // Only show hover on the header line, not on body gaps (comments, blanks).
      if (line > node.span.line) return null;

      const resolved = symbols.resolveFunction(node.name);

      if (resolved !== undefined) {
        return mkHover(formatFunctionHover(resolved), node.span);
      }

      return null;
    }

    case "On":
      // Only show hover when cursor is on the event atom, not body content.
      if (line !== node.eventSpan.line) return null;
      return mkHover(`\`\`\`mtp\non :${node.event}\n\`\`\`\n\nEvent handler`, node.eventSpan);

    // FUTURE (Phase H): Resolve event atom to SDK documentation, including arg type.
    // FUTURE (Phase G): Resolve $_ in event handler to the event argument.

    // --- Assignment targets --------------------------------------------------

    case "AssignGlobal": {
      const resolved = symbols.resolveGlobal(node.name);

      if (resolved === undefined) {
        return mkHover(`\`\`\`mtp\n(global) $${node.name}\n\`\`\`\n\n*Unresolved global variable*`, node.span);
      }

      const typeLabel = resolved.arraySize != null
        ? `${resolved.varType}[${resolved.arraySize}]`
        : resolved.varType;
      
        return mkHover(
        `\`\`\`mtp\n(global) ${typeLabel} $${resolved.name}\n\`\`\`` + formatDocs(resolved.docs),
        node.span,
      );
    }

    case "AssignLocal": {
      const body = findEnclosingBody(path);
      
      if (body !== null) {
        const local = symbols.resolveLocal(node.name, body.stmts, node.span.line, body.params);
        
        if (local !== undefined) {
          const label = local.source === "parameter" ? "parameter" : "local";
          
          return mkHover(
            `\`\`\`mtp\n(${label}) ${local.varType} ${local.name}\n\`\`\`` + formatDocs(local.docs),
            node.span,
          );
        }
      }

      return null;
    }

    default:
      return null;
  }
}

// --- Formatting helpers ------------------------------------------------------

function formatFunctionHover(fn: import("./symbol-table.js").ResolvedFunction): string {
  const returnHint = fn.returnType !== null ? ` -> ${fn.returnType}` : "";
  const sourceTag = fn.source !== "plugin" ? ` (${fn.source})` : "";
  const sig = `(${fn.variant}) ${fn.name}(${formatParams(fn.params)})${returnHint}`;
  return `\`\`\`mtp\n${sig}\n\`\`\`${sourceTag}` + formatDocs(fn.docs);
}

/**
 * Produce a concise per-step pipe hover.
 *
 * Finds which `|>` the cursor is on by comparing the cursor position against
 * each step's call span: the `|>` for step N sits between the end of step N-1
 * (or the head) and the start of step N's call. We pick the step whose call
 * starts *after* the cursor; if none qualifies we fall back to the last step.
 */
function formatPipeStepHover(
  node: import("../lang/ast.js").PipeExpr,
  symbols: SymbolTable,
  line: number,
  col: number,
): Hover | null {
  // Determine which step the cursor's |> belongs to.
  let stepIndex = node.steps.length - 1; // default: last step
  
  for (let i = 0; i < node.steps.length; i++) {
    const callSpan = node.steps[i]!.call.span;
    if (callSpan.line > line || (callSpan.line === line && callSpan.col > col)) {
      stepIndex = i;
      break;
    }
  }

  const step = node.steps[stepIndex]!;
  const carriedLabel = step.carriedType !== "unknown" ? step.carriedType : "?";

  // Describe the source: head expression or previous step's function.
  let fromLabel: string;
  
  if (stepIndex === 0) {
    const h = node.head;
    fromLabel = h.kind === "Identifier" ? h.name
      : h.kind === "Call" ? `${h.name}()`
      : h.kind === "Literal" ? String(h.value)
      : "expr";
  } else {
    fromLabel = `${node.steps[stepIndex - 1]!.call.name}()`;
  }

  // Describe where the carried value lands in the next call.
  const hasExplicitAccumulator = step.call.args.some(
    a => a.kind === "Accumulator",
  );

  const intoHint = hasExplicitAccumulator ? "into `$_`" : "as arg 0";

  const md =
    `**\`|>\`** pipe — carries \`${carriedLabel}\` from \`${fromLabel}\` ${intoHint} of \`${step.call.name}()\``;

  return mkHover(md, node.span);
}

// --- Pipe carried-type resolution --------------------------------------------

/**
 * Walk backward through the ASTPath to find whether the current node sits
 * inside a PipeStep, and if so, return the carriedType for that step.
 *
 * Returns `null` when no pipe context is found or the type is unknown.
 */
function resolvePipeCarriedType(path: ASTPath): string | null {
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i]!;

    // The Pipe node itself contains steps — find which step we're inside.
    if (node.kind === "Pipe") {
      // The node just after the PipeExpr in the path is one of the step calls.
      const child = i + 1 < path.length ? path[i + 1]! : null;
      if (child === null || child.kind !== "Call") return null;

      for (const step of node.steps) {
        if (step.call === child) {
          return step.carriedType !== "unknown" ? step.carriedType : null;
        }
      }
      return null;
    }
  }
  
  return null;
}
