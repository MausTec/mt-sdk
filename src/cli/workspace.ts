// Thin re-export shim, workspace logic has moved to src/project/workspace.ts.
// CLI commands continue to import from this path unchanged.
export type { WorkspaceConfig, PluginEntry, Workspace } from "../project/workspace.js";
export { discoverWorkspace } from "../project/workspace.js";
