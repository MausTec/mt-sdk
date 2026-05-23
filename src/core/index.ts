export type { BuildOptions, BuildResult } from "./build.js";
export { build } from "./build.js";

export type { ValidateOptions, ValidationResult, Diagnostic } from "./validate.js";
export { validate } from "./validate.js";

export type {
  SimulateEvent,
  SimulateOptions,
  EventOutcome,
  SimulationResult,
} from "./simulate.js";
export { simulate } from "./simulate.js";

export type {
  DiscoveredTestFile,
  TestDiscovery,
  TestOptions,
  MemberBuildError,
  TestResult,
} from "./test.js";
export { discoverTests, runProjectTests } from "./test.js";
