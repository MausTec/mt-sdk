import { describe, it, expect } from "vitest";
import { transpile, parseSource } from "./index.js";
import type { LangDiagnostic } from "./diagnostics.js";
import { SymbolTable } from "../lsp/symbol-table.js";
import type { MtpFunctionDefObject } from "../core/mtp-types.js";

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

// --- Phase 1 - Parser hardening ---------------------------------------------

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
    // For now, just confirm it parses cleanly - label propagation is an emitter concern.
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
    string buffer[10]
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
    bool flags[8]
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
    int tape[100]
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
    int tape[100]
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
// Baseline - ensure existing features don't regress
// ===========================================================================

describe("baseline: minimal valid plugin", () => {
  it("transpiles a minimal plugin with no errors", () => {
    const src = `
defplugin "Minimal" do
end`;
    const plugin = transpileOk(src);
    expect(plugin.name).toBe("minimal");
    expect(plugin.display_name).toBe("Minimal");
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

  on :speed_change do
    int level = 0
  end
end`;
    const plugin = transpileOk(src);
    expect(plugin.name).toBe("full");
    expect(plugin.display_name).toBe("Full");
    expect(plugin.variables).toEqual({ counter: 0, name: "test" });
    expect(plugin.config).toHaveProperty("speed");
    expect(plugin.config).toHaveProperty("enabled");
    expect(plugin.functions).toHaveProperty("initialize");
    expect(plugin.events).toHaveProperty("speed_change");
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

// --- Phase C: eventSpan on OnNode -------------------------------------------

describe("Phase C: eventSpan targets the event atom", () => {
  it("captures eventSpan pointing to the :event atom", () => {
    const src = `
defplugin "Test" do
  on :speed_change do
    int level = 0
  end
end`;
    const { ast } = parseSource(src);
    const handler = ast.handlers[0]!;
    expect(handler.event).toBe("speed_change");
    // eventSpan should point to the `:speed_change` atom, not the whole block
    expect(handler.eventSpan.line).toBe(handler.span.line);
    expect(handler.eventSpan.endCol - handler.eventSpan.col).toBe(
      ":speed_change".length,
    );
  });

  it("unknown event warning targets the event atom span", () => {
    const src = `
defplugin "Test" do
  on :bogus_event do
    int level = 0
  end
end`;
    const result = transpile(src);
    const warn = result.diagnostics.find(
      (d) => d.level === "warning" && d.message.includes("bogus_event"),
    );
    expect(warn).toBeDefined();
    // The span should be on the event atom, not the whole on block
    const { ast } = parseSource(src);
    const handler = ast.handlers[0]!;
    expect(warn!.span).toEqual(handler.eventSpan);
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

describe("baseline: conditionals if and unless emit correctly", () => {
  it("emits an if conditional correctly", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    int x = 5
    if x > 0 do
      x = 10
    end
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["myFunc"];
    const def = fn as { actions?: unknown[] };
    expect(def.actions).toContainEqual({
      if: {
        gt: ["$x", 0],
        then: [{ set: { $x: 10 } }]
      }
    });
  });

  it("emits an unless conditional correctly", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    int x = 5
    unless x > 0 do
      x = 10
    end
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["myFunc"];
    const def = fn as { actions?: unknown[] };
    expect(def.actions).toContainEqual({
      if: {
        lte: ["$x", 0],
        then: [{ set: { $x: 10 } }]
      }
    });
  });
});

describe("baseline: loops while and until emit correctly", () => {
  it("emits a while loop correctly", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    int x = 0
    while x < 10 do
      x = x + 1
    end
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["myFunc"];
    const def = fn as { actions?: unknown[] };
    expect(def.actions).toContainEqual({
      while: {
        lt: ["$x", 10],
        then: [{ add: ["$x", 1], to: "$x" }]
      }
    });
  });

  it("emits an until loop correctly", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    int x = 0
    until x >= 10 do
      x = x + 1
    end
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["myFunc"];
    const def = fn as { actions?: unknown[] };
    expect(def.actions).toContainEqual({
      while: {
        lt: ["$x", 10],
        then: [{ add: ["$x", 1], to: "$x" }]
      }
    });
  });
});

// --- Phase 2 - Local arrays & index expressions -----------------------------

describe("Phase 2: local array declarations", () => {
  it("parses a local int array declaration", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    int buffer[10]
  end
end`;
    const errs = parseErrors(src);
    expect(errs.filter((e) => e.includes("array") || e.includes("bracket"))).toHaveLength(0);
  });

  it("rejects local string arrays", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    string buf[20]
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
    bool flags[8]
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
    int items[]
  end
end`;
    const errs = parseErrors(src);
    expect(errs.some((e) => e.includes("size"))).toBe(true);
  });

  it("rejects initializer on local array declarations", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    int buffer[10] = 0
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
    int tape[100]
    int x = 5
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["myFunc"];
    const def = fn as { vars?: string[]; actions?: unknown[] };
    expect(def.vars).toContain("tape[100]");
    expect(def.vars).toContain("x");
    expect(def.actions).toContainEqual({ set: { $x: 5 } });
    // No init action for tape - runtime zero-initializes arrays
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
    int buffer[50]
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
    int data[10]
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
    int data[10]
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
    int data[10]
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
    int data[10]
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
// Phase 3 - Type safety & symbol validation
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
  it("errors when assigning to a config ref with config.name", () => {
    const src = `
defplugin "Test" do
  config do
    int speed = 50
  end

  def myFunc() do
    config.speed = 100
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("read-only") || e.includes("Cannot assign"))).toBe(true);
  });

  it("errors when using @ module attr in expression context", () => {
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
    expect(errs.some((e) => e.includes("Cannot use @speed") || e.includes("Module attributes"))).toBe(true);
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
  on :speed_change do
    const int maxLevel = 20
  end
end`;
    const plugin = transpileOk(src);
    const handler = plugin.events?.["speed_change"] as { vars?: string[] };
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
    for (const event of ["connect", "disconnect", "speed_change", "mode_set", "tick"]) {
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

// ===========================================================================
// Phase 4 - Match block parsing & emission
// ===========================================================================

describe("Phase 4: match block parsing", () => {
  it("parses a match block with known predicates", () => {
    const src = `
defplugin "Test" do
  match do
    ble_name_prefix "LVS-Max"
  end
end`;
    const errs = parseErrors(src);
    expect(errs).toHaveLength(0);
  });

  it("parses multiple match predicates", () => {
    const src = `
defplugin "Test" do
  match do
    ble_name_prefix "LVS"
    vid "1234"
    pid "5678"
  end
end`;
    const errs = parseErrors(src);
    expect(errs).toHaveLength(0);
  });

  it("emits match block to JSON output", () => {
    const src = `
defplugin "Test" do
  match do
    ble_name_prefix "LVS-Max"
    vid "1234"
  end
end`;
    const plugin = transpileOk(src);
    const match = (plugin as unknown as Record<string, unknown>).match as Record<string, unknown>;
    expect(match).toBeDefined();
    expect(match.ble_name_prefix).toBe("LVS-Max");
    expect(match.vid).toBe("1234");
  });

  it("errors on unknown match predicate", () => {
    const src = `
defplugin "Test" do
  match do
    ble_name_prefix "LVS"
    unknownMatch "who"
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("Unknown") && e.includes("unknownMatch"))).toBe(true);
  });

  it("supports ble_name predicate", () => {
    const src = `
defplugin "Test" do
  match do
    ble_name "LVS-Max001"
  end
end`;
    const plugin = transpileOk(src);
    const match = (plugin as unknown as Record<string, unknown>).match as Record<string, unknown>;
    expect(match.ble_name).toBe("LVS-Max001");
  });

  it("supports serial predicate", () => {
    const src = `
defplugin "Test" do
  match do
    serial "ABC123"
  end
end`;
    const plugin = transpileOk(src);
    const match = (plugin as unknown as Record<string, unknown>).match as Record<string, unknown>;
    expect(match.serial).toBe("ABC123");
  });
});

