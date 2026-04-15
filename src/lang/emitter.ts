import type { PluginNode, MetadataFieldNode, MatchBlockNode, ConfigBlockNode, ConfigDecl, GlobalsBlockNode, GlobalDecl as _GlobalDecl, DefNode, Expr, OnNode, FnNode, Stmt } from "./ast.js";
import type { LangDiagnostic } from "./diagnostics.js";
import { langError, langWarning } from "./diagnostics.js";
import type { MtpPlugin } from "../core/mtp-types.js";

export interface EmitResult {
  plugin: MtpPlugin;
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

    if (ast.matchBlock !== null) {
      plugin["match"] = this.emitMatchBlock(ast.matchBlock);
    }

    if (ast.configBlock !== null) {
      plugin["config"] = this.emitConfigBlock(ast.configBlock);
    }

    if (ast.globalsBlock !== null) {
      plugin["variables"] = this.emitGlobalsBlock(ast.globalsBlock);
    }

    if (ast.defs.length > 0 || ast.functions.length > 0) {
      const functions: Record<string, unknown> = {};

      for (const def of ast.defs) {
        functions[def.name] = this.emitDef(def);
      }

      for (const fn of ast.functions) {
        functions[fn.name] = this.emitFn(fn);
      }

      plugin["functions"] = functions;
    }

    if (ast.handlers.length > 0) {
      plugin["events"] = this.emitHandlers(ast.handlers);
    }

    return { plugin: plugin as MtpPlugin, diagnostics: this.diagnostics };
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

  private emitGlobalsBlock(block: GlobalsBlockNode): Record<string, unknown> {
    const variables: Record<string, unknown> = {};

    for (const decl of block.declarations) {
      if (decl.arraySize !== null) {
        variables[`${decl.name}[${decl.arraySize}]`] = [];
      } else {
        variables[decl.name] = exprToJson(decl.init);
      }
    }

    return variables;
  }

  private emitMatchBlock(block: MatchBlockNode): Record<string, unknown> {
    const match: Record<string, unknown> = {};

    for (const pred of block.predicates) {
      const fieldDef = MATCH_FIELDS[pred.key];

      if (!fieldDef) {
        this.diagnostics.push(
          langError(`Unknown match predicate \`${pred.key}\``, pred.span)
        );

        continue;
      }
      
      const jsonKey = fieldDef.jsonKey ?? pred.key;
      match[jsonKey] = exprToJson(pred.value);
    }

    return match;
  }

  /**
   * Collect `LocalDeclStmt` nodes from a block body, returning:
   * - `vars`: flat array of local variable names (for scope allocation)
   * - `initActions`: `set` actions for any declarations that carry an initial value
   */
  private extractLocals(body: Stmt[]): {
    vars: string[];
    initActions: Record<string, unknown>[];
  } {
    const vars: string[] = [];
    const initActions: Record<string, unknown>[] = [];

    for (const stmt of body) {
      if (stmt.kind !== "LocalDecl") continue;

      if (stmt.arraySize !== null) {
        vars.push(`${stmt.name}[${stmt.arraySize}]`);
      } else {
        vars.push(stmt.name);

        if (stmt.init !== null) {
          const entry: Record<string, unknown> = { set: { [`$${stmt.name}`]: exprToJson(stmt.init) } };
          initActions.push(entry);
        }
      }
    }

    return { vars, initActions };
  }

  /**
   * Emits a `def` block from the AST into the JSON plugin schema format.
   * The "args" here are positional or kwarg references, which appear as local variables
   */
  private emitDef(def: DefNode): Record<string, unknown> {
    const { vars, initActions } = this.extractLocals(def.body);

    const result: Record<string, unknown> = {
      args: def.params.map(p => p.name),
      vars,
      actions: initActions,
    };

    if (def.returnType !== null) {
      result.returnType = def.returnType;
    }

    return result;
  }

  private emitFn(fn: FnNode): Record<string, unknown> {
    const result: Record<string, unknown> = {
      args: fn.params.map(p => p.name),
      actions: [],
    };
    
    if (fn.returnType !== null) {
      result.returnType = fn.returnType;
    }

    return result;
  }

  private emitOnNode(handler: OnNode): Record<string, unknown> {
    const { vars, initActions } = this.extractLocals(handler.body);
    
    return {
      vars,
      actions: initActions,
    };
  }

  /**
   * This becomes the "events" key in the output JSON, which is a key/value pair of event name
   * and an array of action objects for each handler attached to that event.
   * @param handlers 
   * @returns 
   */
  private emitHandlers(handlers: OnNode[]) {
    const events: Record<string, unknown> = {};

    for (const handler of handlers) {
      if (!events[handler.event]) {
        events[handler.event] = this.emitOnNode(handler);
      } else {
        this.diagnostics.push(langError(`Multiple handlers defined for event "${handler.event}"`));
      }
    }

    return events;
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
