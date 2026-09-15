import { existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { execSync } from "node:child_process";
import { Command } from "commander";
import { select, input, checkbox, confirm } from "@inquirer/prompts";
import {
  scaffoldPlugin,
  scaffoldUmbrella,
  writeScaffold,
  getAllOverlays,
} from "../../scaffolding/index.js";
import type { PluginScaffoldSpec, UmbrellaScaffoldSpec, PluginType } from "../../scaffolding/index.js";
import {
  info,
  success,
  warn,
  error,
  dim,
  bold,
  green,
  cyan,
} from "../output.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gitUserName(): string {
  try {
    return execSync("git config user.name", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function printPlan(targetDir: string, paths: string[]): void {
  const label = basename(targetDir);
  console.log(`\n  ${bold(label)}/`);
  for (const p of paths) {
    console.log(`    ${green("+")} ${dim(p)}`);
  }
}

// ---------------------------------------------------------------------------
// Flag-driven path (non-interactive / CI)
// ---------------------------------------------------------------------------

interface InitOptions {
  type?: string;
  displayName?: string;
  pluginType?: string;
  platforms?: string;
  author?: string;
  dir?: string;
  overlays?: string;
  dryRun?: boolean;
  yes?: boolean;
  bleNamePrefix?: string;
}

async function runFlagged(name: string, opts: InitOptions): Promise<void> {
  const kind = opts.type;
  if (kind !== "plugin" && kind !== "umbrella") {
    error(`--type must be "plugin" or "umbrella". Got: ${String(kind)}`);
    process.exitCode = 1;
    return;
  }

  const targetDir = opts.dir ? resolve(opts.dir) : resolve(name);
  const overlayIds = opts.overlays ? opts.overlays.split(",").map((s) => s.trim()) : [];

  if (kind === "umbrella") {
    const spec: UmbrellaScaffoldSpec = { kind: "umbrella", name, overlays: overlayIds };
    const result = scaffoldUmbrella(spec, targetDir);
    await commit(result.files.map((f) => f.path), targetDir, opts.dryRun ?? false, opts.yes ?? false, result);
    return;
  }

  // plugin
  if (!opts.displayName) {
    error("--display-name is required in non-interactive mode.");
    process.exitCode = 1;
    return;
  }

  const pluginType = (opts.pluginType ?? "feature") as PluginType;
  if (pluginType !== "feature" && pluginType !== "ble_driver") {
    error(`--plugin-type must be "feature" or "ble_driver". Got: ${String(pluginType)}`);
    process.exitCode = 1;
    return;
  }

  // TODO: Platform syntax has since upgraded from basic family tags to pinned versions, handle this by
  // validating CLI entries against the mt-runtimes library.
  const platforms = opts.platforms
    ? opts.platforms.split(",").map((s) => s.trim())
    : ["@eom", "@mercury"];

  const spec: PluginScaffoldSpec = {
    kind: "plugin",
    name,
    displayName: opts.displayName,
    pluginType,
    platforms,
    author: opts.author ?? gitUserName(),
    overlays: overlayIds,
    ...(opts.bleNamePrefix ? { blePrefix: opts.bleNamePrefix } : {}),
  };

  const result = scaffoldPlugin(spec, targetDir);
  await commit(result.files.map((f) => f.path), targetDir, opts.dryRun ?? false, opts.yes ?? false, result);
}

// ---------------------------------------------------------------------------
// Interactive path
// ---------------------------------------------------------------------------

async function runInteractive(nameArg: string | undefined): Promise<void> {
  const kind = await select<"plugin" | "umbrella">({
    message: "What are you creating?",
    choices: [
      { name: "Plugin   - a single MTP plugin project", value: "plugin" },
      { name: "Umbrella - a workspace containing multiple plugins", value: "umbrella" },
    ],
  });

  const name = nameArg ?? await input({
    message: kind === "umbrella" ? "Workspace name (slug):" : "Plugin name (slug):",
    validate: (v) => /^[a-z0-9_-]+$/i.test(v) ? true : "Use only letters, numbers, hyphens, and underscores.",
  });

  const targetDir = resolve(name);

  if (existsSync(targetDir)) {
    const overwrite = await confirm({
      message: `Directory ${cyan(name)} already exists. Continue anyway?`,
      default: false,
    });
    if (!overwrite) {
      info("Aborted.");
      return;
    }
  }

  // Collect overlays applicable to this kind
  const applicableOverlays = getAllOverlays().filter(
    (o) => !o.appliesTo || o.appliesTo.includes(kind),
  );

  if (kind === "umbrella") {
    const selectedOverlays = await checkbox({
      message: "Which extras would you like to add?",
      choices: applicableOverlays.map((o) => ({
        name: `${o.name} - ${dim(o.description)}`,
        value: o.id,
        checked: o.defaultEnabled,
      })),
    });

    const spec: UmbrellaScaffoldSpec = {
      kind: "umbrella",
      name,
      overlays: selectedOverlays,
    };

    const result = scaffoldUmbrella(spec, targetDir);
    await commit(result.files.map((f) => f.path), targetDir, false, false, result);
    return;
  }

  // --- plugin ---

  const displayName = await input({
    message: "Display name:",
    default: name
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()),
  });

  const pluginType = await select<PluginType>({
    message: "Plugin type:",
    choices: [
      { name: "feature    - general behaviour / feature plugin", value: "feature" },
      { name: "ble_driver - BLE device driver", value: "ble_driver" },
    ],
  });

  const blePrefix = pluginType === "ble_driver"
    ? await input({
        message: "BLE advertised name prefix to match on (e.g. \"LVS-Max\"):",
        validate: (v) => v.trim().length > 0 ? true : "Required for a ble_driver plugin.",
      })
    : undefined;

  // TODO: Validate platform choices against the mt-runtimes library and populate this list accordingly.
  const platformChoices = await checkbox({
    message: "Target platforms:",
    choices: [
      { name: "@eom     — Edge-o-Matic 3000", value: "@eom", checked: true },
      { name: "@mercury — Mercury 1000",       value: "@mercury", checked: true },
    ],
  });

  if (platformChoices.length === 0) {
    warn("No platforms selected.");
    platformChoices.push("@eom", "@mercury");
  }

  const author = await input({
    message: "Author:",
    default: gitUserName(),
  });

  const selectedOverlays = await checkbox({
    message: "Which extras would you like to add?",
    choices: applicableOverlays.map((o) => ({
      name: `${o.name} — ${dim(o.description)}`,
      value: o.id,
      checked: o.defaultEnabled,
    })),
  });

  const spec: PluginScaffoldSpec = {
    kind: "plugin",
    name,
    displayName,
    pluginType,
    platforms: platformChoices,
    author,
    overlays: selectedOverlays,
    ...(blePrefix ? { blePrefix } : {}),
  };

  const result = scaffoldPlugin(spec, targetDir);
  await commit(result.files.map((f) => f.path), targetDir, false, false, result);
}

// ---------------------------------------------------------------------------
// Common commit step
// ---------------------------------------------------------------------------

async function commit(
  paths: string[],
  targetDir: string,
  dryRun: boolean,
  yes: boolean,
  result: ReturnType<typeof scaffoldPlugin | typeof scaffoldUmbrella>,
): Promise<void> {
  printPlan(targetDir, paths);

  for (const w of result.warnings) {
    warn(w);
  }

  if (dryRun) {
    console.log(`\n  ${dim("--- Dry run --- No files written.")}`);
    return;
  }

  const proceed =
    yes ||
    (await confirm({
      message: "Create these files?",
      default: true,
    }));

  if (!proceed) {
    info("Aborted.");
    return;
  }

  const report = writeScaffold(result);

  for (const p of report.skipped) {
    console.log(`  ${dim("-")} ${p} ${dim("(exists, skipped)")}`);
  }
  for (const e of report.errors) {
    error(`Failed to write ${e.path}: ${e.message}`);
  }

  if (report.errors.length > 0) {
    process.exitCode = 1;
    return;
  }

  const rel = basename(targetDir);
  console.log("");
  success(`Done.  cd ${cyan(rel)} && mt-sdk build`);
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const initCommand = new Command("init")
  .description("Scaffold a new plugin or umbrella workspace")
  .argument("[name]", "Project name / directory slug")
  .option("--type <type>", "Project type: plugin or umbrella")
  .option("--display-name <name>", "Plugin display name (plugin only)")
  .option("--plugin-type <type>", "Plugin type: feature or ble_driver (plugin only)", "feature")
  .option("--ble-name-prefix <prefix>", "BLE advertised name prefix to match on (ble_driver only)")
  .option("--platforms <list>", "Comma-separated platform targets, e.g. @eom,@mercury") // TODO: Update when platform target syntax is fixed.
  .option("--author <name>", "Author name")
  .option("--dir <path>", "Target directory (default: ./<name>)")
  .option("--overlays <list>", "Comma-separated overlay IDs to apply")
  .option("--dry-run", "Show what would be created without writing files")
  .option("-y, --yes", "Skip confirmation prompts")
  .action(async (nameArg: string | undefined, opts: InitOptions) => {
    try {
      if (opts.type) {
        // Non-interactive mode requires a name
        const name = nameArg;
        if (!name) {
          error("A project name is required when using --type.");
          process.exitCode = 1;
          return;
        }
        await runFlagged(name, opts);
      } else {
        await runInteractive(nameArg);
      }
    } catch (e) {
      // Inquirer throws ExitPromptError when the user presses Ctrl+C
      if (e instanceof Error && e.name === "ExitPromptError") {
        console.log("\n  Aborted.");
        return;
      }
      throw e;
    }
  });
