import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, join, dirname, relative } from "node:path";

// --- Per-project build config -----------------------------------------------

/**
 * Per-project build overrides, read from a project-level mt-sdk.json.
 * All fields are optional.
 *
 * Defaults:
 *   src    -> "plugin.mtp"
 *   out    -> "dist/plugin.json"
 *   tests  -> "tests/"
 *   strict -> false
 */
export interface ProjectPluginConfig {
  /** MTP source entry point relative to the project directory. */
  src?: string;
  /** Output path for the compiled plugin.json, relative to the project directory. */
  out?: string;
  /** Strict validation mode for this project. */
  strict?: boolean;
  /** Directory containing .test.mtp files, relative to the project directory. */
  tests?: string;
}

// --- Workspace types -------------------------------------------------------

export interface WorkspaceConfig {
  /** Glob patterns for workspace members (project directories). */
  members: string[];
  /** Workspace-wide strict validation mode. Default: false. */
  strict?: boolean;

  // TODO: Add other defaults that we can apply here, compiler settings, etc.
}

/**
 * The detected type of a workspace member directory.
 *
 * - `mtp-plugin`: has a .mtp source file or a project-level mt-sdk.json with a `plugin` section
 * - `json-plugin`: has only a plugin.json artifact (legacy, pre-MTP project)
 * - `app`: has a manifest.json (WASM app project -- tooling not yet implemented)
 * - `unknown`: directory matched by workspace glob but cannot be classified
 */
export type MemberKind = "mtp-plugin" | "json-plugin" | "app" | "unknown";

export interface PluginEntry {
  /** Absolute path to the member project directory. */
  dir: string;
  /** Path relative to the workspace root, for display. */
  relative: string;
  kind: MemberKind;
  /** Resolved per-project config (defaults applied, workspace strict merged in). */
  config: Required<ProjectPluginConfig>;
}

export interface Workspace {
  /** Absolute path to the mt-sdk.json that defines this workspace. */
  configPath: string;
  /** Directory containing that mt-sdk.json. */
  root: string;
  config: WorkspaceConfig;
  members: PluginEntry[];
}

// --- Default project config values -----------------------------------------

export const PROJECT_CONFIG_DEFAULTS = {
  src: "plugin.mtp",
  out: "dist/plugin.json",
  strict: false,
  tests: "tests/",
} as const satisfies Required<ProjectPluginConfig>;


// --- Raw mt-sdk.json shape (internal) --------------------------------------

interface RawWorkspaceSection {
  members?: string[];
  strict?: boolean;
}

interface RawSdkConfig {
  workspace?: RawWorkspaceSection;
  plugin?: ProjectPluginConfig;
  strict?: boolean;
}

// --- Config loading helpers ------------------------------------------------

/**
 * Load and parse an mt-sdk.json file. Returns null if the file does not exist. 
 * Throws if the file exists but cannot be parsed as JSON.
 */
function loadSdkConfig(path: string): RawSdkConfig | null {
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RawSdkConfig;
  } catch (e) {
    throw new Error(
      `Failed to parse mt-sdk.json at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * A file is a workspace root if it has a `workspace` section. A file with only a `plugin` section is a
 * per-project override, not a workspace root.
 */
function isWorkspaceRoot(raw: RawSdkConfig): boolean {
  return !!(raw.workspace);
}

function parseWorkspaceConfig(raw: RawSdkConfig): WorkspaceConfig {
  if (raw.workspace) {
    return {
      members: raw.workspace.members ?? [],
      strict: raw.workspace.strict ?? false,
    };
  }

  return { members: [], strict: raw.strict ?? false };
}

/**
 * Read the per-project mt-sdk.json from a directory, returning its `plugin`
 * section if present, or null otherwise.
 */
export function readProjectConfig(dir: string): ProjectPluginConfig | null {
  const configPath = join(dir, "mt-sdk.json");
  const raw = loadSdkConfig(configPath);

  if (!raw || !raw.plugin) return null;
  
  return raw.plugin;
}

/**
 * Merge per-project config overrides with defaults.
 * `workspaceStrict` is applied only when the project does not explicitly set strict.
 */
export function resolveProjectConfig(
  projectConfig: ProjectPluginConfig | null,
  workspaceStrict?: boolean,
): Required<ProjectPluginConfig> {
  return {
    src:    projectConfig?.src    ?? PROJECT_CONFIG_DEFAULTS.src,
    out:    projectConfig?.out    ?? PROJECT_CONFIG_DEFAULTS.out,
    strict: projectConfig?.strict ?? workspaceStrict ?? PROJECT_CONFIG_DEFAULTS.strict,
    tests:  projectConfig?.tests  ?? PROJECT_CONFIG_DEFAULTS.tests,
  };
}

// --- Member detection ------------------------------------------------------

function detectMemberKind(dir: string, projectConfig: ProjectPluginConfig | null): MemberKind {
  // Explicit project config always wins
  if (projectConfig) return "mtp-plugin";

  // Has a .mtp source file (test files excluded) -> mtp-plugin
  try {
    const hasMtp = readdirSync(dir).some((f) => f.endsWith(".mtp") && !f.endsWith(".test.mtp"));
    if (hasMtp) return "mtp-plugin";
  } catch {
    // ignore unreadable dirs
  }

  // Has manifest.json -> app (detection only; tooling not yet implemented)
  if (existsSync(join(dir, "manifest.json"))) return "app";

  // Has plugin.json only -> legacy JSON project awaiting MTP migration
  if (existsSync(join(dir, "plugin.json"))) return "json-plugin";

  return "unknown";
}

// --- Glob expansion (single-level * only) ----------------------------------

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

// --- Member collection -----------------------------------------------------

function collectMembers(root: string, config: WorkspaceConfig): PluginEntry[] {
  const entries: PluginEntry[] = [];

  for (const pattern of config.members) {
    for (const dir of expandDirGlob(root, pattern)) {
      const projectConfig = readProjectConfig(dir);
      const kind = detectMemberKind(dir, projectConfig);
      const resolved = resolveProjectConfig(projectConfig, config.strict);

      entries.push({
        dir,
        relative: relative(root, dir),
        kind,
        config: resolved,
      });
    }
  }

  return entries;
}

// --- Workspace discovery ---------------------------------------------------

/**
 * Walk up the directory tree from `from`, looking for an mt-sdk.json that
 * defines a workspace (has a `workspace` section or legacy `plugins`/`apps` arrays).
 *
 * Per-project mt-sdk.json files (with only a `plugin` section) are skipped
 * during the walk, they are project-level overrides, not workspace roots.
 *
 * Returns null if no workspace root is found.
 * Throws if an mt-sdk.json exists but cannot be parsed.
 * 
 * I thought about possibly constraining this to only a few levels, we'll see if that matters.
 */
export function discoverWorkspace(from: string): Workspace | null {
  let dir = resolve(from);

  while (true) {
    const candidate = join(dir, "mt-sdk.json");
    const raw = loadSdkConfig(candidate);

    if (raw !== null && isWorkspaceRoot(raw)) {
      const config = parseWorkspaceConfig(raw);

      return {
        configPath: candidate,
        root: dir,
        config,
        members: collectMembers(dir, config),
      };
    }

    const parent = dirname(dir);
    
    if (parent === dir) return null;
    dir = parent;
  }
}
