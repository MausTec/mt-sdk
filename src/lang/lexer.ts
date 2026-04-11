import type { Span, LangDiagnostic } from "./diagnostics.js";
import { TokenKind } from "./token.js";
import type { Token } from "./token.js";

export interface LexResult {
  tokens: Token[];
  diagnostics: LangDiagnostic[];
}

/**
 * Lex a `.mtpl` source string into a flat token array.
 *
 * Always succeeds - unrecognised characters produce an `error` diagnostic and
 * a best-effort token rather than throwing. The final token is always `EOF`.
 *
 * @stub Not yet implemented. Returns a single EOF token.
 */
export function lex(_source: string): LexResult {
  const eof: Token = {
    kind: TokenKind.EOF,
    value: "",
    span: eofSpan(_source),
  };
  return { tokens: [eof], diagnostics: [] };
}

function eofSpan(source: string): Span {
  const lines = source.split("\n");
  const lastLine = lines[lines.length - 1];
  const line = lines.length;
  const col = (lastLine?.length ?? 0) + 1;
  return { line, col, endLine: line, endCol: col };
}
