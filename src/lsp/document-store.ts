import { parseSource } from "../lang/index.js";
import type { ParseResult } from "../lang/index.js";

interface StoredDocument {
  text: string;
  parsed: ParseResult;
}

/**
 * In-memory store of all open `.mtp` documents.
 *
 * Each document is kept as its raw text plus a cached `ParseResult`.
 * The parse result is recomputed on every open/change. If recomputation
 * begins to take too long, we could consider incremental parsing.
 */
export class DocumentStore {
  private readonly docs = new Map<string, StoredDocument>();

  open(uri: string, text: string): void {
    this.docs.set(uri, { text, parsed: parseSource(text) });
  }

  update(uri: string, text: string): void {
    this.docs.set(uri, { text, parsed: parseSource(text) });
  }

  close(uri: string): void {
    this.docs.delete(uri);
  }

  get(uri: string): StoredDocument | undefined {
    return this.docs.get(uri);
  }
}
