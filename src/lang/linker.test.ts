import { describe, it, expect } from "vitest";
import { link } from "./linker.js";
import { parseSource } from "./index.js";
import type { ApiDescriptor, RuntimeBundle } from "@maustec/mt-runtimes";

// --- Helpers ----------------------------------------------------------------

function parse(src: string) {
  const { ast, diagnostics } = parseSource(src);
  expect(
    diagnostics.filter((d) => d.level === "error"),
    "Fixture should parse without errors",
  ).toHaveLength(0);
  return ast;
}

function errors(src: string, context?: RuntimeBundle): string[] {
  const { diagnostics } = link(parse(src), context);
  return diagnostics.filter((d) => d.level === "error").map((d) => d.message);
}

function warnings(src: string, context?: RuntimeBundle): string[] {
  const { diagnostics } = link(parse(src), context);
  return diagnostics.filter((d) => d.level === "warning").map((d) => d.message);
}

// --- Stub descriptors -------------------------------------------------------

const BUILTINS: ApiDescriptor = {
  product: "mt-actions",
  version: "1.1.0",
  functions: [
    { name: "add", permission: null, args: [{ name: "a", type: "int" }, { name: "b", type: "int" }], returns: { type: "int" } },
    { name: "strlen", permission: null, args: [{ name: "s", type: "string" }], returns: { type: "int" } },
    { name: "concat", permission: null, args: [{ name: "a", type: "string" }, { name: "b", type: "string" }], returns: { type: "string" }, variadic: true },
  ],
  events: [],
};

const PLATFORM: ApiDescriptor = {
  product: "edge-o-matic",
  sku: "EOM3K",
  version: "2.0.0",
  functions: [
    { name: "set_speed", permission: "output:write", module: "output", args: [{ name: "speed", type: "int" }], returns: null },
    { name: "get_speed", permission: "output:read", module: "output", args: [], returns: { type: "int" } },
    { name: "ble_write", permission: "ble:write", module: "ble", args: [{ name: "data", type: "string" }], returns: null },
    { name: "opt_fn", permission: null, args: [{ name: "required", type: "int" }, { name: "optional", type: "int", optional: true }], returns: null },
  ],
  events: [
    { name: "connect", permission: null, payload: [] },
    { name: "disconnect", permission: null, payload: [] },
    { name: "speed_change", permission: "output:read", payload: [{ name: "speed", type: "int" }] },
    { name: "tick", permission: null, payload: [] },
  ],
};

const CTX: RuntimeBundle = { builtins: BUILTINS, platformApi: PLATFORM, resolvedPlatforms: [] };

// --- Tests ------------------------------------------------------------------

describe("linker: basic symbol resolution", () => {
  it("resolves plugin-defined functions without warnings", () => {
    const src = `
defplugin "Test" do
  def my_fn(int x) do
    int y = add(x, 1)
  end
end`;
    expect(errors(src, CTX)).toHaveLength(0);
  });

  it("errors on unknown local variable", () => {
    const src = `
defplugin "Test" do
  def go() do
    missing = 5
  end
end`;
    const errs = errors(src, CTX);
    expect(errs.some((e) => e.includes("missing"))).toBe(true);
  });

  it("errors on unknown global variable", () => {
    const src = `
defplugin "Test" do
  def go() do
    $unknown = 5
  end
end`;
    const errs = errors(src, CTX);
    expect(errs.some((e) => e.includes("unknown"))).toBe(true);
  });

  it("errors on unknown config variable", () => {
    const src = `
defplugin "Test" do
  def go() do
    int x = config.nonexistent
  end
end`;
    const errs = errors(src, CTX);
    expect(errs.some((e) => e.includes("nonexistent"))).toBe(true);
  });
});

