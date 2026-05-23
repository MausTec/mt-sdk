import { createCliReporter } from "./cli-reporter.js";
import { createGithubActionsReporter } from "./github-actions-reporter.js";
import type { Reporter, ReporterName } from "./types.js";

export type { Reporter, ReporterName, CollectedSuite } from "./types.js";
export { createCliReporter } from "./cli-reporter.js";
export { createGithubActionsReporter } from "./github-actions-reporter.js";

/** All reporter names accepted by `--reporter`. */
export const REPORTER_NAMES: readonly ReporterName[] = ["auto", "cli", "github"];

/**
 * Resolve a `--reporter` value (or `auto`) to a concrete `Reporter`.
 *
 * `auto` picks `github` when running inside GitHub Actions
 * (`GITHUB_ACTIONS=true`), otherwise `cli`. Unknown names fall back to
 * `cli` after a warning is printed by the caller.
 */
export function createReporter(name: ReporterName | string | undefined): Reporter {
  const resolved = resolveReporterName(name);

  switch (resolved) {
    case "github": return createGithubActionsReporter();
    case "cli":
    default:       return createCliReporter();
  }
}

function resolveReporterName(name: ReporterName | string | undefined): Exclude<ReporterName, "auto"> {
  const requested = (name ?? "auto") as ReporterName;

  if (requested === "auto") {
    return process.env.GITHUB_ACTIONS === "true" ? "github" : "cli";
  }
  
  if (requested === "github" || requested === "cli") return requested;
  return "cli";
}
