/**
 * Main test orchestrator.
 *
 * Provides two public entry points:
 *
 * - `discoverTests(options?)`: walks the workspace, finds
 *   `.test.mtp` files, and parses them. No compilation or WASM involved.
 *
 * - `runProjectTests(options?)`: discovers tests, compiles the
 *   associated `.mtp` sources in memory, loads the WASM bundle once, and
 *   delegates execution to `runTests()` from the lang/test runner.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { lexTest } from "../lang/lexer.js";
import { parseTestFile } from "../lang/test/parser.js";
import { runTests } from "../lang/test/runner.js";
import { build } from "./build.js";

import { discoverWorkspace, readProjectConfig, resolveProjectConfig } from "../project/workspace.js";
import { getLatestApiDescriptor } from "@maustec/mt-runtimes";

import type { LangDiagnostic } from "../lang/index.js";
import type { TestFileNode } from "../lang/test/ast.js";
import type { TestPlugin, TestSuiteResult, TestReporter } from "../lang/test/runner.js";
import type { ApiDescriptor } from "../analysis/types.js";

// --- Discovery types --------------------------------------------------------

/**
 * A single `.test.mtp` file that was discovered and (attempted to be) parsed.
 */
export interface DiscoveredTestFile {
  /** Absolute path to the `.test.mtp` file. */
  filePath: string;
  /** Absolute path to the member project directory that owns this test file. */
  memberDir: string;
  /**
   * Parsed AST. Present when there are no error-level diagnostics.
   * May be a partial AST when there are only warning-level diagnostics.
   */
  ast: TestFileNode | null;
  /** Parse diagnostics (lex + parse phases). */
  diagnostics: LangDiagnostic[];
  /** False when any error-level diagnostic is present. */
  ok: boolean;
}

/**
 * Result of `discoverTests()`.
 */
export interface TestDiscovery {
  /** All discovered test files across all workspace members. */
  files: DiscoveredTestFile[];
  /** Absolute path to the workspace root (directory containing mt-sdk.json). */
  workspaceRoot: string;
}

// --- Run types --------------------------------------------------------------

/**
 * Options for `runProjectTests()`.
 */
export interface TestOptions {
  /**
   * Working directory for workspace discovery.
   * Defaults to `process.cwd()`.
   */
  cwd?: string;

  /**
   * Target device SKU for auto-resolving the API manifest (e.g. `"EOM3K"`).
   * When omitted and `apiDescriptor` is not provided, only explicitly mocked
   * host functions will be registered during test execution.
   */
  sku?: string;

  /**
   * Explicit API descriptor override. Takes precedence over `sku`.
   */
  apiDescriptor?: ApiDescriptor;

  /**
   * Incremental reporter called as execution proceeds.
   * The full aggregated result is also returned when execution completes.
   */
  reporter?: TestReporter;

  /**
   * Capture a per-test-case execution trace. Adds overhead; useful for
   * debugging failing tests. Default: `false`.
   */
  tracing?: boolean;

  /**
   * Emit diagnostic logs to stderr for each setup step. Default: `false`.
   */
  debug?: boolean;
}

/**
 * A member whose `.mtp` source failed to compile.
 * No tests are run for this member.
 */
export interface MemberBuildError {
  /** Absolute path to the member project directory. */
  memberDir: string;
  /** Compile-time diagnostics from the build step. */
  diagnostics: LangDiagnostic[];
}

/**
 * Aggregated result of `runProjectTests()`.
 */
export interface TestResult {
  /** Per-suite results (one suite per successfully-parsed test file). */
  suites: TestSuiteResult[];
  /** Members whose `.mtp` source failed to compile. */
  buildErrors: MemberBuildError[];
  /** Test files that failed to parse (no tests were run for these). */
  parseErrors: DiscoveredTestFile[];
  /** Total number of passing test cases across all suites. */
  passed: number;
  /** Total number of failing test cases across all suites. */
  failed: number;
  /** Total number of errored test cases (unexpected runtime errors) across all suites. */
  errored: number;
  /** True when there are no build errors, parse errors, failed cases, or errored cases. */
  ok: boolean;
}

// --- Discovery --------------------------------------------------------------

/**
 * Discover all `.test.mtp` files in the workspace rooted at (or above) `cwd`.
 *
 * For each `mtp-plugin` member in the workspace, scans the member's configured
 * `tests/` directory (default: `"tests/"`) for `.test.mtp` files and parses
 * them. No compilation or WASM loading is performed.
 *
 * If no workspace is found, treats `cwd` itself as a single project and looks
 * for its own tests directory.
 *
 * @returns All discovered test files and the resolved workspace root path.
 */
