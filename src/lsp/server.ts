import { TextDocumentSyncKind } from "vscode-languageserver/node.js";
import type { InitializeResult } from "vscode-languageserver/node.js";
import { createConnection, ProposedFeatures } from "vscode-languageserver/node.js";
import { DocumentStore } from "./document-store.js";
import { publishDiagnostics } from "./diagnostics.js";
import { getCompletionItems } from "./completion.js";

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
        // hoverProvider: true,
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

  connection.listen();
}
