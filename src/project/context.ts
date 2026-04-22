import { resolve } from "node:path";
import { discoverWorkspace, readProjectConfig, resolveProjectConfig } from "./workspace.js";
import type { Workspace, ProjectPluginConfig } from "./workspace.js";

export interface ProjectContext {
  root: string;
  workspace: Workspace | null;
  /** Resolved per-project config with defaults applied and workspace defaults merged in. */
  projectConfig: Required<ProjectPluginConfig>;
}

/**
 * Resolve the project context from a starting directory.
 *
 * - Discovers the nearest workspace root (if any).
 * - Reads the per-project mt-sdk.json plugin section (if any).
 * - Merges into a fully resolved config with all defaults applied.
 *
 * Never throws — returns a safe default context on error.
 */
export function resolveProjectContext(from?: string): ProjectContext {
  const cwd = resolve(from ?? process.cwd());
  
  try {
    const workspace = discoverWorkspace(cwd);
    const perProject = readProjectConfig(cwd);
    const projectConfig = resolveProjectConfig(perProject, workspace?.config.strict);

    return { 
        root: workspace?.root ?? cwd, 
        workspace: workspace ?? null, 
        projectConfig 
    };
  } catch {
    return { 
        root: cwd, 
        workspace: null, 
        projectConfig: resolveProjectConfig(null) 
    };
  }
}