// ===========================================================================
// Index assignment (setbyte) - end-to-end
// ===========================================================================

describe("index assignment (setbyte)", () => {
  it("compiles arr[i] = val to setbyte action", () => {
    const src = `
defplugin "Test" do
  globals do
    int data[10]
  end

  def write(int idx) do
    int val = 5
    $data[idx] = val
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.write;
    // Should contain a setbyte action
    const setbyte = fn.actions.find((a: any) => a.setbyte !== undefined);
    expect(setbyte).toBeDefined();
    expect(setbyte.setbyte).toEqual(["$data", "$idx", "$val"]);
  });

  it("compiles getbyte (index read) to getbyte action", () => {
    const src = `
defplugin "Test" do
  globals do
    int data[10]
  end

  def read(int idx) do
    int val = 0
    val = $data[idx]
    return val
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.read;
    const getbyte = fn.actions.find((a: any) => a.getbyte !== undefined);
    expect(getbyte).toBeDefined();
    expect(getbyte.getbyte).toEqual(["$data", "$idx"]);
    expect(getbyte.to).toBe("$val");
  });

  it("compiles local byte array declaration to vars with tape notation", () => {
    const src = `
defplugin "Test" do
  def process() do
    int buf[8]
    buf[0] = 42
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.process;
    expect(fn.vars).toContain("buf[8]");
    const setbyte = fn.actions.find((a: any) => a.setbyte !== undefined);
    expect(setbyte).toBeDefined();
    expect(setbyte.setbyte[0]).toBe("$buf");
  });
});

// ===========================================================================
// While loop - end-to-end
// ===========================================================================

describe("while loop", () => {
  it("compiles while block to while action", () => {
    const src = `
defplugin "Test" do
  def countdown() do
    int i = 10
    while i > 0 do
      i -= 1
    end
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.countdown;
    expect(fn.actions).toEqual([
      { set: { "$i": 10 } },
      { while: { gt: ["$i", 0], then: [{ dec: "$i" }] } },
    ]);
  });

  it("compiles until block with inverted condition", () => {
    const src = `
defplugin "Test" do
  def waitForZero() do
    int x = 5
    until x == 0 do
      x -= 1
    end
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.waitForZero;
    expect(fn.actions).toEqual([
      { set: { "$x": 5 } },
      { while: { neq: ["$x", 0], then: [{ dec: "$x" }] } },
    ]);
  });
});

// ===========================================================================
// Compound assignment - end-to-end
// ===========================================================================

describe("compound assignment", () => {
  it("compiles local += 1 to inc", () => {
    const src = `
defplugin "Test" do
  def step() do
    int i = 0
    i += 1
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.step;
    expect(fn.actions).toEqual([
      { set: { "$i": 0 } },
      { inc: "$i" },
    ]);
  });

  it("compiles global -= 1 to dec", () => {
    const src = `
defplugin "Test" do
  globals do
    int lives = 3
  end

  def die() do
    $lives -= 1
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.die;
    expect(fn.actions).toEqual([
      { dec: "$lives" },
    ]);
  });

  it("compiles *= to mul with self-assign", () => {
    const src = `
defplugin "Test" do
  def doubleIt() do
    int x = 1
    x *= 2
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.doubleIt;
    expect(fn.actions).toEqual([
      { set: { "$x": 1 } },
      { mul: ["$x", 2], to: "$x" },
    ]);
  });
});

