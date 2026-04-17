import { TextDocumentSyncKind } from "vscode-languageserver/node.js";
import type { InitializeResult } from "vscode-languageserver/node.js";
import { createConnection, ProposedFeatures } from "vscode-languageserver/node.js";
import { DocumentStore } from "./document-store.js";
import { publishDiagnostics } from "./diagnostics.js";
import { getCompletionItems } from "./completion.js";
import { findNodePath } from "./find-node.js";
import { getHoverContent } from "./hover.js";
import { getSemanticTokens, semanticTokensLegend } from "./semantic-tokens.js";

/**
 * Start the mt-sdk language server.
 */
export function startServer(): void {
  const connection = createConnection(ProposedFeatures.all);
  const store = new DocumentStore();

  connection.onInitialize((): InitializeResult => {
    return {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: TextDocumentSyncKind.Full,
        },

        // Capabilities are added here as each feature is implemented.
        completionProvider: { triggerCharacters: ["@", "$"] },
        hoverProvider: true,
        semanticTokensProvider: {
          legend: semanticTokensLegend,
          full: true,
        },
      },
      serverInfo: {
        name: "mt-sdk-lsp",
        version: "0.1.0",
      },
    };
  });

  // --- Document sync ---------------------------------------------------------

  connection.onDidOpenTextDocument(({ textDocument }) => {
    store.open(textDocument.uri, textDocument.text);
    publishDiagnostics(connection, store, textDocument.uri);
  });

  connection.onDidChangeTextDocument(({ textDocument, contentChanges }) => {
    // Full-sync: the server always receives the complete new text.
    const text = contentChanges[contentChanges.length - 1]?.text ?? "";
    store.update(textDocument.uri, text);
    publishDiagnostics(connection, store, textDocument.uri);
  });

  connection.onDidCloseTextDocument(({ textDocument }) => {
    store.close(textDocument.uri);
    // Clear diagnostics when the document is closed.
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
  });

  // --- Completion ------------------------------------------------------------

  connection.onCompletion(({ textDocument, context }) => {
    return getCompletionItems(store, textDocument.uri, context?.triggerCharacter ?? undefined);
  });

  // --- Hover -----------------------------------------------------------------

  connection.onHover(({ textDocument, position }) => {
    const doc = store.get(textDocument.uri);
    if (doc === undefined) return null;

    // LSP positions are 0-based; Span is 1-based.
    const path = findNodePath(doc.parsed.ast, position.line + 1, position.character + 1);

    // FUTURE (Phase H): getHoverContent needs a document-specific SDK
    // registered to the Symbol Table (sdkVersion + productFamily).
    return getHoverContent(doc.parsed.ast, path, position.line + 1, position.character + 1);
  });

  // --- Semantic tokens -------------------------------------------------------

  connection.languages.semanticTokens.on(({ textDocument }) => {
    const doc = store.get(textDocument.uri);
    if (doc === undefined) return { data: [] };
    return getSemanticTokens(doc.parsed.ast);
  });

  connection.listen();
}
