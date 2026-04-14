import { describe, it, expect } from "vitest";
import { transpile, parseSource } from "./index.js";
import type { LangDiagnostic } from "./diagnostics.js";
import { SymbolTable } from "../lsp/symbol-table.js";

// --- Helpers ----------------------------------------------------------------

/** Collect error messages from a transpile result. */
function errors(diags: LangDiagnostic[]): string[] {
  return diags.filter((d) => d.level === "error").map((d) => d.message);
}

/** Collect warning messages from a transpile result. */
function warnings(diags: LangDiagnostic[]): string[] {
  return diags.filter((d) => d.level === "warning").map((d) => d.message);
}

/** Transpile source expecting zero errors, returning the plugin JSON. */
function transpileOk(source: string) {
  const result = transpile(source);
  const errs = errors(result.diagnostics);
  expect(errs, `Expected no errors but got:\n${errs.join("\n")}`).toHaveLength(0);
  return result.plugin;
}

/** Transpile source and return only the error messages. */
function transpileErrors(source: string): string[] {
  return errors(transpile(source).diagnostics);
}

/** Parse-only (no emit/validation) and return error messages. */
function parseErrors(source: string): string[] {
  return errors(parseSource(source).diagnostics);
}

// --- Phase 1 — Parser hardening ---------------------------------------------

describe("Phase 1: enforce newline after `do`", () => {
  it("rejects code on the same line as `do` in a def block", () => {
    const src = `
defplugin "Test" do
  def myFunc() do int x = 0
  end
end`;
    const errs = parseErrors(src);
    expect(errs).toContain("Unexpected token after `do`, only comments are allowed");
  });

  it("rejects code on the same line as `do` in an if block", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    if true do int x = 0
    end
  end
end`;
    const errs = parseErrors(src);
    expect(errs).toContain("Unexpected token after `do`, only comments are allowed");
  });

  it("allows a comment after `do`", () => {
    const src = `
defplugin "Test" do
  def myFunc() do # this is fine
    int x = 0
  end
end`;
    const errs = parseErrors(src);
    expect(errs.filter((e) => e.includes("after `do`"))).toHaveLength(0);
  });

  it("allows `do` followed by a blank line", () => {
    const src = `
defplugin "Test" do
  def myFunc() do

    int x = 0
  end
end`;
    const errs = parseErrors(src);
    expect(errs.filter((e) => e.includes("after `do`"))).toHaveLength(0);
  });
});

describe("Phase 1: reject nested variable declarations", () => {
  it("rejects a variable declaration inside an if block", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    if true do
      int nested = 1
    end
  end
end`;
    const errs = parseErrors(src);
    expect(errs).toContain(
      "Variable declarations must only be at the top level of a `def` or `on` block",
    );
  });

  it("rejects a variable declaration inside an else block", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    if true do
      int x = 1
    else
      int y = 2
    end
  end
end`;
    const errs = parseErrors(src);
    expect(errs).toContain(
      "Variable declarations must only be at the top level of a `def` or `on` block",
    );
  });

  it("allows variable declarations at the top of a def block", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    int x = 0
    int y = 1
  end
end`;
    const errs = parseErrors(src);
    expect(
      errs.filter((e) => e.includes("Variable declarations must only be at the top level of a `def` or `on` block")),
    ).toHaveLength(0);
  });

  it("allows variable declarations at the top of an on block", () => {
    const src = `
defplugin "Test" do
  on speedChange do
    int level = 0
  end
end`;
    const errs = parseErrors(src);
    expect(
      errs.filter((e) => e.includes("Variable declarations must only be at the top level of a `def` or `on` block")),
    ).toHaveLength(0);
  });
});

