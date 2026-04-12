import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { info, warn, error, success, dim } from "../output.js";
import { transpile } from "../../lang/index.js";
import type { LangDiagnostic } from "../../lang/index.js";

type ProjectType = "app" | "json-plugin" | "mtp-plugin" | "monorepo" | "unknown";

function detectProjectType(cwd: string): ProjectType {
  // Monorepo: has mt-sdk.json in cwd
  if (existsSync(join(cwd, "mt-sdk.json"))) return "monorepo";

  // App: has manifest.json in cwd
  if (existsSync(join(cwd, "manifest.json"))) return "app";

  // Check for .mtp files, which takes precedence over .json (JSON is assumed to be compiled output)
  let hasMtp = false;
  try {
    hasMtp = readdirSync(cwd).some((f) => f.endsWith(".mtp"));
  } catch {
    // ignore unreadable directories
  }
  if (hasMtp) return "mtp-plugin";

  // JSON Plugin: has plugin.json
  if (existsSync(join(cwd, "plugin.json"))) return "json-plugin";

  return "unknown";
}

function buildPlugin(cwd: string): void {
  const mtpFile = readdirSync(cwd).find((f) => f.endsWith(".mtp"));

  if (!mtpFile) {
    error("No .mtp file found in current directory.");
    process.exitCode = 1;
    return;
  }

  const filePath = join(cwd, mtpFile);
  info(`Transpiling ${mtpFile}…`);

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

  const errors = diagnostics.filter((d: LangDiagnostic) => d.level === "error");

  if (errors.length > 0) {
    error(`Transpilation failed with ${errors.length} error(s).`);
    console.log(JSON.stringify(plugin, null, 2));
    process.exitCode = 1;
    return;
  }

  success("Transpilation complete. Output:");
  console.log(JSON.stringify(plugin, null, 2));
}

export async function buildCommand(argv: string[]): Promise<void> {
  const cwd = process.cwd();
  const type = detectProjectType(cwd);

  switch (type) {
    case "app":
      info("App project detected — will compile C app to WASM. (not yet implemented)");
      break;
    case "json-plugin":
      info("JSON Plugin detected — nothing to build.");
      break;
    case "mtp-plugin":
      buildPlugin(cwd);
      break;
    case "monorepo":
      info("Monorepo detected — will build all projects. (not yet implemented)");
      break;
    default:
      warn("Unable to detect project type. Ensure the current directory contains an mt-sdk.json, manifest.json, plugin.json, or *.mtp file.");
      process.exitCode = 1;
  }
}
