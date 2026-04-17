import type {
  PluginNode,
  MetadataFieldNode,
  MatchBlockNode,
  ConfigBlockNode,
  ConfigDecl,
  GlobalsBlockNode,
  Expr,
} from "../ast.js";
import type {
  MtpPlugin,
  MtpConfigField,
  MtpMatch,
  MtpVariables,
  MtpFunctionDef,
  MtpValue,
} from "../../core/mtp-types.js";
import type { LangDiagnostic } from "../diagnostics.js";
import { EmitContext } from "./context.js";
import {
  exprToJson,
  buildLocalFunctionScope,
  emitDef,
  emitFn,
  emitHandlers,
  isLiteral,
} from "./functions.js";

export interface EmitResult {
  plugin: MtpPlugin;
  diagnostics: LangDiagnostic[];
}

// --- Language field definitions -----------------------------------------------

export interface FieldDef {
  /** Whether the value is always emitted as a JSON array. */
  array?: true;
}

/**
 * Known metadata fields inside a `defplugin` body.
 * Keys are the source-language identifiers.
 */
export const METADATA_FIELDS: Readonly<Record<string, FieldDef>> = {
  version:     {},
  sdk_version: {},
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
 * Keys are the source-language identifiers (snake_case), matching the JSON output directly.
 */
export const MATCH_FIELDS: Readonly<Record<string, FieldDef>> = {
  ble_name_prefix: {},
  ble_name:        {},
  vid:             {},
  pid:             {},
  serial:          {},
};

/**
 * Known constraints for Configuration options, specified as kwargs after the config initializer.
 * Typed to match the optional numeric fields on `MtpConfigField`.
 */
export type ConfigConstraintKey = "min" | "max";
export const CONFIG_CONSTRAINT_KEYS: ReadonlyArray<ConfigConstraintKey> = [
    "min", "max",
];

// --- Plugin emitter -----------------------------------------------------------

/**
 * Walks a `PluginNode` AST and produces the JSON plugin schema for mt-actions.
 * Collects semantic diagnostics for any violations of the language rules
 * (unknown keywords, missing required fields, etc.).
 */
export class PluginEmitter {
  private readonly ctx: EmitContext;

  constructor(ctx?: EmitContext) {
    this.ctx = ctx ?? new EmitContext();
  }

  emit(ast: PluginNode): EmitResult {
    const plugin: Record<string, unknown> = {};

    if (ast.displayName === null) {
      this.ctx.error("Plugin is missing a display name");
    } else {
      plugin["display_name"] = ast.displayName;
    }

    for (const field of ast.metadata) {
      this.emitField(plugin, field, METADATA_FIELDS, "defplugin");
    }

    if (ast.matchBlock !== null) {
      plugin["match"] = this.emitMatchBlock(ast.matchBlock);
    }

    if (ast.configBlock !== null) {
      plugin["config"] = this.emitConfigBlock(ast.configBlock);
    }

    if (ast.globalsBlock !== null) {
      plugin["variables"] = this.emitGlobalsBlock(ast.globalsBlock);
    }

    const globalDecls = ast.globalsBlock?.declarations;

    if (ast.defs.length > 0 || ast.functions.length > 0) {
      const localFunctions = buildLocalFunctionScope(ast);
      const functions: Record<string, MtpFunctionDef> = {};

      for (const def of ast.defs) {
        functions[def.name] = emitDef(this.ctx, def, localFunctions, globalDecls);
      }

      for (const fn of ast.functions) {
        functions[fn.name] = emitFn(this.ctx, fn, localFunctions);
      }

      plugin["functions"] = functions;
    }

    if (ast.handlers.length > 0) {
      const localFunctions = (ast.defs.length > 0 || ast.functions.length > 0)
        ? buildLocalFunctionScope(ast)
        : undefined;
        
      plugin["events"] = emitHandlers(this.ctx, ast.handlers, localFunctions, globalDecls);
    }

    return { plugin: plugin as MtpPlugin, diagnostics: this.ctx.diagnostics };
  }

  // --- Block emitters ---------------------------------------------------------

  emitConfigBlock(block: ConfigBlockNode): Record<string, MtpConfigField> {
    const config: Record<string, MtpConfigField> = {};

    for (const decl of block.declarations) {
      config[decl.name] = this.emitConfigDecl(decl);
    }

    return config;
  }

  emitConfigDecl(decl: ConfigDecl): MtpConfigField {
    const entry: MtpConfigField = {
      type: decl.varType as MtpConfigField["type"],
      default: exprToJson(decl.default) ?? 0,
    };

    if (decl.label !== null) {
      entry.label = decl.label;
    }

    for (const key of CONFIG_CONSTRAINT_KEYS) {
      const expr = decl.constraints[key];

      if (typeof expr === "undefined")
        continue;

      if (!isLiteral(expr)) {
        this.ctx.error(
          `Constraint "${key}" must be a literal value`,
          decl.span,
        );

        continue;
      }
      
      if (expr !== undefined) {
        const val = exprToJson(expr);

        if (typeof val === "number") {
          entry[key] = val;
        } else if (val !== null) {
          this.ctx.error(
            `Constraint "${key}" must be a number, got ${expr.varType}`,
            decl.span,
          );
        }
      }
    }

    return entry;
  }

  emitGlobalsBlock(block: GlobalsBlockNode): MtpVariables {
    const variables: MtpVariables = {};

    for (const decl of block.declarations) {
      if (decl.arraySize !== null) {
        variables[`${decl.name}[${decl.arraySize}]`] = [];
      } else {
        const val = exprToJson(decl.init);

        if (val !== null) {
          variables[decl.name] = val;
        }
      }
    }

    return variables;
  }

  emitMatchBlock(block: MatchBlockNode): MtpMatch {
    const match: Record<string, unknown> = {};

    for (const pred of block.predicates) {
      const fieldDef = MATCH_FIELDS[pred.key];

      if (!fieldDef) {
        this.ctx.error(`Unknown match predicate \`${pred.key}\``, pred.span);
        continue;
      }

      const jsonKey = pred.key;
      match[jsonKey] = exprToJson(pred.value);
    }

    return match as MtpMatch;
  }

  // --- Field helpers ----------------------------------------------------------

  emitField(
    target: Record<string, unknown>,
    field: MetadataFieldNode,
    defs: Readonly<Record<string, FieldDef>>,
    blockName: string,
  ): void {
    const def = defs[field.key];

    if (def === undefined) {
      this.ctx.error(
        `Unknown ${blockName} keyword "${field.key}". Valid keywords: ${Object.keys(defs).join(", ")}`,
        field.span,
      );

      return;
    }

    const jsonKey = field.key;

    if (Array.isArray(field.value)) {
      target[jsonKey] = field.value.map(exprToJson);
    } else if (def.array) {
      const val = exprToJson(field.value);

      if (val === null) {
        this.ctx.warning(
          `Could not emit value for "${field.key}"`,
          field.span,
        );
      } else {
        target[jsonKey] = [val];
      }
    } else {
      const val = exprToJson(field.value);

      if (val === null) {
        this.ctx.warning(
          `Could not emit value for "${field.key}"`,
          field.span,
        );
      } else {
        target[jsonKey] = val;
      }
    }
  }
}
