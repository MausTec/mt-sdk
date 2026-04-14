import type {
  PluginNode,
  FnNode,
  DefNode,
  ConfigDecl,
  GlobalDecl,
  LocalDeclStmt,
  VarType,
  DefParam,
} from "../lang/ast.js";

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

    // --- Builtin & runtime function stubs ---
    // These will be populated by future integration with mt-sdk core's
    // API descriptors, keyed by sdkVersion and product family.
    //
    // table.registerBuiltins(sdkVersion);
    // table.registerRuntimeFunctions(sdkVersion, platforms);

    return table;
  }

  // --- Future extension points -----------------------------------------------

  /**
   * Register language built-in functions (e.g. `round`, `to_string`, `concat`,
   * `millis`, `log`, `ble_write`, `add`).
   *
   * Will be populated from the mt-sdk core API descriptor for the given
   * sdkVersion. Until then, callers should treat unresolved function names
   * gracefully (return null rather than error).
   */
  registerBuiltins(_sdkVersion: string): void {
    // TODO: Load builtin function descriptors from mt-sdk core and populate
    //       this.functions with source: "builtin".
  }

  /**
   * Register runtime-provided functions that are available on specific
   * platform families (e.g. `@eom`-only host functions).
   *
   * Will be populated from the mt-sdk core API descriptor for the given
   * sdkVersion + platform list.
   */
  registerRuntimeFunctions(_sdkVersion: string, _platforms: string[]): void {
    // TODO: Load platform-specific runtime function descriptors and populate
    //       this.functions with source: "runtime".
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

  /**
   * Resolve a local variable or function parameter by name within a function
   * or event handler body. Checks parameters first, then scans statements for
   * a LocalDeclStmt that precedes (or is at) the given line.
   *
   * `params` should be the DefParam[] of the enclosing fn/def (empty for on-handlers).
   */
  resolveLocal(
    name: string,
    bodyStmts: readonly import("../lang/ast.js").Stmt[],
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
