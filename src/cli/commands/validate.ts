import { readFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { parseArgs } from "node:util";
import { validate } from "../../core/validator.js";
import { apiCheck } from "../../core/api-check.js";
import type { ApiDescriptor } from "../../core/types.js";
import { resolvePlatforms } from "../../core/platforms.js";
import { getLatestApiDescriptor, getMtActionsDescriptor } from "@maustec/mt-runtimes";
import { info, success, error, dim, CROSS, CHECK, WARN_MARK } from "../output.js";
import { discoverWorkspace } from "../workspace.js";

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

  // --- Resolve validation targets ---
  type Target = { path: string; label: string };
  let targets: Target[];
  let strictMode = values.strict ?? false;

  if (positionals.length > 0) {
    // Explicit file(s) — may be shell-expanded glob results (e.g. mt-sdk validate **/*.json)
    targets = positionals.map((p) => ({ path: resolve(p), label: p }));
  } else {
    // Auto-discover: look for mt-sdk.json workspace config
    const workspace = discoverWorkspace(process.cwd());
    if (workspace) {
      if (!values.strict && workspace.config.strict) {
        strictMode = true;
      }
      targets = workspace.plugins.map((e) => ({ path: e.path, label: e.relative }));
      if (!values.json) {
        const rel = relative(process.cwd(), workspace.configPath);
        info(`Workspace: ${rel} — ${targets.length} plugin(s)${strictMode ? " (strict)" : ""}`);
      }
    } else {
      // Fall back: look for a single plugin.json in cwd
      const single = findSingleManifest();
      if (!single) {
        error("No plugin.json found and no mt-sdk.json workspace config.");
        process.exitCode = 1;
        return;
      }
      targets = [{ path: single, label: single }];
    }
  }

  if (targets.length === 0) {
    error("No plugins found to validate.");
    process.exitCode = 1;
    return;
  }

  // --- Load optional CLI-provided API manifest ---
  let cliManifest: ApiDescriptor | undefined;
  if (values.api) {
    try {
      cliManifest = JSON.parse(readFileSync(values.api, "utf-8")) as ApiDescriptor;
    } catch (e) {
      error(`Failed to parse API manifest: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
      return;
    }
  }

  // --- Validate all targets ---
  const multiFile = targets.length > 1;
  type BatchResult = { file: string; valid: boolean; errors: number; warnings: number };
  const batchResults: BatchResult[] = [];
  let totalPassed = 0;
  let totalFailed = 0;

  for (const target of targets) {
    let plugin: Record<string, unknown>;
    try {
      plugin = JSON.parse(readFileSync(target.path, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!values.json) {
        if (multiFile) {
          console.log(`  ${CROSS} ${target.label} ${dim(`(parse error: ${msg})`)}`);
        } else {
          error(`Failed to parse ${target.path}: ${msg}`);
        }
      }
      batchResults.push({ file: target.label, valid: false, errors: 1, warnings: 0 });
      totalFailed++;
      continue;
    }

    const result = validate({ plugin, manifest: cliManifest, strict: strictMode });

    // If no --api override and the plugin declares platforms, run tier-3 per SKU
    if (!cliManifest) {
      const platforms = Array.isArray(plugin["platforms"]) ? (plugin["platforms"] as string[]) : [];
      if (platforms.length > 0) {
        let skus: string[];
        try {
          skus = resolvePlatforms(platforms);
        } catch (e) {
          result.errors.push({
            tier: "api",
            level: "error",
            message: `platforms: ${e instanceof Error ? e.message : String(e)}`,
          });
          skus = [];
        }
        for (const sku of skus) {
          let descriptor: ApiDescriptor;
          try {
            const platform = getLatestApiDescriptor(sku);
            const common = getMtActionsDescriptor();
            // Merge: common builtins + platform-specific functions
            descriptor = {
              ...platform,
              functions: [...common.functions, ...platform.functions],
            };
          } catch {
            // No API registered for this SKU yet — skip silently
            continue;
          }
          const apiDiags = apiCheck(plugin, descriptor);
          result.errors.push(...apiDiags.filter((d) => d.level === "error"));
          result.warnings.push(...apiDiags.filter((d) => d.level === "warning"));
        }
        // Recompute valid since we may have added errors/warnings
        result.valid = strictMode
          ? result.errors.length === 0 && result.warnings.length === 0
          : result.errors.length === 0;
      }
    }
    batchResults.push({
      file: target.label,
      valid: result.valid,
      errors: result.errors.length,
      warnings: result.warnings.length,
    });

    if (!values.json) {
      if (multiFile) {
        if (result.valid) {
          console.log(`  ${CHECK} ${target.label}`);
        } else {
          console.log(`  ${CROSS} ${target.label}`);
          for (const d of result.errors) {
            console.log(`      ${CROSS} ${d.message}${d.path ? dim(` (${d.path})`) : ""}`);
          }
          for (const d of result.warnings) {
            console.log(`      ${WARN_MARK} ${d.message}${d.path ? dim(` (${d.path})`) : ""}`);
          }
        }
      } else {
        info(`Validating ${target.label}`);
        for (const d of result.errors) {
          console.log(`  ${CROSS} ${d.message}${d.path ? ` (${d.path})` : ""}`);
        }
        for (const d of result.warnings) {
          console.log(`  ${WARN_MARK} ${d.message}${d.path ? ` (${d.path})` : ""}`);
        }
      }
    }

    if (result.valid) totalPassed++;
    else totalFailed++;
  }

  // --- Output ---
  if (values.json) {
    const output = multiFile ? batchResults : batchResults[0];
    console.log(JSON.stringify(output, null, 2));
  } else if (multiFile) {
    console.log();
    if (totalFailed === 0) {
      success(`${CHECK} ${totalPassed} plugin(s) validated — all passed`);
    } else {
      error(`${totalFailed} of ${targets.length} plugin(s) failed validation`);
    }
  } else {
    const r = batchResults[0]!;
    if (r.valid) {
      success(`${CHECK} Validation passed`);
    } else {
      error(`Validation failed (${r.errors} error(s), ${r.warnings} warning(s))`);
    }
  }

  process.exitCode = totalFailed > 0 ? 1 : 0;
}

function findSingleManifest(): string | null {
  const candidates = ["plugin.json", "plugins/plugin.json", "manifest.json"];
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) return resolved;
  }
  return null;
}
