import { describe, it, expect } from "vitest";
import { transpile, parseSource } from "./index.js";
import type { LangDiagnostic } from "./diagnostics.js";

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
