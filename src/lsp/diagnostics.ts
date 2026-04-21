import type { Connection, Diagnostic, Range } from "vscode-languageserver/node.js";
import { DiagnosticSeverity } from "vscode-languageserver/node.js";
import type { LangDiagnostic, Span } from "../lang/index.js";
import type { DocumentStore } from "./document-store.js";
import { link } from "../lang/linker.js";

function spanToRange(span: Span): Range {
  return {
    start: { line: span.line - 1, character: span.col - 1 },
    end:   { line: span.endLine - 1, character: span.endCol - 1 },
  };
}

/**
 * Converts a Language Diagnostic to a VSCode Diagnostic object
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

  // Linker pass: symbol resolution, validation, and (when context is provided)
  // permission analysis.
  const { diagnostics: linkDiags } = link(doc.parsed.ast);

  for (const d of linkDiags) {
    diagnostics.push(toVSCodeDiagnostic(d));
  }

  connection.sendDiagnostics({ uri, diagnostics });
}