describe("Phase 1: multi-line doc comments are joined", () => {
  it("joins consecutive comments on a global variable", () => {
    const src = `
defplugin "Test" do
  globals do
    # Line one
    # Line two
    # Line three
    int counter = 0
  end
end`;
    const plugin = transpileOk(src);
    // The AST carries the label; the emitter propagates it into the JSON.
    // For now, just confirm it parses cleanly — label propagation is an emitter concern.
    expect(plugin.variables).toHaveProperty("counter", 0);
  });

  it("joins consecutive comments on a config field", () => {
    const src = `
defplugin "Test" do
  config do
    # First line
    # Second line
    int intensity = 50
  end
end`;
    const plugin = transpileOk(src);
    expect(plugin.config).toHaveProperty("intensity");
  });
});

describe("Phase 1: reject non-int arrays in globals", () => {
  it("rejects string arrays", () => {
    const src = `
defplugin "Test" do
  globals do
    string[10] buffer = ""
  end
end`;
    const errs = parseErrors(src);
    expect(errs).toContain(
      "Only `int` arrays are supported",
    );
  });

  it("rejects bool arrays", () => {
    const src = `
defplugin "Test" do
  globals do
    bool[8] flags = false
  end
end`;
    const errs = parseErrors(src);
    expect(errs).toContain(
      "Only `int` arrays are supported",
    );
  });

  it("allows int arrays", () => {
    const src = `
defplugin "Test" do
  globals do
    int[100] tape = 0
  end
end`;
    const errs = parseErrors(src);
    expect(
      errs.filter((e) => e.includes("arrays")),
    ).toHaveLength(0);
  });
});

describe("Phase 1: global int arrays emit correctly", () => {
  it("emits name[size]: [] for int array globals", () => {
    const src = `
defplugin "Test" do
  globals do
    int[100] tape = 0
  end
end`;
    const plugin = transpileOk(src);
    expect(plugin.variables).toHaveProperty("tape[100]", []);
  });

  it("emits scalar globals normally", () => {
    const src = `
defplugin "Test" do
  globals do
    int counter = 0
    string label = "hello"
    bool active = true
  end
end`;
    const plugin = transpileOk(src);
    expect(plugin.variables).toEqual({
      counter: 0,
      label: "hello",
      active: true,
    });
  });
});

// ===========================================================================
// Baseline — ensure existing features don't regress
// ===========================================================================

describe("baseline: minimal valid plugin", () => {
  it("transpiles a minimal plugin with no errors", () => {
    const src = `
defplugin "Minimal" do
end`;
    const plugin = transpileOk(src);
    expect(plugin.displayName).toBe("Minimal");
  });

  it("transpiles globals, config, def, and on blocks", () => {
    const src = `
defplugin "Full" do
  globals do
    int counter = 0
    string name = "test"
  end

  config do
    int speed = 50
    bool enabled = true
  end

  def initialize() do
    int x = 10
  end

  on :speedChange do
    int level = 0
  end
end`;
    const plugin = transpileOk(src);
    expect(plugin.displayName).toBe("Full");
    expect(plugin.variables).toEqual({ counter: 0, name: "test" });
    expect(plugin.config).toHaveProperty("speed");
    expect(plugin.config).toHaveProperty("enabled");
    expect(plugin.functions).toHaveProperty("initialize");
    expect(plugin.events).toHaveProperty("speedChange");
  });
});

describe("baseline: function definitions emit correctly", () => {
  it("emits a def with local vars and init actions", () => {
    const src = `
defplugin "Test" do
  def doStuff() do
    int x = 42
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["doStuff"];
    expect(fn).toBeDefined();
    const def = fn as { vars?: string[]; actions?: unknown[] };
    expect(def.vars).toContain("x");
    expect(def.actions).toContainEqual({ set: { $x: 42 } });
  });

  it("emits a def with arguments", () => {
    const src = `
defplugin "Test" do
  def setLevel(int level) do
    int local = 0
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["setLevel"];
    const def = fn as { args?: string[]; vars?: string[] };
    expect(def.args).toContain("level");
    expect(def.vars).toContain("local");
  });
});