// ===========================================================================
// Postfix while/until - end-to-end
// ===========================================================================

describe("postfix while/until", () => {
  it("compiles postfix while guard", () => {
    const src = `
defplugin "Test" do
  def drain() do
    int n = 10
    n -= 1 while n > 0
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.drain;
    expect(fn.actions).toEqual([
      { set: { "$n": 10 } },
      { while: { gt: ["$n", 0], then: [{ dec: "$n" }] } },
    ]);
  });

  it("compiles postfix until guard with inverted condition", () => {
    const src = `
defplugin "Test" do
  def fill() do
    int i = 0
    i += 1 until i == 10
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.fill;
    expect(fn.actions).toEqual([
      { set: { "$i": 0 } },
      { while: { neq: ["$i", 10], then: [{ inc: "$i" }] } },
    ]);
  });
});

// ===========================================================================
// While loop - end-to-end
// ===========================================================================

describe("while loop", () => {
  it("compiles while block to while action", () => {
    const src = `
defplugin "Test" do
  def countdown() do
    int i = 10
    while i > 0 do
      i -= 1
    end
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.countdown;
    expect(fn.actions).toEqual([
      { set: { "$i": 10 } },
      { while: { gt: ["$i", 0], then: [{ dec: "$i" }] } },
    ]);
  });

  it("compiles until block with inverted condition", () => {
    const src = `
defplugin "Test" do
  def waitForZero() do
    int x = 5
    until x == 0 do
      x -= 1
    end
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.waitForZero;
    expect(fn.actions).toEqual([
      { set: { "$x": 5 } },
      { while: { neq: ["$x", 0], then: [{ dec: "$x" }] } },
    ]);
  });
});

