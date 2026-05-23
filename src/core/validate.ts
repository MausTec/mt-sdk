import { validate as analyzePlugin } from "../analysis/validator.js";
import type { ValidationResult, ValidateOptions as AnalysisOptions } from "../analysis/types.js";
export type { ValidationResult } from "../analysis/types.js";
export type { Diagnostic } from "../analysis/types.js";

export interface ValidateOptions {
  /** Parsed plugin.json artifact to validate. */
  plugin: Record<string, unknown>;
  /** Enable strict mode: warnings are treated as errors. */
  strict?: boolean;
  /**
   * JSON Schema to validate structure against.
   * When omitted, only structural and API checks run.
   */
  schema?: Record<string, unknown>;
  /**
   * Firmware API descriptor for cross-referencing events and host functions.
   * When omitted, API tier checks are skipped.
   */
  manifest?: AnalysisOptions["manifest"];
}

/**
 * Validate an already-compiled plugin.json artifact.
 *
 * Runs structural field checks (always), optional JSON schema validation,
 * and optional firmware API cross-reference.
 *
 * This operates on the compiled JSON artifact, not on .mtp source.
 * For MTP source, use `build()` which surfaces all errors during compilation.
 */
export function validate(options: ValidateOptions): ValidationResult {
  return analyzePlugin({
    plugin: options.plugin,
    ...(options.strict !== undefined ? { strict: options.strict } : {}),
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
    ...(options.manifest !== undefined ? { manifest: options.manifest } : {}),
  });
}