import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, join, dirname, relative } from "node:path";

export interface WorkspaceConfig {
  strict?: boolean;
  /** Glob patterns for plugin directories (each must contain a plugin.json). */
  plugins?: string[];
  /** Glob patterns for app directories (each must contain a plugin.json). */
  apps?: string[];
}

export interface PluginEntry {
  /** Absolute path to the plugin.json file. */
  path: string;
  /** Path relative to the workspace root, for display. */
  relative: string;
  category: "plugin" | "app";
}

export interface Workspace {
  /** Absolute path to the mt-sdk.json config file. */
  configPath: string;
  /** Directory containing mt-sdk.json; all glob patterns are relative to this. */
  root: string;
  config: WorkspaceConfig;
  plugins: PluginEntry[];
}

/**
 * Expand a simple directory glob pattern (supports * for single-level
 * wildcards) relative to `base`, returning matching absolute directory paths.
 *
 * Only * is supported; ** and brace expansion are not needed for the
 * patterns used in mt-sdk.json (e.g. "drivers/*", "features/*").
 */
function expandDirGlob(base: string, pattern: string): string[] {
  return resolveSegments(base, pattern.split("/"));
}

function resolveSegments(base: string, [head, ...rest]: string[]): string[] {
  if (!head) return [base];
  if (!existsSync(base)) return [];

  if (head === "*") {
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory())
      .flatMap((e) => resolveSegments(join(base, e.name), rest));
  }

  return resolveSegments(join(base, head), rest);
}

/**
 * Walk up the directory tree from `from`, looking for an mt-sdk.json file.
 * Returns its absolute path if found, otherwise null.
 */
function findConfigUp(from: string): string | null {
  let dir = resolve(from);
  while (true) {
    const candidate = join(dir, "mt-sdk.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function collectPlugins(root: string, config: WorkspaceConfig): PluginEntry[] {
  const entries: PluginEntry[] = [];

  for (const category of ["plugin", "app"] as const) {
    const patterns = category === "plugin" ? config.plugins : config.apps;
    if (!patterns) continue;

    for (const pattern of patterns) {
      for (const dir of expandDirGlob(root, pattern)) {
        const manifestPath = join(dir, "plugin.json");
        if (existsSync(manifestPath)) {
          entries.push({
            path: manifestPath,
            relative: relative(root, manifestPath),
            category,
          });
        }
      }
    }
  }

  return entries;
}

/**
 * Find the nearest mt-sdk.json by walking up from `from`, load it, expand
 * all plugin globs relative to its directory, and return the Workspace.
 *
 * Returns null if no mt-sdk.json is found.
 * Throws if the config file exists but cannot be parsed.
 */
export function discoverWorkspace(from: string): Workspace | null {
  const configPath = findConfigUp(from);
  if (!configPath) return null;

  const root = dirname(configPath);
  let config: WorkspaceConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as WorkspaceConfig;
  } catch (e) {
    throw new Error(
      `Failed to parse mt-sdk.json at ${configPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    configPath,
    root,
    config,
    plugins: collectPlugins(root, config),
  };
}
