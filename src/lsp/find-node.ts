import type { Span } from "../lang/diagnostics.js";
import type {
  ASTNode,
  PluginNode,
  Expr,
  Stmt,
  FnNode,
  DefNode,
  OnNode,
  ConfigDecl,
  GlobalDecl,
  MatchPredicate,
  MetadataFieldNode,
  PipeStep,
} from "../lang/ast.js";

/**
 * A path from the root PluginNode down to the deepest node that contains the
 * cursor position. Index 0 is the root, the last element is the deepest hit.
 */
export type ASTPath = ASTNode[];

/**
 * Find the deepest AST node at `line`:`col` and return the full ancestor path 
 * from root to that node.
 *
 * Returns an empty array if the position falls outside all nodes.
 */
export function findNodePath(ast: PluginNode, line: number, col: number): ASTPath {
  const path: ASTPath = [];
  visitPlugin(ast, line, col, path);
  return path;
}

// --- Span containment --------------------------------------------------------

function contains(span: Span, line: number, col: number): boolean {
  if (line < span.line || line > span.endLine) return false;
  if (line === span.line && col < span.col) return false;
  if (line === span.endLine && col > span.endCol) return false;
  return true;
}

// --- AST visitors ------------------------------------------------------------
//
// Each visitor pushes itself onto `path` on entry and returns `true` if it
// (or a descendant) was the deepest match. If no child claims the position,
// the current node stays as the deepest element.

function visitPlugin(node: PluginNode, line: number, col: number, path: ASTPath): boolean {
  if (!contains(node.span, line, col)) return false;
  path.push(node);

  for (const meta of node.metadata) {
    if (visitMetadataField(meta, line, col, path)) return true;
  }

  if (node.matchBlock !== null && contains(node.matchBlock.span, line, col)) {
    path.push(node.matchBlock);

    for (const pred of node.matchBlock.predicates) {
      if (visitMatchPredicate(pred, line, col, path)) return true;
    }

    return true;
  }

  if (node.configBlock !== null && contains(node.configBlock.span, line, col)) {
    path.push(node.configBlock);

    for (const decl of node.configBlock.declarations) {
      if (visitConfigDecl(decl, line, col, path)) return true;
    }

    return true;
  }

  if (node.globalsBlock !== null && contains(node.globalsBlock.span, line, col)) {
    path.push(node.globalsBlock);

    for (const decl of node.globalsBlock.declarations) {
      if (visitGlobalDecl(decl, line, col, path)) return true;
    }

    return true;
  }

  for (const fn of node.functions) {
    if (visitFn(fn, line, col, path)) return true;
  }

  for (const def of node.defs) {
    if (visitDef(def, line, col, path)) return true;
  }

  for (const handler of node.handlers) {
    if (visitOn(handler, line, col, path)) return true;
  }

  return true;
}

function visitMetadataField(node: MetadataFieldNode, line: number, col: number, path: ASTPath): boolean {
  if (!contains(node.span, line, col)) return false;
  path.push(node);

  if (Array.isArray(node.value)) {
    for (const v of node.value) {
      if (visitExpr(v, line, col, path)) return true;
    }
  } else {
    if (visitExpr(node.value, line, col, path)) return true;
  }

  return true;
}

function visitMatchPredicate(node: MatchPredicate, line: number, col: number, path: ASTPath): boolean {
  if (!contains(node.span, line, col)) return false;
  path.push(node);
  visitExpr(node.value, line, col, path);
  return true;
}

function visitConfigDecl(node: ConfigDecl, line: number, col: number, path: ASTPath): boolean {
  if (!contains(node.span, line, col)) return false;
  path.push(node);

  visitExpr(node.default, line, col, path);

  for (const expr of Object.values(node.constraints)) {
    if (visitExpr(expr, line, col, path)) return true;
  }

  return true;
}

function visitGlobalDecl(node: GlobalDecl, line: number, col: number, path: ASTPath): boolean {
  if (!contains(node.span, line, col)) return false;
  path.push(node);
  visitExpr(node.init, line, col, path);
  return true;
}

function visitFn(node: FnNode, line: number, col: number, path: ASTPath): boolean {
  if (!contains(node.span, line, col)) return false;
  path.push(node);
  visitExpr(node.body, line, col, path);
  return true;
}

function visitDef(node: DefNode, line: number, col: number, path: ASTPath): boolean {
  if (!contains(node.span, line, col)) return false;

  path.push(node);

  for (const stmt of node.body) {
    if (visitStmt(stmt, line, col, path)) return true;
  }

  return true;
}

function visitOn(node: OnNode, line: number, col: number, path: ASTPath): boolean {
  if (!contains(node.span, line, col)) return false;

  path.push(node);

  for (const stmt of node.body) {
    if (visitStmt(stmt, line, col, path)) return true;
  }

  return true;
}

// --- Statements --------------------------------------------------------------

function visitStmt(node: Stmt, line: number, col: number, path: ASTPath): boolean {
  if (!contains(node.span, line, col)) return false;
  path.push(node);

  switch (node.kind) {
    case "LocalDecl":
      if (node.init !== null) visitExpr(node.init, line, col, path);
      break;
    case "AssignLocal":
      visitExpr(node.value, line, col, path);
      break;
    case "AssignGlobal":
      visitExpr(node.value, line, col, path);
      break;
    case "AssignIndex":
      if (visitExpr(node.target, line, col, path)) break;
      if (visitExpr(node.index, line, col, path)) break;
      visitExpr(node.value, line, col, path);
      break;
    case "ExprStmt":
      visitExpr(node.expr, line, col, path);
      break;
    case "If":
      if (visitExpr(node.condition, line, col, path)) break;

      for (const s of node.then) {
        if (visitStmt(s, line, col, path)) return true;
      }

      if (node.else !== null) {
        for (const s of node.else) {
          if (visitStmt(s, line, col, path)) return true;
        }
      }
      break;

    case "Return":
      if (node.value !== null) visitExpr(node.value, line, col, path);
      break;

    case "Conditional":
      if (visitExpr(node.condition, line, col, path)) break;
      visitStmt(node.body, line, col, path);
      break;
  }

  return true;
}

// --- Expressions -------------------------------------------------------------

function visitExpr(node: Expr, line: number, col: number, path: ASTPath): boolean {
  if (!contains(node.span, line, col)) return false;
  path.push(node);

  switch (node.kind) {
    case "Binary":
      if (visitExpr(node.left, line, col, path)) break;
      visitExpr(node.right, line, col, path);
      break;

    case "Unary":
      visitExpr(node.operand, line, col, path);
      break;

    case "Call":
      for (const arg of node.args) {
        if (visitExpr(arg, line, col, path)) return true;
      }
      break;

    case "Pipe":
      if (visitExpr(node.head, line, col, path)) break;
      
      for (const step of node.steps) {
        if (visitExpr(step.call, line, col, path)) return true;
      }
      break;

    // Leaf nodes: Literal, GlobalVar, Accumulator, ErrorCode, ConfigRef, Identifier
    default:
      break;
  }

  return true;
}
