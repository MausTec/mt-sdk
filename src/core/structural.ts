import type { Diagnostic } from "./types.js";

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+/;
const PERMISSION_RE = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_*]*$/;
const VALID_TYPES = ["feature", "ble_driver", "app"] as const;
const VALID_CONFIG_TYPES = ["int", "bool", "string"] as const;

/**
 * Tier 1 validation: lightweight structural checks with zero dependencies.
 * Validates field presence, naming, semver, permissions, and config shape.
 */
export function structuralCheck(
  plugin: Record<string, unknown>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  function error(message: string, path?: string) {
    diagnostics.push({ tier: "structural", level: "error", message, path });
  }
  function warn(message: string, path?: string) {
    diagnostics.push({ tier: "structural", level: "warning", message, path });
  }

  // Required fields
  const requiredFields = [
    "name",
    "version",
    "sdkVersion",
    "displayName",
    "author",
    "license",
    "type",
  ];
  for (const field of requiredFields) {
    if (!(field in plugin) || plugin[field] === "" || plugin[field] === undefined) {
      error(`Missing required field: ${field}`, field);
    }
  }

  // Hub metadata (recommended but not fatal)
  const hubFields = ["description", "repository"];
  for (const field of hubFields) {
    if (!(field in plugin) || plugin[field] === "" || plugin[field] === undefined) {
      warn(`Missing recommended Hub metadata field: ${field}`, field);
    }
  }

  // Name format
  if (typeof plugin["name"] === "string" && !NAME_RE.test(plugin["name"])) {
    error(
      `Name must match ${NAME_RE.source} (got "${plugin["name"]}")`,
      "name",
    );
  }

  // Semver
  if (typeof plugin["version"] === "string" && !SEMVER_RE.test(plugin["version"])) {
    error(
      `Version must be semver (got "${plugin["version"]}")`,
      "version",
    );
  }
  if (typeof plugin["sdkVersion"] === "string" && !SEMVER_RE.test(plugin["sdkVersion"])) {
    error(
      `sdkVersion must be semver (got "${plugin["sdkVersion"]}")`,
      "sdkVersion",
    );
  }

  // Type
  if (
    typeof plugin["type"] === "string" &&
    !(VALID_TYPES as readonly string[]).includes(plugin["type"])
  ) {
    error(
      `Invalid type "${plugin["type"]}" (expected: ${VALID_TYPES.join(", ")})`,
      "type",
    );
  }

  // Permissions
  if (Array.isArray(plugin["permissions"])) {
    for (const [i, perm] of (plugin["permissions"] as unknown[]).entries()) {
      if (typeof perm !== "string" || !PERMISSION_RE.test(perm)) {
        error(
          `Invalid permission format: "${String(perm)}" (expected resource:action)`,
          `permissions[${i}]`,
        );
      }
    }
  }

  // Config schema
  if (plugin["config"] != null && typeof plugin["config"] === "object") {
    const config = plugin["config"] as Record<string, unknown>;
    for (const [fieldName, fieldDef] of Object.entries(config)) {
      if (fieldDef == null || typeof fieldDef !== "object") {
        error(`Config field "${fieldName}" must be an object`, `config.${fieldName}`);
        continue;
      }
      const def = fieldDef as Record<string, unknown>;

      if (!(VALID_CONFIG_TYPES as readonly string[]).includes(String(def["type"] ?? ""))) {
        error(
          `Config field "${fieldName}" has invalid type "${String(def["type"])}" (expected: ${VALID_CONFIG_TYPES.join(", ")})`,
          `config.${fieldName}.type`,
        );
      }

      if (!("default" in def)) {
        error(
          `Config field "${fieldName}" is missing required "default" value`,
          `config.${fieldName}.default`,
        );
      }
    }
  }

  // Functions
  if (plugin["functions"] != null && typeof plugin["functions"] === "object") {
    const functions = plugin["functions"] as Record<string, unknown>;
    for (const [fnName, fnDef] of Object.entries(functions)) {
      if (fnDef == null || typeof fnDef !== "object") {
        error(`Function "${fnName}" must be an object`, `functions.${fnName}`);
        continue;
      }
      const def = fnDef as Record<string, unknown>;
      if (!("actions" in def) || !Array.isArray(def["actions"])) {
        error(
          `Function "${fnName}" must have an "actions" array`,
          `functions.${fnName}.actions`,
        );
      }
    }
  }

  // Events
  if (plugin["events"] != null && typeof plugin["events"] === "object") {
    const events = plugin["events"] as Record<string, unknown>;
    for (const [evName, evDef] of Object.entries(events)) {
      if (evDef == null || typeof evDef !== "object") {
        error(`Event "${evName}" must be an object`, `events.${evName}`);
        continue;
      }
      const def = evDef as Record<string, unknown>;
      if (!("actions" in def) || !Array.isArray(def["actions"])) {
        error(
          `Event "${evName}" must have an "actions" array`,
          `events.${evName}.actions`,
        );
      }
    }
  }

  return diagnostics;
}
