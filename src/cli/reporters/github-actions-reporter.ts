import { appendFileSync } from "node:fs";
import { relative } from "node:path";
import type { TestResult } from "../../core/test.js";
import type {
  TestCaseResult,
  TestReporter,
} from "../../lang/test/runner.js";
import type { CollectedSuite, Reporter } from "./types.js";

/**
 * GitHub Actions workflow-command reporter.
 *
 * Behavior:
 *   - Each suite is wrapped in `::group::` / `::endgroup::` so its cases
 *     collapse in the Actions log.
 *   - Each failing case emits one `::error::` annotation (file-anchored
 *     when a source path is known) so failures surface inline on the PR.
 *   - When `GITHUB_STEP_SUMMARY` is defined, a markdown summary table is
 *     appended for the workflow run summary page.
 *
 * No ANSI colour is emitted — Actions strips it from annotations and the
 * step summary is markdown.
 */
export function createGithubActionsReporter(): Reporter {
  let cwd = process.cwd();
  const collected: CollectedSuite[] = [];
  let currentCases: TestCaseResult[] = [];

  const testReporter: TestReporter = {
    onSuiteStart(info) {
      currentCases = [];
      // eslint-disable-next-line no-console
      console.log(`::group::SUITE ${info.pluginRef}`);
    },
    onCaseResult(result) {
      currentCases.push(result);
      // Annotations are emitted in onSuiteResult below, once the suite's
      // filePath is known so GitHub can anchor them to the right source.
    },
    onSuiteResult(suite) {
      const cases = currentCases;
      currentCases = [];
      collected.push({ suite, cases });

      const status = suite.failed === 0 && suite.errored === 0 ? "PASS" : "FAIL";
      const path   = suite.filePath ? relative(cwd, suite.filePath) : suite.pluginRef;

      // eslint-disable-next-line no-console
      console.log(
        `${status} ${path} -- ${suite.passed} passed, ${suite.failed} failed, ${suite.errored} errored (${suite.durationMs}ms)`,
      );

      // eslint-disable-next-line no-console
      console.log("::endgroup::");

      const file = suite.filePath ? relative(cwd, suite.filePath) : undefined;

      for (const c of cases) {
        if (c.kind !== "pass") emitCaseAnnotation(c, file);
      }
    },
  };

  return {
    testReporter,
    onRunStart(rootCwd) {
      cwd = rootCwd;
    },
    onRunFinish(result, durationMs) {
      emitBuildAndParseAnnotations(result, cwd);
      emitFinalNotice(result, durationMs);
      writeStepSummary(result, collected, durationMs, cwd);
    },
  };
}

// ---------------------------------------------------------------------------
// Workflow commands
// ---------------------------------------------------------------------------

interface AnnotationProps {
  file?:  string;
  line?:  number;
  col?:   number;
  title?: string;
}

function annotate(
  level: "error" | "warning" | "notice",
  props: AnnotationProps,
  message: string,
): void {
  const parts: string[] = [];

  if (props.file)        parts.push(`file=${escapeProp(props.file)}`);
  if (props.line  !== undefined) parts.push(`line=${props.line}`);
  if (props.col   !== undefined) parts.push(`col=${props.col}`);
  if (props.title)       parts.push(`title=${escapeProp(props.title)}`);

  const head = parts.length > 0 ? ` ${parts.join(",")}` : "";

  // eslint-disable-next-line no-console
  console.log(`::${level}${head}::${escapeData(message)}`);
}

