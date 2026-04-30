import type { TestResult } from "../../core/test.js";
import type {
  TestCaseResult,
  TestReporter,
  TestSuiteResult,
} from "../../lang/test/runner.js";

/**
 * A suite paired with the ordered case results captured while it ran.
 * Reporters that need a post-run "failure detail" pass keep these around
 * because the streaming `TestReporter` discards ordering once a suite ends.
 */
export interface CollectedSuite {
  suite: TestSuiteResult;
  cases: TestCaseResult[];
}

/**
 * A pluggable reporter for `mt-sdk test`.
 *
 * Lifecycle:
 *   1. `onRunStart`: once, before any suite runs.
 *   2. `testReporter`: streaming hooks the runner drives per suite/case.
 *   3. `onRunFinish`: once, after all suites resolve and build/parse
 *      errors are known.
 */
export interface Reporter {
  /** Streaming hooks consumed by the test runner. */
  readonly testReporter: TestReporter;

  /** Called once before the first suite is dispatched. */
  onRunStart(cwd: string): void;

  /** Called once after the run completes, with the aggregate result. */
  onRunFinish(result: TestResult, durationMs: number): void;
}

/** Built-in reporter names accepted by `--reporter`. */
export type ReporterName = "cli" | "github" | "auto";
