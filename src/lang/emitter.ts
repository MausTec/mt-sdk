import type { PluginNode, MetadataFieldNode, ConfigBlockNode, ConfigDecl, Expr } from "./ast.js";
import type { LangDiagnostic } from "./diagnostics.js";
import { langError, langWarning } from "./diagnostics.js";

export interface EmitResult {
  plugin: Record<string, unknown>;
  diagnostics: LangDiagnostic[];
}

// --- Language field definitions -----------------------------------------------

interface FieldDef {
  /** JSON output key. Defaults to the source key when omitted. */
  jsonKey?: string;
  /**
   * Whether the value is always emitted as a JSON array.
   */
  array?: true;
}

/**
 * Known metadata fields inside a `defplugin` body.
 * Keys are the source-language identifiers.
 */
const METADATA_FIELDS: Readonly<Record<string, FieldDef>> = {
  version:     {},
  sdkVersion:  {},
  description: {},
  author:      {},
  license:     {},
  repository:  {},
  type:        {},
  platforms:   { array: true },
  permissions: { array: true },
};

/**
 * Known predicate keys inside a `match do ... end` block.
 * Keys are the source-language identifiers (snake_case matching the JSON).
 */
const MATCH_FIELDS: Readonly<Record<string, FieldDef>> = {
  ble_name_prefix: { jsonKey: "bleNamePrefix" },
  ble_name:        { jsonKey: "bleName" },
  vid:             {},
  pid:             {},
  serial:          {},
};


function exprToJson(expr: Expr): unknown {
  switch (expr.kind) {
    case "Literal":
      return expr.value;
    case "Identifier":
      return expr.name;
    default:
      return null;
  }
}

/**
 * Walks a `PluginNode` AST and produces the JSON plugin schema for mt-actions.
 * Collects semantic diagnostics along the way for any violations of the language
 * rules (unknown keywords, missing required fields, etc.).
 */
class Emitter {
  private readonly diagnostics: LangDiagnostic[] = [];

  emit(ast: PluginNode): EmitResult {
    const plugin: Record<string, unknown> = {};

    if (ast.displayName === null) {
      this.diagnostics.push(langError("Plugin is missing a display name"));
    } else {
      plugin["displayName"] = ast.displayName;
    }

    for (const field of ast.metadata) {
      this.emitField(plugin, field, METADATA_FIELDS, "defplugin");
    }

    if (ast.configBlock !== null) {
      plugin["config"] = this.emitConfigBlock(ast.configBlock);
    }

    return { plugin, diagnostics: this.diagnostics };
  }

  private emitConfigBlock(block: ConfigBlockNode): Record<string, unknown> {
    const config: Record<string, unknown> = {};

    for (const decl of block.declarations) {
      config[decl.name] = this.emitConfigDecl(decl);
    }

    return config;
  }

  private emitConfigDecl(decl: ConfigDecl): Record<string, unknown> {
    const entry: Record<string, unknown> = {
      type: decl.varType,
      default: exprToJson(decl.default),
    };

    if (decl.label !== null) {
      entry["label"] = decl.label;
    }

    for (const [key, expr] of Object.entries(decl.constraints)) {
      entry[key] = exprToJson(expr);
    }

    return entry;
  }

  private emitField(
    target: Record<string, unknown>,
    field: MetadataFieldNode,
    defs: Readonly<Record<string, FieldDef>>,
    blockName: string,
  ): void {
    const def = defs[field.key];

    if (def === undefined) {
      this.diagnostics.push(
        langError(
          `Unknown ${blockName} keyword "${field.key}". Valid keywords: ${Object.keys(defs).join(", ")}`,
          field.span,
        ),
      );
      return;
    }

    const jsonKey = def.jsonKey ?? field.key;

    if (Array.isArray(field.value)) {
      target[jsonKey] = field.value.map(exprToJson);
    } else if (def.array) {
      const val = exprToJson(field.value);

      if (val === null) {
        this.diagnostics.push(langWarning(`Could not emit value for "${field.key}"`, field.span));
      } else {
        target[jsonKey] = [val];
      }
    } else {
      const val = exprToJson(field.value);

      if (val === null) {
        this.diagnostics.push(langWarning(`Could not emit value for "${field.key}"`, field.span));
      } else {
        target[jsonKey] = val;
      }
    }
  }
}

// --- Public API ---------------------------------------------------------------

/**
 * Walk a `PluginNode` AST and produce the mt-actions JSON plugin schema.
 */
export function emit(ast: PluginNode): EmitResult {
  return new Emitter().emit(ast);
}

// Re-exported so future lang-defs consumers (LSP completion, docs) can read them.
export { METADATA_FIELDS, MATCH_FIELDS };
export type { FieldDef };