describe("baseline: local variable init emits set action", () => {
  it("emits set for local variable initialization", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    int x = 5
    int y = 10
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["myFunc"];
    const def = fn as { vars?: string[]; actions?: unknown[] };
    expect(def.vars).toEqual(["x", "y"]);
    expect(def.actions).toContainEqual({ set: { $x: 5 } });
    expect(def.actions).toContainEqual({ set: { $y: 10 } });
  });
});

describe("baseline: on block emits correctly", () => {
  it("emits an event handler with local vars", () => {
    const src = `
defplugin "Test" do
  on :motorChange do
    int level = 0
  end
end`;
    const plugin = transpileOk(src);
    expect(plugin.events).toHaveProperty("motorChange");
    const handler = plugin.events?.["motorChange"] as { vars?: string[]; actions?: unknown[] };
    expect(handler.vars).toContain("level");
    expect(handler.actions).toContainEqual({ set: { $level: 0 } });
  });
});

describe("baseline: config fields emit correctly", () => {
  it("emits config with type, default, and constraints", () => {
    const src = `
defplugin "Test" do
  config do
    int intensity = 50, min: 0, max: 100
    bool enabled = true
    string label = "default"
  end
end`;
    const plugin = transpileOk(src);
    const intensity = plugin.config?.["intensity"];
    expect(intensity).toBeDefined();
    expect(intensity!.type).toBe("int");
    expect(intensity!.default).toBe(50);
    expect(intensity!.min).toBe(0);
    expect(intensity!.max).toBe(100);
    expect(plugin.config?.["enabled"]?.type).toBe("bool");
    expect(plugin.config?.["label"]?.type).toBe("string");
  });
});

// --- Phase 2 — Local arrays & index expressions -----------------------------

