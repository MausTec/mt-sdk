/**
 * WASM module loader.
 *
 * Handles loading and instantiation of the mt-actions WASM module from
 * various sources (file path, URL, raw bytes, pre-compiled module).
 *
 * The loader is environment-aware: it uses fs.readFile in Node and fetch
 * in browsers. The caller doesn't need to know which.
 * 
 * This loader is matched to the expected output of the mt-runtime Emscripten build:
 * - The .wasm file is the primary input, and the loader locates the sibling .js glue.
 * - The JS glue is responsible for instantiating the WASM module and providing
 *   the expected imports (js_host_dispatch, js_config_save, etc).
 *
 * The loader returns a promise that resolves to the Emscripten-shaped module
 * interface, which is used by bindings.ts to implement the RuntimeEngine.
 */

import type { EmscriptenModule } from "./memory.js";

// WebAssembly is a global in all modern runtimes but not in the es2022 lib.
declare const WebAssembly: {
  Module: { new (bytes: ArrayBuffer): unknown; prototype: unknown };

  instantiate(
    source: ArrayBuffer | unknown,
    imports?: Record<string, Record<string, unknown>>,
  ): Promise<{ instance: unknown; module: unknown }>;
};

/**
 * Source for WASM module loading.
 * - string: file path (Node) or URL (browser)
 * - ArrayBuffer/Uint8Array: raw WASM bytes
 * - Pre-compiled WASM module
 */
export type WasmSource = string | ArrayBuffer | Uint8Array;

/**
 * The import object shape expected by the mt-actions WASM bridge.
 * These are the JS functions the WASM module calls back into.
 *
 * Signatures match the C externs in wasm_bridge.c. Emscripten passes
 * `const char*` as number (WASM heap pointer), `int` as number.
 */
export interface WasmImports {
  /**
   * Called when execution hits a host function dispatch.
   *
   * C: int js_host_dispatch(int slot, const char* fn_name, const char* args_json, int arg_count)
   */
  js_host_dispatch(slot: number, fnNamePtr: number, argsJsonPtr: number, argCount: number): number;

  /**
   * Called when a plugin requests a config save.
   *
   * C: int js_config_save(int slot)
   */
  js_config_save(slot: number): number;

  /**
   * Called for diagnostic trace events when tracing is enabled.
   *
   * C: void js_trace_event(int slot, int kind, const char* fn_name, int result)
   */
  js_trace_event(slot: number, kind: number, fnNamePtr: number, result: number): void;

  /**
   * Called when the WASM runtime encounters an error.
   *
   * C: void js_error_report(int slot, const char* fn_name, int error_code)
   */
  js_error_report(slot: number, fnNamePtr: number, errorCode: number): void;
}

/**
 * Load raw WASM bytes from the given source.
 */
async function loadWasmBytes(source: WasmSource): Promise<ArrayBuffer> {
  if (source instanceof ArrayBuffer) {
    return source;
  }

  if (source instanceof Uint8Array) {
    return source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength,
    ) as ArrayBuffer;
  }

  if (typeof source === "string") {
    // Node: file path
    if (typeof globalThis.process !== "undefined" && globalThis.process.versions?.node) {
      const { readFile } = await import("node:fs/promises");
      const buffer = await readFile(source);

      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      );
    }

    // Browser: URL
    const response = await fetch(source);

    if (!response.ok) {
      throw new Error(`Failed to fetch WASM from ${source}: ${response.status}`);
    }

    return response.arrayBuffer();
  }

  throw new Error("Invalid WASM source: expected string, ArrayBuffer, Uint8Array, or WebAssembly.Module");
}

/**
 * Instantiate the mt-actions WASM module with the given JS import callbacks.
 *
 * Returns the Emscripten-shaped module interface for use by bindings.ts.
 *
 * Uses the Emscripten-generated JS glue (createMtActionsModule factory).
 * The factory is loaded dynamically: from the filesystem in Node, or via
 * import() in the browser. The .wasm binary is passed via wasmBinary so
 * the glue doesn't need to locate the file itself.
 */
export async function instantiateRuntime(
  source: WasmSource,
  imports: WasmImports,
): Promise<EmscriptenModule> {
  const wasmBytes = await loadWasmBytes(source);

  // Resolve the JS glue path: sibling of the .wasm source when given as a path
  let createModule: (opts: Record<string, unknown>) => Promise<EmscriptenModule>;

  if (typeof source === "string" && source.endsWith(".wasm")) {
    const jsGluePath = source.replace(/\.wasm$/, ".js");

    if (typeof globalThis.process !== "undefined" && globalThis.process.versions?.node) {
      // Node: dynamic require of the CJS/ESM glue
      const mod = await import(jsGluePath);
      createModule = (mod.default ?? mod) as typeof createModule;
    } else {
      // Browser: dynamic import of the JS glue URL
      const mod = await import(/* @vite-ignore */ jsGluePath);
      createModule = (mod.default ?? mod) as typeof createModule;
    }
  } else {
    // Raw bytes provided without a path are invalid, the caller must supply a factory
    // function as part of a future overload. For now, this is unsupported.
    throw new Error(
      "When providing raw WASM bytes, source must be a string path/URL " +
        "ending in '.wasm' so the loader can find the sibling JS glue file.",
    );
  }

  const module = await createModule({
    wasmBinary: wasmBytes,
    _onHostDispatch: imports.js_host_dispatch,
    _onConfigSave: imports.js_config_save,
    _onTraceEvent: imports.js_trace_event,
    _onErrorReport: imports.js_error_report,
  });

  return module;
}