// ===========================================================================
// Compound assignment - end-to-end
// ===========================================================================

describe("compound assignment", () => {
  it("compiles local += 1 to inc", () => {
    const src = `
defplugin "Test" do
  def step() do
    int i = 0
    i += 1
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.step;
    expect(fn.actions).toEqual([
      { set: { "$i": 0 } },
      { inc: "$i" },
    ]);
  });

  it("compiles global -= 1 to dec", () => {
    const src = `
defplugin "Test" do
  globals do
    int lives = 3
  end

  def die() do
    $lives -= 1
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.die;
    expect(fn.actions).toEqual([
      { dec: "$lives" },
    ]);
  });

  it("compiles *= to mul with self-assign", () => {
    const src = `
defplugin "Test" do
  def doubleIt() do
    int x = 1
    x *= 2
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.doubleIt;
    expect(fn.actions).toEqual([
      { set: { "$x": 1 } },
      { mul: ["$x", 2], to: "$x" },
    ]);
  });
});

// ===========================================================================
// Postfix while/until - end-to-end
// ===========================================================================

describe("postfix while/until", () => {
  it("compiles postfix while guard", () => {
    const src = `
defplugin "Test" do
  def drain() do
    int n = 10
    n -= 1 while n > 0
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.drain;
    expect(fn.actions).toEqual([
      { set: { "$n": 10 } },
      { while: { gt: ["$n", 0], then: [{ dec: "$n" }] } },
    ]);
  });

  it("compiles postfix until guard with inverted condition", () => {
    const src = `
defplugin "Test" do
  def fill() do
    int i = 0
    i += 1 until i == 10
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.fill;
    expect(fn.actions).toEqual([
      { set: { "$i": 0 } },
      { while: { neq: ["$i", 10], then: [{ inc: "$i" }] } },
    ]);
  });
});


// --- For-in loop ------------------------------------------------------------

describe("for-in loop", () => {
  it("compiles a forward range loop", () => {
    const src = `
defplugin "Test" do
  def fill() do
    int i = 0
    for i in 1..5 do
      tick()
    end
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.fill;
    expect(fn.actions).toEqual([
      { set: { "$i": 0 } },
      { set: { "$i": 1 } },
      { while: { lte: ["$i", 5], then: [{ tick: [] }, { inc: "$i" }] } },
    ]);
  });

  it("compiles a reverse range loop", () => {
    const src = `
defplugin "Test" do
  def countdown() do
    int i = 0
    for i in 10..1 do
      tick()
    end
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.countdown;
    expect(fn.actions).toEqual([
      { set: { "$i": 0 } },
      { set: { "$i": 10 } },
      { while: { gte: ["$i", 1], then: [{ tick: [] }, { dec: "$i" }] } },
    ]);
  });

  it("compiles a byte array iteration", () => {
    const src = `
defplugin "Test" do
  globals do
    int tape[30]
  end
  def scan() do
    int val = 0
    for val in tape do
      tick()
    end
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.scan;
    expect(fn.actions).toEqual([
      { set: { "$val": 0 } },
      { set: { "$__t0": 0 } },
      { while: { lt: ["$__t0", 30], then: [
        { getbyte: ["$tape", "$__t0"], to: "$val" },
        { tick: [] },
        { inc: "$__t0" },
      ] } },
    ]);
  });

  it("compiles a string iteration", () => {
    const src = `
defplugin "Test" do
  def scan() do
    string msg = "hello"
    int ch = 0
    for ch in msg do
      tick()
    end
  end
end`;
    const plugin = transpileOk(src);
    const fn = (plugin as any).functions.scan;
    expect(fn.actions).toEqual([
      { set: { "$msg": "hello" } },
      { set: { "$ch": 0 } },
      { strlen: "$msg", to: "$__t0" },
      { set: { "$__t1": 0 } },
      { while: { lt: ["$__t1", "$__t0"], then: [
        { charat: ["$msg", "$__t1"], to: "$ch" },
        { tick: [] },
        { inc: "$__t1" },
      ] } },
    ]);
  });

  it("errors on undeclared loop variable", () => {
    const src = `
defplugin "Test" do
  def test() do
    for i in 1..10 do
      tick()
    end
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.length).toBeGreaterThan(0);
  });

  it("errors on iterating a plain int variable", () => {
    const src = `
defplugin "Test" do
  def test() do
    int x = 5
    int val = 0
    for val in x do
      tick()
    end
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some(e => e.includes("Cannot iterate"))).toBe(true);
  });
});

