import { describe, it, expect } from "vitest";
import { PluginEmitter } from "./plugin.js";
import type {
  PluginNode,
  LiteralExpr,
  ConfigBlockNode,
  ConfigDecl,
  GlobalsBlockNode,
  GlobalDecl,
  MatchBlockNode,
  MatchPredicate,
  MetadataFieldNode,
} from "../ast.js";
import type { Span } from "../diagnostics.js";

// --- Helpers ------------------------------------------------------------------

const SPAN: Span = { line: 1, col: 1, endLine: 1, endCol: 1 };

function lit(value: number | string | boolean): LiteralExpr {
  const varType = typeof value === "number"
    ? "int" as const
    : typeof value === "boolean"
      ? "bool" as const
      : "string" as const;
  return { kind: "Literal", varType, value, span: SPAN };
}

function emptyPlugin(overrides: Partial<PluginNode> = {}): PluginNode {
  return {
    kind: "Plugin",
    span: SPAN,
    displayName: "Test Plugin",
    metadata: [],
    matchBlock: null,
    configBlock: null,
    globalsBlock: null,
    functions: [],
    defs: [],
    handlers: [],
    ...overrides,
  };
}

// --- PluginEmitter.emit (top-level) ------------------------------------------

describe("PluginEmitter.emit", () => {
  it("emits displayName", () => {
    const { plugin } = new PluginEmitter().emit(emptyPlugin());
    expect(plugin.displayName).toBe("Test Plugin");
  });

  it("reports error when displayName is missing", () => {
    const { diagnostics } = new PluginEmitter().emit(
      emptyPlugin({ displayName: null }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ level: "error", message: expect.stringContaining("display name") }),
    );
  });

  it("emits metadata fields", () => {
    const metadata: MetadataFieldNode[] = [
      { kind: "MetadataField", key: "version", value: lit("1.0.0"), span: SPAN },
      { kind: "MetadataField", key: "author", value: lit("Test Author"), span: SPAN },
    ];
    const { plugin } = new PluginEmitter().emit(emptyPlugin({ metadata }));
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.author).toBe("Test Author");
  });

  it("emits array metadata fields", () => {
    const metadata: MetadataFieldNode[] = [
      {
        kind: "MetadataField",
        key: "platforms",
        value: [lit("@eom"), lit("@mercury")],
        span: SPAN,
      },
    ];
    const { plugin } = new PluginEmitter().emit(emptyPlugin({ metadata }));
    expect(plugin.platforms).toEqual(["@eom", "@mercury"]);
  });

  it("wraps single-value array fields in an array", () => {
    const metadata: MetadataFieldNode[] = [
      { kind: "MetadataField", key: "platforms", value: lit("@eom"), span: SPAN },
    ];
    const { plugin } = new PluginEmitter().emit(emptyPlugin({ metadata }));
    expect(plugin.platforms).toEqual(["@eom"]);
  });

  it("reports error for unknown metadata fields", () => {
    const metadata: MetadataFieldNode[] = [
      { kind: "MetadataField", key: "bogus", value: lit("x"), span: SPAN },
    ];
    const { diagnostics } = new PluginEmitter().emit(emptyPlugin({ metadata }));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ level: "error", message: expect.stringContaining("bogus") }),
    );
  });
});

// --- Config block -------------------------------------------------------------

describe("PluginEmitter.emitConfigBlock", () => {
  it("emits config declarations", () => {
    const configBlock: ConfigBlockNode = {
      kind: "ConfigBlock",
      span: SPAN,
      declarations: [
        {
          kind: "ConfigDecl",
          varType: "int",
          name: "speed",
          nameSpan: SPAN,
          label: "Speed",
          default: lit(50),
          constraints: { min: lit(0), max: lit(255) },
          span: SPAN,
        } as ConfigDecl,
      ],
    };
    const { plugin } = new PluginEmitter().emit(emptyPlugin({ configBlock }));
    expect(plugin.config).toEqual({
      speed: { type: "int", default: 50, label: "Speed", min: 0, max: 255 },
    });
  });

  it("omits label when null", () => {
    const configBlock: ConfigBlockNode = {
      kind: "ConfigBlock",
      span: SPAN,
      declarations: [
        {
          kind: "ConfigDecl",
          varType: "bool",
          name: "enabled",
          nameSpan: SPAN,
          label: null,
          default: lit(true),
          constraints: {},
          span: SPAN,
        } as ConfigDecl,
      ],
    };
    const { plugin } = new PluginEmitter().emit(emptyPlugin({ configBlock }));
    expect(plugin.config!["enabled"]).toEqual({ type: "bool", default: true });
    expect(plugin.config!["enabled"]).not.toHaveProperty("label");
  });
});

// --- Globals block ------------------------------------------------------------

describe("PluginEmitter.emitGlobalsBlock", () => {
  it("emits scalar globals", () => {
    const globalsBlock: GlobalsBlockNode = {
      kind: "GlobalsBlock",
      span: SPAN,
      declarations: [
        {
          kind: "GlobalDecl", varType: "int", name: "counter",
          nameSpan: SPAN, label: null, arraySize: null, init: lit(0), span: SPAN,
        } as GlobalDecl,
      ],
    };
    const { plugin } = new PluginEmitter().emit(emptyPlugin({ globalsBlock }));
    expect(plugin.variables).toEqual({ counter: 0 });
  });

  it("emits array globals with size syntax", () => {
    const globalsBlock: GlobalsBlockNode = {
      kind: "GlobalsBlock",
      span: SPAN,
      declarations: [
        {
          kind: "GlobalDecl", varType: "int", name: "buffer",
          nameSpan: SPAN, label: null, arraySize: 16, init: lit(0), span: SPAN,
        } as GlobalDecl,
      ],
    };
    const { plugin } = new PluginEmitter().emit(emptyPlugin({ globalsBlock }));
    expect(plugin.variables).toEqual({ "buffer[16]": [] });
  });
});

// --- Match block --------------------------------------------------------------

describe("PluginEmitter.emitMatchBlock", () => {
  it("emits known match predicates with JSON key mapping", () => {
    const matchBlock: MatchBlockNode = {
      kind: "MatchBlock",
      span: SPAN,
      predicates: [
        { kind: "MatchPredicate", key: "ble_name_prefix", value: lit("LVS-"), span: SPAN } as MatchPredicate,
        { kind: "MatchPredicate", key: "vid", value: lit(0x1234), span: SPAN } as MatchPredicate,
      ],
    };
    const { plugin } = new PluginEmitter().emit(emptyPlugin({ matchBlock }));
    expect(plugin.match).toEqual({ bleNamePrefix: "LVS-", vid: 0x1234 });
  });

  it("reports error for unknown match predicates", () => {
    const matchBlock: MatchBlockNode = {
      kind: "MatchBlock",
      span: SPAN,
      predicates: [
        { kind: "MatchPredicate", key: "unknown_field", value: lit("x"), span: SPAN } as MatchPredicate,
      ],
    };
    const { diagnostics } = new PluginEmitter().emit(emptyPlugin({ matchBlock }));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ level: "error", message: expect.stringContaining("unknown_field") }),
    );
  });
});