describe("linker: function call validation", () => {
  it("warns on unknown function without descriptors", () => {
    const src = `
defplugin "Test" do
  def go() do
    unknown_fn()
  end
end`;
    const warns = warnings(src); // no context
    expect(warns.some((w) => w.includes("unknown_fn"))).toBe(true);
  });

  it("warns on unknown function with descriptors", () => {
    const src = `
defplugin "Test" do
  def go() do
    totally_fake()
  end
end`;
    const warns = warnings(src, CTX);
    expect(warns.some((w) => w.includes("totally_fake"))).toBe(true);
  });

  it("errors on wrong arg count — too few", () => {
    const src = `
defplugin "Test" do
  def go() do
    int x = add(1)
  end
end`;
    const errs = errors(src, CTX);
    expect(errs.some((e) => e.includes("add") && e.includes("2") && e.includes("1"))).toBe(true);
  });

  it("errors on wrong arg count — too many", () => {
    const src = `
defplugin "Test" do
  def go() do
    int x = add(1, 2, 3)
  end
end`;
    const errs = errors(src, CTX);
    expect(errs.some((e) => e.includes("add") && e.includes("3"))).toBe(true);
  });

  it("accepts variadic functions with extra args", () => {
    const src = `
defplugin "Test" do
  def go() do
    string s = concat("a", "b", "c", "d")
  end
end`;
    expect(errors(src, CTX)).toHaveLength(0);
  });

  it("errors on variadic function with too few args", () => {
    const src = `
defplugin "Test" do
  def go() do
    string s = concat("a")
  end
end`;
    const errs = errors(src, CTX);
    expect(errs.some((e) => e.includes("concat") && e.includes("at least"))).toBe(true);
  });

  it("accepts optional parameters", () => {
    const src = `
defplugin "Test" do
  def go() do
    opt_fn(42)
  end
end`;
    expect(errors(src, CTX)).toHaveLength(0);
  });

  it("pipe receiver counts implicit accumulator arg", () => {
    const src = `
defplugin "Test" do
  @permissions ["output:write", "output:read"]

  def go() do
    get_speed() |> set_speed()
  end
end`;
    // set_speed expects 1 arg — the pipe provides it implicitly
    expect(errors(src, CTX)).toHaveLength(0);
  });

  it("pipe receiver still errors when too few args with implicit", () => {
    const src = `
defplugin "Test" do
  def go() do
    1 |> add()
  end
end`;
    // add expects 2 args, pipe provides 1 implicit, so 1 explicit needed
    const errs = errors(src, CTX);
    expect(errs.some((e) => e.includes("add") && e.includes("argument"))).toBe(true);
  });

  it("pipe receiver still errors when too many args with implicit", () => {
    const src = `
defplugin "Test" do
  def go() do
    1 |> add(2, 3)
  end
end`;
    // add expects 2 args, pipe provides 1 implicit + 2 explicit = 3
    const errs = errors(src, CTX);
    expect(errs.some((e) => e.includes("add") && e.includes("argument"))).toBe(true);
  });

  // --- Explicit accumulator position in pipe receivers -----------------------

  it("explicit $_ in first position counts as the pipe arg", () => {
    const src = `
defplugin "Test" do
  @permissions ["output:write", "output:read"]

  def go() do
    get_speed() |> set_speed($_)
  end
end`;
    // set_speed(int) — $_ fills the slot explicitly, same as implicit
    expect(errors(src, CTX)).toHaveLength(0);
  });

  it("explicit $_ in non-first position works for arity", () => {
    const src = `
defplugin "Test" do
  def go() do
    1 |> add(2, $_)
  end
end`;
    // add(int, int) — 2 explicit args, one of which is $_, no implicit added
    // But wait — add expects 2 args and we have 2: (2, $_). That should pass.
    expect(errors(src, CTX)).toHaveLength(0);
  });

  it("explicit $_ prevents implicit arg from being added", () => {
    const src = `
defplugin "Test" do
  @permissions ["output:write", "output:read"]

  def go() do
    get_speed() |> set_speed($_, 99)
  end
end`;
    // set_speed expects 1 arg, but $_ + 99 = 2 explicit args
    const errs = errors(src, CTX);
    expect(errs.some((e) => e.includes("set_speed") && e.includes("argument"))).toBe(true);
  });

  it("errors when multiple $_ appear in a single pipe receiver", () => {
    const src = `
defplugin "Test" do
  def go() do
    1 |> add($_, $_)
  end
end`;
    const errs = errors(src, CTX);
    expect(errs.some((e) => e.includes("$_") && e.includes("once"))).toBe(true);
  });

  it("$_ in pipe receiver is not double-counted for arity", () => {
    const src = `
defplugin "Test" do
  def go() do
    1 |> add($_, 2)
  end
end`;
    // add(int, int) — $_ + 2 = 2 args. No implicit added since $_ is explicit.
    expect(errors(src, CTX)).toHaveLength(0);
  });
});

describe("linker: event validation", () => {
  it("does not warn about events without descriptors", () => {
    const src = `
defplugin "Test" do
  on :fake_event do
    int x = 0
  end
end`;
    expect(warnings(src)).toHaveLength(0);
  });

  it("warns on unknown event with descriptors", () => {
    const src = `
defplugin "Test" do
  on :bogus_event do
    int x = 0
  end
end`;
    const warns = warnings(src, CTX);
    expect(warns.some((w) => w.includes("bogus_event") && w.includes("nknown"))).toBe(true);
  });

  it("accepts known events with descriptors", () => {
    const src = `
defplugin "Test" do
  on :connect do
    int x = 0
  end
end`;
    const warns = warnings(src, CTX);
    expect(warns.filter((w) => w.includes("connect"))).toHaveLength(0);
  });

  it("errors when too many bindings for event payload", () => {
    const src = `
defplugin "Test" do
  on :connect with a, b do
    int x = 0
  end
end`;
    const errs = errors(src, CTX);
    expect(errs.some((e) => e.includes("connect") && e.includes("0") && e.includes("2"))).toBe(true);
  });

  it("validates event binding scope resolution", () => {
    const src = `
defplugin "Test" do
  @permissions ["output:write", "output:read"]

  on :speed_change with spd do
    set_speed(spd)
  end
end`;
    // spd should be resolvable as a binding parameter
    expect(errors(src, CTX)).toHaveLength(0);
  });
});

