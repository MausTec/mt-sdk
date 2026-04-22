import { transpile, formatPluginJson } from "../lang/index.js";
import type { LangDiagnostic } from "../lang/index.js";
import type { MtpPlugin } from "../analysis/mtp-types.js";

export interface BuildOptions {
  /** Raw .mtp source text. */
  source: string;
}

export interface BuildResult {
  plugin: MtpPlugin;
  /** Formatted JSON string, ready to write to plugin.json. */
  formattedJson: string;
  diagnostics: LangDiagnostic[];
  ok: boolean;
}

/**
 * Transpile raw .mtp source text into a compiled plugin JSON.
 * Errors are returned as diagnostics with level "error".
 * `ok` is false when any error-level diagnostic is present.
 */
export function build(options: BuildOptions): BuildResult {
  const { plugin, diagnostics } = transpile(options.source);
  const formattedJson = formatPluginJson(plugin);
  const ok = !diagnostics.some((d) => d.level === "error");
  
  return { plugin, formattedJson, diagnostics, ok };
}