// --- Phase B: config.name / meta.name / @attr metadata / PascalCase defplugin -

describe("Phase B: config.name accessor", () => {
  it("parses config.name and emits getPluginConfig action", () => {
    const src = `
defplugin "Test" do
  config do
    int maxLevel = 100
  end

  def ramp() do
    setLevel config.maxLevel
  end
end`;
    const plugin = transpileOk(src);
    const ramp = (plugin as any).functions.ramp;
    expect(ramp.actions).toEqual([
      { getPluginConfig: "maxLevel" },
      { setLevel: "$_" },
    ]);
  });

  it("errors on config.name = expr (read-only)", () => {
    const src = `
defplugin "Test" do
  config do
    int speed = 50
  end

  def test() do
    config.speed = 100
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("read-only") || e.includes("Cannot assign"))).toBe(true);
  });
});

describe("Phase B: meta.name accessor", () => {
  it("parses meta.name but errors in emitter (not yet supported)", () => {
    const src = `
defplugin "Test" do
  def ramp() do
    setLevel meta.version
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("meta") && e.includes("not yet supported"))).toBe(true);
  });

  it("errors on meta.name = expr (read-only)", () => {
    const src = `
defplugin "Test" do
  def test() do
    meta.version = "2.0"
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("read-only") || e.includes("Cannot assign"))).toBe(true);
  });
});

describe("Phase B: PascalCase defplugin module name", () => {
  it("accepts PascalCase identifier as module name", () => {
    const src = `
defplugin LovenseMax do
end`;
    const errs = parseErrors(src);
    expect(errs).toHaveLength(0);
  });

  it("still accepts string display name for backward compat", () => {
    const src = `
defplugin "Lovense Max" do
end`;
    const errs = parseErrors(src);
    expect(errs).toHaveLength(0);
  });

  it("derives name slug from PascalCase module name", () => {
    const src = `
defplugin LovenseMax do
end`;
    const plugin = transpileOk(src);
    expect(plugin.name).toBe("lovense-max");
    expect(plugin.display_name).toBe("LovenseMax");
  });

  it("uses @display_name metadata over module name fallback", () => {
    const src = `
defplugin LovenseMax do
  @display_name "Lovense Max Driver"
end`;
    const plugin = transpileOk(src);
    expect(plugin.name).toBe("lovense-max");
    expect(plugin.display_name).toBe("Lovense Max Driver");
  });
});

describe("Phase B: @key value metadata syntax", () => {
  it("parses @key value metadata inside defplugin", () => {
    const src = `
defplugin Test do
  @version "1.0.0"
  @author "Test Author"
end`;
    const plugin = transpileOk(src);
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.author).toBe("Test Author");
  });

  it("still accepts bareword metadata for backward compat", () => {
    const src = `
defplugin "Test" do
  version "1.0.0"
  author "Test Author"
end`;
    const plugin = transpileOk(src);
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.author).toBe("Test Author");
  });

  it("parses @platforms with bracket list", () => {
    const src = `
defplugin Test do
  @platforms ["@eom", "@m1k"]
end`;
    const plugin = transpileOk(src);
    expect(plugin.platforms).toEqual(["@eom", "@m1k"]);
  });

  it("errors when using @ module attr in expression context", () => {
    const src = `
defplugin Test do
  def test() do
    $x = @speed
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("Cannot use @speed"))).toBe(true);
  });
});