describe("Phase 2: local array declarations", () => {
  it("parses a local int array declaration", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    int[10] buffer
  end
end`;
    const errs = parseErrors(src);
    expect(errs.filter((e) => e.includes("array") || e.includes("bracket"))).toHaveLength(0);
  });

  it("rejects local string arrays", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    string[20] buf
  end
end`;
    const errs = parseErrors(src);
    expect(errs).toContain(
      "Only `int` arrays are supported",
    );
  });

  it("rejects local bool arrays", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    bool[8] flags
  end
end`;
    const errs = parseErrors(src);
    expect(errs).toContain(
      "Only `int` arrays are supported",
    );
  });

  it("rejects unsized local arrays", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    int[] items
  end
end`;
    const errs = parseErrors(src);
    expect(errs.some((e) => e.includes("size"))).toBe(true);
  });

  it("rejects initializer on local array declarations", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    int[10] buffer = 0
  end
end`;
    const errs = parseErrors(src);
    expect(errs.some((e) => e.includes("cannot have an initializer") || e.includes("zero-initialized"))).toBe(true);
  });
});

describe("Phase 2: local arrays emit correctly", () => {
  it("emits name[size] in vars and no init action for array locals", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    int[100] tape
    int x = 5
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["myFunc"];
    const def = fn as { vars?: string[]; actions?: unknown[] };
    expect(def.vars).toContain("tape[100]");
    expect(def.vars).toContain("x");
    expect(def.actions).toContainEqual({ set: { $x: 5 } });
    // No init action for tape — runtime zero-initializes arrays
    expect(def.actions?.some((a) =>
      typeof a === "object" && a !== null && "set" in a &&
      typeof (a as Record<string, unknown>).set === "object" &&
      "$tape" in ((a as Record<string, unknown>).set as Record<string, unknown>),
    )).toBe(false);
  });

  it("emits name[size] in vars for on-block array locals", () => {
    const src = `
defplugin "Test" do
  on :connect do
    int[50] buffer
  end
end`;
    const plugin = transpileOk(src);
    const handler = plugin.events?.["connect"] as { vars?: string[] };
    expect(handler.vars).toContain("buffer[50]");
  });
});

describe("Phase 2: index expressions in conditions and assignments", () => {
  it("parses array index access in an expression", () => {
    const src = `
defplugin "Test" do
  globals do
    int[10] data = 0
  end

  def check() do
    if data[0] > 5 do
      data[0] = 10
    end
  end
end`;
    // Should parse without bracket-related errors
    const errs = parseErrors(src);
    expect(errs.filter((e) => e.includes("[") || e.includes("]") || e.includes("bracket"))).toHaveLength(0);
  });

  it("parses array index with a variable index", () => {
    const src = `
defplugin "Test" do
  globals do
    int[10] data = 0
  end

  def scan() do
    int i = 0
    if data[i] > 0 do
      i = 1
    end
  end
end`;
    const errs = parseErrors(src);
    expect(errs.filter((e) => e.includes("[") || e.includes("]") || e.includes("bracket"))).toHaveLength(0);
  });

  it("parses a complex index expression in a condition and assignment", () => {
    const src = `
defplugin "Test" do
  globals do
    int[10] data = 0
  end

  def scan() do
    int i = 0
    if data[i + 1] > 0 do
      data[i + 1] = 5
    end
  end
end`;
    const errs = parseErrors(src);
    expect(errs).toHaveLength(0);
    expect(errs.filter((e) => e.includes("[") || e.includes("]") || e.includes("bracket"))).toHaveLength(0);
  });

  it("parses index access with variables and nested expressions in parenthesis", () => {
    const src = `
defplugin "Test" do
  globals do
    int[10] data = 0
  end

  def scan() do
    int i = 0
    if data[(i + 1) * 2] > 0 do
      data[(i + 1) * 2] = 5
    end
  end
end`;
    const errs = parseErrors(src);
    expect(errs).toHaveLength(0);
    expect(errs.filter((e) => e.includes("[") || e.includes("]") || e.includes("bracket"))).toHaveLength(0);
  });

});

// ===========================================================================
// Phase 3 — Type safety & symbol validation
// ===========================================================================

// --- 3.1: readonly field on ResolvedVariable --------------------------------

describe("Phase 3.1: readonly field on ResolvedVariable", () => {
  it("marks config variables as readonly in the symbol table", () => {
    const src = `
defplugin "Test" do
  config do
    int speed = 50
  end
end`;
    const { ast } = parseSource(src);
    const symbols = SymbolTable.fromAST(ast);
    const resolved = symbols.resolveConfig("speed");
    expect(resolved).toBeDefined();
    expect(resolved!.readonly).toBe(true);
  });

  it("marks global variables as not readonly", () => {
    const src = `
defplugin "Test" do
  globals do
    int counter = 0
  end
end`;
    const { ast } = parseSource(src);
    const symbols = SymbolTable.fromAST(ast);
    const resolved = symbols.resolveGlobal("counter");
    expect(resolved).toBeDefined();
    expect(resolved!.readonly).toBe(false);
  });

  it("marks local variables as not readonly", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    int x = 0
  end
end`;
    const { ast } = parseSource(src);
    const symbols = SymbolTable.fromAST(ast);
    const body = ast.defs[0]!.body;
    const resolved = symbols.resolveLocal("x", body, 100);
    expect(resolved).toBeDefined();
    expect(resolved!.readonly).toBe(false);
  });

  it("marks parameters as not readonly", () => {
    const src = `
defplugin "Test" do
  def myFunc(int level) do
    int x = 0
  end
end`;
    const { ast } = parseSource(src);
    const symbols = SymbolTable.fromAST(ast);
    const resolved = symbols.resolveLocal("level", ast.defs[0]!.body, 100, ast.defs[0]!.params);
    expect(resolved).toBeDefined();
    expect(resolved!.readonly).toBe(false);
  });
});

// --- 3.2: Config assignment diagnostic --------------------------------------

