import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAllOverlays } from "./overlays/index.js";
import type { ProjectAnalysis, ProjectKind } from "./types.js";

// ---------------------------------------------------------------------------
// Kind detection
// ---------------------------------------------------------------------------

// TODO: This is somewhat of a duplicate of the project module, and might make sense to
// roll into that. The reason this exists is to allow the scaffolder to figure out 
// if we're in an umbrella so that it can properly codegen modules / plugins / apps
// within that space, or if we're in a plugin so it can prevent yo-dawg-ing a plugin
// inside a plugin so you can code while you code.
//
function detectKind(dir: string): ProjectKind {
  if (!existsSync(dir)) return "unknown";

  const sdkConfigPath = join(dir, "mt-sdk.json");

  if (existsSync(sdkConfigPath)) {
    try {
      const raw = JSON.parse(readFileSync(sdkConfigPath, "utf-8")) as Record<string, unknown>;

      if (raw["workspace"]) return "umbrella";
      if (raw["plugin"]) return "plugin";
    } catch {
      // fall through
    }
  }

  // No mt-sdk.json — heuristic detection
  try {
    const hasMtp = readdirSync(dir).some((f) => f.endsWith(".mtp"));
    if (hasMtp) return "plugin";
  } catch {
    // ignore unreadable directories
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a project directory and return its detected kind and applied overlays.
 * 
 * This delegates the overlay detection to the overlays submodule.
 */
export function analyzeProject(dir: string): ProjectAnalysis {
  const warnings: string[] = [];

  const kind = detectKind(dir);

  if (kind === "unknown" && existsSync(dir)) {
    warnings.push(
      "Could not detect project kind. Expected an mt-sdk.json or .mtp source file.",
    );
  }

  const overlays: string[] = [];

  for (const overlay of getAllOverlays()) {
    try {
      if (overlay.detect(dir)) {
        overlays.push(overlay.id);
      }
    } catch {
      warnings.push(`Error while checking overlay "${overlay.id}".`);
    }
  }

  return { dir, kind, overlays, warnings };
}
