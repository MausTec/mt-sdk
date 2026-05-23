import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import type { Diagnostic } from "./types.js";

// ajv modules export differently under CJS/ESM — resolve the constructor
const Ajv = AjvModule.default ?? AjvModule;
type AjvInstance = InstanceType<typeof Ajv>;
const addFormats = addFormatsModule.default ?? addFormatsModule;

/**
 * Tier 2 validation: JSON Schema validation using ajv.
 * Validates plugin manifest against the package-common schema.
 */
export function schemaCheck(
  plugin: Record<string, unknown>,
  schema: Record<string, unknown>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  const ajv: AjvInstance = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);

  const validate = ajv.compile(schema);
  const valid = validate(plugin);

  if (!valid && validate.errors) {
    for (const err of validate.errors) {
      diagnostics.push({
        tier: "schema",
        level: "error",
        path: err.instancePath || undefined,
        message: `${err.instancePath || "/"}: ${err.message ?? "schema validation failed"}`,
      });
    }
  }

  return diagnostics;
}
