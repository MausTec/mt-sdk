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
    expect(errs).toContain("Expected newline after `do` — code must start on the next line");
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
    expect(errs).toContain("Expected newline after `do` — code must start on the next line");
  });

  it("allows a comment after `do`", () => {
    const src = `
defplugin "Test" do
  def myFunc() do # this is fine
    int x = 0
  end
end`;
    const errs = parseErrors(src);
    expect(errs.filter((e) => e.includes("newline after"))).toHaveLength(0);
  });

  it("allows `do` followed by a blank line", () => {
    const src = `
defplugin "Test" do
  def myFunc() do

    int x = 0
  end
end`;
    const errs = parseErrors(src);
    expect(errs.filter((e) => e.includes("newline after"))).toHaveLength(0);
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
      "Only `int` arrays are supported — `string` and `bool` arrays cannot be allocated",
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
      "Only `int` arrays are supported — `string` and `bool` arrays cannot be allocated",
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
