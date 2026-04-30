import { resolve, relative } from "node:path";
import { Command } from "commander";
import { warn, dim, passMark, failMark } from "../output.js";
import { runProjectTests, discoverTests } from "../../core/test.js";
import { createReporter, REPORTER_NAMES } from "../reporters/index.js";

interface TestOptions {
  sku?:      string;
  trace?:    boolean;
  debug?:    boolean;
  json?:     boolean;
  list?:     boolean;
  reporter?: string;
}

async function testListCmd(cwd: string, opts: TestOptions): Promise<void> {
  const discovery = discoverTests({ cwd });

  if (opts.json) {
    console.log(JSON.stringify(discovery, null, 2));
    return;
  }

  if (discovery.files.length === 0) {
    warn("No .test.mtp files found.");
    return;
  }

  for (const f of discovery.files) {
    const rel = relative(cwd, f.filePath);

    if (!f.ok) {
      console.log(`  ${failMark()} ${rel} ${dim("(parse error)")}`);
    } else if (f.ast) {
      const cases = countCases(f.ast);
      console.log(`  ${passMark()} ${rel} ${dim(`(${cases} case${cases === 1 ? "" : "s"})`)}`);
    }
  }
}

async function testJsonCmd(cwd: string, opts: TestOptions): Promise<void> {
  const result = await runProjectTests({
    cwd,
    ...(opts.sku !== undefined ? { sku: opts.sku } : {}),
    ...(opts.trace !== undefined ? { tracing: opts.trace } : {}),
    ...(opts.debug !== undefined ? { debug: opts.debug } : {}),
  });

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

async function testCmd(
  path: string | undefined,
  opts: TestOptions,
): Promise<void> {
  const cwd = path ? resolve(path) : process.cwd();

  // --list: discover only, no execution
  if (opts.list) {
    return testListCmd(cwd, opts);
  }

  // --json: silent run, dump raw result
  if (opts.json) {
    return testJsonCmd(cwd, opts);
  }

  const reporter  = createReporter(opts.reporter);
  const startedAt = Date.now();

  reporter.onRunStart(cwd);

  const result = await runProjectTests({
    cwd,
    ...(opts.sku !== undefined ? { sku: opts.sku } : {}),
    ...(opts.trace !== undefined ? { tracing: opts.trace } : {}),
    ...(opts.debug !== undefined ? { debug: opts.debug } : {}),
    reporter: reporter.testReporter,
  });

  reporter.onRunFinish(result, Date.now() - startedAt);

  process.exitCode = result.ok ? 0 : 1;
}

export const testCommand = new Command("test")
  .description("Run .test.mtp test suites for the workspace")
  .argument("[path]", "working directory (default: cwd)")
  .option("--sku <sku>", "device SKU for resolving the host function manifest (e.g. EOM3K)")
  .option("--trace", "capture per-test execution traces")
  .option("--debug", "emit step-by-step setup diagnostics to stderr")
  .option("--json", "output full results as JSON and suppress all other output")
  .option("--list", "discover and list test files without running them")
  .option(
    `--reporter <name>`,
    `output format: ${REPORTER_NAMES.join(" | ")} (auto picks 'github' under GITHUB_ACTIONS, else 'cli')`,
    "auto",
  )
  .action(testCmd);

/**
 * Count the number of test cases in a parsed test file AST.
 * Used for the --list display.
 */
function countCases(ast: import("../../lang/test/ast.js").TestFileNode): number {
  let count = 0;

  for (const item of ast.body) {
    if (item.kind === "TestCase") {
      count++;
    } else if (item.kind === "Describe") {
      for (const inner of item.body) {
        if (inner.kind === "TestCase") count++;
      }
    }
  }
  
  return count;
}
