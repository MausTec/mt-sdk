import type { ValidateOptions, ValidationResult, Diagnostic } from "./types.js";
import { structuralCheck } from "./structural.js";
import { schemaCheck } from "./schema.js";
import { apiCheck } from "./api-check.js";

/**
 * Three-tier validation orchestrator.
 *
 * Tier 1 (structural): Always runs — zero-dep field presence/format checks
 * Tier 2 (schema): Runs if a JSON schema is provided
 * Tier 3 (api): Runs if a runtime manifest is provided — cross-references
 *   events and host functions against actual firmware capabilities
 */
export function validate(options: ValidateOptions): ValidationResult {
  const all: Diagnostic[] = [];

  // Tier 1: Structural (always)
  all.push(...structuralCheck(options.plugin));

  // Tier 2: JSON Schema (if schema provided)
  if (options.schema) {
    all.push(...schemaCheck(options.plugin, options.schema));
  }

  // Tier 3: API cross-reference (if manifest provided)
  if (options.manifest) {
    all.push(...apiCheck(options.plugin, options.manifest));
  }

  const errors = all.filter((d) => d.level === "error");
  const warnings = all.filter((d) => d.level === "warning");

  return {
    valid: options.strict ? errors.length === 0 && warnings.length === 0 : errors.length === 0,
    errors,
    warnings,
  };
}
