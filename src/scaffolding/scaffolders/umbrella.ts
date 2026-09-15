import { resolve } from "node:path";
import type { UmbrellaScaffoldSpec, ScaffoldFile, ScaffoldResult, TemplateVars } from "../types.js";
import { getOverlay } from "../overlays/index.js";

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const UMBRELLA_SDK_CONFIG_TEMPLATE = `\
{
  "workspace": {
    "members": ["apps/*"],
    "strict": false
  }
}
`;

// An empty `.gitkeep` so git tracks the empty apps/ directory.
const GITKEEP = "";

// ---------------------------------------------------------------------------
// Scaffolder
// ---------------------------------------------------------------------------

/**
 * Produce a ScaffoldResult for a new umbrella workspace.
 * Does not touch the file system.
 */
export function scaffoldUmbrella(
  spec: UmbrellaScaffoldSpec,
  targetDir: string,
): ScaffoldResult {
  const vars: TemplateVars = {
    kind: "umbrella",
    name: spec.name,
    display_name: spec.name,
    year: String(new Date().getFullYear()),
    author: "",
    license: "MIT",
  };

  const base: ScaffoldFile[] = [
    {
      path: "mt-sdk.json",
      content: UMBRELLA_SDK_CONFIG_TEMPLATE,
      overwrite: false,
    },
    {
      path: "apps/.gitkeep",
      content: GITKEEP,
      overwrite: false,
    },
  ];

  const overlayFiles: ScaffoldFile[] = [];
  const warnings: string[] = [];

  for (const id of spec.overlays) {
    const overlay = getOverlay(id);
    if (!overlay) {
      warnings.push(`Unknown overlay "${id}". Skipped.`);
      continue;
    }
    if (overlay.appliesTo && !overlay.appliesTo.includes("umbrella")) {
      warnings.push(`Overlay "${id}" does not apply to umbrellas. Skipped.`);
      continue;
    }
    overlayFiles.push(...overlay.files(vars));
  }

  return {
    spec,
    targetDir: resolve(targetDir),
    files: [...base, ...overlayFiles],
    warnings,
  };
}
