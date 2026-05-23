import { parseSource } from "../lang/index.js";
import { isLiteral } from "../lang/ast.js";

export interface PluginMetadata {
  name: string | null;
  displayName: string | null;
  version: string | null;
  sdkVersion: string | null;
  description: string | null;
  author: string | null;
  license: string | null;
  repository: string | null;
  platforms: string[];
  permissions: string[];
}

/**
 * Parse a .mtp source string and extract plugin metadata from the AST header.
 *
 * Reads the `defplugin` metadata directives (@name, @version, @platforms, etc.)
 * without running the full emitter pipeline. This is the cheapest way to inspect
 * a plugin's identity without producing a compiled output.
 *
 * In the future this can be replaced by a shallow-parse mode that stops after
 * the metadata block.
 *
 * Parse errors result in null/empty fields.
 */
export function scrapePluginMetadata(source: string): PluginMetadata {
  const meta: PluginMetadata = {
    name: null,
    displayName: null,
    version: null,
    sdkVersion: null,
    description: null,
    author: null,
    license: null,
    repository: null,
    platforms: [],
    permissions: [],
  };

  try {
    const { ast } = parseSource(source);

    for (const field of ast.metadata) {
      const value = field.value;

      if (Array.isArray(value)) {
        const strings = value.filter(isLiteral).map((e) => String(e.value));

        if (field.key === "platforms") meta.platforms = strings;
        if (field.key === "permissions") meta.permissions = strings;

      } else if (isLiteral(value)) {
        const str = String(value.value);

        switch (field.key) {
          case "name":         meta.name = str; break;
          case "display_name": meta.displayName = str; break;
          case "version":      meta.version = str; break;
          case "sdk_version":  meta.sdkVersion = str; break;
          case "description":  meta.description = str; break;
          case "author":       meta.author = str; break;
          case "license":      meta.license = str; break;
          case "repository":   meta.repository = str; break;
          case "platforms":    meta.platforms = [str]; break;
          case "permissions":  meta.permissions = [str]; break;
        }
      }
    }
  } catch {
    // just return empty fields.
  }

  return meta;
}