export function discoverTests(options?: { cwd?: string }): TestDiscovery {
  const cwd = options?.cwd ?? process.cwd();
  const workspace = discoverWorkspace(cwd);

  if (!workspace) {
    // Single-project mode: treat cwd as a lone plugin project.
    const projectConfig = readProjectConfig(cwd);
    const resolved = resolveProjectConfig(projectConfig);
    const files = scanTestFiles(cwd, resolved.tests);

    return { files, workspaceRoot: cwd };
  }

  const files: DiscoveredTestFile[] = [];

  for (const member of workspace.members) {
    if (member.kind !== "mtp-plugin") continue;

    const memberFiles = scanTestFiles(member.dir, member.config.tests);
    files.push(...memberFiles);
  }

  return { files, workspaceRoot: workspace.root };
}

// --- Execution --------------------------------------------------------------

/**
 * Discover, compile, and run all tests in the workspace.
 *
 * Workflow:
 * 1. Use `discoverTests()` to find and parse all `.test.mtp` files.
 * 2. For each `mtp-plugin` member that has test files, read and compile its
 *    `.mtp` source in memory via `build()`. Members that fail to compile are
 *    collected in `buildErrors`; their tests are skipped.
 * 3. Load the WASM bundle once via `loadWasm()` from `@maustec/mt-runtimes`.
 * 4. Invoke `runTests()` with the assembled plugins and test file ASTs.
 * 5. Return a `TestResult` aggregating all outcomes.
 *
 * @throws If the WASM binary cannot be loaded from the filesystem.
 */