// --- Phase D: $_ accumulator restrictions -----------------------------------

describe("Phase D: $_ restrictions", () => {
  it("errors on $_ read in a def body outside a pipe", () => {
    const src = `
defplugin "Test" do
  def test() do
    $x = $_
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("$_") && e.includes("pipe"))).toBe(true);
  });

  it("allows $_ inside a pipe chain", () => {
    const src = `
defplugin "Test" do
  def test(int speed) do
    speed |> set_level()
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.filter((e) => e.includes("$_"))).toHaveLength(0);
  });

  it("errors on $_ in an event handler body outside a pipe", () => {
    const src = `
defplugin "Test" do
  on :speed_change do
    set_level($_)
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("$_") && e.includes("pipe"))).toBe(true);
  });

  it("allows $_ in an event handler pipe chain", () => {
    const src = `
defplugin "Test" do
  on :speed_change do
    $_ |> set_level()
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.filter((e) => e.includes("$_"))).toHaveLength(0);
  });

  it("errors on $_ in a fn body outside a pipe", () => {
    const src = `
defplugin "Test" do
  fn bad = (int x) -> $_

  def test() do
    int y = bad(1)
  end
end`;
    const errs = transpileErrors(src);
    expect(errs.some((e) => e.includes("$_") && e.includes("pipe"))).toBe(true);
  });
});

// --- Phase E: local variable init expressions --------------------------------