describe("linker: permission tracking", () => {
  it("reports missing permissions", () => {
    const src = `
defplugin "Test" do
  def go() do
    set_speed(50)
  end
end`;
    const result = link(parse(src), CTX);
    const errs = result.diagnostics.filter((d) => d.level === "error");
    expect(errs.some((e) => e.message.includes("output:write") && e.message.includes("@permissions"))).toBe(true);
    expect(result.permissionAnalysis.required.has("output:write")).toBe(true);
  });

  it("does not report when permissions are declared", () => {
    const src = `
defplugin "Test" do
  @permissions ["output:write"]

  def go() do
    set_speed(50)
  end
end`;
    const result = link(parse(src), CTX);
    const permErrs = result.diagnostics.filter(
      (d) => d.level === "error" && d.message.includes("permission"),
    );
    expect(permErrs).toHaveLength(0);
  });

  it("warns on unused declared permissions", () => {
    const src = `
defplugin "Test" do
  @permissions ["ble:write"]

  def go() do
    int x = get_speed()
  end
end`;
    const result = link(parse(src), CTX);
    const warns = result.diagnostics.filter((d) => d.level === "warning");
    expect(warns.some((w) => w.message.includes("ble:write") && w.message.includes("never used"))).toBe(true);
  });

  it("wildcard permission covers specific permission", () => {
    const src = `
defplugin "Test" do
  @permissions ["output:*"]

  def go() do
    set_speed(50)
    int x = get_speed()
  end
end`;
    const result = link(parse(src), CTX);
    const permErrs = result.diagnostics.filter(
      (d) => d.level === "error" && d.message.includes("permission"),
    );
    expect(permErrs).toHaveLength(0);
  });

  it("tracks permissions from event subscriptions", () => {
    const src = `
defplugin "Test" do
  on :speed_change with spd do
    int x = 0
  end
end`;
    const result = link(parse(src), CTX);
    // speed_change has permission "output:read"
    expect(result.permissionAnalysis.required.has("output:read")).toBe(true);
  });

  it("collects multiple permissions across functions and events", () => {
    const src = `
defplugin "Test" do
  @permissions ["output:write", "output:read"]

  def go() do
    set_speed(50)
  end

  on :speed_change with spd do
    int x = 0
  end
end`;
    const result = link(parse(src), CTX);
    expect(result.permissionAnalysis.required.has("output:write")).toBe(true);
    expect(result.permissionAnalysis.required.has("output:read")).toBe(true);
    // All declared permissions are used, no warnings
    const permWarns = result.diagnostics.filter(
      (d) => d.level === "warning" && d.message.includes("permission"),
    );
    expect(permWarns).toHaveLength(0);
  });
});

describe("linker: symbol table enrichment", () => {
  it("registers builtins on the symbol table", () => {
    const ast = parse(`defplugin "Test" do end`);
    const { symbols } = link(ast, CTX);
    const addFn = symbols.resolveFunction("add");
    expect(addFn).toBeDefined();
    expect(addFn!.source).toBe("builtin");
    expect(addFn!.params).toHaveLength(2);
  });

  it("registers platform functions on the symbol table", () => {
    const ast = parse(`defplugin "Test" do end`);
    const { symbols } = link(ast, CTX);
    const fn = symbols.resolveFunction("set_speed");
    expect(fn).toBeDefined();
    expect(fn!.source).toBe("runtime");
    expect(fn!.permission).toBe("output:write");
  });

  it("registers events on the symbol table", () => {
    const ast = parse(`defplugin "Test" do end`);
    const { symbols } = link(ast, CTX);
    const ev = symbols.resolveEvent("speed_change");
    expect(ev).toBeDefined();
    expect(ev!.permission).toBe("output:read");
  });

  it("plugin-defined functions take priority over builtins", () => {
    const src = `
defplugin "Test" do
  def add(int a) do
    int x = 0
  end
end`;
    const { symbols } = link(parse(src), CTX);
    const addFn = symbols.resolveFunction("add");
    expect(addFn!.source).toBe("plugin");
    expect(addFn!.params).toHaveLength(1);
  });

  it("hasDescriptors returns true when context is provided", () => {
    const ast = parse(`defplugin "Test" do end`);
    const { symbols } = link(ast, CTX);
    expect(symbols.hasDescriptors()).toBe(true);
  });

  it("hasDescriptors returns false without context", () => {
    const ast = parse(`defplugin "Test" do end`);
    const { symbols } = link(ast);
    expect(symbols.hasDescriptors()).toBe(false);
  });
});

describe("linker: graceful degradation (no context)", () => {
  it("still validates scope resolution without descriptors", () => {
    const src = `
defplugin "Test" do
  def go() do
    missing_var = 5
  end
end`;
    const errs = errors(src);
    expect(errs.some((e) => e.includes("missing_var"))).toBe(true);
  });

  it("still resolves plugin-defined functions", () => {
    const src = `
defplugin "Test" do
  def helper(int x) do
    int y = x
  end

  def go() do
    helper(5)
  end
end`;
    expect(errors(src)).toHaveLength(0);
  });

  it("does not warn on events without descriptors", () => {
    const src = `
defplugin "Test" do
  on :anything_goes do
    int x = 0
  end
end`;
    expect(warnings(src)).toHaveLength(0);
  });
});