export async function runProjectTests(options?: TestOptions): Promise<TestResult> {
  const cwd = options?.cwd ?? process.cwd();
  const { files, workspaceRoot: _workspaceRoot } = discoverTests({ cwd });

  // Separate parse failures from parseable files upfront.
  const parseErrors = files.filter((f) => !f.ok);
  const parsedFiles = files.filter((f) => f.ok && f.ast !== null);

  if (parsedFiles.length === 0) {
    return {
      suites: [],
      buildErrors: [],
      parseErrors,
      passed: 0,
      failed: 0,
      errored: 0,
      ok: parseErrors.length === 0,
    };
  }

  // Resolve API manifest. Defaults to EOM3K when neither an explicit
  // descriptor nor an explicit sku is supplied. Without a manifest, any
  // host function the plugin calls that isn't explicitly mocked will fail
  // the action chain (e.g. `get_config`, `to_string`), preventing
  // downstream `expect` assertions from ever observing the calls they care
  // about. Matches the default behavior of `mt-sdk simulate`.
  let manifest: ApiDescriptor | undefined = options?.apiDescriptor;

  if (!manifest) {
    const sku = options?.sku ?? "EOM3K";

    try {
      manifest = getLatestApiDescriptor(sku);
    } catch {
      // No manifest, only explicitly mocked functions will be registered.
    }
  }

  // Compile each member that has test files in memory.
  // Group test files by memberDir so we compile each member at most once.
  const memberDirs = [...new Set(parsedFiles.map((f) => f.memberDir))];

  const plugins: TestPlugin[] = [];
  const buildErrors: MemberBuildError[] = [];
  const failedMemberDirs = new Set<string>();

  for (const memberDir of memberDirs) {
    const projectConfig = readProjectConfig(memberDir);
    const resolved = resolveProjectConfig(projectConfig);
    const srcPath = join(memberDir, resolved.src);

    if (!existsSync(srcPath)) {
      buildErrors.push({
        memberDir,
        diagnostics: [
          {
            level: "error",
            message: `Source file not found: ${srcPath}`,
            span: { line: 0, col: 0, endLine: 0, endCol: 0 },
          },
        ],
      });

      failedMemberDirs.add(memberDir);
      continue;
    }

    let source: string;
    try {
      source = readFileSync(srcPath, "utf-8");
    } catch (e) {
      buildErrors.push({
        memberDir,
        diagnostics: [
          {
            level: "error",
            message: `Could not read ${srcPath}: ${e instanceof Error ? e.message : String(e)}`,
            span: { line: 0, col: 0, endLine: 0, endCol: 0 },
          },
        ],
      });

      failedMemberDirs.add(memberDir);
      continue;
    }

    const buildResult = build({ source });

    if (!buildResult.ok) {
      buildErrors.push({ memberDir, diagnostics: buildResult.diagnostics });
      failedMemberDirs.add(memberDir);
      continue;
    }

    plugins.push({ json: buildResult.plugin as Record<string, unknown> });
  }

  // Filter out test files whose member failed to build.
  const runnableFiles = parsedFiles.filter((f) => !failedMemberDirs.has(f.memberDir));

  if (runnableFiles.length === 0) {
    return {
      suites: [],
      buildErrors,
      parseErrors,
      passed: 0,
      failed: 0,
      errored: 0,
      ok: false,
    };
  }

  // Run all tests.
  const testAsts = runnableFiles.map((f) => f.ast!);

  // Wrap the caller-provided reporter so that streaming `onSuiteResult`
  // events carry the source filePath. We track which suite is in flight by
  // sequencing through `runnableFiles` in lockstep with `onSuiteStart`.

  let suiteCursor = 0;
  const userReporter = options?.reporter;

  const wrappedReporter: TestReporter | undefined = userReporter
    ? {
        onSuiteStart: (info) => {
          userReporter.onSuiteStart?.(info);
        },
        onCaseStart: (info) => {
          userReporter.onCaseStart?.(info);
        },
        onCaseResult: (result) => {
          userReporter.onCaseResult?.(result);
        },
        onSuiteResult: (suite) => {
          const file = runnableFiles[suiteCursor++];
          
          if (file && suite.filePath === undefined) {
            suite.filePath = file.filePath;
          }

          userReporter.onSuiteResult?.(suite);
        },
      }
    : undefined;

  const suites = await runTests({
    tests: testAsts,
    plugins,
    config: {
      ...(manifest !== undefined ? { manifest } : {}),
      tracing: options?.tracing ?? false,
      debug: options?.debug ?? false,
    },

    ...(wrappedReporter !== undefined ? { reporter: wrappedReporter } : {}),
  });

  // Annotate any remaining suites (no-op when the wrapper above already ran).
  for (let i = 0; i < suites.length; i++) {
    const file = runnableFiles[i];
    
    if (file && suites[i] && suites[i]!.filePath === undefined) {
      suites[i]!.filePath = file.filePath;
    }
  }

  const passed  = suites.reduce((n, s) => n + s.passed, 0);
  const failed  = suites.reduce((n, s) => n + s.failed, 0);
  const errored = suites.reduce((n, s) => n + s.errored, 0);

  return {
    suites,
    buildErrors,
    parseErrors,
    passed,
    failed,
    errored,
    ok: buildErrors.length === 0 && parseErrors.length === 0 && failed === 0 && errored === 0,
  };
}

// --- Internal helpers -------------------------------------------------------

/**
 * Scan a directory for `.test.mtp` files and parse each one.
 * Returns an empty array if the directory does not exist.
 */
function scanTestFiles(memberDir: string, testsDir: string): DiscoveredTestFile[] {
  const absTestsDir = join(memberDir, testsDir);

  if (!existsSync(absTestsDir)) return [];

  let entries: string[];

  try {
    entries = readdirSync(absTestsDir);
  } catch {
    return [];
  }

  return entries
    .filter((f) => f.endsWith(".test.mtp"))
    .map((f) => {
      const filePath = join(absTestsDir, f);
      return parseDiscoveredFile(filePath, memberDir);
    });
}

/**
 * Read and parse a single `.test.mtp` file.
 * Lex errors are merged into the diagnostic list; the AST field is null
 * when any error-level diagnostic is present.
 */
function parseDiscoveredFile(filePath: string, memberDir: string): DiscoveredTestFile {
  let source: string;

  try {
    source = readFileSync(filePath, "utf-8");
  } catch (e) {
    return {
      filePath,
      memberDir,
      ast: null,
      diagnostics: [
        {
          level: "error",
          message: `Could not read ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
          span: { line: 0, col: 0, endLine: 0, endCol: 0 },
        },
      ],
      ok: false,
    };
  }

  const { tokens, diagnostics: lexDiags } = lexTest(source);
  const { ast, diagnostics: parseDiags } = parseTestFile(tokens);

  const diagnostics = [...lexDiags, ...parseDiags];
  const ok = !diagnostics.some((d) => d.level === "error");

  return {
    filePath,
    memberDir,
    ast: ok ? ast : null,
    diagnostics,
    ok,
  };
}
