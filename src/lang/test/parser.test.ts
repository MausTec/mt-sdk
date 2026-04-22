import { describe, it, expect } from "vitest";
import { lex } from "../lexer.js";
import { parseTestFile } from "./index.js";
import type {
  TestFileNode,
  DescribeNode,
  TestCaseNode,
  SetupNode,
  MockDeclNode,
  ConfigOverrideNode,
  EmitStmt,
  CallTestStmt,
  AssignGlobalStmt,
  AssertStmt,
  ExpectStmt,
} from "./index.js";
import type { LangDiagnostic } from "../diagnostics.js";

// --- Helpers ----------------------------------------------------------------

function parse(source: string) {
  const { tokens, diagnostics: lexDiag } = lex(source);
  const { ast, diagnostics } = parseTestFile(tokens);
  return { ast, diagnostics: [...lexDiag, ...diagnostics] };
}

function errors(diags: LangDiagnostic[]): string[] {
  return diags.filter((d) => d.level === "error").map((d) => d.message);
}

function parseOk(source: string): TestFileNode {
  const { ast, diagnostics } = parse(source);
  const errs = errors(diagnostics);
  expect(errs, `Expected no errors but got:\n${errs.join("\n")}`).toHaveLength(0);
  return ast;
}

// --- deftest header ---------------------------------------------------------

describe("deftest header", () => {
  it("parses module name reference", () => {
    const ast = parseOk(`
deftest for LovenseMaxDriver do
end
`);
    expect(ast.kind).toBe("TestFile");
    expect(ast.pluginRef).toBe("LovenseMaxDriver");
    expect(ast.pluginRefIsPath).toBe(false);
  });

  it("parses string path reference", () => {
    const ast = parseOk(`
deftest for "drivers/lovense-max/plugin.mtp" do
end
`);
    expect(ast.pluginRef).toBe("drivers/lovense-max/plugin.mtp");
    expect(ast.pluginRefIsPath).toBe(true);
  });

  it("errors when missing `for` keyword", () => {
    const { diagnostics } = parse(`
deftest LovenseMaxDriver do
end
`);
    expect(errors(diagnostics).length).toBeGreaterThan(0);
  });

  it("errors on missing plugin reference", () => {
    const { diagnostics } = parse(`
deftest for do
end
`);
    expect(errors(diagnostics).length).toBeGreaterThan(0);
  });
});

// --- describe block ---------------------------------------------------------

describe("describe block", () => {
  it("parses describe with label", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  describe "connect" do
  end
end
`);
    const desc = ast.body[0] as DescribeNode;
    expect(desc.kind).toBe("Describe");
    expect(desc.label).toBe("connect");
  });

  it("errors on nested describe", () => {
    const { diagnostics } = parse(`
deftest for MyPlugin do
  describe "outer" do
    describe "inner" do
    end
  end
end
`);
    expect(errors(diagnostics).length).toBeGreaterThan(0);
  });

  it("errors when describe has no label", () => {
    const { diagnostics } = parse(`
deftest for MyPlugin do
  describe do
  end
end
`);
    expect(errors(diagnostics).length).toBeGreaterThan(0);
  });
});

// --- test case block --------------------------------------------------------

describe("test case block", () => {
  it("parses test with label and empty body", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  describe "group" do
    test "does something" do
    end
  end
end
`);
    const desc = ast.body[0] as DescribeNode;
    const tc = desc.body[0] as TestCaseNode;
    expect(tc.kind).toBe("TestCase");
    expect(tc.label).toBe("does something");
    expect(tc.steps).toHaveLength(0);
  });
});

// --- setup block ------------------------------------------------------------

