import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, relative, extname, join, dirname, basename } from "node:path";
import { parseArgs } from "node:util";
import { validate } from "../../analysis/validator.js";
import { apiCheck } from "../../analysis/api-check.js";
import type { ApiDescriptor } from "../../analysis/types.js";
import { resolvePlatforms } from "../../analysis/platforms.js";
import { getLatestApiDescriptor, getMtActionsDescriptor } from "@maustec/mt-runtimes";
import { info, success, error, warn, dim, CROSS, CHECK, WARN_MARK } from "../output.js";
import { discoverWorkspace } from "../workspace.js";
import { transpile } from "../../lang/index.js";
import type { LangDiagnostic } from "../../lang/index.js";

type Target = { path: string; label: string; kind: "json" | "mtp" };

/**
 * Resolve a single positional argument to one or more validation targets.
 * Accepts a .json file, .mtp file, or a directory (checks for .mtp first, then plugin.json).
 */
function resolvePositional(arg: string): Target[] {
  const resolved = resolve(arg);

  if (!existsSync(resolved)) {
    error(`Path not found: ${arg}`);
    return [];
  }

  if (statSync(resolved).isFile()) {
    const ext = extname(resolved);
    if (ext === ".mtp") return [{ path: resolved, label: arg, kind: "mtp" }];
    if (ext === ".json") return [{ path: resolved, label: arg, kind: "json" }];
    error(`Unsupported file type "${ext}". Expected .mtp or .json.`);
    return [];
  }

  // Directory: prefer .mtp source over JSON artifact
  const dir = resolved;
  try {
    const mtpFile = readdirSync(dir).find((f) => f.endsWith(".mtp"));
    if (mtpFile) {
      const rel = arg.endsWith("/") ? arg + mtpFile : arg + "/" + mtpFile;
      return [{ path: join(dir, mtpFile), label: rel, kind: "mtp" }];
    }
  } catch {
    // ignore
  }

  const jsonPath = join(dir, "plugin.json");
  if (existsSync(jsonPath)) {
    const rel = arg.endsWith("/") ? arg + "plugin.json" : arg + "/plugin.json";
    return [{ path: jsonPath, label: rel, kind: "json" }];
  }

  error(`No .mtp or plugin.json found in ${arg}`);
  return [];
}

/**
 * Auto-discover a single validation target from cwd (no positional args, no workspace).
 * Prefers .mtp source over compiled JSON artifact.
 */
function findSingleTarget(): Target | null {
  const cwd = process.cwd();

  // Check for .mtp source first
  try {
    const mtpFile = readdirSync(cwd).find((f) => f.endsWith(".mtp"));
    if (mtpFile) {
      return { path: join(cwd, mtpFile), label: mtpFile, kind: "mtp" };
    }
  } catch {
    // ignore
  }

  // Fall back to finding a JSON manifest
  const candidates = ["plugin.json", "plugins/plugin.json", "manifest.json"];
  
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) {
      return { path: resolved, label: candidate, kind: "json" };
    }
  }

  return null;
}

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
  let targets: Target[];
  let strictMode = values.strict ?? false;

  if (positionals.length > 0) {
    targets = positionals.flatMap(resolvePositional);
  } else {
    // Auto-discover: look for mt-sdk.json workspace config
    const workspace = discoverWorkspace(process.cwd());
    if (workspace) {
      if (!values.strict && workspace.config.strict) {
        strictMode = true;
      }
      targets = workspace.members.map((e) => ({ path: e.dir, label: e.relative, kind: "json" as const }));
      if (!values.json) {
        const rel = relative(process.cwd(), workspace.configPath);
        info(`Workspace: ${rel} — ${targets.length} plugin(s)${strictMode ? " (strict)" : ""}`);
      }
    } else {
      const single = findSingleTarget();
      if (!single) {
        error("No .mtp or plugin.json found and no mt-sdk.json workspace config.");
        process.exitCode = 1;
        return;
      }
      targets = [single];
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
    let transpileDiags: LangDiagnostic[] = [];

    if (target.kind === "mtp") {
      // Transpile .mtp in-memory — never writes to disk
      let source: string;
      try {
        source = readFileSync(target.path, "utf-8");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!values.json) {
          if (multiFile) {
            console.log(`  ${CROSS} ${target.label} ${dim(`(read error: ${msg})`)}`);
          } else {
            error(`Failed to read ${target.path}: ${msg}`);
          }
        }
        batchResults.push({ file: target.label, valid: false, errors: 1, warnings: 0 });
        totalFailed++;
        continue;
      }

      const result = transpile(source);
      plugin = result.plugin as unknown as Record<string, unknown>;
      transpileDiags = result.diagnostics;

      // Show transpile diagnostics
      const transpileErrors = transpileDiags.filter((d) => d.level === "error");
      if (!values.json && transpileErrors.length > 0) {
        if (!multiFile) {
          info(`Transpiling ${basename(target.path)}...`);
        }
        for (const diag of transpileDiags) {
          const loc = diag.span ? dim(` (${diag.span.line}:${diag.span.col})`) : "";
          if (diag.level === "error") {
            if (multiFile) {
              // Suppress individual transpile errors in batch — just show summary below
            } else {
              console.log(`  ${CROSS} ${diag.message}${loc}`);
            }
          } else {
            if (!multiFile) {
              console.log(`  ${WARN_MARK} ${diag.message}${loc}`);
            }
          }
        }
      }
    } else {
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
    }

    const result = validate({ plugin, manifest: cliManifest, strict: strictMode });

    // Count transpile diagnostics (for .mtp targets) alongside validation results
    const transpileErrors = transpileDiags.filter((d) => d.level === "error").length;
    const transpileWarnings = transpileDiags.filter((d) => d.level === "warning").length;

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

    // Transpile errors make the target invalid regardless of schema validation
    const totalErrors = result.errors.length + transpileErrors;
    const totalWarnings = result.warnings.length + transpileWarnings;
    const valid = strictMode
      ? totalErrors === 0 && totalWarnings === 0
      : totalErrors === 0;

    batchResults.push({
      file: target.label,
      valid,
      errors: totalErrors,
      warnings: totalWarnings,
    });

    if (!values.json) {
      if (multiFile) {
        if (valid) {
          console.log(`  ${CHECK} ${target.label}`);
        } else {
          const parts: string[] = [];
          if (transpileErrors > 0) parts.push(`${transpileErrors} transpile error(s)`);
          console.log(`  ${CROSS} ${target.label}${parts.length ? dim(` (${parts.join(", ")})`) : ""}`);
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

    if (valid) totalPassed++;
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