/** Escape values per GitHub Actions workflow command rules (data position). */
function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Escape values per GitHub Actions workflow command rules (property position). */
function escapeProp(s: string): string {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

// ---------------------------------------------------------------------------
// Annotation emitters
// ---------------------------------------------------------------------------

function emitCaseAnnotation(
  tc: TestCaseResult,
  filePath: string | undefined,
): void {
  if (tc.kind === "pass") return;

  const label = tc.describe ? `${tc.describe} > ${tc.label}` : tc.label;
  const title = tc.kind === "error" ? `Test errored: ${label}` : `Test failed: ${label}`;

  const lines: string[] = [];
  // Take location from the first failure that carries one; this becomes the
  // inline annotation anchor in the file view.
  const firstLoc = tc.failures.find((f) => f.sourceLoc)?.sourceLoc;

  for (const f of tc.failures) {
    lines.push(f.message);
    if (f.sourceSnippet) {
      for (const sl of f.sourceSnippet.split("\n")) lines.push(`  | ${sl}`);
    }
    if (f.expected !== undefined) lines.push(`  expected: ${f.expected}`);
    if (f.received !== undefined) lines.push(`  received: ${f.received}`);
    if (f.details && f.details.length > 0) {
      lines.push(`  details:`);
      for (const d of f.details) lines.push(`    ${d}`);
    }
    if (f.sourceLoc) {
      lines.push(`  at ${f.sourceLoc.line}:${f.sourceLoc.col}`);
    } else if (f.stepIndex >= 0) {
      lines.push(`  at step #${f.stepIndex}`);
    }
  }

  annotate(
    "error",
    {
      ...(filePath ? { file: filePath } : {}),
      ...(firstLoc ? { line: firstLoc.line, col: firstLoc.col } : {}),
      title,
    },
    lines.join("\n"),
  );
}

function emitBuildAndParseAnnotations(result: TestResult, cwd: string): void {
  for (const be of result.buildErrors) {
    const file = relative(cwd, be.memberDir);

    for (const d of be.diagnostics) {
      annotate(
        "error",
        {
          file,
          ...(d.span ? { line: d.span.line, col: d.span.col } : {}),
          title: "Plugin build failure",
        },
        d.message,
      );
    }
  }
  for (const pe of result.parseErrors) {
    const file = relative(cwd, pe.filePath);

    for (const d of pe.diagnostics) {
      annotate(
        "error",
        {
          file,
          ...(d.span ? { line: d.span.line, col: d.span.col } : {}),
          title: "Test file parse failure",
        },
        d.message,
      );
    }
  }
}

function emitFinalNotice(result: TestResult, durationMs: number): void {
  const total = result.passed + result.failed + result.errored;
  const msg = `Tests: ${result.passed} passed, ${result.failed} failed, ${result.errored} errored (${total} total) in ${durationMs}ms`;
  annotate(result.ok ? "notice" : "error", { title: "mt-sdk test" }, msg);
}

// ---------------------------------------------------------------------------
// Step summary (markdown)
// ---------------------------------------------------------------------------

function writeStepSummary(
  result: TestResult,
  collected: CollectedSuite[],
  durationMs: number,
  cwd: string,
): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const total = result.passed + result.failed + result.errored;
  const status = result.ok ? "Passed" : "Failed";

  const lines: string[] = [];
  lines.push(`## mt-sdk test -- ${status}`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Test Files | ${collected.length} |`);
  lines.push(`| Tests | ${total} |`);
  lines.push(`| Passed | ${result.passed} |`);
  lines.push(`| Failed | ${result.failed} |`);
  lines.push(`| Errored | ${result.errored} |`);
  lines.push(`| Duration | ${durationMs}ms |`);
  lines.push("");

  if (collected.length > 0) {
    lines.push("### Suites");
    lines.push("");
    lines.push("| Status | Suite | Passed | Failed | Errored | Duration |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: |");

    for (const { suite } of collected) {
      const ok = suite.failed === 0 && suite.errored === 0;
      const path = suite.filePath ? relative(cwd, suite.filePath) : suite.pluginRef;

      lines.push(
        `| ${ok ? "PASS" : "FAIL"} | \`${path}\` | ${suite.passed} | ${suite.failed} | ${suite.errored} | ${suite.durationMs}ms |`,
      );
    }

    lines.push("");
  }

  const failingCases: { suite: string; label: string; messages: string[] }[] = [];

  for (const { suite, cases } of collected) {
    const path = suite.filePath ? relative(cwd, suite.filePath) : suite.pluginRef;

    for (const tc of cases) {
      if (tc.kind === "pass") continue;

      const label = tc.describe ? `${tc.describe} > ${tc.label}` : tc.label;

      failingCases.push({
        suite: path,
        label,
        messages: tc.failures.map((f) => f.message),
      });
    }
  }

  if (failingCases.length > 0) {
    lines.push("### Failures");
    lines.push("");

    for (const fc of failingCases) {
      lines.push(`- **${fc.label}** (\`${fc.suite}\`)`);

      for (const m of fc.messages) {
        lines.push(`  - ${m}`);
      }
    }
    
    lines.push("");
  }

  try {
    appendFileSync(summaryPath, lines.join("\n") + "\n");
  } catch {
    // Best-effort; failing to write the summary should not fail the run.
  }
}
