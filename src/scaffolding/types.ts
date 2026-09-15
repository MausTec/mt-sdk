// ---------------------------------------------------------------------------
// Scaffold specification types
// ---------------------------------------------------------------------------

export type PluginType = "feature" | "ble_driver";

export type LicenseId = "MIT" | "Apache-2.0" | "GPL-3.0" | "UNLICENSED";

export interface PluginScaffoldSpec {
  kind: "plugin";
  /** Directory slug, used as folder name and plugin `name` field. */
  name: string;
  /** Human-readable display name used in `defplugin`. */
  displayName: string;
  pluginType: PluginType;
  /** Platform targets, e.g. ["@eom", "@mercury"]. */
  platforms: string[];
  author: string;
  /** Overlay IDs to apply on top of the base scaffold. */
  overlays: string[];
  /** BLE advertised name prefix to match on. Required for pluginType "ble_driver". Adding this as a CLI flag is a weird choice but here we are. */
  blePrefix?: string;
}

export interface UmbrellaScaffoldSpec {
  kind: "umbrella";
  /** Directory slug, used as folder name. */
  name: string;
  /** Overlay IDs to apply on top of the base scaffold. */
  overlays: string[];
}

export type ScaffoldSpec = PluginScaffoldSpec | UmbrellaScaffoldSpec;

// ---------------------------------------------------------------------------
// Scaffold result
// ---------------------------------------------------------------------------

export interface ScaffoldFile {
  /** Path relative to the target directory. */
  path: string;
  content: string;
  /**
   * When true the writer will overwrite this file if it already exists.
   * Default false. Used for non-desctructive overlay regeneration.
   */
  overwrite: boolean;
}

export interface ScaffoldResult {
  spec: ScaffoldSpec;
  /** Absolute path of the directory to write into. */
  targetDir: string;
  files: ScaffoldFile[];
  warnings: string[];
}

/*
 * Context passed to the writer
 */
export interface ScaffoldContext {
  /** Absolute path of the directory to write into. */
  targetDir: string;
  /** Print plan but do not write files. */
  dryRun: boolean;
}

/*
 * Template substitution variable bag
 */
export type TemplateVars = Record<string, string>;

// ---------------------------------------------------------------------------
// Overlay descriptor
// ---------------------------------------------------------------------------

/**
 * An overlay is a named set of additional files that can be applied on top of
 * any base scaffold (plugin or umbrella). Overlays receive template variables 
 * and return file descriptors without touching the FS.
 *
 * The `detect` function allows the analyzer to determine which overlays are
 * already present in an existing project directory.
 */
export interface OverlayDescriptor {
  /** Stable identifier, e.g. "github-ci". */
  id: string;
  /** Human-readable name shown in prompts. */
  name: string;
  /** One-line description shown in prompts. */
  description: string;
  /**
   * When true this overlay is pre-selected in interactive mode.
   * The user can always deselect it.
   */
  defaultEnabled: boolean;
  /** Which scaffold kinds this overlay applies to. Omit to apply to all. */
  appliesTo?: Array<ScaffoldSpec["kind"]>;
  /**
   * Return the files this overlay contributes given the resolved template vars.
   * Must be a pure function (no FS calls).
   */
  files(vars: TemplateVars): ScaffoldFile[];
  /**
   * Return true if this overlay appears to be present in the given directory.
   * Used by the project analyzer. May read the FS.
   */
  detect(dir: string): boolean;
}

// ---------------------------------------------------------------------------
// Project analysis
// ---------------------------------------------------------------------------

export type ProjectKind = "plugin" | "umbrella" | "unknown";

export interface ProjectAnalysis {
  /** Absolute path of the analyzed directory. */
  dir: string;
  kind: ProjectKind;
  /** IDs of overlays that appear to be present. */
  overlays: string[];
  /** Any issues found during analysis (non-fatal). */
  warnings: string[];
}
