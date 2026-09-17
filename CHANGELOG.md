# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Bumped `@maustec/mt-runtimes` dependency to its v1 release.

## [1.0.0] - 2026-09-16

First stable release of the SDK, covering the full plugin authoring pipeline
(lexer -> parser -> linker/validation -> emitter), a WASM-backed simulation
runtime that mirrors real hardware, a `.test.mtp` test framework, and CLI/VSCode tooling.

### Added

- **Test framework**: new `.test.mtp` language support — dedicated lexer
  tokens and parser (`Test parser finalized as a subclass instead of standalone
  parser`), a JSON expression evaluator for assertions, and a test runner
  under `src/lang/test` with diagnostic logging, filename-origin tracking, and
  formatted assertion-failure reporting.
- **CLI**: migrated to Commander, adding a proper test runner command with
  reporters, a `--live` simulator flag for viewing live runtime traces, and a
  project scaffolding module for generating new plugin projects.
- **Runtime**: runtime error raising support, runtime tracing, global
  variable access from the host simulator, and a `result` identifier to
  capture the value of `call`/`emit` during test execution.
- **VSCode extension**: extended to recognize and edit `.test.mtp` files.
- **Platform resolution**: support for `file:`-based platform definitions to
  speed up local development across plugin/API combinations.
- Documentation scaffold, ready for content population.
- CI pipeline for automated builds/tests.

### Changed

- Converted the plugin runtime to bind function/event arguments positionally,
  dropping named-argument call syntax (emitter and test runtime updated to
  match; corresponding cleanup follow-up tracked in `mt-runtimes`).
- Updated the emitter to emit the canonical `get_config` instead of
  `get_plugin_config`, now that config lookups live in the plugin core
  runtime.
- Refactored the host simulator runtime to consume the new WASM module
  interface from `mt-runtimes`.
- Renamed `src/core` to `src/analysis` to clarify its role as the JSON
  plugin analyzer, and introduced new top-level developer entrypoints under
  `src/core/`.
- Moved workspace/project detection out of the CLI and into its own module.
- Always emit `status` in pipe calls; removed implicit first-argument
  variable reach in the runtime.
- Aligned the VSCode extension package version with the `mt-sdk` package
  version.

### Fixed

- Split test-specific lexer tokens out of the plugin namespace to avoid
  polluting it for non-test plugin code.

[Unreleased]: https://github.com/MausTec/mt-sdk/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/MausTec/mt-sdk/compare/v0.1.0...v1.0.0