describe("setup block", () => {
  it("parses setup with emit step", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  describe "tick" do
    setup do
      emit :connect
    end
    test "runs" do
    end
  end
end
`);
    const desc = ast.body[0] as DescribeNode;
    const setup = desc.body[0] as SetupNode;
    expect(setup.kind).toBe("Setup");
    expect(setup.steps).toHaveLength(1);
    expect(setup.steps[0]!.kind).toBe("Emit");
  });
});

// --- mock declaration -------------------------------------------------------

describe("mock declaration", () => {
  it("parses top-level mock with no params", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  mock millis = () -> 0
end
`);
    const mock = ast.body[0] as MockDeclNode;
    expect(mock.kind).toBe("MockDecl");
    expect(mock.name).toBe("millis");
    expect(mock.params).toHaveLength(0);
    expect(mock.body).toMatchObject({ kind: "Literal", value: 0 });
  });

  it("parses mock with typed params", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  mock ble_write = (string data) -> 0
end
`);
    const mock = ast.body[0] as MockDeclNode;
    expect(mock.params).toHaveLength(1);
    expect(mock.params[0]).toMatchObject({ varType: "string", name: "data" });
  });

  it("parses sequential mock re-declarations in a test body", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  test "re-declares mock" do
    mock millis = () -> 0
    emit :tick
    mock millis = () -> 1001
    emit :tick
  end
end
`);
    const tc = ast.body[0] as TestCaseNode;
    expect(tc.steps[0]).toMatchObject({ kind: "MockDecl", name: "millis" });
    expect(tc.steps[2]).toMatchObject({ kind: "MockDecl", name: "millis" });
    expect(
      (tc.steps[0] as MockDeclNode).body,
    ).toMatchObject({ kind: "Literal", value: 0 });
    expect(
      (tc.steps[2] as MockDeclNode).body,
    ).toMatchObject({ kind: "Literal", value: 1001 });
  });
});

// --- emit statement ---------------------------------------------------------

describe("emit statement", () => {
  it("parses emit without arg", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  test "basic emit" do
    emit :connect
  end
end
`);
    const tc = ast.body[0] as TestCaseNode;
    const stmt = tc.steps[0] as EmitStmt;
    expect(stmt.kind).toBe("Emit");
    expect(stmt.event).toBe("connect");
    expect(stmt.arg).toBeNull();
  });

  it("parses emit with `with` arg", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  test "emit with arg" do
    emit :speed_change with 50
  end
end
`);
    const tc = ast.body[0] as TestCaseNode;
    const stmt = tc.steps[0] as EmitStmt;
    expect(stmt.arg).not.toBeNull();
    expect(stmt.arg).toHaveLength(1);
    expect(stmt.arg![0]).toMatchObject({ kind: "Literal", value: 50 });
  });

  it("errors when missing atom", () => {
    const { diagnostics } = parse(`
deftest for MyPlugin do
  test "bad emit" do
    emit connect
  end
end
`);
    expect(errors(diagnostics).length).toBeGreaterThan(0);
  });
});

// --- call statement ---------------------------------------------------------

describe("call statement", () => {
  it("parses call with no args", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  test "call fn" do
    call my_fn()
  end
end
`);
    const tc = ast.body[0] as TestCaseNode;
    const stmt = tc.steps[0] as CallTestStmt;
    expect(stmt.kind).toBe("CallTest");
    expect(stmt.name).toBe("my_fn");
    expect(stmt.args).toHaveLength(0);
  });

  it("parses call with arguments", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  test "call fn with args" do
    call set_level(3, true)
  end
end
`);
    const tc = ast.body[0] as TestCaseNode;
    const stmt = tc.steps[0] as CallTestStmt;
    expect(stmt.args).toHaveLength(2);
    expect(stmt.args[0]).toMatchObject({ kind: "Literal", value: 3 });
  });
});

// --- global assignment ------------------------------------------------------

describe("global assignment", () => {
  it("parses $name = expr", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  test "assign global" do
    $air_phase = 1
  end
end
`);
    const tc = ast.body[0] as TestCaseNode;
    const stmt = tc.steps[0] as AssignGlobalStmt;
    expect(stmt.kind).toBe("AssignGlobal");
    expect(stmt.name).toBe("air_phase");
    expect(stmt.value).toMatchObject({ kind: "Literal", value: 1 });
  });
});

// --- assert statement -------------------------------------------------------

describe("assert statement", () => {
  it("parses assert with expression", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  test "assert" do
    assert $air_phase == 0
  end
end
`);
    const tc = ast.body[0] as TestCaseNode;
    const stmt = tc.steps[0] as AssertStmt;
    expect(stmt.kind).toBe("Assert");
    expect(stmt.condition.kind).toBe("Binary");
  });
});

