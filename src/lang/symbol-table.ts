import type {
  PluginNode,
  FnNode,
  DefNode,
  ConfigDecl,
  GlobalDecl,
  LocalDeclStmt,
  VarType,
  DefParam,
} from "./ast.js";
import type {
  HostFunctionDescriptor,
  EventDescriptor,
  ApiDescriptor,
  PayloadField,
} from "@maustec/mt-runtimes";

// --- Resolved symbol types ---------------------------------------------------

export interface ResolvedFunction {
  source: "plugin" | "builtin" | "runtime";
  name: string;
  params: DefParam[];
  docs: string[];
  /** `null` until @return tags or type inference is implemented. */
  returnType: VarType | null;
  /** For `fn` nodes: "fn"; for `def` nodes: "def". */
  variant: "fn" | "def";
  /** Full descriptor from mt-runtimes, when resolved from an API descriptor. */
  descriptor?: HostFunctionDescriptor;
  /** Origin identifier: "mt-actions/1.1.0" or "EOM3K/2.0.1". */
  apiOrigin?: string;
  /** Permission required to call this function, from the descriptor. */
  permission?: string | null;
  /** Module grouping from the API descriptor (e.g. "ble", "config", "system"). */
  module?: string | undefined;
  /** Whether the function accepts additional arguments beyond its declared params. */
  variadic?: boolean | undefined;
}

export interface ResolvedEvent {
  name: string;
  source: "builtin" | "runtime";
  descriptor?: EventDescriptor;
  apiOrigin?: string;
  permission?: string | null;
  module?: string | undefined;
  payload?: PayloadField[] | undefined;
}

export interface ResolvedVariable {
  source: "config" | "global" | "local" | "parameter";
  name: string;
  varType: VarType;
  readonly: boolean;
  docs: string[];
  /** For globals: array size if declared as fixed-size. */
  arraySize?: number | null;
}

export type ResolvedSymbol = ResolvedFunction | ResolvedVariable;

// --- Symbol table ------------------------------------------------------------

/**
 * Collects all named symbols from a PluginNode into fast lookup maps.
 *
 * The table is split by category so hover/completion can query the right
 * namespace without ambiguity (e.g. a config `@speed` vs a local `speed`).
 *
 * Designed for extension: `registerBuiltins()` and `registerRuntimeFunctions()`
 * hooks are provided as stubs for plugging in API-sourced symbols later.
 */
export class SymbolTable {
  readonly functions = new Map<string, ResolvedFunction>();
  readonly configVars = new Map<string, ResolvedVariable>();
  readonly globalVars = new Map<string, ResolvedVariable>();
  readonly events = new Map<string, ResolvedEvent>();

  /**
   * Build a symbol table from a parsed plugin AST.
   */
  static fromAST(ast: PluginNode): SymbolTable {
    const table = new SymbolTable();

    // --- Plugin-defined functions ---
    for (const fn of ast.functions) {
      table.functions.set(fn.name, {
        source: "plugin",
        name: fn.name,
        params: fn.params,
        docs: fn.docs,
        returnType: fn.returnType,
        variant: "fn",
      });
    }

    for (const def of ast.defs) {
      table.functions.set(def.name, {
        source: "plugin",
        name: def.name,
        params: def.params,
        docs: def.docs,
        returnType: def.returnType,
        variant: "def",
      });
    }

    // --- Config variables ---
    if (ast.configBlock !== null) {
      for (const decl of ast.configBlock.declarations) {
        table.configVars.set(decl.name, {
          source: "config",
          name: decl.name,
          varType: decl.varType,
          readonly: true,
          docs: decl.label !== null ? [decl.label] : [],
        });
      }
    }

    // --- Global variables ---
    if (ast.globalsBlock !== null) {
      for (const decl of ast.globalsBlock.declarations) {
        table.globalVars.set(decl.name, {
          source: "global",
          name: decl.name,
          varType: decl.varType,
          readonly: false,
          docs: decl.label !== null ? [decl.label] : [],
          arraySize: decl.arraySize,
        });
      }
    }

    return table;
  }

  // --- Descriptor registration -----------------------------------------------

  /**
   * Register functions and events from an API descriptor.
   * The `source` tag and `origin` string are attached to each registered symbol
   * so consumers can trace where a function was defined.
   */
  registerDescriptor(
    descriptor: ApiDescriptor,
    source: "builtin" | "runtime",
    origin: string,
  ): void {
    for (const fn of descriptor.functions) {
      // Don't overwrite plugin-defined functions (plugin always wins)
      if (this.functions.has(fn.name)) continue;

      const returnType = fn.returns?.type as VarType | undefined ?? null;

      this.functions.set(fn.name, {
        source,
        name: fn.name,
        params: (fn.args ?? []).map((a) => ({
          varType: a.type as VarType,
          name: a.name,
          span: { line: 0, col: 0, endLine: 0, endCol: 0 },
        })),
        docs: fn.description ? [fn.description] : [],
        returnType,
        variant: "def",
        descriptor: fn,
        apiOrigin: origin,
        permission: fn.permission,
        module: fn.module,
        variadic: fn.variadic,
      });
    }

    for (const ev of descriptor.events) {
      // Don't overwrite — first descriptor to register an event wins
      if (this.events.has(ev.name)) continue;

      this.events.set(ev.name, {
        name: ev.name,
        source,
        descriptor: ev,
        apiOrigin: origin,
        permission: ev.permission,
        module: ev.module,
        payload: ev.payload,
      });
    }
  }

  // --- Lookup helpers --------------------------------------------------------

  resolveFunction(name: string): ResolvedFunction | undefined {
    return this.functions.get(name);
  }

  resolveConfig(name: string): ResolvedVariable | undefined {
    return this.configVars.get(name);
  }

  resolveGlobal(name: string): ResolvedVariable | undefined {
    return this.globalVars.get(name);
  }

  resolveEvent(name: string): ResolvedEvent | undefined {
    return this.events.get(name);
  }

  /** Returns true if any descriptors have been registered (builtins or runtime). */
  hasDescriptors(): boolean {
    if (this.events.size > 0) return true;
    for (const fn of this.functions.values()) {
      if (fn.source !== "plugin") return true;
    }
    return false;
  }

  /**
   * Resolve a local variable or function parameter by name within a function
   * or event handler body. Checks parameters first, then scans statements for
   * a LocalDeclStmt that precedes (or is at) the given line.
   *
   * `params` should be the DefParam[] of the enclosing fn/def (empty for on-handlers).
   */
  resolveLocal(
    name: string,
    bodyStmts: readonly import("./ast.js").Stmt[],
    beforeLine: number,
    params?: readonly DefParam[],
  ): ResolvedVariable | undefined {
    // Check function parameters first.
    if (params !== undefined) {
      for (const p of params) {
        if (p.name === name) {
          return {
            source: "parameter",
            name: p.name,
            varType: p.varType,
            readonly: false,
            docs: [],
          };
        }
      }
    }

    for (const stmt of bodyStmts) {
      if (stmt.kind !== "LocalDecl") continue;
      if (stmt.name === name && stmt.span.line <= beforeLine) {
        return {
          source: "local",
          name: stmt.name,
          varType: stmt.varType,
          readonly: stmt.isConst === true,
          docs: stmt.docs,
        };
      }
    }
    return undefined;
  }
}
