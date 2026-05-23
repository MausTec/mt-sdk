import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { readProjectConfig, PROJECT_CONFIG_DEFAULTS } from "./workspace.js";

export type PluginSource =
  | { kind: "mtp"; path: string; source: string }
  | { kind: "json"; path: string; data: Record<string, unknown> };

/**
 * Resolve a plugin source from an optional path argument.
 *
 * - If `arg` is provided: treat as file or directory and resolve from there.
 * - If `arg` is omitted: auto-discover from `from` (defaults to cwd).
 *
 * Returns null for app directories (contain manifest.json, no .mtp or plugin.json).
 * Throws for unresolvable paths or malformed files.
 */
export function resolvePlugin(arg: string | undefined, from?: string): PluginSource | null {
  if (arg !== undefined) return resolveFromArg(arg);
  return autoDiscover(from ?? process.cwd());
}

function resolveFromArg(arg: string): PluginSource | null {
  const resolved = resolve(arg);

  if (!existsSync(resolved)) throw new Error(`Path not found: ${arg}`);
  if (statSync(resolved).isFile()) return readPluginFile(resolved);
  
  return resolveFromDir(resolved);
}

function resolveFromDir(dir: string): PluginSource | null {
  // Check project config for an explicit src override
  const projectConfig = readProjectConfig(dir);
  const src = projectConfig?.src ?? PROJECT_CONFIG_DEFAULTS.src;
  const srcPath = join(dir, src);

  if (existsSync(srcPath)) {
    return { kind: "mtp", path: srcPath, source: readFileSync(srcPath, "utf-8") };
  }

  // Fall back to scanning for any .mtp file
  try {
    const mtpFile = readdirSync(dir).find((f) => f.endsWith(".mtp") && !f.endsWith(".test.mtp"));

    if (mtpFile) {
      const full = join(dir, mtpFile);
      return { kind: "mtp", path: full, source: readFileSync(full, "utf-8") };
    }
  } catch {
    // ignore unreadable dirs
  }

  // manifest.json -> app directory, return null silently
  if (existsSync(join(dir, "manifest.json"))) return null;

  // Legacy: plugin.json only
  const jsonPath = join(dir, "plugin.json");
  if (existsSync(jsonPath)) return readPluginFile(jsonPath);

  return null;
}

function autoDiscover(from: string): PluginSource | null {
  const dir = resolve(from);
  return resolveFromDir(dir);
}

function readPluginFile(path: string): PluginSource {
  const ext = extname(path);

  if (ext === ".mtp") {
    return { kind: "mtp", path, source: readFileSync(path, "utf-8") };
  }

  if (ext === ".json") {
    try {
      return {
        kind: "json",
        path,
        data: JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>,
      };
    } catch (e) {
      throw new Error(
        `Failed to parse ${path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  
  throw new Error(`Unsupported file type "${ext}" at ${path}. Expected .mtp or .json.`);
}
