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
import { SymbolTable } from "../lang/symbol-table.js";

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
      const carried = resolvePipeCarriedInfo(path, symbols);
      const typeHint = carried?.type ?? "unknown";
      const sourceHint = carried ? ` from \`${carried.sourceLabel}\`` : "";

      let md = `\`\`\`mtp\n(pipe accumulator) ${typeHint} $_\n\`\`\`\n\n` +
        `Carries the result${sourceHint} into the next pipe step.`;

      if (carried?.sourceFn?.docs?.length) {
        md += "\n\n---\n\n" + carried.sourceFn.docs.join("\n");
      }

      return mkHover(md, node.span);
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

      // Check if this call is a pipe receiver
      const pipeParent = path.length >= 2 ? path[path.length - 2] : undefined;
      const isPipeReceiver = pipeParent !== undefined && pipeParent.kind === "Pipe";

      if (fn !== undefined) {
        const baseMd = formatFunctionHover(fn);

        if (isPipeReceiver) {
          const carried = resolvePipeCarriedInfo(path, symbols);
          const resolvedSig = formatResolvedPipeSig(fn, node.args, carried);
          return mkHover(baseMd + resolvedSig, node.span);
        }

        return mkHover(baseMd, node.span);
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
        `\`\`\`mtp\n(config) ${node.varType} config.${node.name}\n\`\`\`` +
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

function formatFunctionHover(fn: import("../lang/symbol-table.js").ResolvedFunction): string {
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
  const carried = buildCarriedInfo(node, stepIndex, symbols);
  const typeLabel = carried.type ?? "?";

  // Describe where the carried value lands in the next call.
  const hasExplicitAccumulator = step.call.args.some(
    a => a.kind === "Accumulator",
  );
  const intoHint = hasExplicitAccumulator ? "into `$_`" : "as arg 0";

  let md =
    `**\`|>\`** pipe — carries \`${typeLabel}\` from \`${carried.sourceLabel}\` ${intoHint} of \`${step.call.name}()\``;

  if (carried.sourceFn?.docs?.length) {
    md += "\n\n---\n\n" + carried.sourceFn.docs.join("\n");
  }

  return mkHover(md, node.span);
}

/**
 * Format a resolved pipe call signature showing where $_ is substituted.
 *
 * When the receiver uses explicit $_, shows the signature as-written.
 * When implicit (no $_ in args), shows $_ prepended as the first arg.
 */
function formatResolvedPipeSig(
  fn: import("../lang/symbol-table.js").ResolvedFunction,
  callArgs: readonly import("../lang/ast.js").Expr[],
  carried: PipeCarriedInfo | null,
): string {
  const carriedType = carried?.type ?? "?";
  const hasExplicitAccumulator = callArgs.some(a => a.kind === "Accumulator");

  // Build the resolved arg list with $_ shown in its position
  const resolvedParts: string[] = [];

  if (hasExplicitAccumulator) {
    // Show each arg, substituting $_ with its carried type
    for (let i = 0; i < callArgs.length; i++) {
      const arg = callArgs[i]!;

      if (arg.kind === "Accumulator") {
        resolvedParts.push(`${carriedType} $_`);
      } else {
        // Use the param type from the function signature if available
        const param = fn.params[i];
        resolvedParts.push(param ? `${param.varType} ${param.name}` : "?");
      }
    }
  } else {
    // Implicit: $_ is prepended as arg 0
    resolvedParts.push(`${carriedType} $_`);

    for (let i = 1; i < fn.params.length; i++) {
      const param = fn.params[i]!;
      resolvedParts.push(`${param.varType} ${param.name}`);
    }
  }

  const resolvedSig = `${fn.name}(${resolvedParts.join(", ")})`;
  const returnHint = fn.returnType !== null ? ` -> ${fn.returnType}` : "";

  return `\n\n---\n\n*Pipe-resolved call:*\n\`\`\`mtp\n${resolvedSig}${returnHint}\n\`\`\``;
}

// --- Pipe carried-type resolution --------------------------------------------

/**
 * Describes the value flowing through a pipe at a given point.
 */
interface PipeCarriedInfo {
  /** Inferred type of the carried value, or null if unknown. */
  type: string | null;
  /** Human-readable label for the source expression (e.g. "get_speed()"). */
  sourceLabel: string;
  /** Resolved function info for the source, if it was a function call. */
  sourceFn: import("../lang/symbol-table.js").ResolvedFunction | undefined;
}

/**
 * Walk backward through the ASTPath to find whether the current node sits
 * inside a PipeStep, and if so, return rich carried info for that step.
 *
 * Returns `null` when no pipe context is found.
 */
function resolvePipeCarriedInfo(path: ASTPath, symbols: SymbolTable): PipeCarriedInfo | null {
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i]!;

    // The Pipe node itself contains steps — find which step we're inside.
    if (node.kind === "Pipe") {
      // The node just after the PipeExpr in the path is one of the step calls.
      const child = i + 1 < path.length ? path[i + 1]! : null;
      if (child === null || child.kind !== "Call") return null;

      for (let s = 0; s < node.steps.length; s++) {
        if (node.steps[s]!.call === child) {
          return buildCarriedInfo(node, s, symbols);
        }
      }
      return null;
    }
  }

  return null;
}

/**
 * Build PipeCarriedInfo for a given step index in a PipeExpr.
 */
function buildCarriedInfo(
  pipe: import("../lang/ast.js").PipeExpr,
  stepIndex: number,
  symbols: SymbolTable,
): PipeCarriedInfo {
  if (stepIndex === 0) {
    // Source is the pipe head expression
    const h = pipe.head;

    if (h.kind === "Call") {
      const fn = symbols.resolveFunction(h.name);
      
      return {
        type: fn?.returnType ?? null,
        sourceLabel: `${h.name}()`,
        sourceFn: fn,
      };
    }

    if (h.kind === "Identifier") {
      const fn = symbols.resolveFunction(h.name);
      
      return { 
        type: fn?.returnType ?? null, 
        sourceLabel: h.name, 
        sourceFn: fn 
      };
    }


    if (h.kind === "Literal") {
      const t = typeof h.value === "number"
        ? (Number.isInteger(h.value) ? "int" : "float")
        : typeof h.value === "string" ? "string"
        : typeof h.value === "boolean" ? "bool"
        : null;
      
      return { 
        type: t, 
        sourceLabel: String(h.value), 
        sourceFn: undefined 
      };
    }

    return { 
      type: null, 
      sourceLabel: "expr", 
      sourceFn: undefined 
    };
  }

  // Source is the previous step's function call
  const prevCall = pipe.steps[stepIndex - 1]!.call;
  const fn = symbols.resolveFunction(prevCall.name);
  
  return {
    type: fn?.returnType ?? null,
    sourceLabel: `${prevCall.name}()`,
    sourceFn: fn,
  };
}