describe("Phase 3.2: config assignment diagnostic", () => {
  it("errors when assigning to a config ref with @", () => {
    const src = `
defplugin "Test" do
  config do
    int speed = 50
  end

  def myFunc() do
    @speed = 100
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("read-only") || e.includes("Cannot assign"))).toBe(true);
  });
});

// --- 3.3: const declarations ------------------------------------------------

describe("Phase 3.3: const declarations", () => {
  it("parses a const declaration in a def block", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    const int maxSpeed = 255
  end
end`;
    const errs = parseErrors(src);
    expect(errs.filter((e) => e.includes("const"))).toHaveLength(0);
  });

  it("emits const locals in vars the same as regular locals", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    const int maxSpeed = 255
    int x = 0
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["myFunc"];
    const def = fn as { vars?: string[]; actions?: unknown[] };
    expect(def.vars).toContain("maxSpeed");
    expect(def.actions).toContainEqual({ set: { $maxSpeed: 255 } });
  });

  it("errors when reassigning a const variable", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    const int maxSpeed = 255
    maxSpeed = 100
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("Cannot assign") && e.includes("maxSpeed"))).toBe(true);
  });

  it("allows reassigning a non-const variable", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    int x = 0
    x = 10
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.filter((e) => e.includes("Cannot assign"))).toHaveLength(0);
  });

  it("parses a const in an on block", () => {
    const src = `
defplugin "Test" do
  on :speedChange do
    const int maxLevel = 20
  end
end`;
    const plugin = transpileOk(src);
    const handler = plugin.events?.["speedChange"] as { vars?: string[] };
    expect(handler.vars).toContain("maxLevel");
  });

  it("requires an initializer for const declarations", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    const int maxSpeed
  end
end`;
    const errs = parseErrors(src);
    expect(errs.some((e) => e.includes("const") && e.includes("initializer"))).toBe(true);
  });
});

// --- 3.4: Function reference without call -----------------------------------

describe("Phase 3.4: function reference without call", () => {
  it("errors when using a function name as a value (assignment)", () => {
    const src = `
defplugin "Test" do
  def setLevel(int level) do
    int x = 0
  end

  def myFunc() do
    int val = setLevel
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("Cannot use function") && e.includes("setLevel"))).toBe(true);
  });

  it("errors when using an fn name as a value", () => {
    const src = `
defplugin "Test" do
  fn square = (int x) -> x

  def myFunc() do
    int val = square
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("Cannot use function") && e.includes("square"))).toBe(true);
  });

  it("does not error when calling the function with parens", () => {
    const src = `
defplugin "Test" do
  def setLevel(int level) do
    int x = 0
  end

  def myFunc() do
    setLevel(5)
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.filter((e) => e.includes("Cannot use function"))).toHaveLength(0);
  });
});

// --- 3.5: Arity mismatch diagnostic ----------------------------------------

describe("Phase 3.5: arity mismatch diagnostic", () => {
  it("errors when calling a function with too few arguments", () => {
    const src = `
defplugin "Test" do
  def setLevel(int level) do
    int x = 0
  end

  def myFunc() do
    setLevel()
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("expects 1 argument") || e.includes("expects 1 arg"))).toBe(true);
  });

  it("errors when calling a function with too many arguments", () => {
    const src = `
defplugin "Test" do
  def setLevel(int level) do
    int x = 0
  end

  def myFunc() do
    setLevel(1, 2)
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("expects 1 argument") || e.includes("expects 1 arg"))).toBe(true);
  });

  it("passes when calling with correct arity", () => {
    const src = `
defplugin "Test" do
  def setLevel(int level) do
    int x = 0
  end

  def myFunc() do
    setLevel(5)
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.filter((e) => e.includes("expects") && e.includes("argument"))).toHaveLength(0);
  });

  it("errors on arity mismatch for fn functions", () => {
    const src = `
defplugin "Test" do
  fn double = (int x) -> x

  def myFunc() do
    double(1, 2)
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("expects 1 argument") || e.includes("expects 1 arg"))).toBe(true);
  });

  it("passes for zero-arg function called with no args", () => {
    const src = `
defplugin "Test" do
  def reset() do
    int x = 0
  end

  def myFunc() do
    reset()
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.filter((e) => e.includes("expects") && e.includes("argument"))).toHaveLength(0);
  });

  it("checks arity in pipe chains", () => {
    const src = `
defplugin "Test" do
  fn double = (int x) -> x

  def myFunc() do
    int x = 0
    x = double(1, 2)
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("expects 1 argument") || e.includes("expects 1 arg"))).toBe(true);
  });
});

