/**
 * WASM memory helpers: string and argument marshalling across the JS / WASM boundary.
 *
 * The WASM linear memory uses Emscripten conventions:
 * - Strings are null-terminated UTF-8 in WASM heap
 * - Allocation via _malloc / deallocation via _free
 * - Emscripten runtime methods (allocateUTF8, UTF8ToString) handle encoding
 *
 * This module wraps those primitives with typed helpers so the rest of the
 * runtime module never touches raw pointers or memory views directly.
 */

import type { RuntimeValue, ValueType } from "../types.js";

/**
 * Minimal interface for the Emscripten-generated JS glue.
 * Only the methods we actually use are declared here.
 */
export interface EmscriptenModule {
  HEAP8: Int8Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;

  _malloc(size: number): number;
  _free(ptr: number): void;

  // Emscripten runtime methods (requested via EXPORTED_RUNTIME_METHODS)
  ccall(
    ident: string,
    returnType: string | null,
    argTypes: string[],
    args: unknown[],
  ): unknown;

  cwrap(
    ident: string,
    returnType: string | null,
    argTypes: string[],
  ): (...args: unknown[]) => unknown;

  UTF8ToString(ptr: number): string;
  stringToUTF8(str: string, outPtr: number, maxBytesToWrite: number): void;
  lengthBytesUTF8(str: string): number;
}

/**
 * Write a JS string into WASM heap memory.
 * Returns a pointer that MUST be freed with freeString().
 */
export function allocString(mod: EmscriptenModule, str: string): number {
  const size = mod.lengthBytesUTF8(str) + 1;
  const ptr = mod._malloc(size);

  if (!ptr) throw new Error("WASM _malloc failed");

  mod.stringToUTF8(str, ptr, size);
  return ptr;
}

/**
 * Read a null-terminated UTF-8 string from WASM heap memory.
 */
export function readString(mod: EmscriptenModule, ptr: number): string {
  return mod.UTF8ToString(ptr);
}

/**
 * Free a previously allocated WASM string pointer.
 */
export function freeString(mod: EmscriptenModule, ptr: number): void {
  mod._free(ptr);
}

/**
 * Serialize a RuntimeValue to a JSON string for passing into WASM.
 * The C bridge can cJSON_Parse this on the other side.
 */
export function serializeValue(value: RuntimeValue): string {
  return JSON.stringify({ type: value.type, value: value.value });
}

/**
 * Deserialize a JSON string from WASM into a RuntimeValue.
 */
export function deserializeValue(json: string): RuntimeValue {
  const parsed: unknown = JSON.parse(json);

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "type" in parsed &&
    "value" in parsed
  ) {
    const obj = parsed as { type: string; value: unknown };
    return {
      type: obj.type as ValueType,
      value: obj.value as number | string | boolean,
    };
  }

  // Fallback: treat raw numbers/strings/bools
  if (typeof parsed === "number") {
    return { type: Number.isInteger(parsed) ? "int" : "float", value: parsed };
  }

  if (typeof parsed === "string") {
    return { type: "string", value: parsed };
  }

  if (typeof parsed === "boolean") {
    return { type: "bool", value: parsed };
  }

  return { type: "int", value: 0 };
}

/**
 * Serialize an array of RuntimeValues to JSON for passing as function args.
 */
export function serializeArgs(args: RuntimeValue[]): string {
  return JSON.stringify(args.map((a) => ({ type: a.type, value: a.value })));
}

/**
 * Deserialize a JSON array of values from WASM.
 */
export function deserializeArgs(json: string): RuntimeValue[] {
  const parsed: unknown = JSON.parse(json);

  if (!Array.isArray(parsed)) return [];

  return parsed.map((item: unknown) => {
    if (
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      "value" in item
    ) {
      const obj = item as { type: string; value: unknown };

      return {
        type: obj.type as ValueType,
        value: obj.value as number | string | boolean,
      };
    }
    
    return { type: "int" as const, value: 0 };
  });
}
