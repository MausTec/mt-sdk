import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { validate } from "../../core/validator.js";
import type { RuntimeManifest } from "../../core/types.js";
import { info, success, error, CROSS, CHECK, WARN_MARK } from "../output.js";

export async function validateCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      api: { type: "string" },
      strict: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  // Find manifest
  const manifestPath = findManifest(positionals[0]);
  if (!manifestPath) {
    error("No plugin.json or manifest.json found.");
    process.exitCode = 1;
    return;
  }

  info(`Validating ${manifestPath}`);

  // Load plugin
  let plugin: Record<string, unknown>;
  try {
    plugin = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  } catch (e) {
    error(`Failed to parse ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }

  // Load API manifest if provided
  let manifest: RuntimeManifest | undefined;
  if (values.api) {
    try {
      manifest = JSON.parse(readFileSync(values.api, "utf-8")) as RuntimeManifest;
    } catch (e) {
      error(`Failed to parse API manifest: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
      return;
    }
  }

  // Run validation
  const result = validate({
    plugin,
    manifest,
    strict: values.strict,
  });

  // Output
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const d of result.errors) {
      console.log(`  ${CROSS} ${d.message}${d.path ? ` (${d.path})` : ""}`);
    }
    for (const d of result.warnings) {
      console.log(`  ${WARN_MARK} ${d.message}${d.path ? ` (${d.path})` : ""}`);
    }

    if (result.valid) {
      success(`${CHECK} Validation passed`);
    } else {
      error(`Validation failed (${result.errors.length} error(s), ${result.warnings.length} warning(s))`);
    }
  }

  process.exitCode = result.valid ? 0 : 1;
}

function findManifest(explicit?: string): string | null {
  if (explicit) {
    const resolved = resolve(explicit);
    return existsSync(resolved) ? resolved : null;
  }

  const candidates = ["plugin.json", "plugins/plugin.json", "manifest.json"];
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) return resolved;
  }
  return null;
}
