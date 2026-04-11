import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { info, warn } from "../output.js";

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
      info("MTP Plugin detected — will transpile MTP Plugin to JSON. (not yet implemented)");
      break;
    case "monorepo":
      info("Monorepo detected — will build all projects. (not yet implemented)");
      break;
    default:
      warn("Unable to detect project type. Ensure the current directory contains an mt-sdk.json, manifest.json, plugin.json, or *.mtp file.");
      process.exitCode = 1;
  }
}
