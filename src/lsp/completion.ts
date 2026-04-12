import { CompletionItemKind } from "vscode-languageserver/node.js";
import type { CompletionItem } from "vscode-languageserver/node.js";
import type { DocumentStore } from "./document-store.js";

/**
 * Build completion items for a given document URI.
 *
 * Provides:
 * - `@name` items for every declared config variable (trigger: `@`)
 * - `$name` items for every declared global variable (trigger: `$`)
 *
 * When `triggerCharacter` is provided, only the matching sigil's items are
 * returned — this prevents both lists from appearing when the user types one
 * sigil and accidentally inserting the wrong one.
 */
export function getCompletionItems(
  store: DocumentStore,
  uri: string,
  triggerCharacter?: string,
): CompletionItem[] {
  const doc = store.get(uri);
  if (doc === undefined) return [];

  const { ast } = doc.parsed;
  const items: CompletionItem[] = [];

  const includeConfig = triggerCharacter === undefined || triggerCharacter === "@";
  const includeGlobals = triggerCharacter === undefined || triggerCharacter === "$";

  if (includeConfig && ast.configBlock !== null) {
    for (const decl of ast.configBlock.declarations) {
      const item: CompletionItem = {
        label: `@${decl.name}`,
        kind: CompletionItemKind.Variable,
        detail: decl.varType,
        insertText: decl.name,
      };

      if (decl.label !== null) {
        item.documentation = decl.label;
      }

      items.push(item);
    }
  }

  if (includeGlobals && ast.globalsBlock !== null) {
    for (const decl of ast.globalsBlock.declarations) {
      const typeLabel = decl.arraySize !== null
        ? `${decl.varType}[${decl.arraySize}]`
        : decl.varType;

      items.push({
        label: `$${decl.name}`,
        kind: CompletionItemKind.Variable,
        detail: typeLabel,
        insertText: decl.name,
      });
    }
  }

  return items;
}
