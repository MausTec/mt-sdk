import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, extname, dirname, basename } from "node:path";
import { parseArgs } from "node:util";
import { info, warn, error, success, dim } from "../output.js";
import { transpile } from "../../lang/index.js";
import type { LangDiagnostic } from "../../lang/index.js";

type ProjectType = "app" | "json-plugin" | "mtp-plugin" | "monorepo" | "unknown";

function detectProjectType(dir: string): ProjectType {
  // Monorepo: has mt-sdk.json in dir
  if (existsSync(join(dir, "mt-sdk.json"))) return "monorepo";

  // App: has manifest.json in dir
  if (existsSync(join(dir, "manifest.json"))) return "app";

  // Check for .mtp files, which takes precedence over .json (JSON is assumed to be compiled output)
  let hasMtp = false;
  try {
    hasMtp = readdirSync(dir).some((f) => f.endsWith(".mtp"));
  } catch {
    // ignore unreadable directories
  }
  if (hasMtp) return "mtp-plugin";

  // JSON Plugin: has plugin.json
  if (existsSync(join(dir, "plugin.json"))) return "json-plugin";

  return "unknown";
}

/**
 * Resolve the output destination from the --out value and project directory.
 * Returns an absolute file path, or "-" for stdout.
 */
function resolveOutput(out: string | undefined, projectDir: string): string {
  if (out === "-") return "-";
  if (!out) return join(projectDir, "plugin.json");

  const resolved = resolve(out);

  // If it exists and is a directory, or ends with a separator, treat as directory
  if (
    (existsSync(resolved) && statSync(resolved).isDirectory()) ||
    out.endsWith("/")
  ) {
    return join(resolved, "plugin.json");
  }

  // Treat as a file path
  const ext = extname(resolved);
  if (ext && ext !== ".json") {
    warn(`Output file has extension "${ext}", expected ".json".`);
  }

  return resolved;
}

/**
 * Write the build result to the resolved output destination.
 */
function writeOutput(dest: string, json: string): void {
  if (dest === "-") {
    process.stdout.write(json + "\n");
    return;
  }

  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, json + "\n", "utf8");
  success(`Wrote ${dest}`);
}

function buildMtpFile(filePath: string, outputDest: string): void {
  const label = basename(filePath);
  info(`Transpiling ${label}...`);

  const source = readFileSync(filePath, "utf8");
  const { plugin, diagnostics } = transpile(source);

  // Emit diagnostics
  for (const diag of diagnostics) {
    const loc = diag.span
      ? dim(` (${diag.span.line}:${diag.span.col})`)
      : "";
    if (diag.level === "error") {
      error(`${diag.message}${loc}`);
    } else {
      warn(`${diag.message}${loc}`);
    }
  }

  const warnings = diagnostics.filter((d: LangDiagnostic) => d.level === "warning");
  const errors = diagnostics.filter((d: LangDiagnostic) => d.level === "error");

  const json = JSON.stringify(plugin, null, 2);

  if (errors.length > 0) {
    error(`Transpilation failed with ${errors.length} error(s)${warnings.length > 0 ? ` and ${warnings.length} warning(s)` : ""}`);
    // Still write partial output so user can inspect it
    writeOutput(outputDest, json);
    process.exitCode = 1;
    return;
  } else if (warnings.length > 0) {
    warn(`Transpilation completed with ${warnings.length} warning(s).`);
  }

  writeOutput(outputDest, json);
}

function buildProject(dir: string, outputDest: string): void {
  const mtpFile = readdirSync(dir).find((f) => f.endsWith(".mtp"));

  if (!mtpFile) {
    error("No .mtp file found in directory.");
    process.exitCode = 1;
    return;
  }

  buildMtpFile(join(dir, mtpFile), outputDest);
}

export async function buildCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      out: { type: "string", short: "o" },
    },
    allowPositionals: true,
  });

  const target = positionals[0] ? resolve(positionals[0]) : undefined;

  // --- Single file argument ---
  if (target && existsSync(target) && statSync(target).isFile()) {
    const ext = extname(target);

    if (ext === ".mtp") {
      const outputDest = resolveOutput(values.out, dirname(target));
      buildMtpFile(target, outputDest);
      return;
    }

    if (ext === ".json") {
      info("JSON file, nothing to build.");
      return;
    }

    error(`Unsupported file type "${ext}". Expected .mtp or .json.`);
    process.exitCode = 1;
    return;
  }

  // --- Directory / project build ---
  const projectDir = target ?? process.cwd();

  if (target && !existsSync(target)) {
    error(`Path not found: ${positionals[0]}`);
    process.exitCode = 1;
    return;
  }

  const type = detectProjectType(projectDir);
  const outputDest = resolveOutput(values.out, projectDir);

  switch (type) {
    case "app":
      info("App project detected, will compile C app to WASM. (not yet implemented)");
      break;
    case "json-plugin":
      info("JSON Plugin detected, nothing to build.");
      break;
    case "mtp-plugin":
      buildProject(projectDir, outputDest);
      break;
    case "monorepo":
      info("Monorepo detected, will build all projects. (not yet implemented)");
      break;
    default:
      warn("Unable to detect project type. Ensure the current directory contains an mt-sdk.json, manifest.json, plugin.json, or *.mtp file.");
      process.exitCode = 1;
  }
}