// --- expect statement --------------------------------------------------------

describe("expect statement", () => {
  it("parses `expect fn called` -- called at least once", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  test "called" do
    expect ble_write called
  end
end
`);
    const tc = ast.body[0] as TestCaseNode;
    const stmt = tc.steps[0] as ExpectStmt;
    expect(stmt.kind).toBe("Expect");
    expect(stmt.name).toBe("ble_write");
    expect(stmt.negated).toBe(false);
    expect(stmt.args).toBeNull();
    expect(stmt.times).toBeNull();
  });

  it("parses `expect fn not called`", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  test "not called" do
    expect ble_write not called
  end
end
`);
    const tc = ast.body[0] as TestCaseNode;
    const stmt = tc.steps[0] as ExpectStmt;
    expect(stmt.negated).toBe(true);
    expect(stmt.args).toBeNull();
    expect(stmt.times).toBeNull();
  });

  it("parses `expect fn called with arg` -- single arg", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  test "called with" do
    expect ble_write called with "Battery;"
  end
end
`);
    const tc = ast.body[0] as TestCaseNode;
    const stmt = tc.steps[0] as ExpectStmt;
    expect(stmt.negated).toBe(false);
    expect(stmt.args).toHaveLength(1);
    expect(stmt.args![0]).toMatchObject({ kind: "Literal", value: "Battery;" });
    expect(stmt.times).toBeNull();
  });

  it("parses `expect fn called with arg1, arg2` -- multiple args", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  test "called with multi" do
    expect ble_write called with "Air:Level:3;", 123
  end
end
`);
    const tc = ast.body[0] as TestCaseNode;
    const stmt = tc.steps[0] as ExpectStmt;
    expect(stmt.args).toHaveLength(2);
    expect(stmt.args![0]).toMatchObject({ kind: "Literal", value: "Air:Level:3;" });
    expect(stmt.args![1]).toMatchObject({ kind: "Literal", value: 123 });
  });

  it("parses `expect fn not called with arg`", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  test "not called with" do
    expect ble_write not called with "Battery;"
  end
end
`);
    const tc = ast.body[0] as TestCaseNode;
    const stmt = tc.steps[0] as ExpectStmt;
    expect(stmt.negated).toBe(true);
    expect(stmt.args).toHaveLength(1);
    expect(stmt.args![0]).toMatchObject({ kind: "Literal", value: "Battery;" });
  });

  it("parses `expect fn called 3 times` -- exact count (implicit ==)", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  test "called N times" do
    expect ble_write called 3 times
  end
end
`);
    const tc = ast.body[0] as TestCaseNode;
    const stmt = tc.steps[0] as ExpectStmt;
    expect(stmt.negated).toBe(false);
    expect(stmt.args).toBeNull();
    expect(stmt.times).toEqual({ op: "==", count: 3 });
  });

  it("parses `expect fn called >= 3 times` -- comparison operator", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  test "called >= N times" do
    expect ble_write called >= 3 times
  end
end
`);
    const tc = ast.body[0] as TestCaseNode;
    const stmt = tc.steps[0] as ExpectStmt;
    expect(stmt.times).toEqual({ op: ">=", count: 3 });
  });

  it("errors when `called` keyword is missing", () => {
    const { diagnostics } = parse(`
deftest for MyPlugin do
  test "missing called" do
    expect ble_write with "arg"
  end
end
`);
    expect(errors(diagnostics).length).toBeGreaterThan(0);
  });

  it("errors when function name is missing", () => {
    const { diagnostics } = parse(`
deftest for MyPlugin do
  test "missing name" do
    expect called
  end
end
`);
    expect(errors(diagnostics).length).toBeGreaterThan(0);
  });

  it("errors when `times` keyword is missing after count", () => {
    const { diagnostics } = parse(`
deftest for MyPlugin do
  test "missing times" do
    expect ble_write called 3
  end
end
`);
    expect(errors(diagnostics).length).toBeGreaterThan(0);
  });
});

it("parses multiple expects in one test case", () => {
  const ast = parseOk(`
deftest for MyPlugin do
  test "multiple expects" do
    expect ble_write called with "Battery;"
    expect ble_write called with "Air:Level:3;"
  end
end
`);
  const tc = ast.body[0] as TestCaseNode;
  const stmt1 = tc.steps[0] as ExpectStmt;
  const stmt2 = tc.steps[1] as ExpectStmt;
  expect(stmt1.args).toHaveLength(1);
  expect(stmt1.args![0]).toMatchObject({ kind: "Literal", value: "Battery;" });
  expect(stmt2.args).toHaveLength(1);
  expect(stmt2.args![0]).toMatchObject({ kind: "Literal", value: "Air:Level:3;" });
});

it.todo("parses expect with args and count, but count came first", () => {
  const ast = parseOk(`
deftest for MyPlugin do
  test "args and count" do
    expect ble_write called 2 times with "Battery;"
  end
end
`);
  const tc = ast.body[0] as TestCaseNode;
  const stmt = tc.steps[0] as ExpectStmt;
  expect(stmt.args).toHaveLength(1);
  expect(stmt.args![0]).toMatchObject({ kind: "Literal", value: "Battery;" });
  expect(stmt.times).toEqual({ op: "==", count: 2 });
});

it("parses expect with args and count, but args came first", () => {
  const ast = parseOk(`
deftest for MyPlugin do
  test "args and count" do
    expect ble_write called with "Battery;" 2 times
  end
end
`);
  const tc = ast.body[0] as TestCaseNode;
  const stmt = tc.steps[0] as ExpectStmt;
  expect(stmt.args).toHaveLength(1);
  expect(stmt.args![0]).toMatchObject({ kind: "Literal", value: "Battery;" });
  expect(stmt.times).toEqual({ op: "==", count: 2 });
});

// --- config override block ---------------------------------------------------

describe("config override block", () => {
  it("parses config block inside test", () => {
    const ast = parseOk(`
deftest for MyPlugin do
  test "with config" do
    config do
      int air_min = 3
    end
    emit :connect
  end
end
`);
    const tc = ast.body[0] as TestCaseNode;
    const cfg = tc.steps[0] as ConfigOverrideNode;
    expect(cfg.kind).toBe("ConfigOverride");
    expect(cfg.declarations).toHaveLength(1);
    expect(cfg.declarations[0]!).toMatchObject({
      varType: "int",
      name: "air_min",
    });
    expect(cfg.declarations[0]!.default).toMatchObject({ value: 3 });
  });
});

// --- full integration snippet -----------------------------------------------

describe("integration", () => {
  it("parses a realistic test file", () => {
    const source = `
deftest for LovenseMaxDriver do
  mock millis    = () -> 0
  mock ble_write = (string data) -> 0

  describe "connect" do
    test "queries battery" do
      emit :connect
      expect ble_write called with "Battery;"
    end
    test "with config override" do
      config do
        int air_min = 3
      end
      emit :connect
      expect ble_write called with "Air:Level:3;"
    end
  end

  describe "tick" do
    setup do
      emit :connect
    end

    test "toggles after half period" do
      mock millis = () -> 1001
      emit :tick
      assert $air_phase == 0
      expect ble_write called 2 times
    end
  end
end
`;
    const { ast, diagnostics } = parse(source);
    expect(errors(diagnostics)).toHaveLength(0);
    expect(ast.pluginRef).toBe("LovenseMaxDriver");
    expect(ast.body).toHaveLength(4); // 2 mocks + 2 describes

    const describes = ast.body.filter((n) => n.kind === "Describe") as DescribeNode[];
    expect(describes).toHaveLength(2);
    expect(describes[0]!.label).toBe("connect");
    expect(describes[1]!.label).toBe("tick");

    const tickDesc = describes[1]!;
    const setup = tickDesc.body.find((n) => n.kind === "Setup") as SetupNode | undefined;
    expect(setup).toBeDefined();
    expect(setup!.steps[0]!.kind).toBe("Emit");

    const tc = tickDesc.body.find((n) => n.kind === "TestCase") as TestCaseNode | undefined;
    expect(tc!.label).toBe("toggles after half period");
    expect(tc!.steps.map((s) => s.kind)).toEqual([
      "MockDecl",
      "Emit",
      "Assert",
      "Expect",
    ]);
  });
});
