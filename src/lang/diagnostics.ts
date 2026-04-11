/** Source span — all line/col values are 1-based. */
export interface Span {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

export type LangDiagnosticLevel = "error" | "warning";

/** A diagnostic emitted by the lexer, parser, or emitter. */
export interface LangDiagnostic {
  level: LangDiagnosticLevel;
  message: string;
  span?: Span | undefined;
}

export function langError(message: string, span?: Span): LangDiagnostic {
  return { level: "error", message, span };
}

export function langWarning(message: string, span?: Span): LangDiagnostic {
  return { level: "warning", message, span };
}

/** A zero-width span at (1,1), used when no real position is available. */
export const NULL_SPAN: Span = { line: 1, col: 1, endLine: 1, endCol: 1 };
