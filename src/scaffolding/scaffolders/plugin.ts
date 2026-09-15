import { resolve } from "node:path";
import type { PluginScaffoldSpec, ScaffoldFile, ScaffoldResult, TemplateVars } from "../types.js";
import { render } from "../render.js";
import { getOverlay } from "../overlays/index.js";

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const PLUGIN_MTP_TEMPLATE = `\
defplugin {{ identifier }} do
  @display_name "{{ display_name }}"
  @version      "0.1.0"
  @sdk_version  "~> 1.1.0"
  @type         "{{ plugin_type }}"
  @author       "{{ author }}"
  @license      "{{ license }}"
  @platforms    [{{ platforms }}]
  @permissions  [{{ permissions }}]
{{ match_block }}
  on :connect do
    log "{{ name }}: connected"
  end

  on :disconnect do
    log "{{ name }}: disconnected"
  end
end
`;

const SMOKE_TEST_TEMPLATE = `\
# Smoke tests for {{ display_name }}

deftest for {{ identifier }} do
  mock log = (string msg) -> 0

  describe "lifecycle" do
    test "connects and disconnects cleanly" do
      emit :connect
      emit :disconnect
    end
  end
end
`;

// ---------------------------------------------------------------------------
// Scaffolder
// ---------------------------------------------------------------------------

/** Derive a PascalCase `defplugin` identifier from a display name, e.g. "Lovense Max Driver" -> "LovenseMaxDriver". */
function toIdentifier(displayName: string): string {
  return displayName
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}

/**
 * Produce a ScaffoldResult for a new plugin project.
 * Does not touch the file system.
 */
export function scaffoldPlugin(
  spec: PluginScaffoldSpec,
  targetDir: string,
): ScaffoldResult {
  const warnings: string[] = [];
  const isBleDriver = spec.pluginType === "ble_driver";

  let matchBlock = "";
  if (isBleDriver) {
    const prefix = spec.blePrefix?.trim();
    if (!prefix) {
      warnings.push('ble_driver plugin has no BLE name prefix: edit the "match" block in plugin.mtp before use. Other match types coming soon.');
    }
    matchBlock = `\n  match do\n    ble_name_prefix "${prefix || "CHANGE_ME"}"\n  end\n`;
  }

  const vars: TemplateVars = {
    kind: "plugin",
    name: spec.name,
    identifier: toIdentifier(spec.displayName),
    display_name: spec.displayName,
    plugin_type: spec.pluginType,
    platforms: spec.platforms.map((p) => `"${p}"`).join(", "),
    permissions: isBleDriver ? `"ble:write"` : "",
    match_block: matchBlock,
    author: spec.author,
    license: "MIT",
    year: String(new Date().getFullYear()),
  };

  const base: ScaffoldFile[] = [
    {
      path: "plugin.mtp",
      content: render(PLUGIN_MTP_TEMPLATE, vars),
      overwrite: false,
    },
    {
      path: "tests/smoke.test.mtp",
      content: render(SMOKE_TEST_TEMPLATE, vars),
      overwrite: false,
    },
  ];

  const overlayFiles: ScaffoldFile[] = [];

  for (const id of spec.overlays) {
    const overlay = getOverlay(id);
    if (!overlay) {
      warnings.push(`Unknown overlay "${id}". Skipped.`);
      continue;
    }
    if (overlay.appliesTo && !overlay.appliesTo.includes("plugin")) {
      warnings.push(`Overlay "${id}" does not apply to plugins. Skipped.`);
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
