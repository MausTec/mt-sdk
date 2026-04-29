/**
 * Type converters between mt-sdk's RuntimeValue / ConfigValue and the
 * Component Model ABI types (ArgValue, ConfigValue) from @maustec/mt-runtimes.
 *
 * These converters are the only place in the codebase that knows about both
 * type systems. Everything above this layer uses RuntimeValue; everything
 * below (the bridge) uses ArgValue / ConfigValue.
 *
 * NOTE: RuntimeValue's "bytes" variant has no equivalent in the Component
 * Model ABI. An error is thrown if one is encountered during conversion.
 * This constraint will be revisited once the bridge WIT is extended.
 */

import type { ArgValue, ConfigValue } from "@maustec/mt-runtimes";
import type { RuntimeValue } from "../types.js";

// --- ArgValue <-> RuntimeValue ---------------------------------------------

export function runtimeValueToArgValue(rv: RuntimeValue): ArgValue {
  switch (rv.type) {
    case "int":
      return { tag: "int-val", val: rv.value as number };
    case "float":
      return { tag: "float-val", val: rv.value as number };
    case "string":
      return { tag: "str-val", val: rv.value as string };
    case "bool":
      // The bridge has no bool variant in ArgValue; bools are passed as ints.
      return { tag: "int-val", val: (rv.value as boolean) ? 1 : 0 };
    case "bytes":
      throw new Error(
        "RuntimeValue 'bytes' type is not supported by the mtp:core bridge",
      );
    default:
      return { tag: "null-val" };
  }
}

export function argValueToRuntimeValue(av: ArgValue): RuntimeValue {
  switch (av.tag) {
    case "int-val":
      return { type: "int", value: av.val };
    case "float-val":
      return { type: "float", value: av.val };
    case "str-val":
      return { type: "string", value: av.val };
    case "null-val":
      return { type: "int", value: 0 };
  }
}

// --- ConfigValue <-> RuntimeValue ---------------------------------------------

// Used for getVariable / setVariable, which map to getConfigValue /
// setConfigValue in the bridge.

export function runtimeValueToConfigValue(rv: RuntimeValue): ConfigValue {
  switch (rv.type) {
    case "int":
      return { tag: "int-val", val: rv.value as number };
    case "float":
      // ConfigValue has no float variant; truncate to int.
      return { tag: "int-val", val: Math.trunc(rv.value as number) };
    case "string":
      return { tag: "str-val", val: rv.value as string };
    case "bool":
      return { tag: "bool-val", val: rv.value as boolean };
    case "bytes":
      throw new Error(
        "RuntimeValue 'bytes' type is not supported by the mtp:core bridge",
      );
    default:
      return { tag: "int-val", val: 0 };
  }
}

export function configValueToRuntimeValue(cv: ConfigValue): RuntimeValue {
  switch (cv.tag) {
    case "bool-val":
      return { type: "bool", value: cv.val };
    case "int-val":
      return { type: "int", value: cv.val };
    case "str-val":
      return { type: "string", value: cv.val };
  }
}