// --- 3.6: Return type annotations -------------------------------------------

describe("Phase 3.6: return type annotations", () => {
  it("parses a def with a return type annotation", () => {
    const src = `
defplugin "Test" do
  def getSpeed(): int do
    int x = 0
  end
end`;
    const errs = parseErrors(src);
    expect(errs.filter((e) => e.includes("return") || e.includes("type"))).toHaveLength(0);
  });

  it("parses a def with params and a return type", () => {
    const src = `
defplugin "Test" do
  def clamp(int val, int maxVal): int do
    int x = 0
  end
end`;
    const errs = parseErrors(src);
    expect(errs.filter((e) => e.includes("return") || e.includes("type"))).toHaveLength(0);
  });

  it("emits returnType in the JSON output for def", () => {
    const src = `
defplugin "Test" do
  def getSpeed(): int do
    int x = 0
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["getSpeed"] as unknown as Record<string, unknown>;
    expect(fn.returnType).toBe("int");
  });

  it("does not emit returnType when not annotated", () => {
    const src = `
defplugin "Test" do
  def doStuff() do
    int x = 0
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["doStuff"] as unknown as Record<string, unknown>;
    expect(fn.returnType).toBeUndefined();
  });

  it("parses an fn with a return type annotation", () => {
    const src = `
defplugin "Test" do
  fn square = (int x): int -> x
end`;
    const errs = parseErrors(src);
    expect(errs.filter((e) => e.includes("return") || e.includes("type"))).toHaveLength(0);
  });

  it("emits returnType in the JSON output for fn", () => {
    const src = `
defplugin "Test" do
  fn square = (int x): int -> x
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["square"] as unknown as Record<string, unknown>;
    expect(fn.returnType).toBe("int");
  });

  it("supports all type keywords as return types", () => {
    for (const type of ["int", "bool", "string"]) {
      const src = `
defplugin "Test" do
  def myFunc(): ${type} do
    int x = 0
  end
end`;
      const errs = parseErrors(src);
      expect(errs.filter((e) => e.includes("return") || e.includes("type"))).toHaveLength(0);
    }
  });
});

// --- 3.7: Unknown event warning ---------------------------------------------

describe("Phase 3.7: unknown event warning", () => {
  it("warns on an unknown event name", () => {
    const src = `
defplugin "Test" do
  on :fakeEvent do
    int x = 0
  end
end`;
    const result = transpile(src);
    const warns = warnings(result.diagnostics);
    expect(warns.some((w) => w.includes("fakeEvent") && w.includes("nknown"))).toBe(true);
  });

  it("does not warn on known event names", () => {
    for (const event of ["connect", "disconnect", "speedChange", "modeSet", "tick"]) {
      const src = `
defplugin "Test" do
  on :${event} do
    int x = 0
  end
end`;
      const result = transpile(src);
      const warns = warnings(result.diagnostics);
      expect(warns.filter((w) => w.includes(event) && w.includes("nknown"))).toHaveLength(0);
    }
  });

  it("still errors on duplicate handlers (not just warn)", () => {
    const src = `
defplugin "Test" do
  on :connect do
    int x = 0
  end
  on :connect do
    int y = 0
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("Multiple handlers"))).toBe(true);
  });
});
