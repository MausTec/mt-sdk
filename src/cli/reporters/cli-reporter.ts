import { relative } from "node:path";
import {
  bold, dim, gray, green, red, yellow,
  tag, formatDuration,
  CROSS,
  warn,
} from "../output.js";
import type { TestResult } from "../../core/test.js";
import type {
  TestCaseResult,
  TestReporter,
  TestSuiteResult,
} from "../../lang/test/runner.js";
import type { CollectedSuite, Reporter } from "./types.js";

/**
 * Vitest-style human reporter. Streams one header line per suite as it
 * completes, then prints a failure detail block and a summary block.
 */
export function createCliReporter(): Reporter {
  let cwd = process.cwd();
  const collected: CollectedSuite[] = [];
  let currentCases: TestCaseResult[] = [];

  const testReporter: TestReporter = {
    onSuiteStart() {
      currentCases = [];
    },
    onCaseResult(result) {
      currentCases.push(result);
    },
    onSuiteResult(suite) {
      const cases = currentCases;
      currentCases = [];
      collected.push({ suite, cases });
      printSuiteHeader(suite, cases, cwd);
    },
  };

  return {
    testReporter,
    onRunStart(rootCwd) {
      cwd = rootCwd;
      console.log();
      console.log(` ${tag("RUN", "info")}  ${dim(relative(process.cwd(), cwd) || ".")}`);
      console.log();
    },
    onRunFinish(result, durationMs) {
      printBuildErrors(result, cwd);
      printParseErrors(result, cwd);
      printFailures(collected, cwd);
      printSummary(result, collected, durationMs);
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

function printSuiteHeader(suite: TestSuiteResult, cases: TestCaseResult[], cwd: string): void {
  const suiteOk = suite.failed === 0 && suite.errored === 0;
  const label   = suiteOk ? tag("PASS", "pass") : tag("FAIL", "fail");
  const path    = suite.filePath ? relative(cwd, suite.filePath) : suite.pluginRef;
  const counts  = formatSuiteCounts(suite, cases);
  const time    = dim(`(${formatDuration(suite.durationMs)})`);

  console.log(` ${label} ${bold(path)} ${counts} ${time}`);
}

function formatSuiteCounts(suite: TestSuiteResult, cases: TestCaseResult[]): string {
  const total = cases.length;
  const parts: string[] = [];

  if (suite.passed  > 0) parts.push(green(`${suite.passed} passed`));
  if (suite.failed  > 0) parts.push(red(`${suite.failed} failed`));
  if (suite.errored > 0) parts.push(red(`${suite.errored} errored`));

  return dim(`(${total})`) + (parts.length > 0 ? ` ${parts.join(dim(", "))}` : "");
}

// ---------------------------------------------------------------------------
// Detail printers
// ---------------------------------------------------------------------------

function printBuildErrors(result: TestResult, cwd: string): void {
  if (result.buildErrors.length === 0) return;

  console.log();
  console.log(`${tag("BUILD", "fail")} ${red("compile failures")}`);

  for (const be of result.buildErrors) {
    const rel = relative(cwd, be.memberDir);
    console.log();
    console.log(`  ${red(CROSS)} ${bold(rel)}`);

    for (const d of be.diagnostics) {
      const loc = d.span ? gray(` (${d.span.line}:${d.span.col})`) : "";
      console.log(`      ${d.message}${loc}`);
    }
  }
}

function printParseErrors(result: TestResult, cwd: string): void {
  if (result.parseErrors.length === 0) return;

  console.log();
  console.log(`${tag("PARSE", "fail")} ${red("test file parse failures")}`);

  for (const pe of result.parseErrors) {
    const rel = relative(cwd, pe.filePath);
    console.log();
    console.log(`  ${red(CROSS)} ${bold(rel)}`);

    for (const d of pe.diagnostics) {
      const loc = d.span ? gray(` (${d.span.line}:${d.span.col})`) : "";
      console.log(`      ${d.message}${loc}`);
    }
  }
}

function printFailures(collected: CollectedSuite[], cwd: string): void {
  const failingSuites = collected.filter((c) => c.cases.some((tc) => tc.kind !== "pass"));
  if (failingSuites.length === 0) return;

  console.log();
  console.log(bold(red("Failed Tests")));
  console.log(dim("-".repeat(60)));

  for (const { suite, cases } of failingSuites) {
    const path = suite.filePath ? relative(cwd, suite.filePath) : suite.pluginRef;

    for (const tc of cases) {
      if (tc.kind === "pass") continue;

      const label = tc.describe ? `${tc.describe} > ${tc.label}` : tc.label;
      const kindTag = tc.kind === "error" ? tag("ERROR", "fail") : tag("FAIL", "fail");

      console.log();
      console.log(` ${kindTag} ${bold(label)}`);
      console.log(`   ${gray(path)}`);

      for (const f of tc.failures) {
        console.log();
        console.log(`   ${red(CROSS)} ${f.message}`);

        if (f.expected !== undefined) {
          console.log(`       ${dim("expected:")} ${green(f.expected)}`);
        }

        if (f.received !== undefined) {
          console.log(`       ${dim("received:")} ${red(f.received)}`);
        }

        if (f.stepIndex >= 0) {
          console.log(`       ${dim(`at step #${f.stepIndex}`)}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(result: TestResult, collected: CollectedSuite[], durationMs: number): void {
  const total = result.passed + result.failed + result.errored;

  if (
    total === 0 &&
    result.buildErrors.length === 0 &&
    result.parseErrors.length === 0
  ) {
    console.log();
    warn("No test cases found.");
    return;
  }

  const passedSuites  = collected.filter((c) => c.suite.failed === 0 && c.suite.errored === 0).length;
  const failedSuites  = collected.length - passedSuites;
  const totalSuites   = collected.length;

  const fileLine = formatSummaryRow("Test Files", formatCounts({
    passed:  passedSuites,
    failed:  failedSuites,
    total:   totalSuites,
    skipped: result.parseErrors.length + result.buildErrors.length,
  }));

  const testLine = formatSummaryRow("Tests", formatCounts({
    passed:  result.passed,
    failed:  result.failed,
    errored: result.errored,
    total,
  }));

  const durLine = formatSummaryRow("Duration", formatDuration(durationMs));

  console.log();
  console.log(fileLine);
  console.log(testLine);
  console.log(durLine);
  console.log();

  if (result.ok) {
    console.log(` ${tag("PASS", "pass")} ${green(`${total} test${total === 1 ? "" : "s"} passed`)}`);
  } else {
    const bits: string[] = [];

    if (result.failed  > 0) bits.push(red(`${result.failed} failed`));
    if (result.errored > 0) bits.push(red(`${result.errored} errored`));
    if (result.passed  > 0) bits.push(green(`${result.passed} passed`));

    console.log(` ${tag("FAIL", "fail")} ${bits.join(dim(", "))}`);
  }
}

function formatSummaryRow(field: string, value: string): string {
  return `${dim(field.padStart(12))}  ${value}`;
}

interface CountBuckets {
  passed:   number;
  failed:   number;
  errored?: number;
  skipped?: number;
  total:    number;
}

function formatCounts(c: CountBuckets): string {
  const parts: string[] = [];

  if (c.failed   > 0)               parts.push(red(`${c.failed} failed`));
  if ((c.errored ?? 0) > 0)         parts.push(red(`${c.errored} errored`));
  if (c.passed   > 0)               parts.push(green(`${c.passed} passed`));
  if ((c.skipped ?? 0) > 0)         parts.push(yellow(`${c.skipped} skipped`));
  
  return `${parts.join(dim(" | "))} ${dim(`(${c.total})`)}`;
}
