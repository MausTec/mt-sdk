import type { LangDiagnostic, Span } from "../diagnostics.js";
import { langError, langWarning } from "../diagnostics.js";
import type { VarType } from "../ast.js";

/** Lightweight variable info for the emitter (no full symbol table needed). */
export interface EmitVarInfo {
  varType: VarType;
  arraySize: number | null;
}

/**
 * Shared context threaded through all sub-emitters.
 * Collects diagnostics and serves as the base for block-level contexts.
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

/**
 * Block-scoped context for emitting function/event bodies.
 * Extends {@link EmitContext} with temporary variable allocation,
 * accumulator-reservation tracking, and local function scope.
 *
 * Temp variables are named `__t0`, `__t1`, etc. The counter resets
 * after each top-level statement (via {@link resetTemps}), but the
 * high-water mark is preserved so the final `vars` list includes
 * every slot that was ever needed.
 */
export class BlockEmitContext extends EmitContext {
  /**
   * Map of local function names to their parameter names.
   * Used by the Call emitter to distinguish plugin-local calls
   * (`@`-prefixed, named args) from host/builtin calls (bare key).
   */
  readonly localFunctions: ReadonlyMap<string, string[]>;

  /**
   * Variable type info for locals, globals, and parameters.
   * Keyed by bare name (no `$` prefix). Used by the for-loop emitter
   * to determine whether an iterable is an array or string.
   */
  readonly variables: ReadonlyMap<string, EmitVarInfo>;

  /** Current temp index, reset per statement. */
  private tempCounter = 0;

  /** Maximum temp index ever reached across all statements. */
  private tempHighWater = 0;

  /**
   * `true` when the accumulator (`$_`) is already carrying a value
   * that must not be overwritten (e.g. inside a pipe chain).
   * Phase D validation (in lsp/validation.ts) restricts `$_` reads to pipe
   * chains and event handlers at the source level. This flag is an emitter
   * concern, it prevents the emitter from clobbering `$_` during nested pipes.
   * HOEWEVER AS DISCUSSED: Nested pipes are NOT possible and aren't a concern.
   * If a pipe is called inside a function call, that function call is a pipe step itself,
   * and the return of the function will become the new pipe accumulator, which means the pipe
   * accumulator is *transformed* by the function and thus DOES NOT need to be preserved.
   */
  accumulatorReserved = false;

  constructor(
    localFunctions?: Map<string, string[]>,
    variables?: Map<string, EmitVarInfo>,
  ) {
    super();
    this.localFunctions = localFunctions ?? new Map();
    this.variables = variables ?? new Map();
  }

  /**
   * Allocate a temp variable reference (`$__t0`, `$__t1`, ...).
   * Returns the variable reference string (with `$` prefix).
   */
  allocTemp(): string {
    const idx = this.tempCounter++;
    if (this.tempCounter > this.tempHighWater) {
      this.tempHighWater = this.tempCounter;
    }
    return `$__t${idx}`;
  }

  /** Reset the temp counter for the next statement. */
  resetTemps(): void {
    this.tempCounter = 0;
  }

  /**
   * Return the list of temp variable names (without `$` prefix)
   * needed in the enclosing function's `vars` declaration.
   */
  getTempVars(): string[] {
    const vars: string[] = [];
    
    for (let i = 0; i < this.tempHighWater; i++) {
      vars.push(`__t${i}`);
    }

    return vars;
  }
}
