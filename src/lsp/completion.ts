import { CompletionItemKind } from "vscode-languageserver/node.js";
import type { CompletionItem } from "vscode-languageserver/node.js";
import type { DocumentStore } from "./document-store.js";

/**
 * Build completion items for a given document URI.
 *
 * Currently provides:
 * - `@name` completions for every declared config variable in the document.
 *   Triggered when the user types `@`.
 */
export function getCompletionItems(
  store: DocumentStore,
  uri: string,
): CompletionItem[] {
  const doc = store.get(uri);
  if (doc === undefined) return [];

  const { ast } = doc.parsed;
  if (ast.configBlock === null) return [];

  return ast.configBlock.declarations.map((decl) => {
    const item: CompletionItem = {
      label: `@${decl.name}`,
      kind: CompletionItemKind.Variable,
      detail: decl.varType,
      // Strip the `@` that the user already typed (triggerCharacter was `@`)
      insertText: decl.name,
    };

    if (decl.label !== null) {
      item.documentation = decl.label;
    }

    return item;
  });
}
