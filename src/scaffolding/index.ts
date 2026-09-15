// Public API for the scaffolding module.
//
// Consumers (CLI, MCP tools, VS Code extension), please use only these exports.
// Internal modules are not part of the public contract, and mt-sdk has a strict module-based 
// code separation.

export type {
  ScaffoldSpec,
  PluginScaffoldSpec,
  UmbrellaScaffoldSpec,
  ScaffoldFile,
  ScaffoldResult,
  ScaffoldContext,
  TemplateVars,
  OverlayDescriptor,
  ProjectAnalysis,
  ProjectKind,
  PluginType,
  LicenseId,
} from "./types.js";

export { scaffoldPlugin } from "./scaffolders/plugin.js";
export { scaffoldUmbrella } from "./scaffolders/umbrella.js";
export { writeScaffold } from "./writer.js";
export type { WriteReport } from "./writer.js";
export { analyzeProject } from "./analyzer.js";
export {
  getAllOverlays,
  getOverlay,
  registerOverlay,
} from "./overlays/index.js";