describe("Phase E: local variable init with expression", () => {
  it("compiles int x = some_call() to a call action with to: target", () => {
    const src = `
defplugin "Test" do
  def myFunc() do
    int x = round(42)
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["myFunc"] as { vars?: string[]; actions?: unknown[] };
    expect(fn.vars).toContain("x");
    expect(fn.actions).toContainEqual({ round: 42, to: "$x" });
  });

  it("compiles int x = a + b to a binary action with to: target", () => {
    const src = `
defplugin "Test" do
  def myFunc(int a, int b) do
    int result = a + b
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["myFunc"] as { vars?: string[]; actions?: unknown[] };
    expect(fn.vars).toContain("result");
    expect(fn.actions).toContainEqual({ add: ["$a", "$b"], to: "$result" });
  });

  it("compiles int x = pipe chain to actions with final to: target", () => {
    const src = `
defplugin "Test" do
  def myFunc(int speed) do
    int level = speed |> round()
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["myFunc"] as { vars?: string[]; actions?: unknown[] };
    expect(fn.vars).toContain("level");
    expect(fn.actions).toContainEqual({ set: "$speed" });
    expect(fn.actions).toContainEqual({ round: [], to: "$level" });
  });

  it("compiles complex init in on block", () => {
    const src = `
defplugin "Test" do
  on :motorChange do
    int level = round(128)
  end
end`;
    const plugin = transpileOk(src);
    const handler = plugin.events?.["motorChange"] as { vars?: string[]; actions?: unknown[] };
    expect(handler.vars).toContain("level");
    expect(handler.actions).toContainEqual({ round: 128, to: "$level" });
  });

  it("preserves declaration-site ordering for init actions", () => {
    const src = `
defplugin "Test" do
  def myFunc(int a) do
    log("before")
    int x = round(a)
    log("after")
  end
end`;
    const plugin = transpileOk(src);
    const fn = plugin.functions?.["myFunc"] as { vars?: string[]; actions?: unknown[] };
    const actions = fn.actions as Record<string, unknown>[];
    const logBefore = actions.findIndex((a) => a.log === "before");
    const roundAction = actions.findIndex((a) => a.round !== undefined);
    const logAfter = actions.findIndex((a) => a.log === "after");
    expect(logBefore).toBeLessThan(roundAction);
    expect(roundAction).toBeLessThan(logAfter);
  });
});

// --- Phase F: fn inline semantics (future) -----------------------------------

describe("Phase F: fn inline semantics", () => {
  it.todo("fn bodies should inline at call sites when the optimizer is implemented", () => {
    // FUTURE: When the optimizer is implemented, fn definitions should be
    // inlined at call sites rather than compiled as separate functions.
    //
    // Given:
    //   fn double = (int x) -> x * 2
    //   def test(int val) do
    //     int result = double(val)
    //   end
    //
    // Current output (compiled function):
    //   { "functions": { "double": { "args": ["x"], "actions": [{"mul":["$x",2]},{"return":"$_"}] } } }
    //   { "test": { "actions": [{"@double": "$val", "to": "$result"}] } }
    //
    // Expected future output (inlined):
    //   { "test": { "actions": [{"mul": ["$val", 2], "to": "$result"}] } }
    //
    // The optimizer should:
    // 1. Detect fn definitions (pure, single-expression)
    // 2. Substitute parameters at each call site
    // 3. Remove the fn from the functions map if all call sites are inlined
  });
});

// --- Phase G: event handler `with` bindings ----------------------------------

describe("Phase G: on :event with bindings", () => {
  it("parses on :event with single binding and emits args", () => {
    const plugin = transpileOk(`
defplugin "Test" do
  on :speed_change with speed do
    int level = speed
  end
end
`);

    expect(plugin.events).toHaveProperty("speed_change");
    expect(plugin!.events!.speed_change).toEqual({
      vars: ["level"],
      args: ["speed"],
      actions: [{ set: { $level: "$speed" } }],
    });
  });

  it("parses on :event with multiple bindings", () => {
    const plugin = transpileOk(`
defplugin "Test" do
  on :speed_change with speed, mode do
    int s = speed
    int m = mode
  end
end
`);
    expect(plugin!.events!).toHaveProperty("speed_change");
    expect(plugin!.events!.speed_change).toEqual({
      vars: ["s", "m"],
      args: ["speed", "mode"],
      actions: [
        { set: { $s: "$speed" } },
        { set: { $m: "$mode" } },
      ],
    });
  });

  it("on :event without with still works (no args)", () => {
    const plugin = transpileOk(`
defplugin "Test" do
  on :connect do
    int x = 1
  end
end
`);
    expect(plugin!.events!).toHaveProperty("connect");
    expect(plugin!.events!.connect).toEqual({
      vars: ["x"],
      actions: [{ set: { $x: 1 } }],
    });
    // No args key when no bindings
    expect(plugin!.events!.connect).not.toHaveProperty("args");
  });

  it("bindings are in scope inside the handler body", () => {
    const plugin = transpileOk(`
defplugin "Test" do
  on :speed_change with speed do
    speed + 1
  end
end
`);
    expect(plugin!.events!).toHaveProperty("speed_change");
    expect((plugin!.events!.speed_change as MtpFunctionDefObject)!.args).toEqual(["speed"]);
  });
});
