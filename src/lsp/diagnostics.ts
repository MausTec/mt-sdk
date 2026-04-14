import type { Connection, Diagnostic, Range } from "vscode-languageserver/node.js";
import { DiagnosticSeverity } from "vscode-languageserver/node.js";
import type { LangDiagnostic, Span } from "../lang/index.js";
import type { DocumentStore } from "./document-store.js";
import { validateSymbols } from "./validation.js";
import type { ValidationDiagnostic } from "./validation.js";

function spanToRange(span: Span): Range {
  return {
    start: { line: span.line - 1, character: span.col - 1 },
    end:   { line: span.endLine - 1, character: span.endCol - 1 },
  };
}

/**
 * Converts a Language Diagnostic to a VSCode Diagnostic object
 * @param d 
 * @returns 
 */
function toVSCodeDiagnostic(d: LangDiagnostic): Diagnostic {
  return {
    severity: d.level === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    range: d.span ? spanToRange(d.span) : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    message: d.message,
    source: "mt-sdk",
  };
}

/**
 * Converts a Validation Diagnostic to a VSCode diagnostic
 * @param d 
 * @returns 
 */
function validationToVSCodeDiagnostic(d: ValidationDiagnostic): Diagnostic {
  return {
    severity: d.level === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    range: spanToRange(d.span),
    message: d.message,
    source: "mt-sdk",
  };
}

/**
 * Re-publish diagnostics for `uri` from its cached parse result.
 * Called after every open/change.
 */
export function publishDiagnostics(
  connection: Connection,
  store: DocumentStore,
  uri: string,
): void {
  const doc = store.get(uri);
  if (!doc) return;

  const diagnostics: Diagnostic[] = doc.parsed.diagnostics.map(toVSCodeDiagnostic);

  // Symbol resolution validation pass
  const validationDiags = validateSymbols(doc.parsed.ast);
  
  for (const d of validationDiags) {
    diagnostics.push(validationToVSCodeDiagnostic(d));
  }

  connection.sendDiagnostics({ uri, diagnostics });
}
