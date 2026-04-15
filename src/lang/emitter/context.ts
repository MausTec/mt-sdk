import type { LangDiagnostic, Span } from "../diagnostics.js";
import { langError, langWarning } from "../diagnostics.js";

/**
 * Shared context threaded through all sub-emitters.
 * Collects diagnostics and (in future phases) tracks scope/temp variables.
 */
export class EmitContext {
  readonly diagnostics: LangDiagnostic[] = [];

  error(message: string, span?: Span): void {
    this.diagnostics.push(langError(message, span));
  }

  warning(message: string, span?: Span): void {
    this.diagnostics.push(langWarning(message, span));
  }
}
