import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { Command } from "commander";
import { info, success, error, warn, dim } from "../output.js";
import { createRuntime, formatTrace } from "../../runtime/index.js";
import type { Runtime, PluginHandle, RuntimeError } from "../../runtime/index.js";
import { getLatestApiDescriptor } from "@maustec/mt-runtimes";
import { transpile } from "../../lang/index.js";

/**
 * Resolve the plugin source to a parsed JSON object.
 * Accepts .json (plugin JSON) or .mtp (compiles first).
 */
function loadPlugin(path: string): Record<string, unknown> {
  const ext = extname(path);

  if (ext === ".mtp") {
    const source = readFileSync(path, "utf-8");
    const result = transpile(source);

    for (const d of result.diagnostics) {
      const loc = d.span ? `${path}:${d.span.line}:${d.span.col}` : path;

      if (d.level === "error") {
        error(`${loc} -- ${d.message}`);
      } else {
        warn(`${loc} -- ${d.message}`);
      }
    }

    if (result.diagnostics.some((d) => d.level === "error")) {
      throw new Error("Compilation failed");
    }

    return result.plugin as unknown as Record<string, unknown>;
  }

  if (ext === ".json") {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  }

  throw new Error(`Unsupported file type "${ext}". Expected .mtp or .json.`);
}

/**
 * Auto-discover a plugin file in the current directory.
 */
function findPlugin(): string | null {
  const cwd = process.cwd();

  try {
    const mtpFile = readdirSync(cwd).find((f) => f.endsWith(".mtp"));

    if (mtpFile) return join(cwd, mtpFile);
  } catch {
    // ignore
  }

  const jsonPath = join(cwd, "plugin.json");

  if (existsSync(jsonPath)) return jsonPath;

  return null;
}

async function simulate(
      path: string | undefined,
      opts: { api?: string; event?: string[]; arg?: string[]; trace: boolean; json?: boolean },
): Promise<void> {
  // Resolve plugin path
  let pluginPath: string;

  if (path !== undefined) {
    pluginPath = resolve(path);
  } else {
    const found = findPlugin();

    if (!found) {
      error("No plugin file found. Provide a path or run from a plugin directory.");
      process.exitCode = 1;
      return;
    }

    pluginPath = found;
  }

  if (!existsSync(pluginPath)) {
    error(`File not found: ${pluginPath}`);
    process.exitCode = 1;
    return;
  }

  // Load plugin JSON
  let pluginJson: Record<string, unknown>;

  try {
    pluginJson = loadPlugin(pluginPath);
  } catch (e) {
    error(`Failed to load plugin: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // Resolve API manifest
  const sku = opts.api ?? "EOM3K";
  let manifest;

  try {
    manifest = getLatestApiDescriptor(sku);
  } catch {
    warn(`Could not load API manifest for "${sku}". Running without host function stubs.`);
    manifest = undefined;
  }

  // Events to fire
  const events = opts.event ?? ["modeSet"];
  const args = (opts.arg ?? ["128"]).map(Number);

  info(`Loading WASM runtime...`);

  let runtime: Runtime;

  try {
    runtime = await createRuntime({
      ...(manifest ? { manifest } : {}),
      tracing: opts.trace,
      errorReporter: (err: RuntimeError) => {
        error(`[P${err.pluginId}] ${err.message}${err.context ? ` (${err.context})` : ""}`);
      },
    });
  } catch (e) {
    error(`Failed to initialize runtime: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // Load the plugin
  let plugin: PluginHandle;
  try {
    plugin = runtime.loadPlugin(pluginJson);

    success(
      `Loaded plugin: ${plugin.displayName}` +
        (plugin.pluginType ? ` ${dim(`[${plugin.pluginType}]`)}` : ""),
    );
  } catch (e) {
    error(`Failed to load plugin: ${(e as Error).message}`);
    runtime.dispose();
    process.exitCode = 1;
    return;
  }

  // Fire events
  for (let i = 0; i < events.length; i++) {
    const eventName = events[i]!;
    const arg = args[i] ?? args[0] ?? 0;

    info(`Firing event: ${eventName}(${arg})`);
    const result = runtime.fireEvent(plugin, eventName, arg);

    if (result.success) {
      success(
        `Event ${eventName} -> OK` +
          (result.accumulator ? ` (acc=${result.accumulator.value})` : ""),
      );
    } else {
      error(`Event ${eventName} -> error code ${result.errorCode}`);
    }
  }

  // Display trace
  if (opts.trace) {
    const trace = runtime.getTrace();

    if (trace.length > 0) {
      console.log();

      if (opts.json) {
        const { traceToJson } = await import("../../runtime/format.js");
        console.log(JSON.stringify(traceToJson(trace), null, 2));
      } else {
        info("Execution trace:");
        console.log(formatTrace(trace));
      }

    } else {
      info(dim("No trace events captured."));
    }
  }

  // Display errors
  const errors = runtime.getErrors();
  
  if (errors.length > 0) {
    console.log();
    warn(`${errors.length} error(s) during execution:`);

    for (const err of errors) {
      console.log(
        `  P${err.pluginId} [${err.code}] ${err.message}` +
          (err.context ? ` ${dim(`(${err.context})`)}` : ""),
      );
    }
  }

  // Cleanup
  runtime.freePlugin(plugin);
  runtime.dispose();
}

export const simulateCommand = new Command("simulate")
  .description("Run a simulation with a plugin against one or more events")
  .argument("[path]", "plugin file or directory (default: auto-discover in cwd)")
  .option("-a, --api <sku>", "device SKU for API manifest (default: EOM3K)")
  .option("-e, --event <events...>", "event(s) to fire (default: modeSet)")
  .option("--arg <args...>", "event argument(s) (default: 128)")
  .option("--no-trace", "disable execution trace")
  .option("--json", "output trace as JSON")
  .action(simulate);
